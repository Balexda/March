import type { BroodDatabase } from "./sqlite.js";
import { parseIntegrationOutcome } from "./integration.js";
import type { IntegrationAttemptState, PrIntegrationResult, RegisterIntegrationAttempt } from "./types.js";

export interface IntegrationRegistry {
  registerIntegrationAttempt(input: RegisterIntegrationAttempt): IntegrationAttemptState;
  writeIntegrationOutcome(attemptId: string, outcome: PrIntegrationResult): PrIntegrationResult;
  readIntegrationAttempt(attemptId: string): IntegrationAttemptState;
  readIntegrationOutcome(spawnId: string): PrIntegrationResult | null;
  confirmIntegrationFailure(attemptId: string): IntegrationAttemptState;
}

export class IntegrationStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationStateConflictError";
  }
}

interface AttemptRow {
  spawn_id: string | null;
  steward_deadline: string | null;
  fenced: 0 | 1;
  outcome_json: string | null;
}

function readOutcome(row: AttemptRow | undefined): PrIntegrationResult | null {
  if (!row?.outcome_json) return null;
  const outcome = parseIntegrationOutcome(JSON.parse(row.outcome_json));
  if (!outcome) throw new Error("Invalid persisted Brood integration outcome");
  return outcome;
}

/** Attempts outlive session rows and have no role in teardown. */
export class SqliteIntegrationRegistry implements IntegrationRegistry {
  constructor(private readonly db: BroodDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_attempts (
        generation INTEGER PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE,
        spawn_id TEXT,
        steward_deadline TEXT,
        fenced INTEGER NOT NULL DEFAULT 0,
        outcome_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_integration_attempts_spawn
        ON integration_attempts(spawn_id, generation);
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private find(attemptId: string): AttemptRow | undefined {
    return this.db.prepare(
      "SELECT spawn_id, steward_deadline, fenced, outcome_json FROM integration_attempts WHERE attempt_id = ?",
    ).get(attemptId) as AttemptRow | undefined;
  }

  readIntegrationAttempt(attemptId: string): IntegrationAttemptState {
    const row = this.find(attemptId);
    return {
      attemptId,
      spawnId: row?.spawn_id ?? null,
      stewardDeadline: row?.steward_deadline ?? null,
      fenced: row?.fenced === 1,
      outcome: readOutcome(row),
    };
  }

  readIntegrationOutcome(spawnId: string): PrIntegrationResult | null {
    const row = this.db.prepare(`
      SELECT outcome_json FROM integration_attempts
      WHERE spawn_id = ? ORDER BY generation DESC LIMIT 1
    `).get(spawnId) as AttemptRow | undefined;
    return readOutcome(row);
  }

  registerIntegrationAttempt(input: RegisterIntegrationAttempt): IntegrationAttemptState {
    const { attemptId, spawnId, stewardDeadline } = input;
    return this.transaction(() => {
      const row = this.find(attemptId);
      if (row) {
        if (row.fenced || row.spawn_id !== spawnId || row.steward_deadline !== stewardDeadline) {
          throw new IntegrationStateConflictError("Integration attempt is fenced or already bound");
        }
        return this.readIntegrationAttempt(attemptId);
      }
      this.db.prepare(
        "UPDATE integration_attempts SET fenced = 1 WHERE spawn_id = ? AND fenced = 0",
      ).run(spawnId);
      this.db.prepare(
        "INSERT INTO integration_attempts (attempt_id, spawn_id, steward_deadline) VALUES (?, ?, ?)",
      ).run(attemptId, spawnId, stewardDeadline);
      return this.readIntegrationAttempt(attemptId);
    });
  }

  writeIntegrationOutcome(attemptId: string, outcome: PrIntegrationResult): PrIntegrationResult {
    const parsed = parseIntegrationOutcome(outcome);
    if (!parsed) throw new IntegrationStateConflictError("Invalid terminal integration outcome");
    const serialized = JSON.stringify(parsed);
    return this.transaction(() => {
      const row = this.find(attemptId);
      if (!row || row.fenced || row.spawn_id !== parsed.spawnId || !row.steward_deadline) {
        throw new IntegrationStateConflictError("Integration attempt is fenced or unbound");
      }
      if (row.outcome_json) {
        if (row.outcome_json === serialized) return parsed;
        throw new IntegrationStateConflictError("Integration attempt already has a terminal outcome");
      }
      const deadline = Date.parse(row.steward_deadline);
      if ((parsed.status !== "failed" || parsed.failureReason !== "timeout") &&
          (Date.now() >= deadline || Date.parse(parsed.completedAt) >= deadline)) {
        throw new IntegrationStateConflictError("Integration attempt exceeded its Steward deadline");
      }
      if (parsed.status === "succeeded" && !this.db.prepare(
        "SELECT 1 FROM sessions WHERE id = ? AND kind = 'spawn'",
      ).get(parsed.spawnId)) {
        throw new IntegrationStateConflictError("Successful integration requires a registered spawn");
      }
      this.db.prepare(
        "UPDATE integration_attempts SET outcome_json = ? WHERE attempt_id = ?",
      ).run(serialized, attemptId);
      return parsed;
    });
  }

  confirmIntegrationFailure(attemptId: string): IntegrationAttemptState {
    return this.transaction(() => {
      // An unregistered attempt gets a tombstone that blocks delayed registration.
      // A committed outcome always wins over a competing confirmation.
      this.db.prepare(`
        INSERT INTO integration_attempts (attempt_id, fenced) VALUES (?, 1)
        ON CONFLICT(attempt_id) DO UPDATE SET fenced = 1
        WHERE integration_attempts.outcome_json IS NULL
      `).run(attemptId);
      return this.readIntegrationAttempt(attemptId);
    });
  }
}
