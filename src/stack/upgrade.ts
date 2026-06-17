import path from "node:path";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { runBuild, runCommand, describeExecError, type CommandRunner } from "./exec.js";
import { MARCH_SERVICES, locateCompose, type MarchService } from "./services.js";
import { resolveCastraToken, type ResolvedToken } from "./up.js";

/**
 * `march upgrade` — rebuild the locally-built `march-*:latest` images from
 * source and recreate the running containers so the new images take effect,
 * the build-and-roll counterpart to `march up` (which never builds).
 *
 * Each service is rebuilt from its `docker/<name>.Dockerfile` (mirroring the
 * `build:<name>-image` scripts in `package.json`) and then recreated with
 * `docker compose up -d --force-recreate`. The recreate preserves state: named
 * volumes (registries, Herald's event log, telemetry) survive a `--force-recreate`,
 * which only replaces the container, not its volumes. Services are walked in
 * dependency order (otel-lgtm → castra → … → legate) so a service comes back up
 * after the ones it depends on. otel-lgtm is pulled, not built, so it is
 * recreated without a build. `--service <name>` scopes the whole operation to a
 * single service.
 *
 * Best-effort and per-service: a build failure marks that service failed and
 * skips its recreate (so a stale image is never silently rolled), but the
 * remaining services still upgrade.
 */

export type UpgradeOutcome = "upgraded" | "failed";

export interface ServiceUpgradeResult {
  readonly service: string;
  /** True when the local image was rebuilt (false for pulled services / build failures). */
  readonly built: boolean;
  readonly outcome: UpgradeOutcome;
  readonly detail?: string;
}

export interface StackUpgradeResult {
  /** The shared token used for the recreate. Undefined when the upgrade was rejected before resolving one. */
  readonly token?: ResolvedToken;
  /**
   * Set when `--service` named a service that is not part of the stack: no
   * service was touched, no token was resolved, and `services` is empty.
   */
  readonly unknownService?: string;
  /**
   * Set when a single-service (`--service`) upgrade was refused because no
   * shared `CASTRA_API_TOKEN` already exists (env or persisted file): recreating
   * one container with a freshly minted token would desync it from its
   * still-running siblings. `services` is empty.
   */
  readonly partialUpgradeTokenError?: string;
  readonly services: ServiceUpgradeResult[];
}

