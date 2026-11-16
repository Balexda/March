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

/** No default endpoint or key: incomplete consumer wiring must fail closed. */
export function resolveTesseraConfig(options: {
  baseUrl?: string; clientKey?: string; env?: NodeJS.ProcessEnv;
}): { baseUrl: string; clientKey: string } | undefined {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? env.MARCH_TESSERA_URL;
  const clientKey = options.clientKey ?? env.MARCH_TESSERA_CLIENT_KEY;
  if (!baseUrl?.trim() || !clientKey?.trim() || /[\r\n]/.test(clientKey)) return;
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    return { baseUrl: url.href.replace(/\/+$/, ""), clientKey };
  } catch { return; }
}
