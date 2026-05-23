import fs from "node:fs";
import path from "node:path";
import { HeraldClient } from "../../../herald/service/client.js";
import {
  emptySystemState,
  reduce,
  type EventBody,
  type HeraldEvent,
  type SystemState,
} from "../../../herald/events.js";

/**
 * The legate loop's seam to Herald — the system-state observation service and
 * unified event log (#175). Herald runs as a service, so this calls it over HTTP
 * via the {@link HeraldClient} (set `MARCH_HERALD_URL`). It wraps the client with
 * the two pieces of state the inbox protocol needs:
 *
 *   1. A **persistent cursor** — the last consumed `seq`, written under the
 *      conductor dir (`~/.march/legate/<conductor>/herald-cursor.json`) so a loop
 *      restart resumes where it left off instead of re-folding the whole log.
 *   2. An in-memory **folded projection** — the {@link SystemState} the consumed
 *      events fold into via the shared reducer in `herald/events.ts`. The legate's
 *      Stage-1 adapter (`senseFromHerald`) reads this instead of self-polling.
 *
 * Plus the write path: {@link append} posts the legate's transition events to
 * `POST /events` (Herald assigns the seq).
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
  /** Directory the cursor file lives in (the legate conductor dir). */
  readonly conductorDir: string;
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
  /** Last consumed seq (the inbox cursor); persisted across restarts. */
  private cursor: number;
  /** Accumulated fold; null until the first {@link consume} seeds it. */
  private state: SystemState | null = null;
  /**
   * Slice ids whose operator `slice.recovery.requested` (#238) was drained in the
   * most recent {@link consume}. The reducer drops the slice from the fold, so the
   * fold alone leaves no marker for the warm loop to reconcile its IN-MEMORY
   * working state from (warm-loop invisibility). This captures the request off the
   * drain so the loop can drop the slice from `raw` and re-dispatch it this tick.
   * {@link takeRecoveryRequests} returns and clears it.
   */
  private recoveryRequests: string[] = [];

  constructor(opts: LegateHeraldOptions) {
    this.client = opts.client ?? new HeraldClient({ env: opts.env });
    this.cursorPath = path.join(opts.conductorDir, HERALD_CURSOR_FILE);
    this.pageLimit = opts.pageLimit ?? HERALD_DRAIN_PAGE_LIMIT;
    this.cursor = this.loadCursor();
  }

  /** The last consumed seq (the persisted inbox cursor). */
  get lastCursor(): number {
    return this.cursor;
  }

  /** The accumulated projection, or null before the first {@link consume}. */
  get projection(): SystemState | null {
    return this.state;
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
  async consume(): Promise<SystemState> {
    // Recovery requests are scoped to THIS drain — reset before folding so
    // takeRecoveryRequests() reflects only what was drained this tick.
    this.recoveryRequests = [];
    if (this.state === null) {
      this.state = this.cursor > 0 ? await this.client.state(this.cursor) : emptySystemState();
      // Recover from a stale/corrupt cursor: the seeded fold reflects at most
      // its own seq, so reading after a higher persisted cursor would skip every
      // future event and wedge the consumer. Clamp down to what we actually have.
      if (this.state.seq < this.cursor) {
        this.cursor = this.state.seq;
        this.persistCursor();
      }
    }
    for (;;) {
      const page = await this.client.events({ after: this.cursor, limit: this.pageLimit });
      for (const event of page.events) {
        if (event.type === "slice.recovery.requested") this.recoveryRequests.push(event.sliceId);
        reduce(this.state, event as HeraldEvent);
      }
      if (page.lastSeq > this.cursor) {
        this.cursor = page.lastSeq;
        this.persistCursor();
      }
      // A short page means we've reached the tail; a full page may have more.
      if (page.events.length < this.pageLimit) break;
    }
    return this.state;
  }

  /**
   * Return (and clear) the slice ids whose operator `slice.recovery.requested`
   * (#238) was drained in the most recent {@link consume}. The warm loop drops
   * each from its in-memory working state so the still-ready smithy work
   * re-dispatches fresh this tick — the durable fold can't carry this to the warm
   * loop on its own (the reducer dropped the slice; warm-loop invisibility).
   */
  takeRecoveryRequests(): string[] {
    const requests = this.recoveryRequests;
    this.recoveryRequests = [];
    return requests;
  }

  /**
   * Append a transition event (the legate write-path). Herald forces the source
   * to `legate` and assigns the seq. Returns the stored event.
   */
  async append(event: TransitionEvent): Promise<HeraldEvent> {
    return this.client.append(event);
  }
}
