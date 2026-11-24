/** @l1 @deterministic @ci */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTesseraProbes } from "./tessera-probes.js";

const exec = promisify(execFile);

it("probes the deployed key in the consumer and returns only bounded verdicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "march-doctor-"));
  const keyFile = join(dir, "key");
  const secret = "sentinel-client-key";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/healthz") return response.end();
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.statusCode = 401;
    }
    response.end(JSON.stringify({ client: "hatchery", grants: [], extra: secret }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const env = {
      MARCH_TESSERA_PORT: String(port),
      MARCH_TESSERA_URL: `http://127.0.0.1:${port}`,
      MARCH_TESSERA_CLIENT_KEY_FILE: keyFile,
      MARCH_TESSERA_CLIENT_KEY: "ignored-env-key",
    };
    const probes = createTesseraProbes(env, async ([command, ...args]) => {
      if (command === "inspect") {
        expect(args[1]).toContain('split . "="');
        return args.at(-1) === "march-castra" ? "GH_TOKEN\nGITHUB_TOKEN" : null;
      }
      expect(command).toBe("exec");
      const [container, bin, ...nodeArgs] = args;
      expect(container).toBe(`march-${nodeArgs.at(-1)}`);
      expect(bin).toBe("node");
      if (container === "march-statio") return null;
      expect(nodeArgs.join(" ")).not.toContain(secret);
      const { stdout } = await exec(process.execPath, nodeArgs, { env, timeout: 3_000 });
      return stdout.trim();
    });
    expect(await probes.reachable()).toBe(true);
    expect(await probes.key("hatchery")).toBe("missing");
    await writeFile(keyFile, secret, { mode: 0o600 });
    expect(await probes.key("hatchery")).toBe("accepted");
    expect(await probes.key("herald")).toBe("rejected");
    await writeFile(keyFile, "stale-key");
    expect(await probes.key("hatchery")).toBe("rejected");
    expect(await probes.key("statio")).toBe("unverifiable");
    expect(await probes.ambient("castra")).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
    expect(await probes.ambient("statio")).toBeNull();
    expect(requests).toEqual(["GET /healthz", "GET /v1/client", "GET /v1/client", "GET /v1/client"]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("bounds liveness and treats unavailable HTTP as unreachable", async () => {
  const probes = createTesseraProbes({}, async () => null, async (_, options) => {
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    throw new Error("sentinel upstream error");
  });
  expect(await probes.reachable()).toBe(false);
  expect(await probes.key("hatchery")).toBe("unverifiable");
});

it("accepts the same plaintext hosts as the production client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "march-doctor-"));
  const keyFile = join(dir, "key");
  await writeFile(keyFile, "k", { mode: 0o600 });
  const verdicts: string[] = [];
  try {
    for (const url of ["http://march_tessera:1", "http://tessera.example.com:1"]) {
      const env = { MARCH_TESSERA_URL: url, MARCH_TESSERA_CLIENT_KEY_FILE: keyFile };
      const probes = createTesseraProbes(env, async ([, , , ...nodeArgs]) => {
        // Stub fetch so only the host check decides: allowed hosts reach the server and get accepted.
        const script = `globalThis.fetch = async () => new Response(JSON.stringify({ client: "hatchery", grants: [] }));` + nodeArgs[1];
        const { stdout } = await exec(process.execPath, ["-e", script, ...nodeArgs.slice(2)], { env, timeout: 3_000 });
        return stdout.trim();
      });
      verdicts.push(await probes.key("hatchery"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(verdicts).toEqual(["accepted", "unverifiable"]);
});
