import { execFileSync } from "node:child_process";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { MARCH_SERVICES, locateCompose, type MarchService } from "./services.js";

/**
 * Placeholder injected for `CASTRA_API_TOKEN` when the operator hasn't set it.
 * The service compose files declare it as a *required* interpolation variable
 * (`${CASTRA_API_TOKEN:?...}`), so `docker compose down` refuses to even parse
 * them without a value — yet teardown never uses the token (containers match by
 * compose project, not by secret). A non-empty placeholder satisfies the parse
 * without the operator having to recall the real token just to turn the system
 * off. When `march up` (#388) exports the real token, it flows through
 * unchanged.
 */
const TEARDOWN_TOKEN_PLACEHOLDER = "march-down-teardown-placeholder";

/**
 * Build the child env for `compose down`: the operator's env, with the
 * required-but-teardown-irrelevant `CASTRA_API_TOKEN` filled in when absent so
 * compose-file interpolation succeeds. A real token already in the env is left
 * untouched.
 */
export function resolveComposeEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (base[CASTRA_TOKEN_ENV]) return base;
  return { ...base, [CASTRA_TOKEN_ENV]: TEARDOWN_TOKEN_PLACEHOLDER };
}

/**
 * `march down` — stop the full March service stack, the inverse of `march up`.
 *
 * Stops/removes the service containers in reverse dependency order. State is
 * preserved by default (named volumes, worktrees, branches, in-flight
 * sessions); `--volumes` removes the named volumes and `--drain` tears down
 * in-flight Brood sessions first. Best-effort and idempotent: a service that is
 * already down is reported, not an error.
 */

export type DownOutcome = "stopped" | "skipped" | "failed";

export interface ServiceDownResult {
  readonly service: string;
  readonly outcome: DownOutcome;
  readonly detail?: string;
}

export interface DrainResult {
  /** Session ids torn down. */
  readonly tornDown: string[];
  readonly failures: { id: string; detail: string }[];
  /** Set when drain was skipped (e.g. Brood unreachable). */
  readonly note?: string;
}

export interface StackDownResult {
  readonly services: ServiceDownResult[];
  /** Present only when `--drain` was requested. */
  readonly drain?: DrainResult;
}

/** Runs a command, throwing on non-zero exit (the `execFileSync` contract). */
export type CommandRunner = (
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => void;

export interface StackDownOptions {
  /** Also remove named volumes (`docker compose down --volumes`). */
  readonly volumes?: boolean;
  /** Tear down in-flight Brood sessions before stopping services. */
  readonly drain?: boolean;
  /** Injected command runner (defaults to `docker` via `execFileSync`). */
  readonly run?: CommandRunner;
  /** Injected compose-file locator (defaults to {@link locateCompose}). */
  readonly locate?: (basename: string) => string | null;
  /** Injected drain implementation (defaults to {@link drainBroodSessions}). */
  readonly drainSessions?: () => Promise<DrainResult>;
  /** Base env for compose interpolation (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

const defaultRun: CommandRunner = (file, args, env) => {
  execFileSync(file, args, { stdio: ["ignore", "ignore", "pipe"], env });
};

function downService(
  svc: MarchService,
  opts: {
    run: CommandRunner;
    locate: (basename: string) => string | null;
    volumes: boolean;
    env: NodeJS.ProcessEnv;
  },
): ServiceDownResult {
  const composePath = opts.locate(svc.compose);
  if (!composePath) {
    return {
      service: svc.name,
      outcome: "skipped",
      detail: `could not locate docker/${svc.compose}`,
    };
  }
  try {
    const args = ["compose", "-f", composePath, "down"];
    if (opts.volumes) args.push("--volumes");
    opts.run("docker", args, opts.env);
    return {
      service: svc.name,
      outcome: "stopped",
      detail: opts.volumes ? "removed containers + volumes" : "removed containers",
    };
  } catch (err) {
    return {
      service: svc.name,
      outcome: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tear down in-flight Brood sessions (spawn + steward kinds) so the worktrees,
 * branches, and steward containers they hold are recovered before the services
 * that own them are stopped. Best-effort: a Brood that is unreachable yields a
 * note rather than throwing — the operator can still bring the stack down.
 */
export async function drainBroodSessions(): Promise<DrainResult> {
  const { BroodClient } = await import("../brood/service/client.js");
  const client = new BroodClient();
  const tornDown: string[] = [];
  const failures: DrainResult["failures"] = [];

  let sessions;
  try {
    sessions = await client.list({});
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      tornDown,
      failures,
      note: `could not list Brood sessions (${detail}); skipped drain`,
    };
  }

  // Only spawn/steward sessions hold worktrees + steward containers worth
  // recovering; the legate row is the shared service container we stop below.
  // Skip already-finished rows so re-running drain is a no-op.
  const targets = sessions.filter(
    (s) =>
      (s.kind === "spawn" || s.kind === "steward") && s.status !== "torndown",
  );

  for (const s of targets) {
    try {
      await client.teardown(s.id, { force: true, reason: "march down --drain" });
      tornDown.push(s.id);
    } catch (err) {
      failures.push({
        id: s.id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tornDown, failures };
}

/** Stop the March service stack. See {@link StackDownOptions}. */
export async function stackDown(
  opts: StackDownOptions = {},
): Promise<StackDownResult> {
  const run = opts.run ?? defaultRun;
  const locate = opts.locate ?? ((b: string) => locateCompose(b));
  const env = resolveComposeEnv(opts.env ?? process.env);

  let drain: DrainResult | undefined;
  if (opts.drain) {
    const drainFn = opts.drainSessions ?? drainBroodSessions;
    drain = await drainFn();
  }

  const services: ServiceDownResult[] = [];
  // Reverse dependency order: legate first, otel-lgtm (network owner) last.
  for (const svc of [...MARCH_SERVICES].reverse()) {
    services.push(
      downService(svc, { run, locate, volumes: opts.volumes ?? false, env }),
    );
  }

  return { services, drain };
}
