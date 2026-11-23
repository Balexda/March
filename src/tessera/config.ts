import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
/** Tessera's service identity and contracted default port. */
export const TESSERA_SERVICE_NAME = "march-tessera";
export const TESSERA_PORT_ENV = "MARCH_TESSERA_PORT";
export const TESSERA_DEFAULT_PORT = 9477;

export class TesseraConfigError extends Error {}

export function resolveTesseraPort(
  override?: number | string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = override ?? env[TESSERA_PORT_ENV];
  if (raw === undefined || raw === "") return TESSERA_DEFAULT_PORT;
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TesseraConfigError("Invalid Tessera port: expected an integer in 1..65535.");
  }
  return value;
}

/** US3 owns secret provisioning and path policy; never expose filesystem errors. */
export async function loadTesseraAppConfig(env: NodeJS.ProcessEnv = process.env): Promise<{
  appId?: string; privateKey?: string; installationId?: number;
}> {
  const appId = env.TESSERA_GITHUB_APP_ID?.trim() || undefined;
  const rawInstallation = env.TESSERA_GITHUB_INSTALLATION_ID?.trim();
  let installationId: number | undefined;
  if (rawInstallation) {
    installationId = Number(rawInstallation);
    if (!/^\d+$/.test(rawInstallation) || !Number.isSafeInteger(installationId) || installationId < 1) {
      throw new TesseraConfigError("Invalid Tessera GitHub installation id: expected a positive integer.");
    }
  }
  const keyFile = env.TESSERA_GITHUB_APP_KEY_FILE?.trim();
  let privateKey: string | undefined;
  if (keyFile) {
    try {
      const { readFile } = await import("node:fs/promises");
      privateKey = (await readFile(keyFile, "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new TesseraConfigError("Unable to read Tessera GitHub App key file.");
      }
    }
  }
  return { appId, privateKey, installationId };
}

function plaintextHostAllowed(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !host.includes(".") && !host.includes(":");
}
/** Env var naming a file that holds the client key (takes precedence over MARCH_TESSERA_CLIENT_KEY). */
export const TESSERA_CLIENT_KEY_FILE_ENV = "MARCH_TESSERA_CLIENT_KEY_FILE";

/**
 * Read a client-key file synchronously with the same rules as the token CLI:
 * a regular file owned by this process's user, mode 0600, at most 4 KiB.
 * Returns undefined (unconfigured — fail closed) on any violation.
 */
export function readClientKeyFileSync(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return undefined;
    const buffer = Buffer.alloc(4097);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) return undefined;
    return buffer.toString("utf8", 0, bytes).trim() || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The configured client key: the key file when named, else the env key. */
export function configuredClientKey(env: NodeJS.ProcessEnv): string | undefined {
  const file = env[TESSERA_CLIENT_KEY_FILE_ENV]?.trim();
  if (file) return readClientKeyFileSync(file);
  return env.MARCH_TESSERA_CLIENT_KEY;
}

/** No default endpoint or key: incomplete consumer wiring must fail closed. */
export function resolveTesseraConfig(options: {
  baseUrl?: string; clientKey?: string; env?: NodeJS.ProcessEnv;
}): { baseUrl: string; clientKey: string } | undefined {
  const env = options.env ?? process.env;
  // Trim before validating so the key sent in the auth header is exactly what was checked.
  const baseUrl = (options.baseUrl ?? env.MARCH_TESSERA_URL)?.trim();
  const clientKey = (options.clientKey ?? configuredClientKey(env))?.trim();
  if (!baseUrl || !clientKey || /[\r\n]/.test(clientKey)) return;
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    // The bearer key must not cross an untrusted network in cleartext: plain http is
    // limited to loopback, single-label compose service names and private IPv4 literals.
    if (url.protocol === "http:" && !plaintextHostAllowed(url.hostname)) return;
    return { baseUrl: url.href.replace(/\/+$/, ""), clientKey };
  } catch { return; }
}
