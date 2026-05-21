import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabaseSync, type HeraldDatabase } from "./sqlite.js";
import {
  emptySystemState,
  entityRefOf,
  foldEvents,
  reduce,
  type AppendEventInput,
  type EventBody,
  type HeraldEvent,
  type SystemState,
} from "../events.js";
import type { EventStoreOptions } from "./types.js";

/** Event-store schema version. Bumped only on a breaking migration. */
export const HERALD_SCHEMA_VERSION = 1;

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
  payload      TEXT NOT NULL
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
  payload: string;
}

function rowToEvent(row: EventRow): HeraldEvent {
  const body = JSON.parse(row.payload) as EventBody;
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    source: row.source as HeraldEvent["source"],
    ...body,
  } as HeraldEvent;
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
  private hot: SystemState;
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
    this.migrate();
    this.hot = this.rebuildProjection();
  }

  private migrate(): void {
    this.db.exec(CREATE_TABLE_SQL);
    const row = this.db
      .prepare("SELECT version FROM schema_meta LIMIT 1")
      .get() as { version?: number } | undefined;
    if (row?.version === undefined) {
      this.db
        .prepare("INSERT INTO schema_meta (version) VALUES (?)")
        .run(HERALD_SCHEMA_VERSION);
    }
    // Future breaking changes branch on `row.version` here.
  }

  /** Rebuild the full projection from the latest snapshot + trailing events. */
  private rebuildProjection(): SystemState {
    const snap = this.db
      .prepare("SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; state: string } | undefined;
    const base = snap ? (JSON.parse(snap.state) as SystemState) : emptySystemState();
    const fromSeq = snap ? snap.seq : 0;
    const trailing = this.readAfter(fromSeq, Number.MAX_SAFE_INTEGER);
    return foldEvents(trailing, base);
  }

  /**
   * Append an event. Assigns a monotonic `seq`; fills `id` (uuid) and `ts`
   * (now) when absent. Idempotent on `id` — a duplicate append returns the
   * existing row and does not re-fold.
   */
  append(input: AppendEventInput): HeraldEvent {
    const id = input.id ?? crypto.randomUUID();
    const ts = input.ts ?? new Date().toISOString();
    const body = bodyOf(input);
    const ref = entityRefOf(body);

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (id, type, entity_kind, entity_id, source, ts, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, body.type, ref.kind, ref.id, input.source, ts, JSON.stringify(body));

    if (result.changes === 0) {
      // Duplicate id — return the already-stored event unchanged.
      const existing = this.db
        .prepare("SELECT * FROM events WHERE id = ?")
        .get(id) as EventRow | undefined;
      if (existing) return rowToEvent(existing);
    }

    const seq = Number(result.lastInsertRowid);
    const event: HeraldEvent = { seq, id, ts, source: input.source, ...body } as HeraldEvent;
    reduce(this.hot, event);
    if (++this.appendsSinceSnapshot >= this.snapshotEvery) {
      this.writeSnapshot();
    }
    return event;
  }

  /** Events with `seq` strictly greater than `afterSeq`, oldest first. The inbox. */
  readAfter(afterSeq: number, limit: number): HeraldEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(afterSeq, limit) as unknown as EventRow[];
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

  /** The current projection (fold of every event). Returns a defensive clone. */
  projection(): SystemState {
    return structuredClone(this.hot);
  }

  /** The projection as of `seq` (snapshot at-or-before `seq`, folded forward). */
  stateAt(seq: number): SystemState {
    const snap = this.db
      .prepare("SELECT seq, state FROM snapshots WHERE seq <= ? ORDER BY seq DESC LIMIT 1")
      .get(seq) as { seq: number; state: string } | undefined;
    const base = snap ? (JSON.parse(snap.state) as SystemState) : emptySystemState();
    const fromSeq = snap ? snap.seq : 0;
    return foldEvents(this.range(fromSeq, seq), base);
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
