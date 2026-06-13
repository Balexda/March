import { SessionStore, type SessionStoreOptions } from "./store.js";
import type { ExtractionResult } from "./extraction-result.js";
import type {
  ListSessionsFilter,
  RegisterSessionInput,
  SessionRecord,
  UpdateSessionInput,
} from "./types.js";

/**
 * Storage seam for the brood session registry.
 *
 * The registry is intentionally swappable: a `node:sqlite` file for local/dev
 * (the default), a managed DB (e.g. Postgres) for SaaS (issue #167, part of
 * #166). Every consumer — routes, teardown, the server — depends on this
 * interface, never the concrete sqlite class, so the backend can change with no
 * caller edits.
 *
 * The method shape mirrors {@link SessionStore} 1:1 and is intentionally
 * synchronous: the single-threaded Fastify server serializes access, and a sync
 * contract keeps every caller unchanged. A network-backed impl that needs async
 * I/O is a follow-up that would widen this contract (and its callers) together.
 */
export interface SessionRepository {
  /** Register a session, or merge new fields into an existing one (idempotent). */
  register(input: RegisterSessionInput): SessionRecord;
  /** Apply a lifecycle update. Returns `undefined` if the session is unknown. */
  update(id: string, changes: UpdateSessionInput): SessionRecord | undefined;
  /** Store one current extraction result for a spawn. */
  recordExtractionResult(
    id: string,
    result: ExtractionResult,
  ): SessionRecord | undefined;
  /** Fetch a single session by id. */
  get(id: string): SessionRecord | undefined;
  /** List sessions, optionally filtered by kind/status/parentId. */
  list(filter?: ListSessionsFilter): SessionRecord[];
  /** Mark a session torn down. Returns `undefined` if the session is unknown. */
  markTorndown(id: string): SessionRecord | undefined;
  /** Release the underlying store (db handle, connection pool). */
  close(): void;
}

/**
 * Registry backend selector. `sqlite` is the only implemented backend today;
 * `postgres` is the typed extension point for the managed-DB SaaS impl (a
 * follow-up to #166).
 */
export type SessionRepositoryBackend = "sqlite" | "postgres";

/**
 * Config for {@link createSessionRepository}. Extends the sqlite options with a
 * backend selector and a connection string for a managed-DB backend.
 */
export interface SessionRepositoryConfig extends SessionStoreOptions {
  /** Which backend to construct. Defaults to `sqlite`. */
  readonly backend?: SessionRepositoryBackend;
  /** Connection string for a managed DB backend (e.g. `MARCH_BROOD_DB_URL`). */
  readonly connectionString?: string;
}

/**
 * Construct the brood session repository for the configured backend. This is the
 * single seam callers go through; switching to a managed DB is a config change,
 * not a code change at the call sites.
 */
export function createSessionRepository(
  config: SessionRepositoryConfig = {},
): SessionRepository {
  const backend = config.backend ?? "sqlite";
  switch (backend) {
    case "sqlite":
      return new SessionStore(config);
    case "postgres":
      return createPostgresSessionRepository(config);
    default: {
      // Exhaustiveness guard: a new backend in the union must be handled here.
      const unreachable: never = backend;
      throw new Error(`Unknown brood store backend "${String(unreachable)}".`);
    }
  }
}

/**
 * Extension point for the managed-DB (Postgres) registry. Not implemented yet —
 * the seam exists so the SaaS impl drops in here without touching any caller.
 * Implementing this is what lets us drop the `node:sqlite` / Node-22.5 floor and
 * the `describe.skipIf(!sqliteAvailable)` guards in the brood service tests.
 */
export function createPostgresSessionRepository(
  _config: SessionRepositoryConfig,
): SessionRepository {
  throw new Error(
    "The Postgres-backed brood registry is not implemented yet. " +
      "Set MARCH_BROOD_STORE=sqlite (the default) to use the local registry.",
  );
}
