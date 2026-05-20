import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnRecordDir } from "../spawn-record.js";
import { getDatabaseSync, type BroodDatabase } from "./sqlite.js";
import type {
  ListSessionsFilter,
  RegisterSessionInput,
  SessionRecord,
  SessionStatus,
  UpdateSessionInput,
} from "./types.js";

/** Registry schema version. Bumped only on a breaking migration. */
export const BROOD_SCHEMA_VERSION = 1;

/** Absolute path to `<home>/.march/brood/`. */
export function broodDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".march", "brood");
}

/** Absolute path to the registry sqlite file. */
export function registryDbPath(homeDir?: string): string {
  return path.join(broodDir(homeDir), "registry.db");
}

/** Absolute path to a session's teardown archive directory. */
export function broodArchiveDir(id: string, homeDir?: string): string {
  return path.join(broodDir(homeDir), "archive", id);
}

export interface SessionStoreOptions {
  /** Home directory override (defaults to `os.homedir()`). */
  readonly homeDir?: string;
  /** Explicit db path (e.g. `":memory:"` for tests). Overrides `homeDir`. */
  readonly dbPath?: string;
  /** Import existing `~/.march/spawns/*.json` on open (default true). */
  readonly importSpawnRecords?: boolean;
  /** Best-effort warning sink for skipped/malformed records. */
  readonly warn?: (message: string) => void;
}

/** Ordered registry columns — single source of truth for read/write mapping. */
const COLUMNS = [
  "id",
  "kind",
  "status",
  "parent_id",
  "repo_path",
  "branch",
  "worktree_path",
  "container_id",
  "agentdeck_session_id",
  "profile",
  "ad_group",
  "backend",
  "image_id",
  "exit_code",
  "failure_reason",
  "created_at",
  "updated_at",
  "started_at",
  "stopped_at",
  "torndown_at",
] as const;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  parent_id            TEXT,
  repo_path            TEXT,
  branch               TEXT,
  worktree_path        TEXT,
  container_id         TEXT,
  agentdeck_session_id TEXT,
  profile              TEXT,
  ad_group             TEXT,
  backend              TEXT,
  image_id             TEXT,
  exit_code            INTEGER,
  failure_reason       TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  started_at           TEXT,
  stopped_at           TEXT,
  torndown_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_kind_status ON sessions(kind, status);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
`;

// `excluded.col` for every column except the primary key and created_at (which
// must survive an upsert). Built once from COLUMNS so it can't drift.
const UPSERT_SET_SQL = COLUMNS.filter(
  (c) => c !== "id" && c !== "created_at",
)
  .map((c) => `${c} = excluded.${c}`)
  .join(",\n  ");

const PERSIST_SQL = `
INSERT INTO sessions (${COLUMNS.join(", ")})
VALUES (${COLUMNS.map(() => "?").join(", ")})
ON CONFLICT(id) DO UPDATE SET
  ${UPSERT_SET_SQL}
