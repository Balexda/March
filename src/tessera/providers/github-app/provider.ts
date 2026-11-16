/**
 * The github-app credential provider: mints downscoped GitHub App
 * installation tokens for the `app` identity.
 *
 * - Bot identity: derived from GitHub (`GET /app` → slug, `GET /users/<slug>[bot]`
 *   → id), never from configuration. Until it is known, no token is issued —
 *   a token without a commit identity is refused with `provider_unavailable`.
 * - Installation Binding: the configured installation id when set, else
 *   resolved per repository owner. Only successful lookups are remembered; a
 *   binding is dropped when a mint against it reports not-found.
 * - Downscoping: every mint names exactly the one requested repository and
 *   exactly the access profile's permissions ({@link ACCESS_PROFILES}); an
 *   unknown access level is refused before any GitHub call. There is no retry
 *   with a broader scope and no fallback to another identity.
 * - Provider Status follows the data model lifecycle: network/5xx →
 *   `degraded`, next success → `ok`, rejected credential → `invalid` (sticky
 *   until restart in this slice: once invalid, no later failure or success,
 *   including one from a request already in flight, changes `state` or
 *   `last_error`). `last_error` carries the error code only.
 *
 * Tokens are not cached here (Slice 3). Nothing in this module logs.
 */
import type { GitHubAppConfig } from "../../config.js";
import {
  ACCESS_PROFILES,
  CredentialInvalidError,
  ProviderUnavailableError,
  RepoNotInstalledError,
  TesseraError,
  TesseraValidationError,
  type CommitIdentity,
  type CredentialProvider,
  type GitHubPermissions,
  type ProviderIssueRequest,
  type ProviderIssueResult,
  type ProviderState,
  type ProviderStatus,
  type TesseraErrorCode,
} from "../../types.js";
import {
  createAppAssertionSigner,
  type AppAssertionSigner,
  type Clock,
  type KeyFileReader,
} from "./app-assertion.js";
import { GitHubClient } from "./github-client.js";

/** Provider id of the GitHub App provider. */
export const GITHUB_APP_PROVIDER_ID = "github-app" as const;

/** The configured variant of {@link GitHubAppConfig}; the provider is only built when configured. */
export type GitHubAppProviderConfig = Extract<GitHubAppConfig, { readonly configured: true }>;

/** Inputs to {@link createGitHubAppProvider}. */
export interface GitHubAppProviderOptions {
  readonly config: GitHubAppProviderConfig;
  /** GitHub client; defaults to one against the public API. */
  readonly client?: GitHubClient;
  /** Wall clock for the app assertion. */
  readonly now?: Clock;
  /** Key file reader; defaults to reading from disk. */
  readonly readFile?: KeyFileReader;
}

interface BotIdentity {
  readonly login: string;
  readonly commitIdentity: CommitIdentity;
}

const IDENTITY_UNKNOWN_MESSAGE =
  "The GitHub App bot identity could not be derived from GitHub; no token is issued without it.";

function errorCode(error: unknown): TesseraErrorCode {
  return error instanceof TesseraError ? error.code : "internal";
}

function splitRepo(repo: string | undefined): { owner: string; name: string } {
  const [owner, name, ...rest] = (repo ?? "").split("/");
  if (!owner || !name || rest.length > 0) {
    throw new TesseraValidationError('repo is required in owner/name form for identity "app".');
  }
  return { owner, name };
}

