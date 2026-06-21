import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { runCommand, describeExecError, type CommandRunner } from "./exec.js";
import { MARCH_SERVICES, locateCompose, type MarchService } from "./services.js";
import { resolveCastraToken, type ResolvedToken } from "./up.js";

/**
 * `march upgrade` — recreate the running service containers so they adopt the
 * latest available `march-*` images, in dependency order. It is the "roll the
 * stack onto new images" counterpart to `march up` (which only starts what is
 * stopped and never recreates a running container).
 *
 * `march upgrade` **never builds** and never reads a Dockerfile, so it works
 * from a plain `npm i -g @balexda/march` with no source tree present. It
 * operates on the **locally available** images — the local image store, "the
 * local registry." Producing those images is a separate concern:
 *
 * - Developers with the source rebuild them with the npm `build:*-image`
 *   scripts (`npm run build:images`), then run `march upgrade` to roll the
 *   containers onto them — `npm run deploy:local` chains both.
 * - Pulling prebuilt images from a *hosted* registry (so an npm/brew install
 *   with no source can fetch fresh images) is tracked in issue #438; until that
 *   lands, `upgrade` rolls whatever images are already present locally.
 *
 * Each service is recreated with `docker compose up -d --force-recreate
 * --no-build`. `--force-recreate` replaces the container even when the compose
 * config is unchanged — which is what picks up a new `:latest` image — while
 * preserving named volumes (registries, Herald's event log, telemetry); only
 * the container is replaced, not its state. Services are walked in dependency
 * order (otel-lgtm → castra → … → legate) so a service comes back up after the
 * ones it depends on. `--service <name>` scopes the operation to a single
 * service.
 *
 * Best-effort and per-service: a recreate failure marks that service failed but
 * the remaining services still upgrade.
 */

export type UpgradeOutcome = "upgraded" | "failed";

export interface ServiceUpgradeResult {
  readonly service: string;
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
  /** Injected compose locator (defaults to {@link locateCompose}). */
  readonly locate?: (basename: string) => string | null;
  /** Injected token resolver (defaults to {@link resolveCastraToken}). */
  readonly resolveToken?: () => ResolvedToken;
  /** Base env for compose interpolation (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Recreate a service's container from the latest available image, preserving
 * named volumes. `--force-recreate` replaces the container even when the
 * compose config is unchanged, which is what picks up a new `:latest` image.
 * `--no-build` keeps the recreate honest: it must adopt an image that already
 * exists locally and fail loudly otherwise, never silently trigger compose's
 * own `build:` section (mirrors `march up`'s no-build guarantee).
 */
function recreateService(
  svc: MarchService,
  opts: {
    run: CommandRunner;
    locate: (basename: string) => string | null;
    env: NodeJS.ProcessEnv;
  },
): ServiceUpgradeResult {
  const composePath = opts.locate(svc.compose);
  if (!composePath) {
    return {
      service: svc.name,
      outcome: "failed",
      detail: `could not locate docker/${svc.compose}`,
    };
  }
  try {
    opts.run(
      "docker",
      ["compose", "-f", composePath, "up", "-d", "--force-recreate", "--no-build"],
      opts.env,
    );
    return { service: svc.name, outcome: "upgraded" };
  } catch (err) {
    return { service: svc.name, outcome: "failed", detail: describeExecError(err) };
  }
}

/** Recreate the March service stack onto the latest local images. See {@link StackUpgradeOptions}. */
export async function stackUpgrade(
  opts: StackUpgradeOptions = {},
): Promise<StackUpgradeResult> {
  const run = opts.run ?? runCommand;
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
    services.push(recreateService(svc, { run, locate, env }));
  }

  return { token, services };
}