export interface StackUpgradeOptions {
  /** Restrict the upgrade to a single service (by {@link MarchService.name}). */
  readonly service?: string;
  /** Injected command runner (defaults to `docker` via `execFileSync`). */
  readonly run?: CommandRunner;
  /** Injected compose/Dockerfile locator (defaults to {@link locateCompose}). */
  readonly locate?: (basename: string) => string | null;
  /** Injected token resolver (defaults to {@link resolveCastraToken}). */
  readonly resolveToken?: () => ResolvedToken;
  /** Base env for compose interpolation (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Rebuild a service's local image from its Dockerfile. The build context is the
 * package root (the dir holding `docker/`), matching the `.` context the
 * `build:<name>-image` scripts use. Returns null detail on success.
 */
function buildImage(
  svc: MarchService,
  opts: {
    buildRun: CommandRunner;
    locate: (basename: string) => string | null;
    env: NodeJS.ProcessEnv;
  },
): { ok: boolean; detail?: string } {
  const dockerfilePath = opts.locate(svc.dockerfile!);
  if (!dockerfilePath) {
    return { ok: false, detail: `could not locate docker/${svc.dockerfile}` };
  }
  // <root>/docker/<name>.Dockerfile → <root> (the build context).
  const context = path.dirname(path.dirname(dockerfilePath));
  try {
    // buildRun streams output (no maxBuffer ceiling) — see runBuild in exec.ts.
    opts.buildRun(
      "docker",
      ["build", "-t", svc.image!, "-f", dockerfilePath, context],
      opts.env,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: describeExecError(err) };
  }
}

/**
 * Recreate a service's container from the (freshly built) image, preserving
 * named volumes. `--force-recreate` replaces the container even when the
 * compose config is unchanged, which is what picks up the new `:latest` image.
 */
function recreateService(
  svc: MarchService,
  opts: {
    run: CommandRunner;
    locate: (basename: string) => string | null;
    env: NodeJS.ProcessEnv;
  },
): { ok: boolean; detail?: string } {
  const composePath = opts.locate(svc.compose);
  if (!composePath) {
    return { ok: false, detail: `could not locate docker/${svc.compose}` };
  }
  try {
    // `--no-build` keeps the recreate honest: it must pick up the image
    // buildImage() just produced and fail loudly otherwise, never silently
    // trigger compose's own `build:` section (mirrors stackUp's guard).
    opts.run(
      "docker",
      ["compose", "-f", composePath, "up", "-d", "--force-recreate", "--no-build"],
      opts.env,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: describeExecError(err) };
  }
}

function upgradeService(
  svc: MarchService,
  opts: {
    run: CommandRunner;
    buildRun: CommandRunner;
    locate: (basename: string) => string | null;
    env: NodeJS.ProcessEnv;
  },
): ServiceUpgradeResult {
  // Pulled services (no Dockerfile/image, e.g. otel-lgtm) are recreated only.
  if (svc.dockerfile && svc.image) {
    const build = buildImage(svc, opts);
    if (!build.ok) {
      // Don't recreate on a failed build — that would roll a stale image.
      return { service: svc.name, built: false, outcome: "failed", detail: build.detail };
    }
    const recreate = recreateService(svc, opts);
    if (!recreate.ok) {
      return { service: svc.name, built: true, outcome: "failed", detail: recreate.detail };
    }
    return { service: svc.name, built: true, outcome: "upgraded" };
  }

  const recreate = recreateService(svc, opts);
  if (!recreate.ok) {
    return { service: svc.name, built: false, outcome: "failed", detail: recreate.detail };
  }
  return { service: svc.name, built: false, outcome: "upgraded" };
}

/** Rebuild + recreate the March service stack. See {@link StackUpgradeOptions}. */
export async function stackUpgrade(
  opts: StackUpgradeOptions = {},
): Promise<StackUpgradeResult> {
  const run = opts.run ?? runCommand;
  // Builds stream their output (runBuild); recreates pipe + capture stderr for
  // the result detail (runCommand). An injected `run` overrides both so tests
  // record every docker invocation through one recorder.
  const buildRun = opts.run ?? runBuild;
  const locate = opts.locate ?? ((b: string) => locateCompose(b));

  // Validate `--service` before resolving the token so an unknown service never
  // generates/persists a fresh ~/.march/castra-token as a side effect.
  let targets: readonly MarchService[] = MARCH_SERVICES;
  if (opts.service) {
    const match = MARCH_SERVICES.find((s) => s.name === opts.service);
    if (!match) {
      return { unknownService: opts.service, services: [] };
    }
    targets = [match];
  }

  const token = (opts.resolveToken ?? (() => resolveCastraToken(opts.env)))();

  // A single-service recreate must reuse the token the rest of the stack is
  // already running with. A freshly *generated* token (no env value, no
  // persisted file) means there is no shared secret to reuse — recreating just
  // one container with a new token would desync it from its still-running
  // siblings (cross-service auth failures). Refuse rather than break the stack;
  // a full `march upgrade` rolls every container onto the new shared token at once.
  if (opts.service && token.source === "generated") {
    return {
      token,
      partialUpgradeTokenError:
        `Cannot upgrade only "${opts.service}" without an existing shared ${CASTRA_TOKEN_ENV}: ` +
        "recreating one container with a freshly generated token would desync it from the " +
        `rest of the stack. Set ${CASTRA_TOKEN_ENV} (or run \`march up\` once to persist a ` +
        "shared token), or run `march upgrade` without --service to roll the whole stack together.",
      services: [],
    };
  }

  // Inject the shared token so compose-file interpolation succeeds on recreate
  // (the service compose files declare CASTRA_API_TOKEN as required).
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    [CASTRA_TOKEN_ENV]: token.token,
  };

  const services: ServiceUpgradeResult[] = [];
  // Forward dependency order: otel-lgtm (network owner) first, legate last.
  for (const svc of targets) {
    services.push(upgradeService(svc, { run, buildRun, locate, env }));
  }

  return { token, services };
}