/** Build the github-app {@link CredentialProvider}. Never throws; a bad key surfaces as state `invalid`. */
export function createGitHubAppProvider({
  config,
  client = new GitHubClient(),
  now,
  readFile,
}: GitHubAppProviderOptions): CredentialProvider {
  let state: ProviderState = "unconfigured";
  let lastError: TesseraErrorCode | null = null;
  let invalidError: CredentialInvalidError | null = null;
  let signer: AppAssertionSigner | null = null;
  let identity: BotIdentity | null = null;
  let identityLookup: Promise<BotIdentity> | null = null;
  /** Installation Binding per owner; successful lookups only. */
  const bindings = new Map<string, number>();

  function markInvalid(error: CredentialInvalidError): never {
    if (invalidError === null) {
      invalidError = error;
      state = "invalid";
      lastError = error.code;
    }
    throw error;
  }

  function markOk(): void {
    if (invalidError !== null || identity === null) return;
    state = "ok";
    lastError = null;
  }

  /**
   * Record a failed GitHub call per the lifecycle, then rethrow it. Once the
   * provider is invalid, no later failure (e.g. an in-flight request timing out
   * after another got a 401) changes `state` or `last_error` until restart.
   */
  function markFailure(error: unknown): never {
    if (error instanceof CredentialInvalidError) markInvalid(error);
    if (invalidError !== null) throw error;
    if (error instanceof ProviderUnavailableError) {
      state = "degraded";
      lastError = error.code;
    } else if (!(error instanceof RepoNotInstalledError)) {
      lastError = errorCode(error);
    }
    throw error;
  }

  function assertion(): string {
    if (invalidError !== null) throw invalidError;
    if (signer === null) {
      try {
        signer = createAppAssertionSigner({
          appId: config.appId,
          keyFile: config.keyFile,
          ...(now === undefined ? {} : { now }),
          ...(readFile === undefined ? {} : { readFile }),
        });
      } catch (error) {
        if (error instanceof CredentialInvalidError) markInvalid(error);
        throw error;
      }
    }
    return signer();
  }

  async function lookupIdentity(): Promise<BotIdentity> {
    try {
      const app = await client.getApp(assertion());
      const user = await client.getBotUser(app.slug);
      const login = `${app.slug}[bot]`;
      identity = {
        login,
        commitIdentity: { name: login, email: `${user.id}+${login}@users.noreply.github.com` },
      };
      markOk();
      return identity;
    } catch (error) {
      if (error instanceof CredentialInvalidError) markInvalid(error);
      if (invalidError === null) {
        state = "degraded";
        lastError = errorCode(error);
      }
      throw error;
    }
  }

  /** The bot identity, deriving it from GitHub when not yet known (one lookup in flight at a time). */
  async function ensureIdentity(): Promise<BotIdentity> {
    if (invalidError !== null) throw invalidError;
    if (identity !== null) return identity;
    identityLookup ??= lookupIdentity().finally(() => {
      identityLookup = null;
    });
    return identityLookup;
  }

  async function resolveInstallation(owner: string): Promise<number> {
    if (config.installationId !== undefined) return config.installationId;
    const known = bindings.get(owner);
    if (known !== undefined) return known;
    try {
      const installation = await client.getOwnerInstallation(assertion(), owner);
      bindings.set(owner, installation.id);
      markOk();
      return installation.id;
    } catch (error) {
      return markFailure(error);
    }
  }

  return {
    id: GITHUB_APP_PROVIDER_ID,
    identity: "app",

    async start(): Promise<void> {
      try {
        await ensureIdentity();
      } catch {
        // State already reflects the failure; start never throws.
      }
    },

    async issue(req: ProviderIssueRequest): Promise<ProviderIssueResult> {
      const { owner, name } = splitRepo(req.repo);
      const permissions = ACCESS_PROFILES[req.access] as GitHubPermissions | undefined;
      if (permissions === undefined) {
        throw new TesseraValidationError('access must be "read" or "write".');
      }
      if (invalidError !== null) throw invalidError;

      let bot: BotIdentity;
      try {
        bot = await ensureIdentity();
      } catch (error) {
        if (error instanceof CredentialInvalidError || error instanceof ProviderUnavailableError) throw error;
        throw new ProviderUnavailableError(IDENTITY_UNKNOWN_MESSAGE);
      }

      const installationId = await resolveInstallation(owner);
      try {
        const minted = await client.createInstallationToken(assertion(), installationId, {
          repositories: [name],
          permissions,
        });
        markOk();
        return {
          token: minted.token,
          expiresAt: minted.expiresAt,
          identity: bot.login,
          commitIdentity: bot.commitIdentity,
          cache: "miss",
        };
      } catch (error) {
        if (error instanceof RepoNotInstalledError && bindings.get(owner) === installationId) {
          bindings.delete(owner);
        }
        return markFailure(error);
      }
    },

    status(): ProviderStatus {
      return {
        provider: GITHUB_APP_PROVIDER_ID,
        state,
        login: identity?.login ?? null,
        credential_expires_at: null,
        expiry_warning: false,
        last_error: lastError,
      };
    },
  };
}
