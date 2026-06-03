import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabaseSync, type HeraldDatabase } from "./sqlite.js";
import {
  emptyMultiProfileState,
  emptySystemState,
  entityRefOf,
  foldEventsMulti,
  reduceMulti,
  type AppendEventInput,
  type EventBody,
  type HeraldEvent,
  type MultiProfileState,
  type SystemState,
} from "../events.js";
import type { EventStoreOptions } from "./types.js";

/** Event-store schema version. Bumped to 2 when the `profile` column landed;
 *  to 3 when the `admin`/`operator`/`note` audit columns landed (#265). */
export const HERALD_SCHEMA_VERSION = 3;

/** Profile stamped on events whose producer set none (and on legacy v1 rows at
 *  migration when no deployment profile is known). */
export const DEFAULT_PROFILE = "default";

const DEFAULT_SNAPSHOT_EVERY = 256;

/** Absolute path to `<home>/.march/herald/`. */
export function heraldDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".march", "herald");
}

/** Absolute path to the event-log sqlite file. */
export function eventsDbPath(homeDir?: string): string {
  return path.join(heraldDir(homeDir), "events.db");
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  ts           TEXT NOT NULL,
  profile      TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL,
  admin        INTEGER NOT NULL DEFAULT 0,
  operator     TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_kind, entity_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq);
