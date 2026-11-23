import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TesseraConfigError } from "./config.js";
import { REPO_PATTERN, TesseraError, type AuthorizationBoundary } from "./models.js";

const CLIENT_KEYS_FILE = "TESSERA_CLIENT_KEYS_FILE";
const POLICY_FILE = "TESSERA_POLICY_FILE";
const OWNER_WILDCARD = /^[A-Za-z0-9_.-]+\/\*$/;

function record(value: unknown, fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => fields.includes(key));
}

async function readRows(variable: string, env: NodeJS.ProcessEnv): Promise<unknown[]> {
  const path = env[variable]?.trim();
  if (!path) throw new TesseraConfigError(`${variable} is required.`);
  let contents: string;
  try {
    // Opening nonblocking lets a mistakenly configured FIFO fail the regular-file check.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Expected a regular file");
      contents = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw new TesseraConfigError(`Unable to read ${variable} as a regular file.`);
  }
  let rows: unknown;
  try {
    rows = JSON.parse(contents);
  } catch {
    throw new TesseraConfigError(`${variable} must contain a non-empty JSON array.`);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TesseraConfigError(`${variable} must contain a non-empty JSON array.`);
  }
  return rows;
}

export async function loadTesseraAuthorization(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorizationBoundary> {
  const clients = new Map<string, Buffer>();
  const digests = new Set<string>();
  for (const [index, row] of (await readRows(CLIENT_KEYS_FILE, env)).entries()) {
    if (!record(row, ["client", "key_sha256"]) ||
      typeof row.client !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(row.client) ||
      typeof row.key_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.key_sha256)) {
      throw new TesseraConfigError(`${CLIENT_KEYS_FILE} row ${index + 1} has an invalid client or digest.`);
    }
    if (clients.has(row.client) || digests.has(row.key_sha256)) {
      throw new TesseraConfigError(`${CLIENT_KEYS_FILE} row ${index + 1} repeats a client or digest.`);
    }
    clients.set(row.client, Buffer.from(row.key_sha256, "hex"));
    digests.add(row.key_sha256);
  }

  const rules = new Map<string, { identities: string[]; repos: Set<string>; maxAccess: "read" | "write" }[]>();
  for (const [index, row] of (await readRows(POLICY_FILE, env)).entries()) {
    const location = `${POLICY_FILE} row ${index + 1}`;
    if (!record(row, ["client", "identities", "repos", "max_access"]) ||
      typeof row.client !== "string" || !Array.isArray(row.identities) || row.identities.length === 0 ||
      !row.identities.every(identity => identity === "app" || identity === "user") ||
      (row.max_access !== "read" && row.max_access !== "write") ||
      (row.identities.includes("app") && row.repos === undefined) ||
      (row.repos !== undefined && (!Array.isArray(row.repos) || !row.repos.every(
        repo => typeof repo === "string" && (REPO_PATTERN.test(repo) || OWNER_WILDCARD.test(repo)),
      )))) {
      throw new TesseraConfigError(`${location} has an invalid policy rule.`);
    }
    if (!clients.has(row.client)) throw new TesseraConfigError(`${location} names an unregistered client.`);
    if (row.client !== "legate" && row.identities.includes("user")) {
      throw new TesseraConfigError(`${location} grants user identity to a client other than legate.`);
    }
    const grants = rules.get(row.client) ?? [];
    grants.push({
      identities: row.identities,
      repos: new Set((row.repos ?? []).map((repo: string) => repo.toLowerCase())),
      maxAccess: row.max_access,
    });
    rules.set(row.client, grants);
  }

  return {
    authenticate(authorization) {
      const key = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization ?? "")?.[1];
      if (!key) throw new TesseraError("unauthorized");
      const digest = createHash("sha256").update(key).digest();
      let caller: string | undefined;
      for (const [client, registered] of clients) {
        if (timingSafeEqual(digest, registered)) caller = client;
      }
      if (!caller) throw new TesseraError("unauthorized");
      return caller;
    },
    authorize(caller, request) {
      const repo = request.repo?.toLowerCase();
      const allowed = rules.get(caller)?.some(rule => {
        if (!rule.identities.includes(request.identity)) return false;
        if (request.identity === "user") return caller === "legate";
        return repo !== undefined && (request.access === "read" || rule.maxAccess === "write") &&
          (rule.repos.has(repo) || rule.repos.has(`${repo.split("/")[0]}/*`));
      });
      if (!allowed) throw new TesseraError("policy_denied");
    },
    grants(caller) {
      return (rules.get(caller) ?? []).flatMap(rule => rule.identities.map(identity => ({
        identity: identity as "app" | "user",
        access: rule.maxAccess,
        repos: identity === "app" ? [...rule.repos].sort() : [],
      })));
    },
  };
}
