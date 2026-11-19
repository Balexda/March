import { ERROR, SUCCESS, USAGE_ERROR } from "../shared/exit-codes.js";
import { TesseraClient, TesseraClientError } from "./client.js";
import { REPO_PATTERN } from "./models.js";

export function writeTesseraTokenUsageError(): void {
  process.stderr.write("Usage: march tessera token --repo <owner/name> --access <read|write> [--identity app]\n");
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

  // Limit this credential-printing command to Tessera configuration.
  const client = new TesseraClient({
    env: {
      MARCH_TESSERA_URL: process.env.MARCH_TESSERA_URL,
      MARCH_TESSERA_CLIENT_KEY: process.env.MARCH_TESSERA_CLIENT_KEY,
    },
  });
  try {
    const { token } = await client.issueGitHubToken({ repo, access, identity });
    if (/\s/.test(token)) throw new TesseraClientError("invalid_response");
    process.stdout.write(token + "\n");
    return SUCCESS;
  } catch (error) {
    const code = error instanceof TesseraClientError ? error.code : "invalid_response";
    process.stderr.write(`Tessera token request failed (${code}).\n`);
    return ERROR;
  }
}