CREATE TABLE IF NOT EXISTS snapshots (
  seq        INTEGER PRIMARY KEY,
  state      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
`;

interface EventRow {
  seq: number;
  id: string;
  type: string;
  source: string;
  ts: string;
  profile: string;
  payload: string;
  admin: number;
  operator: string | null;
  note: string | null;
}

function rowToEvent(row: EventRow): HeraldEvent {
  const body = JSON.parse(row.payload) as EventBody;
  const event = {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    source: row.source as HeraldEvent["source"],
    profile: row.profile,
    ...body,
  } as HeraldEvent;
  // Surface the audit columns only on operator-authored rows (#265) so they are
  // never present on normal events; the spread of `body` cannot collide because
  // the audit fields live in the envelope, never in any event body.
  if (row.admin) {
    event.admin = true;
    if (row.operator !== null) event.operator = row.operator;
    if (row.note !== null) event.note = row.note;
  }
  return event;
}

/** Audit attributes stamped on an operator-authored admin append (#265). */
export interface AppendAudit {
  readonly operator: string;
  readonly note: string;
}

/** The body half of an event (everything the producer sets minus the envelope). */
function bodyOf(input: AppendEventInput): EventBody {
  const { source: _source, id: _id, ts: _ts, ...body } = input;
  void _source;
  void _id;
  void _ts;
  return body as EventBody;
}

/**
 * Herald's append-only event log, backed by `node:sqlite`. Synchronous API: the
 * single-threaded Fastify server serializes access naturally.
 *
 * The log is the source of truth for system state — {@link projection} is the
 * fold of every event. A hot projection is kept in memory (updated on each
 * append) so the observe loop can diff against it cheaply, and periodic
 * snapshots let a cold start fast-forward instead of replaying the whole log.
 */
export class EventStore {
  private readonly db: HeraldDatabase;
  private readonly snapshotEvery: number;
  /** Profile stamped on appends/legacy rows that carry none. */
  readonly defaultProfile: string;
  /** Hot multi-profile projection, advanced on each append. */
  private hot: MultiProfileState;
  private appendsSinceSnapshot = 0;

  constructor(options: EventStoreOptions = {}) {
    const dbPath = options.dbPath ?? eventsDbPath(options.homeDir);
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const DatabaseSync = getDatabaseSync();
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    this.defaultProfile = options.defaultProfile ?? DEFAULT_PROFILE;
    this.migrate();
    this.hot = this.rebuildProjection();
  }

  private migrate(): void {
    // CREATE_TABLE_SQL is no-op on an existing DB (IF NOT EXISTS); a fresh DB
    // gets the v2 `events` table WITH the profile column. The profile index is
    // created at the END (below), after the column is guaranteed to exist — it
    // cannot live in CREATE_TABLE_SQL because that also runs against a v1 table
    // that lacks the column.
    this.db.exec(CREATE_TABLE_SQL);
    const row = this.db
      .prepare("SELECT version FROM schema_meta LIMIT 1")
      .get() as { version?: number } | undefined;
    if (row?.version === undefined) {
      this.db
        .prepare("INSERT INTO schema_meta (version) VALUES (?)")
        .run(HERALD_SCHEMA_VERSION);
    } else if (row.version < 2) {
      // v1 → v2: the `profile` column landed. An existing v1 DB needs the ALTER
      // plus a backfill of the single pre-multi-profile deployment's events to
      // the default profile.
      const hasProfile = (
        this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>
      ).some((c) => c.name === "profile");
      if (!hasProfile) {
        this.db.exec("ALTER TABLE events ADD COLUMN profile TEXT NOT NULL DEFAULT ''");
      }
      this.db
        .prepare("UPDATE events SET profile = ? WHERE profile = '' OR profile IS NULL")
        .run(this.defaultProfile);
      // Old snapshots are single-profile `SystemState` blobs (incompatible shape);
      // drop them — they are a regenerable optimization and rebuildProjection
      // re-folds from the events.
      this.db.exec("DELETE FROM snapshots");
      this.db.prepare("UPDATE schema_meta SET version = ?").run(HERALD_SCHEMA_VERSION);
    }
    // v2 → v3: the `admin`/`operator`/`note` audit columns landed (#265). A v1 DB
    // already gets them via the v1→v2 branch's recreate path? No — that branch only
    // ALTERs `profile`. So add the audit columns idempotently here for any pre-v3
    // DB (covers both a v2 DB upgrading and a v1 DB that just ran the block above).
    // No backfill: existing rows are non-admin, and the column DEFAULTs encode that.
    const cols = (
      this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("admin")) {
      this.db.exec("ALTER TABLE events ADD COLUMN admin INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.includes("operator")) {
      this.db.exec("ALTER TABLE events ADD COLUMN operator TEXT");
    }
    if (!cols.includes("note")) {
      this.db.exec("ALTER TABLE events ADD COLUMN note TEXT");
    }
    if (row?.version !== undefined && row.version < HERALD_SCHEMA_VERSION) {
      this.db.prepare("UPDATE schema_meta SET version = ?").run(HERALD_SCHEMA_VERSION);
    }
    // The profile column now exists on every path — index it.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_profile_seq ON events(profile, seq)");
  }

  /** Rebuild the multi-profile projection from the latest snapshot + trailing events. */
  private rebuildProjection(): MultiProfileState {
    const snap = this.db
      .prepare("SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; state: string } | undefined;
    const base = snap ? (JSON.parse(snap.state) as MultiProfileState) : emptyMultiProfileState();
    const fromSeq = snap ? snap.seq : 0;
    const trailing = this.readAfter(fromSeq, Number.MAX_SAFE_INTEGER);
    return foldEventsMulti(trailing, base);
  }

  /**
   * Append an event. Assigns a monotonic `seq`; fills `id` (uuid), `ts` (now)
   * and `profile` (the store default) when absent. Idempotent on `id` — a
   * duplicate append returns the existing row and does not re-fold.
   *
   * When `audit` is given (the break-glass `POST /admin/events` path, #265) the
   * row is stamped `admin=1` with the operator + note for forensics. These are
   * envelope columns, never folded — the corrective event still reduces by its
   * own type, so an admin-authored event folds identically to a normal one.
   */
  append(input: AppendEventInput, audit?: AppendAudit): HeraldEvent {
    const id = input.id ?? crypto.randomUUID();
    const ts = input.ts ?? new Date().toISOString();
    const profile = input.profile && input.profile.length > 0 ? input.profile : this.defaultProfile;
    const body = bodyOf(input);
    const ref = entityRefOf(body);

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (id, type, entity_kind, entity_id, source, ts, profile, payload, admin, operator, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        body.type,
        ref.kind,
        ref.id,
        input.source,
        ts,
        profile,
        JSON.stringify(body),
        audit ? 1 : 0,
        audit ? audit.operator : null,
        audit ? audit.note : null,
      );

    if (result.changes === 0) {
      // Duplicate id — return the already-stored event unchanged.
      const existing = this.db
        .prepare("SELECT * FROM events WHERE id = ?")
        .get(id) as EventRow | undefined;
      if (existing) return rowToEvent(existing);
    }

    const seq = Number(result.lastInsertRowid);
    const event: HeraldEvent = { seq, id, ts, source: input.source, profile, ...body } as HeraldEvent;
    if (audit) {
      event.admin = true;
      event.operator = audit.operator;
      event.note = audit.note;
    }
    reduceMulti(this.hot, event);
    if (++this.appendsSinceSnapshot >= this.snapshotEvery) {
      this.writeSnapshot();
    }
    return event;
  }

  /**
   * Events with `seq` strictly greater than `afterSeq`, oldest first. The inbox.
   * The legate drains the WHOLE (multiplexed) stream with one cursor; an optional
   * `profile` filter is for operators/observability only.
   */
  readAfter(afterSeq: number, limit: number, profile?: string): HeraldEvent[] {
    const rows = profile
      ? (this.db
          .prepare("SELECT * FROM events WHERE seq > ? AND profile = ? ORDER BY seq ASC LIMIT ?")
          .all(afterSeq, profile, limit) as unknown as EventRow[])
      : (this.db
          .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
          .all(afterSeq, limit) as unknown as EventRow[]);
    return rows.map(rowToEvent);
  }

  /** Events that moved state from `fromSeq` to `toSeq` — `(fromSeq, toSeq]`. */
  range(fromSeq: number, toSeq: number): HeraldEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq ASC")
      .all(fromSeq, toSeq) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  /** The highest assigned seq (0 when empty). */
  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null };
    return row?.m ?? 0;
  }

  /** Total event count. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return row.c;
  }

  /** The full multi-profile projection (fold of every event). Defensive clone. */
  multiProjection(): MultiProfileState {
    return structuredClone(this.hot);
  }

  /** The projection for one profile (empty when the profile has no events yet). */
  projectionFor(profile: string): SystemState {
    const sys = this.hot.byProfile[profile];
    return sys ? structuredClone(sys) : emptySystemState();
  }

  /** The default profile's projection — back-compat single-profile view. */
  projection(): SystemState {
    return this.projectionFor(this.defaultProfile);
  }

  /** The multi-profile projection as of `seq` (snapshot ≤ `seq`, folded forward). */
  multiStateAt(seq: number): MultiProfileState {
    const snap = this.db
      .prepare("SELECT seq, state FROM snapshots WHERE seq <= ? ORDER BY seq DESC LIMIT 1")
      .get(seq) as { seq: number; state: string } | undefined;
    const base = snap ? (JSON.parse(snap.state) as MultiProfileState) : emptyMultiProfileState();
    const fromSeq = snap ? snap.seq : 0;
    return foldEventsMulti(this.range(fromSeq, seq), base);
  }

  /** One profile's projection as of `seq` (the legate's per-profile cold-start). */
  stateAtFor(profile: string, seq: number): SystemState {
    return this.multiStateAt(seq).byProfile[profile] ?? emptySystemState();
  }

  /** The default profile's projection as of `seq` — back-compat single view. */
  stateAt(seq: number): SystemState {
    return this.stateAtFor(this.defaultProfile, seq);
  }

  /** Persist the current projection as a snapshot for fast cold-start. */
  writeSnapshot(): void {
    this.appendsSinceSnapshot = 0;
    if (this.hot.seq === 0) return;
    this.db
      .prepare("INSERT OR REPLACE INTO snapshots (seq, state, created_at) VALUES (?, ?, ?)")
      .run(this.hot.seq, JSON.stringify(this.hot), new Date().toISOString());
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
