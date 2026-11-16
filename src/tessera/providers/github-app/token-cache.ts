/**
 * In-memory cache of minted installation tokens (data model "Cached
 * Installation Token"). Owned by the github-app provider because the key needs
 * the installation id.
 *
 * - Key: (`installation_id`, sorted `repos`, access level). Different
 *   repositories or access levels never share an entry.
 * - Lifecycle: an entry is `fresh` while strictly more than
 *   {@link REMINT_THRESHOLD_MS} of life remains, `stale` after that until it
 *   expires, and dropped on access once expired, so {@link TokenCache.size}
 *   never counts a dead entry.
 *
 * Nothing is written to disk and nothing in this module logs.
 */
import type { AccessLevel } from "../../types.js";
import type { Clock } from "./app-assertion.js";

/** A cached token with less than this much life left is re-minted: ten minutes. */
export const REMINT_THRESHOLD_MS = 10 * 60 * 1000;

/** Identifies one cache entry. `repos` order does not matter. */
export interface TokenCacheKey {
  readonly installationId: number;
  readonly repos: readonly string[];
  readonly access: AccessLevel;
}

/** One cached installation token. The token is never logged. */
export interface CachedInstallationToken {
  readonly token: string;
  /** RFC 3339, as GitHub returned it. */
  readonly expiresAt: string;
}

/** Inputs to {@link createTokenCache}. */
export interface TokenCacheOptions {
  /** Wall clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: Clock;
}

/** The token cache operations. */
export interface TokenCache {
  /** The entry when strictly more than {@link REMINT_THRESHOLD_MS} of life remains, else `undefined`. */
  getFresh(key: TokenCacheKey): CachedInstallationToken | undefined;
  /** The entry when it has not yet expired (fresh or stale), else `undefined`. */
  getUnexpired(key: TokenCacheKey): CachedInstallationToken | undefined;
  /** Store or replace an entry. An entry whose `expiresAt` cannot be parsed or has passed is not stored. */
  set(key: TokenCacheKey, entry: CachedInstallationToken): void;
  /** Drop one entry. */
  evict(key: TokenCacheKey): void;
  /** Drop every entry (key reload). */
  clear(): void;
  /** Number of unexpired entries. */
  size(): number;
}

interface StoredEntry {
  readonly entry: CachedInstallationToken;
  readonly expiresAtMs: number;
}

function keyString({ installationId, repos, access }: TokenCacheKey): string {
  return JSON.stringify([installationId, [...repos].sort(), access]);
}

/** Build an empty in-memory {@link TokenCache}. */
export function createTokenCache({ now = Date.now }: TokenCacheOptions = {}): TokenCache {
  const entries = new Map<string, StoredEntry>();

  /** The stored entry when unexpired; an expired entry is dropped. */
  function live(key: string): StoredEntry | undefined {
    const stored = entries.get(key);
    if (stored === undefined) return undefined;
    if (stored.expiresAtMs <= now()) {
      entries.delete(key);
      return undefined;
    }
    return stored;
  }

  return {
    getFresh(key) {
      const stored = live(keyString(key));
      if (stored === undefined || stored.expiresAtMs - now() <= REMINT_THRESHOLD_MS) return undefined;
      return stored.entry;
    },

    getUnexpired(key) {
      return live(keyString(key))?.entry;
    },

    set(key, entry) {
      const expiresAtMs = Date.parse(entry.expiresAt);
      const id = keyString(key);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
        entries.delete(id);
        return;
      }
      entries.set(id, { entry: { token: entry.token, expiresAt: entry.expiresAt }, expiresAtMs });
    },

    evict(key) {
      entries.delete(keyString(key));
    },

    clear() {
      entries.clear();
    },

    size() {
      for (const id of [...entries.keys()]) live(id);
      return entries.size;
    },
  };
}
