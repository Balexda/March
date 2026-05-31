/**
 * Herald service wire + storage types. The event taxonomy and projection live
 * in {@link ../events.js} (shared with the legate); this module holds the store
 * options and HTTP query shapes.
 */

export interface EventStoreOptions {
  /** Home directory override (defaults to `os.homedir()`). */
  readonly homeDir?: string;
  /** Explicit db path (e.g. `":memory:"` for tests). Overrides `homeDir`. */
  readonly dbPath?: string;
  /** Write a snapshot every N appends (cold-start fast-forward). Default 256. */
  readonly snapshotEvery?: number;
  /**
   * Profile stamped on appends that carry none, and used to backfill legacy v1
   * rows on the schema-2 migration. The server sets this to the single-profile
   * deployment's profile (from meta); tests/default use {@link DEFAULT_PROFILE}.
   */
  readonly defaultProfile?: string;
}

/** Parsed/validated `GET /events` query. */
export interface EventsQuery {
  /** Return events with `seq` strictly greater than this (default 0). */
  readonly after: number;
  /** Max events to return (default 100, capped at 1000). */
  readonly limit: number;
}

/** `GET /events` response. */
export interface EventsPage {
  events: import("../events.js").HeraldEvent[];
  /** seq of the last event in the page (or the requested `after` if empty). */
  lastSeq: number;
}
