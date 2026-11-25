/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MARCH_SERVICES } from "../src/stack/services.ts";
import {
  buildManifest,
  composeImages,
  imageRepoName,
  loadServices,
  planImages,
} from "./stack-manifest.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const scriptPath = path.join(scriptDir, "stack-manifest.mjs");
const COMMIT = "1".repeat(40);
const digestFor = (name) =>
  `sha256:${Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

/** A minimal checkout: services.ts + compose files + package.json scripts. */
function fixture({ services, composes, scripts }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stack-manifest-test-"));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, "src", "stack"), { recursive: true });
  fs.mkdirSync(path.join(root, "docker"));
  fs.writeFileSync(
    path.join(root, "src", "stack", "services.ts"),
    `export interface MarchService { readonly name: string; readonly compose: string; readonly image?: string }\n` +
      `export const MARCH_SERVICES: readonly MarchService[] = ${JSON.stringify(services)};\n`,
  );
  for (const [name, text] of Object.entries(composes)) {
    fs.writeFileSync(path.join(root, "docker", name), text);
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }));
  return root;
}

const compose = (image) => `services:\n  svc:\n    image: ${image}\n    restart: unless-stopped\n`;

function goodFixture() {
  return fixture({
    services: [
      { name: "otel-lgtm", compose: "otel-lgtm.docker-compose.yml" },
      { name: "castra", compose: "castra.docker-compose.yml", image: "march-castra:latest" },
      { name: "legate", compose: "legate.docker-compose.yml", image: "march-legate:latest" },
    ],
    composes: {
      "otel-lgtm.docker-compose.yml": compose("grafana/otel-lgtm:0.11.16"),
      "castra.docker-compose.yml": compose("march-castra:latest"),
      "legate.docker-compose.yml": compose("march-legate:latest"),
    },
    scripts: { "build:castra-image": "docker build ...", "build:legate-image": "docker build ..." },
  });
}

describe("stack-manifest against this checkout", () => {
  it("loads exactly MARCH_SERVICES, in order", async () => {
    const loaded = await loadServices(repoRoot);
    expect(loaded.map((s) => [s.name, s.compose, s.image])).toEqual(
      MARCH_SERVICES.map((s) => [s.name, s.compose, s.image]),
    );
  });

  it("plans one image per service with an image, matching its compose image: line", async () => {
    const plan = await planImages(repoRoot);
    const withImage = MARCH_SERVICES.filter((s) => s.image);
    expect(plan.map((p) => p.name)).toEqual(withImage.map((s) => s.name));
    for (const svc of withImage) {
      const p = plan.find((x) => x.name === svc.name);
      expect(composeImages(repoRoot, svc.compose)).toEqual([svc.image]);
      expect(p.localImage).toBe(svc.image);
      expect(p.repo).toBe(`ghcr.io/balexda/${imageRepoName(svc.image)}`);
      expect(p.script).toBe(`build:${svc.name}-image`);
    }
  });

  it("generates a manifest covering every service in recreate order", async () => {
    const digests = Object.fromEntries(
      MARCH_SERVICES.filter((s) => s.image).map((s) => [s.name, digestFor(s.name)]),
    );
    const m = await buildManifest(repoRoot, { version: "v9.9.9", commit: COMMIT, digests });
    expect(m.schema).toBe(1);
    expect(m.services.map((s) => s.name)).toEqual(MARCH_SERVICES.map((s) => s.name));
    for (const [i, svc] of MARCH_SERVICES.entries()) {
      const entry = m.services[i];
      expect(entry.compose).toBe(svc.compose);
      if (svc.image) {
        expect(entry.localImage).toBe(svc.image);
        expect(entry.image).toBe(
          `ghcr.io/balexda/${imageRepoName(svc.image)}:v9.9.9@${digests[svc.name]}`,
        );
      } else {
        expect(entry).toMatchObject({ image: null, localImage: null });
      }
    }
  });
});

describe("stack-manifest on a fixture checkout", () => {
  it("emits the contract shape", async () => {
    const root = goodFixture();
    const m = await buildManifest(root, {
      version: "v0.2.0",
      commit: COMMIT,
      digests: { castra: digestFor("castra"), legate: digestFor("legate") },
    });
    expect(m).toEqual({
      schema: 1,
      version: "v0.2.0",
      commit: COMMIT,
      services: [
        { name: "otel-lgtm", compose: "otel-lgtm.docker-compose.yml", image: null, localImage: null },
        {
          name: "castra",
          compose: "castra.docker-compose.yml",
          image: `ghcr.io/balexda/march-castra:v0.2.0@${digestFor("castra")}`,
          localImage: "march-castra:latest",
        },
        {
          name: "legate",
          compose: "legate.docker-compose.yml",
          image: `ghcr.io/balexda/march-legate:v0.2.0@${digestFor("legate")}`,
          localImage: "march-legate:latest",
        },
      ],
    });
  });

  it("rejects a compose image: that differs from MARCH_SERVICES", async () => {
    const root = goodFixture();
    fs.writeFileSync(path.join(root, "docker", "legate.docker-compose.yml"), compose("march-legate:dev"));
    await expect(planImages(root)).rejects.toThrow(/does not match/);
  });

  it("rejects a service with no build script", async () => {
    const root = goodFixture();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { "build:castra-image": "x" } }),
    );
    await expect(planImages(root)).rejects.toThrow(/build:legate-image/);
  });

  it("rejects a missing digest, a bad commit and a non-tag version", async () => {
    const root = goodFixture();
    const digests = { castra: digestFor("castra"), legate: digestFor("legate") };
    await expect(
      buildManifest(root, { version: "v0.2.0", commit: COMMIT, digests: { castra: digests.castra } }),
    ).rejects.toThrow(/legate/);
    await expect(buildManifest(root, { version: "v0.2.0", commit: "abc", digests })).rejects.toThrow(/commit/);
    await expect(buildManifest(root, { version: "main", commit: COMMIT, digests })).rejects.toThrow(/version/);
  });

  it("CLI writes the manifest to stdout and fails loudly on errors", () => {
    const root = goodFixture();
    const digestsFile = path.join(root, "digests.json");
    fs.writeFileSync(digestsFile, JSON.stringify({ castra: digestFor("castra"), legate: digestFor("legate") }));
    const ok = spawnSync(
      process.execPath,
      [scriptPath, "manifest", "--root", root, "--version", "v0.2.0", "--commit", COMMIT, "--digests", digestsFile],
      { encoding: "utf8" },
    );
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).services).toHaveLength(3);

    const bad = spawnSync(process.execPath, [scriptPath, "plan"], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--root/);
  });
});
