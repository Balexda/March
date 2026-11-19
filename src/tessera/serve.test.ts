/** @l1 @deterministic @ci */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../dist/cli.js");
const keys = "TESSERA_CLIENT_KEYS_FILE";
const policy = "TESSERA_POLICY_FILE";
const registration = { client: "herald", key_sha256: "a".repeat(64) };
const rule = { client: "herald", identities: ["app"], repos: ["acme/widgets"], max_access: "read" };
const invalidFiles = [
  ...[keys, policy].flatMap(variable => [
    { variable, reason: "is required", input: undefined },
    { variable, reason: "Unable to read", input: null },
    { variable, reason: "non-empty JSON array", input: "" },
    { variable, reason: "non-empty JSON array", input: "[]" },
    { variable, reason: "non-empty JSON array", input: "PRIVATE_CONTENT" },
  ]),
  { variable: keys, reason: "invalid client or digest", input: JSON.stringify([{ ...registration, client: "Herald" }]) },
  { variable: keys, reason: "invalid client or digest", input: JSON.stringify([{ ...registration, key_sha256: "A".repeat(64) }]) },
  { variable: keys, reason: "repeats a client or digest", input: JSON.stringify([registration, { ...registration, key_sha256: "b".repeat(64) }]) },
  { variable: keys, reason: "repeats a client or digest", input: JSON.stringify([registration, { ...registration, client: "brood" }]) },
  { variable: policy, reason: "invalid policy rule", input: JSON.stringify([{ ...rule, repos: ["*"] }]) },
  { variable: policy, reason: "invalid policy rule", input: JSON.stringify([{ ...rule, repos: undefined }]) },
  { variable: policy, reason: "invalid policy rule", input: JSON.stringify([{ ...rule, max_access: "admin" }]) },
  { variable: policy, reason: "unregistered client", input: JSON.stringify([{ ...rule, client: "brood" }]) },
  { variable: policy, reason: "other than legate", input: JSON.stringify([{ ...rule, identities: ["app", "user"] }]) },
];

it.each(invalidFiles)("exits before listening when $variable reports $reason", async ({ variable, reason, input }) => {
  const directory = await mkdtemp(join(tmpdir(), "tessera-serve-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, MARCH_OTEL: "0", MARCH_TESSERA_LOG_DIR: directory };
    const files = { [keys]: JSON.stringify([registration]), [policy]: JSON.stringify([rule]), [variable]: input };
    for (const [name, contents] of Object.entries(files)) {
      const path = join(directory, name);
      if (contents === undefined) delete env[name];
      else env[name] = path;
      if (typeof contents === "string") await writeFile(path, contents);
    }
    // If startup reaches provider configuration first, it fails for the wrong reason.
    env.TESSERA_GITHUB_INSTALLATION_ID = "invalid";
    const result = await run(process.execPath, [cli, "tessera", "serve"], { env, timeout: 3000 }).catch(error => error);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(variable);
    expect(result.stderr).toContain(reason);
    for (const secret of [directory, "PRIVATE_CONTENT", registration.key_sha256]) {
      expect(result.stderr).not.toContain(secret);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