`;

interface SqliteRow {
  [key: string]: string | number | null;
}

/** Shape of a persisted SpawnRecord we read during import (loosely typed so it
 *  tolerates forward-compatible fields added by later milestones). */
interface ImportedSpawnRecord {
  id?: unknown;
  status?: unknown;
  repoPath?: unknown;
  branch?: unknown;
  worktreePath?: unknown;
  containerId?: unknown;
  imageId?: unknown;
  exitCode?: unknown;
  backend?: unknown;
  createdAt?: unknown;
  startedAt?: unknown;
  stoppedAt?: unknown;
  stewardSessionId?: unknown;
  failureReason?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Copy only the keys of `changes` whose value is not `undefined` onto `base`. */
function mergeDefined<T extends object>(base: T, changes: Partial<T>): T {
  const out = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function rowToRecord(row: SqliteRow): SessionRecord {
  const record: SessionRecord = {
    id: row.id as string,
    kind: row.kind as SessionRecord["kind"],
    status: row.status as SessionStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
  const optional: Array<[keyof SessionRecord, string]> = [
    ["parentId", "parent_id"],
    ["repoPath", "repo_path"],
    ["branch", "branch"],
    ["worktreePath", "worktree_path"],
    ["containerId", "container_id"],
    ["agentDeckSessionId", "agentdeck_session_id"],
    ["profile", "profile"],
    ["group", "ad_group"],
    ["backend", "backend"],
    ["imageId", "image_id"],
    ["failureReason", "failure_reason"],
    ["startedAt", "started_at"],
    ["stoppedAt", "stopped_at"],
    ["torndownAt", "torndown_at"],
  ];
  for (const [field, column] of optional) {
    const value = row[column];
    if (value != null) {
      (record as unknown as Record<string, unknown>)[field] = value;
    }
  }
  if (row.exit_code != null) record.exitCode = row.exit_code as number;
  return record;
}

function recordToValues(record: SessionRecord): Array<string | number | null> {
  return [
    record.id,
    record.kind,
    record.status,
    record.parentId ?? null,
    record.repoPath ?? null,
    record.branch ?? null,
    record.worktreePath ?? null,
    record.containerId ?? null,
    record.agentDeckSessionId ?? null,
    record.profile ?? null,
    record.group ?? null,
    record.backend ?? null,
    record.imageId ?? null,
    record.exitCode ?? null,
    record.failureReason ?? null,
    record.createdAt,
    record.updatedAt,
    record.startedAt ?? null,
    record.stoppedAt ?? null,
    record.torndownAt ?? null,
  ];
}

/**
 * The brood session registry, backed by `node:sqlite`. Synchronous API: the
 * single-threaded Fastify server serializes access naturally, and WAL +
 * busy_timeout tolerate the JSON-import scan racing a live dispatch.
 */
export class SessionStore {
  private readonly db: BroodDatabase;
  private readonly warn: (message: string) => void;

  constructor(options: SessionStoreOptions = {}) {
    this.warn =
      options.warn ?? ((message) => process.stderr.write(`${message}\n`));

    const dbPath = options.dbPath ?? registryDbPath(options.homeDir);
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const DatabaseSync = getDatabaseSync();
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();

    if (options.importSpawnRecords !== false) {
      this.importSpawnRecords(options.homeDir);
    }
  }

  private migrate(): void {
    this.db.exec(CREATE_TABLE_SQL);
    const row = this.db
      .prepare("SELECT version FROM schema_meta LIMIT 1")
      .get() as { version?: number } | undefined;
    if (row?.version === undefined) {
      this.db
        .prepare("INSERT INTO schema_meta (version) VALUES (?)")
        .run(BROOD_SCHEMA_VERSION);
    }
    // Future breaking changes branch on `row.version` here.
  }

  private persist(record: SessionRecord): void {
    this.db.prepare(PERSIST_SQL).run(...recordToValues(record));
  }

  /** Register a session, or merge new fields into an existing one (idempotent). */
  register(input: RegisterSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const existing = this.get(input.id);
    const base: SessionRecord = existing ?? {
      id: input.id,
      kind: input.kind,
      status: input.status ?? "created",
      createdAt: now,
      updatedAt: now,
    };
    const { id: _id, ...rest } = input;
    void _id;
    const merged = mergeDefined(base, { ...rest, updatedAt: now });
    this.persist(merged);
    return merged;
  }

  /** Apply a lifecycle update. Returns `undefined` if the session is unknown. */
  update(id: string, changes: UpdateSessionInput): SessionRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = mergeDefined(existing, {
      ...changes,
      updatedAt: new Date().toISOString(),
    });
    this.persist(merged);
    return merged;
  }

  /** Fetch a single session by id. */
  get(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SqliteRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** List sessions, optionally filtered by kind/status/parentId. */
  list(filter: ListSessionsFilter = {}): SessionRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.parentId) {
      clauses.push("parent_id = ?");
      params.push(filter.parentId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions${where} ORDER BY created_at ASC`)
      .all(...params) as SqliteRow[];
    return rows.map(rowToRecord);
  }

  /** Mark a session torn down. Returns `undefined` if the session is unknown. */
  markTorndown(id: string): SessionRecord | undefined {
    return this.update(id, {
      status: "torndown",
      torndownAt: new Date().toISOString(),
    });
  }

  /**
   * Import existing per-spawn JSON records into the registry so a brood that
   * starts after spawns already exist still owns them. Never overwrites a row
   * that already exists (sqlite is authoritative). Uses a tolerant read: a
   * malformed file is skipped with a warning rather than failing the scan.
   */
  importSpawnRecords(homeDir?: string): void {
    const dir = spawnRecordDir(homeDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // no spawns dir yet — nothing to import
    }
    const now = new Date().toISOString();
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      const parsed = this.readSpawnRecordTolerant(filePath);
      if (!parsed) continue;
      const id = str(parsed.id);
      if (!id || this.get(id)) continue; // unknown id or already owned
      this.persist({
        id,
        kind: "spawn",
        status: (str(parsed.status) as SessionStatus) ?? "created",
        repoPath: str(parsed.repoPath),
        branch: str(parsed.branch),
        worktreePath: str(parsed.worktreePath),
        containerId: str(parsed.containerId),
        agentDeckSessionId: str(parsed.stewardSessionId),
        backend: str(parsed.backend),
        imageId: str(parsed.imageId),
        exitCode: num(parsed.exitCode),
        failureReason: str(parsed.failureReason),
        createdAt: str(parsed.createdAt) ?? now,
        updatedAt: now,
        startedAt: str(parsed.startedAt),
        stoppedAt: str(parsed.stoppedAt),
      });
    }
  }

  private readSpawnRecordTolerant(
    filePath: string,
  ): ImportedSpawnRecord | undefined {
    // Safe-read protocol: one retry on parse failure (catches a concurrent
    // dispatch mid-write), then skip-and-warn.
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf-8");
      } catch {
        return undefined;
      }
      try {
        return JSON.parse(raw) as ImportedSpawnRecord;
      } catch {
        if (attempt === 1) {
          this.warn(`brood: skipping unreadable spawn record at "${filePath}"`);
        }
      }
    }
    return undefined;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
