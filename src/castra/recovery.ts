import type { RecoveryRuntime, RecoverySessionView } from "./adapter.js";
import type { RecoverReport, SessionRecoveryResult, TrustDialogResult } from "./types.js";
import {
  parseTrustDialog,
  resolveTrustDialog,
  type ResolveTrustDialogOptions,
  type TrustDialogIo,
} from "./trust-dialog.js";

/**
 * Castra session recovery (#castra-recover).
 *
 * After a host reboot the tmux server comes back but the prior panes are gone,
 * so every agent-deck session reports `status: "error"`. `revive` can't help
 * (it needs a surviving tmux server with only a dead pipe); the recovery here
 * drives `agent-deck session restart --force`, which recreates the pane and —
 * for a Claude session with a stored `claude_session_id` — re-spawns as
 * `claude --resume <uuid>`.
 *
 * On a large conversation that resume shows Claude's **"Resume from summary /
 * Resume full session"** startup picker. agent-deck has an auto-confirm for it,
 * but the CLI `session restart` path only runs that on a *fresh* restart, not
 * the resume branch — so the picker is left unanswered when driven over the
 * CLI. Castra therefore answers it itself: poll the pane for both picker
 * markers and, when seen, press Enter to accept the preselected default
 * ("Resume from summary"). That gets the session back to a workable state.
 *
 * A session can also be `stopped` (its tmux session is gone, e.g. after a long
 * host pause, #587). `session restart` brings that back the same way, but a
 * stopped session may have been stopped deliberately by an operator, so it is
 * only recovered when the caller names it explicitly (`sessionIds`) — the legate
 * does exactly that for stopped stewards still backing a live slice. A group-wide
 * sweep keeps recovering `error` sessions only.
 *
 * Directory-trust dialogs: stewards launched before #608 pass `--add-dir
 * ~/.march/steward`, so Claude Code opens with an "Adding a new directory …
 * Yes, add it" dialog that blocks every send. The sweep answers that dialog when
 * it names Castra's own steward directory — after a restart, and on live
 * in-scope sessions — and reports any other directory's dialog untouched (see
 * trust-dialog.ts).
 *
 * The runtime, clock, and sleeper are injected so the orchestration is unit
 * testable without a live agent-deck/tmux; production wires {@link
 * createAgentDeckRecoveryRuntime}.
 */

/** The group whose sessions are managed by their own conductor tooling and so
 * are excluded from a recovery sweep by default (the operator chose to leave
 * the conductor alone — worker/steward groups only). */
export const RECOVERY_DEFAULT_EXCLUDED_GROUPS = ["conductor"] as const;

/** The status agent-deck reports for a session whose pane died (e.g. reboot). */
const ERROR_STATUS = "error";

/** The status agent-deck reports for a session whose tmux session is gone
 *  (e.g. a long host pause, #587). Recovered only on explicit id targeting. */
const STOPPED_STATUS = "stopped";

/** Statuses a restart is meant to leave: a session still in one is not live. */
const NOT_LIVE_STATUSES: ReadonlySet<string> = new Set([ERROR_STATUS, STOPPED_STATUS]);

/**
 * Substrings that appear together only on Claude's resume picker. Both must be
 * present so a chat message mentioning one phrase in isolation never trips it —
 * mirrors agent-deck's own `resumePickerMarkers`.
 */
const RESUME_PICKER_MARKERS = ["Resume from summary", "Resume full session"] as const;

/** Strip SGR escape sequences so marker matching isn't derailed by colour codes. */
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** Does the captured pane text show the Claude resume picker? */
export function looksLikeResumePicker(pane: string): boolean {
  const clean = pane.replace(ANSI_SGR, "");
  return RESUME_PICKER_MARKERS.every((marker) => clean.includes(marker));
}

export interface RecoverOptions {
  readonly profile: string;
  /**
   * When set, only sessions in this group are recovered. When unset, every
   * errored session is recovered except those in {@link excludeGroups}.
   */
  readonly group?: string;
  /**
   * When set, recovery is restricted to these exact session ids — the errored
   * ones AND the `stopped` ones (#587: a stopped session is only ever restarted
   * when named explicitly, never by a group sweep). This is explicit targeting —
   * it overrides the default conductor exclusion, so an operator can name a
   * specific session in any group. Combined with `group`, both must match. Use for a controlled
   * "recover just these" sweep rather than a whole group.
   */
  readonly sessionIds?: readonly string[];
  /**
   * Groups skipped when no explicit `group`/`sessionIds` is given. Defaults to
   * {@link RECOVERY_DEFAULT_EXCLUDED_GROUPS} (the conductor).
   */
  readonly excludeGroups?: readonly string[];
}

