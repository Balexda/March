import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_PATTERN } from "./models.js";

/**
 * `march tessera provision` — write everything Tessera and its consumers need
 * under `~/.march/tessera/` (npm-safe: only `~/.march` is read or written):
 *
 *   clients.json        client registrations (`{client, key_sha256}`; digests only)
 *   policy.json         per-client grants over the provisioned repositories
 *   keys/<client>.key   each consumer's raw bearer key (0600; generated once,
 *                       kept on rerun so running services keep authenticating)
 *   github-token        the operator token Tessera vends (from `gh auth token`
 *                       with `--from-gh`; kept on rerun otherwise)
 *
 * The steward key is also written to `~/.march/steward/tessera-client-key`,
 * where `steward-launch` points `MARCH_TESSERA_CLIENT_KEY_FILE`.
 */

/** A Tessera consumer and the grant it needs (from the code paths that call Tessera). */
export interface TesseraClientGrant {
  readonly client: string;
  readonly identities: readonly ("app" | "user")[];
  readonly maxAccess: "read" | "write";
  /** Why it needs the grant (printed, not written). */
  readonly purpose: string;
}

/** Every component that calls Tessera today, and with what access. */
export const TESSERA_CLIENT_GRANTS: readonly TesseraClientGrant[] = [
  { client: "hatchery", identities: ["app"], maxAccess: "read", purpose: "spawn base pinning + collision checks (src/hatchery/github-read.ts)" },
  { client: "legate", identities: ["app", "user"], maxAccess: "write", purpose: "merges, PR labels, CI reruns (app/write) + Copilot review request (user/write)" },
  { client: "herald", identities: ["app"], maxAccess: "read", purpose: "PR observation + default-branch sync (src/observe/github-read.ts)" },
  { client: "brood", identities: ["app"], maxAccess: "read", purpose: "steward-removal PR gate (src/brood/service/steward-removal.ts)" },
  { client: "statio", identities: ["app"], maxAccess: "read", purpose: "forge gateway reads (src/statio/forge.ts)" },
  { client: "steward", identities: ["app"], maxAccess: "write", purpose: "steward git push / gh via `march tessera token` (steward-launch)" },
];

const KEY_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;

export interface ProvisionOptions {
  /** Repositories (`owner/name` or `owner/*`) the app grants cover. Non-empty. */
  readonly repos: readonly string[];
  /** Write `github-token` from this token (e.g. `gh auth token`); undefined keeps the existing one. */
  readonly githubToken?: string;
  /** HOME whose `.march` is written (defaults to os.homedir()). */
  readonly home?: string;
  /** Key generator (tests). */
  readonly generateKey?: () => string;
}

export interface ProvisionResult {
  readonly dir: string;
  readonly clients: { client: string; keyPath: string; created: boolean }[];
  readonly repos: string[];
  readonly githubToken: "written" | "kept" | "missing";
  readonly stewardKeyPath: string;
}

export class TesseraProvisionError extends Error {}

/** Write `contents` to `file` atomically with mode 0600. */
function writePrivate(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function readKey(file: string): string | undefined {
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    return KEY_PATTERN.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Normalize + validate the repository list (dedup, lowercase). */
export function normalizeRepos(repos: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of repos) {
    const repo = raw.trim();
    if (!repo) continue;
    if (!REPO_PATTERN.test(repo) && !/^[A-Za-z0-9_.-]+\/\*$/.test(repo)) {
      throw new TesseraProvisionError(`Invalid repository "${repo}": expected owner/name or owner/*.`);
    }
    out.add(repo.toLowerCase());
  }
  return [...out].sort();
}

/** Write the Tessera configuration. Idempotent: keys are generated once. */
export function provisionTessera(opts: ProvisionOptions): ProvisionResult {
  const repos = normalizeRepos(opts.repos);
  if (repos.length === 0) throw new TesseraProvisionError("No repositories to grant: pass --repos owner/name[,owner/name…].");
  const home = opts.home ?? os.homedir();
  const dir = path.join(home, ".march", "tessera");
  const keysDir = path.join(dir, "keys");
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(keysDir, 0o700);
  const generate = opts.generateKey ?? (() => randomBytes(32).toString("hex"));

  const clients: ProvisionResult["clients"] = [];
  const registrations: { client: string; key_sha256: string }[] = [];
  const keys = new Map<string, string>();
  for (const grant of TESSERA_CLIENT_GRANTS) {
    const keyPath = path.join(keysDir, `${grant.client}.key`);
    let key = readKey(keyPath);
    const created = !key;
    if (!key) {
      key = generate();
      if (!KEY_PATTERN.test(key)) throw new TesseraProvisionError("Generated key has an invalid shape.");
      writePrivate(keyPath, key);
    } else {
      fs.chmodSync(keyPath, 0o600);
    }
    keys.set(grant.client, key);
    clients.push({ client: grant.client, keyPath, created });
    registrations.push({ client: grant.client, key_sha256: createHash("sha256").update(key).digest("hex") });
  }
  writePrivate(path.join(dir, "clients.json"), JSON.stringify(registrations, null, 2) + "\n");
  const policy = TESSERA_CLIENT_GRANTS.map((grant) => ({
    client: grant.client,
    identities: [...grant.identities],
    repos,
    max_access: grant.maxAccess,
  }));
  writePrivate(path.join(dir, "policy.json"), JSON.stringify(policy, null, 2) + "\n");

  // steward-launch reads its key from the steward root (~/.march/steward).
  const stewardDir = path.join(home, ".march", "steward");
  fs.mkdirSync(stewardDir, { recursive: true });
  const stewardKeyPath = path.join(stewardDir, "tessera-client-key");
  writePrivate(stewardKeyPath, keys.get("steward")!);

  const tokenPath = path.join(dir, "github-token");
  let githubToken: ProvisionResult["githubToken"];
  if (opts.githubToken !== undefined) {
    const token = opts.githubToken.trim();
    if (!token || /[\s\0]/.test(token)) throw new TesseraProvisionError("The GitHub token is empty or malformed.");
    writePrivate(tokenPath, token + "\n");
    githubToken = "written";
  } else if (fs.existsSync(tokenPath)) {
    fs.chmodSync(tokenPath, 0o600);
    githubToken = "kept";
  } else {
    githubToken = "missing";
  }
  return { dir, clients, repos, githubToken, stewardKeyPath };
}

/** `gh auth token` — the operator's current GitHub token. */
export function ghAuthToken(): string {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();
  } catch {
    throw new TesseraProvisionError("`gh auth token` failed: log in with `gh auth login`, or omit --from-gh.");
  }
}
