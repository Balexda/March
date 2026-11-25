#!/usr/bin/env node
/**
 * Plan and generate the `march-stack.json` release asset (issue #438).
 *
 * The release publishes one GHCR image per `MARCH_SERVICES` entry that has an
 * `image`, and attaches `march-stack.json` so a host updater can install the
 * release by pulling those images instead of building on the host. The
 * manifest shape is the engine ⇄ updater contract (schema 1):
 *
 *   { schema: 1, version, commit,
 *     services: [{ name, compose, image: "<repo>:<tag>@sha256:…" | null,
 *                  localImage: "<compose image:>" | null }] }
 *
 * `services` keeps `MARCH_SERVICES` order (the order `march upgrade` walks).
 *
 * The services are read from `<root>/src/stack/services.ts`, where `<root>` is
 * any checkout — including an older tag whose tree predates this script — so
 * the release-images workflow runs this file from the current code against the
 * tag being published (backfill). The TS module is transpiled with the
 * `typescript` package resolved from *this* script's checkout.
 *
 * Usage:
 *   node scripts/stack-manifest.mjs plan --root <dir> [--registry ghcr.io/balexda]
 *     → JSON array of the images to build: [{ name, script, localImage, repo }]
 *   node scripts/stack-manifest.mjs manifest --root <dir> --version <tag>
 *        --commit <sha> --digests <file.json> [--registry ghcr.io/balexda]
 *     → march-stack.json on stdout; <file.json> maps service name → sha256 digest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST_SCHEMA = 1;
export const DEFAULT_REGISTRY = "ghcr.io/balexda";

const require = createRequire(import.meta.url);

/** Load `MARCH_SERVICES` from `<root>/src/stack/services.ts`. */
export async function loadServices(root) {
  const file = path.join(root, "src", "stack", "services.ts");
  const source = fs.readFileSync(file, "utf8");
  const ts = require("typescript");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "march-stack-"));
  try {
    const out = path.join(tmp, "services.mjs");
    fs.writeFileSync(out, outputText);
    const mod = await import(pathToFileURL(out).href);
    if (!Array.isArray(mod.MARCH_SERVICES)) {
      throw new Error(`${file} does not export a MARCH_SERVICES array`);
    }
    return mod.MARCH_SERVICES.map((s) => ({ ...s }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The `image:` values in a compose file. */
export function composeImages(root, compose) {
  const file = path.join(root, "docker", compose);
  const text = fs.readFileSync(file, "utf8");
  const images = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+image:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/.exec(line);
    if (m) images.push(m[1]);
  }
  return images;
}

/** `march-castra:latest` → `march-castra`. */
export function imageRepoName(localImage) {
  const slash = localImage.lastIndexOf("/");
  const colon = localImage.lastIndexOf(":");
  return colon > slash ? localImage.slice(0, colon) : localImage;
}

/**
 * Validate the stack at `root` and list the images to publish, in stack order.
 * Throws when a service's compose file does not reference exactly its `image`
 * (the updater retags pulled images to that name) or when the npm
 * `build:<name>-image` script that builds it is missing.
 */
export async function planImages(root, { registry = DEFAULT_REGISTRY } = {}) {
  const services = await loadServices(root);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const scripts = pkg.scripts ?? {};
  const plan = [];
  for (const svc of services) {
    if (typeof svc.name !== "string" || typeof svc.compose !== "string") {
      throw new Error(`MARCH_SERVICES entry missing name/compose: ${JSON.stringify(svc)}`);
    }
    if (!svc.image) continue;
    const images = composeImages(root, svc.compose);
    if (images.length !== 1 || images[0] !== svc.image) {
      throw new Error(
        `docker/${svc.compose} image: ${JSON.stringify(images)} does not match ` +
          `MARCH_SERVICES ${svc.name}.image ${svc.image}`,
      );
    }
    const script = `build:${svc.name}-image`;
    if (!scripts[script]) {
      throw new Error(`package.json has no "${script}" script for ${svc.name}`);
    }
    plan.push({
      name: svc.name,
      script,
      localImage: svc.image,
      repo: `${registry}/${imageRepoName(svc.image)}`,
    });
  }
  return plan;
}

/** Build the schema-1 `march-stack.json` object. */
export async function buildManifest(
  root,
  { version, commit, digests, registry = DEFAULT_REGISTRY },
) {
  if (!/^v\d+\.\d+\.\d+/.test(version ?? "")) {
    throw new Error(`version must be a release tag like v1.2.3, got ${version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new Error(`commit must be a 40-hex sha, got ${commit}`);
  }
  const services = await loadServices(root);
  const planned = new Map(
    (await planImages(root, { registry })).map((p) => [p.name, p]),
  );
  return {
    schema: MANIFEST_SCHEMA,
    version,
    commit,
    services: services.map((svc) => {
      const p = planned.get(svc.name);
      if (!p) {
        return { name: svc.name, compose: svc.compose, image: null, localImage: null };
      }
      const digest = digests?.[svc.name];
      if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
        throw new Error(`no valid sha256 digest for ${svc.name}: ${digest}`);
      }
      return {
        name: svc.name,
        compose: svc.compose,
        image: `${p.repo}:${version}@${digest}`,
        localImage: p.localImage,
      };
    }),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key?.startsWith("--") || rest[i + 1] === undefined) {
      throw new Error(`bad argument: ${key}`);
    }
    opts[key.slice(2)] = rest[i + 1];
  }
  return { command, opts };
}

async function main(argv) {
  const { command, opts } = parseArgs(argv);
  if (!opts.root) throw new Error("--root <dir> is required");
  const root = path.resolve(opts.root);
  const registry = opts.registry ?? DEFAULT_REGISTRY;
  if (command === "plan") {
    return planImages(root, { registry });
  }
  if (command === "manifest") {
    if (!opts.digests) throw new Error("--digests <file.json> is required");
    const digests = JSON.parse(fs.readFileSync(opts.digests, "utf8"));
    return buildManifest(root, {
      version: opts.version,
      commit: opts.commit,
      digests,
      registry,
    });
  }
  throw new Error(`unknown command: ${command} (expected plan | manifest)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => process.stdout.write(`${JSON.stringify(out, null, 2)}\n`),
    (err) => {
      process.stderr.write(`stack-manifest: ${err.message}\n`);
      process.exit(1);
    },
  );
}
