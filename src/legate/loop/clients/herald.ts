import fs from "node:fs";
import path from "node:path";
import { HeraldClient } from "../../../herald/service/client.js";
import {
  emptyMultiProfileState,
  emptySystemState,
  reduceMulti,
  type EventBody,
  type HeraldEvent,
  type MultiProfileState,
  type SystemState,
} from "../../../herald/events.js";
import type { StewardAttachment } from "../state/sense.js";

/**
 * The legate loop's seam to Herald — the system-state observation service and
 * unified event log (#175). Herald runs as a service, so this calls it over HTTP
 * via the {@link HeraldClient} (set `MARCH_HERALD_URL`). It wraps the client with
 * the two pieces of state the inbox protocol needs:
 *
 *   1. A **single persistent cursor** — the last consumed `seq` over the ONE
 *      multiplexed (all-profiles) event stream, written container-wide
 *      (`~/.march/legate/herald-cursor.json`) so a restart resumes where it left
 *      off instead of re-folding the whole log. Herald assigns one global `seq`,
 *      so one cursor is correct no matter how many profiles the legate drives.
 *   2. An in-memory **multi-profile folded projection** — the consumed events fold
 *      into {@link MultiProfileState} (per-profile {@link SystemState}) via the
 *      shared reducer. The legate ticks each profile against its own bucket, so a
 *      sliceId shared across profiles never collides.
 *
 * Plus the write path: {@link append} posts the legate's transition events to
 * `POST /events` (Herald assigns the seq), stamped with the owning profile.
 */

/** The legate-written subset of the taxonomy (the transition events). */
export type TransitionEvent = Extract<
  EventBody,
  {
    type:
      | "slice.dispatched"
      | "slice.stage.changed"
      | "slice.archived"
      | "slice.recovery.dispatched"
      // The graduated-recovery driver (#413) appends inner-rung
      // `slice.recovery.requested {rung}` events to durably advance the ladder
      // (rung 1/2) and tombstone on the last-resort nuke (rung 3). The operator
      // CLI also appends this (no `rung`); both share Herald's validator.
      | "slice.recovery.requested"
      | "steward.relaunched"
      | "slice.escalated"
      | "retry.counted";
  }
>;

/** Filename of the persistent cursor inside the conductor dir. */
export const HERALD_CURSOR_FILE = "herald-cursor.json";

/**
 * Page size used when draining the inbox. Matches Herald's `MAX_EVENTS_LIMIT`
 * so each round-trip pulls as much as the server allows; {@link LegateHerald.consume}
 * pages until caught up, so this only bounds the per-request size, not the total.
 */
export const HERALD_DRAIN_PAGE_LIMIT = 1000;

export interface LegateHeraldOptions {
  /** Directory the single (container-wide) cursor file lives in. */
  readonly stateDir: string;
  /** Injected HTTP client (defaults to a real {@link HeraldClient}). */
  readonly client?: HeraldClient;
  /** Env used to resolve the Herald URL when no client is injected. */
  readonly env?: NodeJS.ProcessEnv;
  /** Per-request inbox page size (default {@link HERALD_DRAIN_PAGE_LIMIT}). */
  readonly pageLimit?: number;
}

export class LegateHerald {
  private readonly client: HeraldClient;
  private readonly cursorPath: string;
  private readonly pageLimit: number;
  /** Last consumed seq over the ONE multiplexed stream; persisted across restarts. */
  private cursor: number;
  /** Accumulated multi-profile fold; null until the first {@link consume} seeds it. */
  private multi: MultiProfileState | null = null;
  /**
   * Per-profile slice ids whose operator `slice.recovery.requested` (#238) was
   * drained in the most recent {@link consume}. The reducer drops the slice from
   * the fold, so the fold alone leaves no marker for the warm loop to reconcile
   * its IN-MEMORY working state from (warm-loop invisibility). This captures the
   * request off the drain, keyed by profile, so the loop can drop the slice from
   * that profile's `raw` and re-dispatch it. {@link takeRecoveryRequests} returns
   * and clears one profile's list.
   */
  private recoveryRequests = new Map<string, string[]>();
  /**
   * Per-profile `slice.steward.attached` events (#213/#265) drained in the most
   * recent {@link consume}. Hatchery / the admin endpoint authors these (not the
   * legate), so the warm loop only learns of a mid-run attach through the fold —
   * and the fold alone reaches the warm loop next tick. Captured off the drain,
   * keyed by profile, so {@link senseFromHerald} folds them into that profile's
   * `raw.slices` without a restart. {@link takeStewardAttachments} returns and
   * clears one profile's list. Same shape as {@link recoveryRequests}.
   */
  private stewardAttachments = new Map<string, StewardAttachment[]>();

  constructor(opts: LegateHeraldOptions) {
    this.client = opts.client ?? new HeraldClient({ env: opts.env });
    this.cursorPath = path.join(opts.stateDir, HERALD_CURSOR_FILE);
    this.pageLimit = opts.pageLimit ?? HERALD_DRAIN_PAGE_LIMIT;
    this.cursor = this.loadCursor();
  }

  /** The last consumed seq (the persisted inbox cursor). */
  get lastCursor(): number {
    return this.cursor;
  }

  /** The accumulated multi-profile projection, or null before the first {@link consume}. */
  get projection(): MultiProfileState | null {
    return this.multi;
  }

  /** One profile's folded SystemState (empty when the profile has no events yet). */
  snapshotFor(profile: string): SystemState {
    return this.multi?.byProfile[profile] ?? emptySystemState();
  }

