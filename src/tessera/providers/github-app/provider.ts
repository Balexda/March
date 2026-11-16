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
 * - Token cache ({@link createTokenCache}): keyed by (installation id, sorted
 *   repositories, access level). A request with strictly more than ten minutes
 *   of life left on its entry is served from the cache (`cache: "hit"`) with
 *   no GitHub call; otherwise a new token is minted, stored and returned
 *   (`cache: "miss"`). `refresh: true` evicts the entry first. Failed mints are
 *   not cached. When the provider goes `invalid` the whole cache is cleared.
 * - Coalescing: at most one mint is in flight per cache key. Concurrent
 *   requests for the same key await that one mint and receive the same token
 *   (or the same error); every one of them reports `cache: "miss"`, since no
 *   cached token existed when it arrived. The in-flight entry is removed when
 *   the mint settles, success or failure, so a failed mint is never retained
 *   and the next request mints again. Requests for different keys never wait
 *   on each other. A `refresh: true` request joins a mint already in flight for
 *   its key (that token is minted no earlier than the request arrived, so it is
 *   as new as a refresh would produce); only with nothing in flight does it
 *   evict the entry and mint. Concurrent first lookups of the same owner's
 *   installation are coalesced the same way.
 * - Outages (cache lifecycle transition 4, `stale` → `stale`): when a re-mint
 *   fails with `provider_unavailable` and the entry for that key is still
 *   unexpired at that moment, the cached token is served instead
 *   (`cache: "hit"`) and the provider goes `degraded` with `last_error`
 *   `provider_unavailable`; every joiner of that shared mint gets it too. Only
 *   `provider_unavailable` is masked: `repo_not_installed`,
 *   `credential_invalid` and `mint_failed` always propagate. An expired token
 *   is never served, nothing is served once the provider is `invalid`, and a
 *   `refresh: true` request never receives a cached token (it evicted the
 *   entry, or it joined a mint and asked for a new token), so it gets
 *   `provider_unavailable`. The key must be known without GitHub: the bot
 *   identity is never forgotten once derived, and the installation id comes
 *   from the override or a remembered binding; when the binding has to be
 *   looked up and that lookup fails, the error propagates. A token is never
 *   served for a different key.
 *
 * Nothing in this module logs, and nothing is written to disk.
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
import {
  createTokenCache,
  tokenCacheKeyId,
  type CachedInstallationToken,
  type TokenCacheKey,
} from "./token-cache.js";

/** Provider id of the GitHub App provider. */
export const GITHUB_APP_PROVIDER_ID = "github-app" as const;

/** The configured variant of {@link GitHubAppConfig}; the provider is only built when configured. */
export type GitHubAppProviderConfig = Extract<GitHubAppConfig, { readonly configured: true }>;

/** Inputs to {@link createGitHubAppProvider}. */
export interface GitHubAppProviderOptions {
  readonly config: GitHubAppProviderConfig;
  /** GitHub client; defaults to one against the public API. */
  readonly client?: GitHubClient;
  /** Wall clock (epoch ms) for the app assertion and the token cache. */
  readonly now?: Clock;
  /** Key file reader; defaults to reading from disk. */
  readonly readFile?: KeyFileReader;
}

/** The github-app provider: a {@link CredentialProvider} that owns a token cache. */
export interface GitHubAppProvider extends CredentialProvider {
  /** Number of unexpired cached installation tokens. */
  cacheEntries(): number;
  /** Drop every cached token (the key-reload transition). */
  clearCache(): void;
}

/**
 * Result of one shared mint: the new token, or an outage for a key whose
 * cached token was still unexpired when the mint failed.
 */