export interface RecoverDeps {
  readonly runtime: RecoveryRuntime;
  /** Resolves after `ms`; injected so tests run without real timers. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Monotonic clock in ms; defaults to `Date.now`. */
  readonly now?: () => number;
  /** How long to watch for the resume picker after a restart. Default 5s. */
  readonly pickerTimeoutMs?: number;
  /** Pane poll cadence while waiting for the picker. Default 250ms. */
  readonly pickerPollMs?: number;
  /** How long to wait for the session to leave `error`/`stopped`. Default 10s. */
  readonly statusTimeoutMs?: number;
  /** Status poll cadence. Default 500ms. */
  readonly statusPollMs?: number;
  /** Trust-dialog answering options (owned dirs, key settle time). */
  readonly trustDialog?: ResolveTrustDialogOptions;
}

const DEFAULTS = {
  pickerTimeoutMs: 5_000,
  pickerPollMs: 250,
  statusTimeoutMs: 10_000,
  statusPollMs: 500,
} as const;

/** Is `group` the given group or one of its subgroups (`<group>/...`)? */
function inGroup(group: string, scope: string): boolean {
  return group === scope || group.startsWith(scope + "/");
}

/** Which sessions a sweep targets, honoring group/excludeGroups. `error` is
 *  always eligible; `stopped` only under explicit `sessionIds` targeting. */
export function selectRecoverable(
  sessions: readonly RecoverySessionView[],
  options: RecoverOptions,
): RecoverySessionView[] {
  const ids =
    options.sessionIds && options.sessionIds.length ? new Set(options.sessionIds) : null;
  const excluded = new Set(options.excludeGroups ?? RECOVERY_DEFAULT_EXCLUDED_GROUPS);
  return sessions.filter((s) => {
    // Explicit id targeting wins (overrides the conductor exclusion); when a
    // group is also given, both must match.
    if (ids) {
      if (s.status !== ERROR_STATUS && s.status !== STOPPED_STATUS) return false;
      // The group restriction also admits its subgroups (`legate-workers/forge`),
      // matching how the legate classifies worker sessions.
      return ids.has(s.sessionId) && (!options.group || inGroup(s.group, options.group));
    }
    if (s.status !== ERROR_STATUS) return false;
    if (options.group) return s.group === options.group;
    return !excluded.has(s.group);
  });
}

/**
 * Restart every errored session in scope and resolve any resume picker, then
 * report per-session outcomes. Never throws on a single session's failure: a
 * restart error is captured as `restart_failed` so one bad session can't abort
 * the sweep.
 */
export async function recoverErrorSessions(
  deps: RecoverDeps,
  options: RecoverOptions,
): Promise<RecoverReport> {
  const now = deps.now ?? Date.now;
  const cfg = {
    pickerTimeoutMs: deps.pickerTimeoutMs ?? DEFAULTS.pickerTimeoutMs,
    pickerPollMs: deps.pickerPollMs ?? DEFAULTS.pickerPollMs,
    statusTimeoutMs: deps.statusTimeoutMs ?? DEFAULTS.statusTimeoutMs,
    statusPollMs: deps.statusPollMs ?? DEFAULTS.statusPollMs,
  };

  const sessions = await deps.runtime.listSessions(options.profile);
  const targets = selectRecoverable(sessions, options);
  const recovered: SessionRecoveryResult[] = [];
  const trustDialogs: TrustDialogResult[] = [];

  for (const target of targets) {
    recovered.push(await recoverOne(deps, options.profile, target, now, cfg, trustDialogs));
  }

  // Live sessions are not restarted, but one may sit on a trust dialog.
  for (const target of selectTrustScan(sessions, options)) {
    const result = await answerTrustDialog(deps, target, target.tmuxSession);
    if (result) trustDialogs.push(result);
  }

  return { recovered, trustDialogs };
}

/**
 * Live in-scope sessions to check for a trust dialog: the same scoping as
 * {@link selectRecoverable}, but only sessions that are NOT `error`/`stopped`
 * (those are restarted, and checked after the restart) and have a pane.
 */
export function selectTrustScan(
  sessions: readonly RecoverySessionView[],
  options: RecoverOptions,
): RecoverySessionView[] {
  const ids =
    options.sessionIds && options.sessionIds.length ? new Set(options.sessionIds) : null;
  const excluded = new Set(options.excludeGroups ?? RECOVERY_DEFAULT_EXCLUDED_GROUPS);
  return sessions.filter((s) => {
    if (NOT_LIVE_STATUSES.has(s.status) || !s.tmuxSession) return false;
    if (ids) return ids.has(s.sessionId) && (!options.group || inGroup(s.group, options.group));
    if (options.group) return s.group === options.group;
    return !excluded.has(s.group);
  });
}