  private loadCursor(): number {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cursorPath, "utf-8")) as { seq?: unknown };
      const seq = Number(parsed?.seq);
      return Number.isFinite(seq) && seq >= 0 ? seq : 0;
    } catch {
      // No cursor yet (fresh deployment) or unreadable — start from the top.
      return 0;
    }
  }

  private persistCursor(): void {
    try {
      fs.mkdirSync(path.dirname(this.cursorPath), { recursive: true });
      fs.writeFileSync(this.cursorPath, JSON.stringify({ seq: this.cursor }) + "\n", "utf-8");
    } catch {
      // Best effort: a missed write just re-seeds from GET /state on the next
      // cold start. Never let cursor persistence break a tick.
    }
  }

  /**
   * Drain the inbox since the last consumed seq and fold the new events into the
   * accumulated projection, returning it. On the first call after process start
   * the projection is seeded from the server's fold up to the persisted cursor
   * (`GET /state?at=<cursor>`), so a restart resumes with full state rather than
   * only the events appended after the cursor.
   *
   * `/events` is paginated (the server caps each page at {@link HERALD_DRAIN_PAGE_LIMIT}),
   * so a cold start (cursor=0 over the PR1 observation backlog) or a busy interval
   * can have more queued than one page holds. We page until caught up before
   * returning, so each tick folds a fully up-to-date projection rather than
   * running Stage-2 handlers against a partial one.
   */
  async consume(): Promise<MultiProfileState> {
    // Recovery requests + steward attachments are scoped to THIS drain — reset
    // before folding so the take*() side-channels reflect only this tick's events.
    this.recoveryRequests = new Map();
    this.stewardAttachments = new Map();
    if (this.multi === null) {
      this.multi = this.cursor > 0 ? await this.client.stateAll(this.cursor) : emptyMultiProfileState();
      // Recover from a stale/corrupt cursor: the seeded fold reflects at most
      // its own seq, so reading after a higher persisted cursor would skip every
      // future event and wedge the consumer. Clamp down to what we actually have.
      if (this.multi.seq < this.cursor) {
        this.cursor = this.multi.seq;
        this.persistCursor();
      }
    }
    for (;;) {
      const page = await this.client.events({ after: this.cursor, limit: this.pageLimit });
      for (const event of page.events) {
        // Only OPERATOR begin-graduated requests (no `rung`) are fresh-recovery
        // signals that restart the graduated ladder (#413). The driver's OWN
        // inner-rung descent events (`rung` 1/2/3) are durability records, not new
        // requests — capturing them here would re-enter the request list every
        // descent, resetting the per-rung budget so the ladder could never progress
        // (and a re-drained rung-3 would re-trigger after the tombstone). Mid-walk
        // continuation is driven by the slice's `recovery_rung`, not this list.
        if (event.type === "slice.recovery.requested" && (event as { rung?: number }).rung === undefined) {
          const list = this.recoveryRequests.get(event.profile) ?? [];
          list.push(event.sliceId);
          this.recoveryRequests.set(event.profile, list);
        }
        if (event.type === "slice.steward.attached") {
          const list = this.stewardAttachments.get(event.profile) ?? [];
          list.push({
            sliceId: event.sliceId,
            sessionId: event.sessionId,
            branch: event.branch,
            worktreePath: event.worktreePath,
          });
          this.stewardAttachments.set(event.profile, list);
        }
        reduceMulti(this.multi, event as HeraldEvent);
      }
      if (page.lastSeq > this.cursor) {
        this.cursor = page.lastSeq;
        this.persistCursor();
      }
      // A short page means we've reached the tail; a full page may have more.
      if (page.events.length < this.pageLimit) break;
    }
    return this.multi;
  }

  /**
   * Return (and clear) one profile's slice ids whose operator
   * `slice.recovery.requested` (#238) was drained in the most recent
   * {@link consume}. The warm loop drops each from that profile's in-memory
   * working state so the still-ready smithy work re-dispatches fresh this tick —
   * the durable fold can't carry this to the warm loop on its own (the reducer
   * dropped the slice; warm-loop invisibility).
   */
  takeRecoveryRequests(profile: string): string[] {
    const requests = this.recoveryRequests.get(profile) ?? [];
    this.recoveryRequests.delete(profile);
    return requests;
  }

  /**
   * Return (and clear) one profile's `slice.steward.attached` events (#213/#265)
   * drained in the most recent {@link consume}. {@link senseFromHerald} folds the
   * slice→session correlation into that profile's in-memory `raw.slices` so a
   * mid-run attach (Hatchery push or operator admin event) takes effect on the
   * next tick — the durable fold can't carry this to the warm loop on its own.
   */
  takeStewardAttachments(profile: string): StewardAttachment[] {
    const attachments = this.stewardAttachments.get(profile) ?? [];
    this.stewardAttachments.delete(profile);
    return attachments;
  }

  /**
   * Append a transition event (the legate write-path), stamped with the owning
   * profile. Herald forces the source to `legate` and assigns the seq. Returns
   * the stored event.
   */
  async append(profile: string, event: TransitionEvent): Promise<HeraldEvent> {
    return this.client.append({ ...event, profile });
  }

  /**
   * Record a steward self-report for `profile` via Herald's `POST /steward-report`
   * (the steward.report event is NOT in the legate's transition-event set, so it
   * can't go through {@link append}). The respond endpoint posts a non-awaiting
   * status here to clear a latched `steward_awaiting_input` escalation.
   */
  async stewardReport(
    profile: string,
    input: {
      sliceId: string;
      classified: boolean;
      status?: "awaiting_input" | "reported" | "working";
      summary?: string;
    },
  ): Promise<HeraldEvent> {
    return this.client.stewardReport({ profile, ...input });
  }
}
