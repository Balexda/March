/**
 * Compaction + prompt-cache tuning for March's long-lived Claude Code sessions
 * (stewards and the legate conductor).
 *
 * These sessions sit idle for long stretches — a steward waits on CI and
 * review — and then resume. A resume after the prompt cache has expired
 * re-writes the whole conversation at the uncached rate, so the cost of an idle
 * gap scales with how large the context was allowed to grow. No Claude Code
 * hook can *start* a compaction (`PreCompact` only blocks or annotates one), so
 * the lever is the settings `env` block: it tunes Claude Code's own idle and
 * automatic compaction rather than adding a March-side scheduler.
 *
 * The result is written under `env` in the settings files March generates
 * (`buildStewardSettings`, the conductor's `.claude/settings.json`).
 */

/** Claude Code's accepted prompt-cache lifetimes. */
const CACHE_TTLS = ["5m", "1h"] as const;
type CacheTtl = (typeof CACHE_TTLS)[number];

/**
 * One-hour cache lifetime. Idle compaction only applies to a conversation on
 * the one-hour TTL, and API-key billing otherwise defaults to five minutes —
 * shorter than nearly every gap between steward turns.
 */
export const DEFAULT_SESSION_CACHE_TTL: CacheTtl = "1h";

/** Claude Code's documented floor for `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`
 *  (its own default is 200000). */
export const IDLE_COMPACT_MIN_TOKENS_FLOOR = 100_000;
export const DEFAULT_IDLE_COMPACT_MIN_TOKENS = IDLE_COMPACT_MIN_TOKENS_FLOOR;

/** Claude Code's documented range for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. */
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;
/**
 * Cap the context at 200k so a session on a 1M-window model compacts long
 * before it reaches ~967k — bounding what a cold resume has to re-write.
 * Claude Code clamps this to the model's own window.
 */
export const DEFAULT_AUTO_COMPACT_WINDOW = 200_000;

function isDisabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

/** Parse a plain positive integer token count, or `undefined` if it isn't one. */
function parseTokens(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The Claude Code env vars to set on a long-lived March session.
 *
 * Operator overrides (read from `env`, defaulting to `process.env`):
 * - `MARCH_SESSION_COMPACTION=0|false|off` — emit nothing; the session keeps
 *   Claude Code's stock behaviour.
 * - `MARCH_SESSION_CACHE_TTL=5m|1h`
 * - `MARCH_SESSION_IDLE_COMPACT_MIN_TOKENS=<tokens>`
 * - `MARCH_SESSION_AUTO_COMPACT_WINDOW=<tokens>`
 *
 * An unparseable override falls back to the default and an out-of-range token
 * count is clamped into Claude Code's documented range, so a typo can never
 * produce a settings file Claude Code rejects or silently ignores.
 */
export function buildSessionCompactionEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (isDisabled(env.MARCH_SESSION_COMPACTION)) return {};

  const ttlOverride = env.MARCH_SESSION_CACHE_TTL?.trim().toLowerCase();
  const ttl = CACHE_TTLS.find((candidate) => candidate === ttlOverride)
    ?? DEFAULT_SESSION_CACHE_TTL;

  const idleMinTokens = Math.max(
    IDLE_COMPACT_MIN_TOKENS_FLOOR,
    parseTokens(env.MARCH_SESSION_IDLE_COMPACT_MIN_TOKENS)
      ?? DEFAULT_IDLE_COMPACT_MIN_TOKENS,
  );

  const autoCompactWindow = clamp(
    parseTokens(env.MARCH_SESSION_AUTO_COMPACT_WINDOW)
      ?? DEFAULT_AUTO_COMPACT_WINDOW,
    AUTO_COMPACT_WINDOW_MIN,
    AUTO_COMPACT_WINDOW_MAX,
  );

  return {
    CLAUDE_CODE_PROMPT_CACHE_TTL: ttl,
    CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: String(idleMinTokens),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow),
  };
}

/**
 * Settings fragment to spread into a generated `settings.json`: `{ env }` when
 * tuning is on, `{}` when the operator disabled it (so no empty `env` key is
 * written).
 */
export function sessionCompactionSettings(
  env: NodeJS.ProcessEnv = process.env,
): { env?: Record<string, string> } {
  const vars = buildSessionCompactionEnv(env);
  return Object.keys(vars).length > 0 ? { env: vars } : {};
}
