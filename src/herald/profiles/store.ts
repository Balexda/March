import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabaseSync, type HeraldDatabase } from "../service/sqlite.js";
import { parseMergePolicy } from "./merge-policy.js";
import type {
  ListProfilesOptions,
  ProfileRecord,
  ProfileStatus,
  ProfileStoreOptions,
  RegisterProfileInput,
} from "./types.js";

/** Profile-registry schema version. Bumped only on a breaking migration.
 *  v2 added the nullable `merge_policy` TEXT column (per-task-type merge gates). */
export const PROFILE_SCHEMA_VERSION = 2;

/**
 * Absolute path to the profile-registry sqlite file. Deliberately a SEPARATE
 * file from the event log (`events.db`) so the registry can be lifted into a
 * standalone profile service without a data migration — and so the registry
 * never JOINs against the event log.
 */
export function profilesDbPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".march", "herald", "profiles.db");
}

/** Ordered registry columns — single source of truth for read/write mapping. */
const COLUMNS = [
  "profile",
  "repo_name",
  "repo_path",
  "worker_group",
  "conductor_name",
  "brood_endpoint",
  "march_cli_path",
  "mode",
  "merge_policy",
  "status",
  "created_at",
  "updated_at",
] as const;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS profiles (
  profile        TEXT PRIMARY KEY,
  repo_name      TEXT NOT NULL,
  repo_path      TEXT NOT NULL,
  worker_group   TEXT NOT NULL,
  conductor_name TEXT,
  brood_endpoint TEXT,
  march_cli_path TEXT,
  mode           TEXT,
  merge_policy   TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE TABLE IF NOT EXISTS profile_schema_meta (version INTEGER NOT NULL);
`;

// `excluded.col` for every column except the primary key and created_at (which
// must survive an upsert). Built once from COLUMNS so it can't drift.
const UPSERT_SET_SQL = COLUMNS.filter((c) => c !== "profile" && c !== "created_at")
  .map((c) => `${c} = excluded.${c}`)
  .join(",\n  ");

const PERSIST_SQL = `
INSERT INTO profiles (${COLUMNS.join(", ")})
VALUES (${COLUMNS.map(() => "?").join(", ")})
ON CONFLICT(profile) DO UPDATE SET
  ${UPSERT_SET_SQL}
`;

interface SqliteRow {
  [key: string]: string | number | null;
}

function rowToRecord(row: SqliteRow): ProfileRecord {
  const record: ProfileRecord = {
    profile: row.profile as string,
    repoName: row.repo_name as string,
    repoPath: row.repo_path as string,
    workerGroup: row.worker_group as string,
    status: (row.status as ProfileStatus) ?? "active",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
  const optional: Array<[keyof ProfileRecord, string]> = [
    ["conductorName", "conductor_name"],
    ["broodEndpoint", "brood_endpoint"],
    ["marchCliPath", "march_cli_path"],
    ["mode", "mode"],
  ];
  for (const [field, column] of optional) {
    const value = row[column];
    if (value != null) (record as unknown as Record<string, unknown>)[field] = value;
  }
  const mergePolicy = parseMergePolicy(row.merge_policy as string | null);
  if (mergePolicy) (record as unknown as Record<string, unknown>).mergePolicy = mergePolicy;
  return record;
}

function recordToValues(record: ProfileRecord): Array<string | null> {
  return [
    record.profile,
    record.repoName,
    record.repoPath,
    record.workerGroup,
    record.conductorName ?? null,
    record.broodEndpoint ?? null,
    record.marchCliPath ?? null,
    record.mode ?? null,
    record.mergePolicy != null ? JSON.stringify(record.mergePolicy) : null,
    record.status,
    record.createdAt,
    record.updatedAt,
  ];
}

/**
 * The profile registry, backed by `node:sqlite`. Synchronous API: the
 * single-threaded Fastify server serializes access naturally. This is Herald's
 * source of truth for which profiles exist; it intentionally shares no schema or
 * statements with the event log so it can be extracted into a profile service.
 */
export class ProfileStore {
  private readonly db: HeraldDatabase;

  constructor(options: ProfileStoreOptions = {}) {
    const dbPath = options.dbPath ?? profilesDbPath(options.homeDir);
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
  }

  private migrate(): void {
    this.db.exec(CREATE_TABLE_SQL);
    const row = this.db
      .prepare("SELECT version FROM profile_schema_meta LIMIT 1")
      .get() as { version?: number } | undefined;
    if (row?.version === undefined) {
      // Fresh DB: CREATE_TABLE_SQL already includes every column, so just stamp
      // the current version.
      this.db
        .prepare("INSERT INTO profile_schema_meta (version) VALUES (?)")
        .run(PROFILE_SCHEMA_VERSION);
      return;
    }

    // v1 → v2: add the `merge_policy` column. CREATE_TABLE_SQL above is a no-op
    // on an existing table, so an old DB still lacks the column — add it with an
    // `ALTER` guarded by a column-existence check (a fresh DB created from the
    // current CREATE_TABLE_SQL already has it, and an unguarded ALTER would throw
    // "duplicate column name").
    if (row.version < 2) {
      if (!this.hasColumn("profiles", "merge_policy")) {
        this.db.exec("ALTER TABLE profiles ADD COLUMN merge_policy TEXT;");
      }
      this.db.prepare("UPDATE profile_schema_meta SET version = ?").run(2);
    }
    // Future breaking changes branch on `row.version` here.
  }

  private hasColumn(table: string, column: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  }

  /** Register a profile, or merge new fields into an existing one (idempotent). */
  register(input: RegisterProfileInput): ProfileRecord {
    const now = new Date().toISOString();
    const existing = this.get(input.profile, { includeRemoved: true });
    const record: ProfileRecord = {
      profile: input.profile,
      repoName: input.repoName,
      repoPath: input.repoPath,
      workerGroup: input.workerGroup,
      conductorName: input.conductorName ?? existing?.conductorName,
      broodEndpoint: input.broodEndpoint ?? existing?.broodEndpoint,
      marchCliPath: input.marchCliPath ?? existing?.marchCliPath,
      mode: input.mode ?? existing?.mode,
      // Preserve an existing policy when a plain re-register (e.g. `march legate
      // init`) omits it; an explicit policy on the input replaces it.
      mergePolicy: input.mergePolicy ?? existing?.mergePolicy,
      // A re-register defaults to reactivating (status omitted → active), so
      // `march legate init` on a previously-removed profile brings it back.
      status: input.status ?? "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.prepare(PERSIST_SQL).run(...recordToValues(record));
    return record;
  }

  /** Fetch a single profile by name (active only unless `includeRemoved`). */
  get(profile: string, options: ListProfilesOptions = {}): ProfileRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM profiles WHERE profile = ?")
      .get(profile) as SqliteRow | undefined;
    if (!row) return undefined;
    const record = rowToRecord(row);
    if (!options.includeRemoved && record.status === "removed") return undefined;
    return record;
  }

  /** List profiles, active-only by default. */
  list(options: ListProfilesOptions = {}): ProfileRecord[] {
    const where = options.includeRemoved ? "" : " WHERE status = 'active'";
    const rows = this.db
      .prepare(`SELECT * FROM profiles${where} ORDER BY profile ASC`)
      .all() as SqliteRow[];
    return rows.map(rowToRecord);
  }

  /** Soft-delete a profile. Returns the updated record, or undefined if unknown. */
  remove(profile: string): ProfileRecord | undefined {
    const existing = this.get(profile, { includeRemoved: true });
    if (!existing) return undefined;
    const updated: ProfileRecord = {
      ...existing,
      status: "removed",
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(PERSIST_SQL).run(...recordToValues(updated));
    return updated;
  }

  /** Total profile count (including removed). */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM profiles").get() as { c: number };
    return row.c;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