function trustIo(deps: RecoverDeps, tmuxSession: string): TrustDialogIo {
  return {
    capture: () => deps.runtime.capturePane(tmuxSession),
    sendKey: (key) => deps.runtime.sendKey(tmuxSession, key),
    sleep: deps.sleep,
  };
}

/** Answer the session's trust dialog if one is shown; null when none is. */
async function answerTrustDialog(
  deps: RecoverDeps,
  target: RecoverySessionView,
  tmuxSession: string,
): Promise<TrustDialogResult | null> {
  const resolution = await resolveTrustDialog(trustIo(deps, tmuxSession), deps.trustDialog);
  if (resolution.outcome === "not_shown") return null;
  return {
    sessionId: target.sessionId,
    title: target.title,
    group: target.group,
    outcome: resolution.outcome,
    dir: resolution.dir ?? "",
    ...(resolution.detail ? { detail: resolution.detail } : {}),
  };
}

async function recoverOne(
  deps: RecoverDeps,
  profile: string,
  target: RecoverySessionView,
  now: () => number,
  cfg: {
    pickerTimeoutMs: number;
    pickerPollMs: number;
    statusTimeoutMs: number;
    statusPollMs: number;
  },
  trustDialogs: TrustDialogResult[],
): Promise<SessionRecoveryResult> {
  const base = { sessionId: target.sessionId, title: target.title, group: target.group };

  try {
    await deps.runtime.restart(profile, target.sessionId);
  } catch (err) {
    return {
      ...base,
      outcome: "restart_failed",
      pickerResolved: false,
      finalStatus: target.status,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Restart regenerates the tmux session name, so re-read to target the pane.
  // The restart already succeeded; if OBSERVING the result throws (e.g.
  // readSession's `agent-deck session show` errors), don't let that one session
  // abort the whole sweep — report it as unconfirmed/still_error and move on.
  let pickerResolved = false;
  let finalStatus: string;
  try {
    pickerResolved = await resolvePickerIfShown(
      deps,
      profile,
      target,
      now,
      cfg,
      trustDialogs,
    );
    finalStatus = await waitForLive(deps, profile, target.sessionId, target.status, now, cfg);
  } catch (err) {
    return {
      ...base,
      outcome: "still_error",
      pickerResolved,
      finalStatus: target.status,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (NOT_LIVE_STATUSES.has(finalStatus)) {
    return { ...base, outcome: "still_error", pickerResolved, finalStatus };
  }
  return {
    ...base,
    outcome: pickerResolved ? "picker_resolved" : "recovered",
    pickerResolved,
    finalStatus,
  };
}

/**
 * Poll the live pane for the resume picker; press Enter once if it appears. A
 * directory-trust dialog seen meanwhile is answered once (Castra's own steward
 * directory only) and polling continues, since the picker may follow it.
 */
async function resolvePickerIfShown(
  deps: RecoverDeps,
  profile: string,
  target: RecoverySessionView,
  now: () => number,
  cfg: { pickerTimeoutMs: number; pickerPollMs: number },
  trustDialogs: TrustDialogResult[],
): Promise<boolean> {
  const deadline = now() + cfg.pickerTimeoutMs;
  let trustHandled = false;
  for (;;) {
    const view = await deps.runtime.readSession(profile, target.sessionId);
    const tmuxSession = view?.tmuxSession ?? "";
    if (tmuxSession) {
      const pane = await deps.runtime.capturePane(tmuxSession);
      if (looksLikeResumePicker(pane)) {
        await deps.runtime.sendEnter(tmuxSession);
        return true;
      }
      if (!trustHandled && parseTrustDialog(pane)) {
        trustHandled = true;
        const result = await answerTrustDialog(deps, target, tmuxSession);
        if (result) trustDialogs.push(result);
        continue;
      }
    }
    if (now() >= deadline) return false;
    await deps.sleep(cfg.pickerPollMs);
  }
}

/** Poll status until the session leaves `error`/`stopped`, or return the last status. */
async function waitForLive(
  deps: RecoverDeps,
  profile: string,
  sessionId: string,
  initialStatus: string,
  now: () => number,
  cfg: { statusTimeoutMs: number; statusPollMs: number },
): Promise<string> {
  const deadline = now() + cfg.statusTimeoutMs;
  let last = initialStatus;
  for (;;) {
    const view = await deps.runtime.readSession(profile, sessionId);
    last = view?.status ?? last;
    if (!NOT_LIVE_STATUSES.has(last)) return last;
    if (now() >= deadline) return last;
    await deps.sleep(cfg.statusPollMs);
  }
}