type MintOutcome =
  | { readonly kind: "minted"; readonly token: CachedInstallationToken }
  | { readonly kind: "outage"; readonly error: ProviderUnavailableError };

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
}: GitHubAppProviderOptions): GitHubAppProvider {
  let state: ProviderState = "unconfigured";
  let lastError: TesseraErrorCode | null = null;
  let invalidError: CredentialInvalidError | null = null;
  let signer: AppAssertionSigner | null = null;
  let identity: BotIdentity | null = null;
  let identityLookup: Promise<BotIdentity> | null = null;
  /** Installation Binding per owner; successful lookups only. */
  const bindings = new Map<string, number>();
  /** In-flight owner installation lookups, one per owner. */
  const pendingLookups = new Map<string, Promise<number>>();
  /** In-flight mints, one per cache key ({@link tokenCacheKeyId}). */
  const pendingMints = new Map<string, Promise<MintOutcome>>();
  const cache = createTokenCache(now === undefined ? {} : { now });

  function markInvalid(error: CredentialInvalidError): never {
    if (invalidError === null) {
      invalidError = error;
      cache.clear();
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
   * Record a failed GitHub call per the lifecycle (a rejected credential throws
   * via {@link markInvalid}). Once the provider is invalid, no later failure
   * (e.g. an in-flight request timing out after another got a 401) changes
   * `state` or `last_error` until restart.
   */
  function recordFailure(error: unknown): void {
    if (error instanceof CredentialInvalidError) markInvalid(error);
    if (invalidError !== null) return;
    if (error instanceof ProviderUnavailableError) {
      state = "degraded";
      lastError = error.code;
    } else if (!(error instanceof RepoNotInstalledError)) {
      lastError = errorCode(error);
    }
  }

  /** {@link recordFailure}, then rethrow. */
  function markFailure(error: unknown): never {
    recordFailure(error);
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

  /**
   * Run `start` unless a call for `id` is already in flight, in which case join
   * it. The entry is removed once the shared promise settles either way.
   */
  function shared<T>(pending: Map<string, Promise<T>>, id: string, start: () => Promise<T>): Promise<T> {
    const existing = pending.get(id);
    if (existing !== undefined) return existing;
    const promise = start().finally(() => {
      if (pending.get(id) === promise) pending.delete(id);
    });
    pending.set(id, promise);
    return promise;
  }

  async function resolveInstallation(owner: string): Promise<number> {
    if (config.installationId !== undefined) return config.installationId;
    const known = bindings.get(owner);
    if (known !== undefined) return known;
    return shared(pendingLookups, owner, () => lookupInstallation(owner));
  }

  async function lookupInstallation(owner: string): Promise<number> {
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
      if (invalidError !== null) throw invalidError;
      const key: TokenCacheKey = { installationId, repos: [name], access: req.access };
      const keyId = tokenCacheKeyId(key);
      const result = (token: CachedInstallationToken, cacheOutcome: "hit" | "miss"): ProviderIssueResult => ({
        token: token.token,
        expiresAt: token.expiresAt,
        identity: bot.login,
        commitIdentity: bot.commitIdentity,
        cache: cacheOutcome,
      });

      // A refresh joins a mint already in flight for its key; see the module doc.
      if (req.refresh === true && !pendingMints.has(keyId)) cache.evict(key);
      const hit = req.refresh === true ? undefined : cache.getFresh(key);
      if (hit !== undefined) return result(hit, "hit");

      const outcome = await shared(pendingMints, keyId, async (): Promise<MintOutcome> => {
        try {
          const token = await client.createInstallationToken(assertion(), installationId, {
            repositories: [name],
            permissions,
          });
          markOk();
          if (invalidError === null) cache.set(key, token);
          return { kind: "minted", token };
        } catch (error) {
          if (error instanceof RepoNotInstalledError && bindings.get(owner) === installationId) {
            bindings.delete(owner);
          }
          recordFailure(error);
          // Outage with a live entry for this key: serve it (see the module doc).
          if (error instanceof ProviderUnavailableError && invalidError === null && cache.getUnexpired(key)) {
            return { kind: "outage", error };
          }
          throw error;
        }
      });
      if (outcome.kind === "minted") return result(outcome.token, "miss");
      // Re-checked per caller: a joiner may resume after the entry expired or
      // the provider went invalid (which clears the cache).
      if (invalidError !== null) throw invalidError;
      const cached = req.refresh === true ? undefined : cache.getUnexpired(key);
      if (cached === undefined) throw outcome.error;
      return result(cached, "hit");
    },

    cacheEntries(): number {
      return cache.size();
    },

    clearCache(): void {
      cache.clear();
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
