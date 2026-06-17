import type { ProfileRecord } from "../herald/profiles/types.js";
import type { SessionRecord } from "../brood/service/types.js";
import type { SystemState } from "../herald/events.js";
import type { CastraSession } from "../castra/types.js";
import type {
  ContainerEnvReader,
  ContainerStateReader,
  GitRunner,
  PathExists,
} from "./probes.js";

/**
 * The dependencies the doctor checks run against, expressed as the narrow
 * surfaces each check actually uses. The real service clients (CastraClient,
 * BroodClient, HeraldClient, ProfileClient) satisfy these structurally; the
 * narrowing keeps the checks unit-testable with in-memory fakes and documents
 * exactly which service calls the diagnostics depend on.
 */

/** Castra session listing (the live interactive-session view). */
export interface CastraView {
  listSessions(profile: string, group?: string): Promise<CastraSession[]>;
}

/**
 * Result of probing Castra's token gate: `accepted` = the bearer passed the
 * gate (any non-auth response), `rejected` = an explicit 401/403, `unverified`
 * = no token to probe with, or an unreachable/erroring backend (NOT an auth
 * fault). Status-aware so a 5xx/outage is never misread as a token rejection.
 */
export type CastraAuthVerdict = "accepted" | "rejected" | "unverified";

/** Brood session-registry view (the tracked-session authority). */
export interface BroodView {
  list(): Promise<SessionRecord[]>;
}

/** Herald fold view (the event-sourced system-state projection). */
export interface HeraldView {
  state(at?: number, profile?: string): Promise<SystemState>;
}

/** The probes + clients a doctor run is wired against. */
export interface DoctorContext {
  /** Profiles in scope (already filtered by `--profile`). */
  readonly profiles: readonly ProfileRecord[];
  readonly castra: CastraView;
  readonly brood: BroodView;
  readonly herald: HeraldView;
  /**
   * Probe Castra's token gate with a specific token (the one read from the
   * service containers), independent of the client's own bearer. Status-aware
   * so token-wiring can distinguish a 401/403 rejection from a backend outage.
   */
  readonly castraAuthProbe: (token: string | undefined) => Promise<CastraAuthVerdict>;
  readonly containerEnv: ContainerEnvReader;
  readonly containerState: ContainerStateReader;
  readonly git: GitRunner;
  readonly pathExists: PathExists;
  /** Base env (the legate cap fallback reads `MARCH_MAX_CONCURRENT_SPAWNS`). */
  readonly env: NodeJS.ProcessEnv;
}
