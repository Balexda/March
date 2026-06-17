import path from "node:path";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { runCommand, describeExecError, type CommandRunner } from "./exec.js";
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

export type UpgradeOutcome = "upgraded" | "skipped" | "failed";

export interface ServiceUpgradeResult {
  readonly service: string;
  /** True when the local image was rebuilt (false for pulled services / build failures). */
  readonly built: boolean;
  readonly outcome: UpgradeOutcome;
  readonly detail?: string;
}

export interface StackUpgradeResult {
  readonly token: ResolvedToken;
  /**
   * Set when `--service` named a service that is not part of the stack: no
   * service was touched and `services` is empty.
   */
  readonly unknownService?: string;
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
    run: CommandRunner;
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
    opts.run(
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
    opts.run(
      "docker",
      ["compose", "-f", composePath, "up", "-d", "--force-recreate"],
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
  const locate = opts.locate ?? ((b: string) => locateCompose(b));
  const token = (opts.resolveToken ?? (() => resolveCastraToken(opts.env)))();

  let targets: readonly MarchService[] = MARCH_SERVICES;
  if (opts.service) {
    const match = MARCH_SERVICES.find((s) => s.name === opts.service);
    if (!match) {
      return { token, unknownService: opts.service, services: [] };
    }
    targets = [match];
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
    services.push(upgradeService(svc, { run, locate, env }));
  }

  return { token, services };
}
