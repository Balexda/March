/**
 * `march tessera token` (contracts "CLI"): print a bot token for one
 * repository and access level, and nothing else, on stdout.
 *
 * It calls {@link TesseraClient.issueGitHubToken} directly — never
 * `getGitHubToken` — so the migration fallback cannot apply and
 * `MARCH_TESSERA_GH_TOKEN_FALLBACK`, `GH_TOKEN` and `GITHUB_TOKEN` are never
 * read. Only the `app` identity is offered. Failures are one fixed-text line on
 * stderr: no server message, token or client key is ever echoed.
 */
import { ERROR, SUCCESS, USAGE_ERROR } from "../shared/exit-codes.js";
import { TesseraClient, TesseraClientError, type TesseraClientErrorCode } from "./client.js";
import { TESSERA_CLIENT_KEY_ENV, TESSERA_PORT_ENV } from "./config.js";
import { isValidRepo } from "./repo-name.js";

const PREFIX = "march tessera token: ";

export interface RunTesseraTokenCommandOptions {
  /** `--repo`, `owner/name`. */
  readonly repo?: string;
  /** `--access`, `read` or `write`. */
  readonly access?: string;
  /** `--identity`; only `app` is accepted. */
  readonly identity?: string;
  /** Settings for the default client; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** `fetch` for the default client (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Use this client instead of one built from `env`. */
  readonly client?: TesseraClient;
  /** Defaults to `process.stdout.write`. Receives only the token line. */
  readonly stdout?: (text: string) => void;
  /** Defaults to `process.stderr.write`. */
  readonly stderr?: (text: string) => void;
}

/** Fixed, leak-free text per client error code. */
const FAILURE_TEXT: Readonly<Record<TesseraClientErrorCode, string>> = {
  unauthorized: "Tessera refused this process's client key",
  policy_denied: "Tessera's policy does not allow this client that repository and access level",
  invalid_request: "the request or the Tessera client settings are invalid",
  repo_not_installed: "the GitHub App is not installed on that repository",
  provider_unconfigured: "Tessera has no GitHub App configured",
  credential_invalid: "Tessera's GitHub App credential was rejected by GitHub",
  provider_unavailable: "GitHub is unavailable to Tessera",
  mint_failed: "Tessera could not mint a token",
  internal: "Tessera hit an internal error",
  unreachable: "Tessera could not be reached or gave an invalid answer",
  client_key_missing: `no Tessera client key is configured; set ${TESSERA_CLIENT_KEY_ENV}`,
};

/** The one stderr line (without the newline) for a client error. */
export function tokenFailureMessage(err: TesseraClientError): string {
  let text = FAILURE_TEXT[err.code] ?? "Tessera could not issue a token";
  if (err.code === "invalid_request" && err.status === undefined) {
    text = `the request or a Tessera client setting such as ${TESSERA_PORT_ENV} is invalid`;
  }
  const retry =
    err.code === "provider_unavailable" && err.retryAfterSeconds !== undefined
      ? `, retry after ${err.retryAfterSeconds}s`
      : "";
  return `${PREFIX}${text} (${err.code}${retry})`;
}

function usageProblem(options: RunTesseraTokenCommandOptions): string | undefined {
  const { repo, access, identity } = options;
  if (typeof repo !== "string" || repo === "") return "--repo <owner/name> is required";
  if (!isValidRepo(repo)) return "--repo must be in owner/name form";
  if (access === undefined || access === "") return "--access <read|write> is required";
  if (access !== "read" && access !== "write") return '--access must be "read" or "write"';
  if (identity !== undefined && identity !== "app") return '--identity accepts only "app"';
  return undefined;
}

/**
 * Run `march tessera token`. Returns the exit status: SUCCESS with
 * `<token>\n` on stdout; USAGE_ERROR for bad flags (before any request);
 * ERROR for any Tessera failure. Nothing reaches stdout on failure.
 */
export async function runTesseraTokenCommand(
  options: RunTesseraTokenCommandOptions,
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));

  const problem = usageProblem(options);
  if (problem !== undefined) {
    stderr(`${PREFIX}${problem}\n`);
    return USAGE_ERROR;
  }

  const client =
    options.client ??
    new TesseraClient({
      env: options.env ?? process.env,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });

  try {
    const entitlement = await client.issueGitHubToken({
      identity: "app",
      repo: options.repo as string,
      access: options.access as "read" | "write",
    });
    stdout(`${entitlement.token}\n`);
    return SUCCESS;
  } catch (err) {
    if (err instanceof TesseraClientError) {
      stderr(`${tokenFailureMessage(err)}\n`);
    } else {
      stderr(`${PREFIX}an unexpected error occurred while requesting a token\n`);
    }
    return ERROR;
  }
}
