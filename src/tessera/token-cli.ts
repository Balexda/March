import { ERROR, SUCCESS, USAGE_ERROR } from "../shared/exit-codes.js";
import { TesseraClient, TesseraClientError } from "./client.js";
import { REPO_PATTERN } from "./models.js";

export function writeTesseraTokenUsageError(): void {
  process.stderr.write("Usage: march tessera token --repo <owner/name> --access <read|write> [--identity app]\n");
}

export async function issueTesseraCliToken(opts: {
  repo: string;
  access: "read" | "write";
  identity: "app";
}): Promise<string> {
  // Both credential-printing commands require Tessera, even during migration.
  const client = new TesseraClient({
    env: {
      MARCH_TESSERA_URL: process.env.MARCH_TESSERA_URL,
      MARCH_TESSERA_CLIENT_KEY: process.env.MARCH_TESSERA_CLIENT_KEY,
    },
  });
  const { token } = await client.issueGitHubToken(opts);
  if (/[\s\x00-\x1f\x7f]/.test(token)) throw new TesseraClientError("invalid_response");
  return token;
}

export async function runTesseraToken(opts: {
  repo: string;
  access: string;
  identity: string;
}): Promise<number> {
  const { repo, access, identity } = opts;
  if (!REPO_PATTERN.test(repo) || /\s/.test(repo) ||
      (access !== "read" && access !== "write") || identity !== "app") {
    writeTesseraTokenUsageError();
    return USAGE_ERROR;
  }

  try {
    const token = await issueTesseraCliToken({ repo, access, identity });
    process.stdout.write(token + "\n");
    return SUCCESS;
  } catch (error) {
    const code = error instanceof TesseraClientError ? error.code : "invalid_response";
    process.stderr.write(`Tessera token request failed (${code}).\n`);
    return ERROR;
  }
}
