import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import {
  runCommand,
  imageExists,
  describeExecError,
  type CommandRunner,
} from "./exec.js";
import { MARCH_SERVICES, locateCompose, type MarchService } from "./services.js";

/**
 * `march up` — bring up the full March service stack with one command, the
 * inverse of `march down`.
 *
 * Brings services up in dependency order (otel-lgtm first — it creates the
 * shared `march` network — then castra, then the rest). A shared
 * `CASTRA_API_TOKEN` is resolved once and injected into every service so they
 * agree on the secret; it is generated and persisted on first run and reused
 * thereafter. `up` never builds images: if any locally-built `march-*` image is
 * missing it aborts before starting anything and points the operator at
 * `march upgrade`. Idempotent — re-running on a healthy stack reconciles via
 * `docker compose up -d`.
 */

/** Where the generated shared token is persisted between runs. */
export function defaultTokenPath(home: string = os.homedir()): string {
  return path.join(home, ".march", "castra-token");
}

export interface ResolvedToken {
  readonly token: string;
  readonly source: "env" | "file" | "generated";
  /** Set when the token was read from or written to a file. */
  readonly persistedPath?: string;
}

/** Injectable IO for token resolution (real impl uses fs + crypto). */
export interface TokenIo {
  readonly path: string;
  /** Returns the file contents, or null when the file is absent. */
  readonly read: (path: string) => string | null;
  readonly write: (path: string, content: string) => void;
  readonly generate: () => string;
}

function defaultTokenIo(home?: string): TokenIo {
  const p = defaultTokenPath(home);
  return {
    path: p,
    read: (fp) => {
      try {
        return fs.readFileSync(fp, "utf-8");
      } catch {
        return null;
      }
    },
    write: (fp, content) => {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, { mode: 0o600 });
    },
    generate: () => randomBytes(32).toString("hex"),
  };
}

/**
 * Resolve the shared `CASTRA_API_TOKEN`: an operator-set env value wins; else a
 * previously persisted token is reused; else a fresh token is generated and
 * persisted (mode 0600). The value is never logged.
 */
export function resolveCastraToken(
  env: NodeJS.ProcessEnv = process.env,
  io: TokenIo = defaultTokenIo(),
): ResolvedToken {
  const fromEnv = env[CASTRA_TOKEN_ENV];
  if (fromEnv && fromEnv.trim()) {
    return { token: fromEnv, source: "env" };
  }
  const fromFile = io.read(io.path);
  if (fromFile && fromFile.trim()) {
    return { token: fromFile.trim(), source: "file", persistedPath: io.path };
  }
  const token = io.generate();
  io.write(io.path, token);
  return { token, source: "generated", persistedPath: io.path };
}

export type UpOutcome = "started" | "skipped" | "failed";

export interface ServiceUpResult {
  readonly service: string;
  readonly outcome: UpOutcome;
  readonly detail?: string;
}

export interface MissingImage {
  readonly service: string;
  readonly image: string;
}

export type TmuxAnchorOutcome = "present" | "created" | "failed";

export interface TmuxAnchorResult {
  readonly outcome: TmuxAnchorOutcome;
  readonly detail?: string;
}

export interface StackUpResult {
  readonly token: ResolvedToken;
  /**
   * Non-empty when the pre-flight image check failed: no service was started,
   * and the operator should build the images (`march upgrade`). When present,
   * `services` is empty.
   */
  readonly missingImages: MissingImage[];
  /**
   * Outcome of the host tmux-server anchor (see {@link ensureHostTmuxServer}).
   * Undefined when the run aborted before anchoring (e.g. missing images).
   */
  readonly tmuxAnchor?: TmuxAnchorResult;
  readonly services: ServiceUpResult[];
}

/** The detached tmux session that keeps the host-owned server alive. */
export const HOST_TMUX_ANCHOR_SESSION = "march-host-anchor";

/**
 * Ensure the host owns the default tmux server before castra starts.
 *
 * castra is a containerized agent-deck that drives sessions over the host tmux
 * socket bind-mounted at `/tmp/tmux-<uid>/default`. Whichever process first
 * touches that socket *becomes* the server, and every pane it spawns — stewards
 * and operator shells alike — runs in that process's namespace. Under Docker
 * Desktop the castra container autostarts from the Windows side, so without this
 * anchor it wins the race and all panes land *inside the container* (a bare
 * `node@<container>` bash shell) instead of on the host.
 *
 * `march up` runs on the host as the operator's uid, so creating a detached
 * anchor session here makes the host own that server first; castra then attaches
 * as a client and panes land on the host. This only holds when castra cannot
 * autostart ahead of `march up` — the compose `restart: on-failure` policy is
 * what removes that boot-time race. Best-effort: a missing tmux binary or any
 * tmux error is recorded, never fatal.
 */
export function ensureHostTmuxServer(
  run: CommandRunner,
  env: NodeJS.ProcessEnv,
): TmuxAnchorResult {
  try {
    // Server up and anchor present — idempotent no-op across re-runs.
    run("tmux", ["has-session", "-t", HOST_TMUX_ANCHOR_SESSION], env);
    return { outcome: "present" };
  } catch {
    // No server (or anchor missing): (re)create it. `new-session` starts a
    // server on the default uid socket when none is running.
    try {
      run("tmux", ["new-session", "-d", "-s", HOST_TMUX_ANCHOR_SESSION], env);
      return { outcome: "created" };
    } catch (err) {
      return { outcome: "failed", detail: describeExecError(err) };
    }
  }
}

export interface StackUpOptions {
  /** Injected command runner (defaults to `docker` via `execFileSync`). */
  readonly run?: CommandRunner;
  /** Injected compose-file locator (defaults to {@link locateCompose}). */
  readonly locate?: (basename: string) => string | null;
  /** Injected image-presence check (defaults to {@link imageExists}). */
  readonly imagePresent?: (image: string) => boolean;
  /** Injected token resolver (defaults to {@link resolveCastraToken}). */
  readonly resolveToken?: () => ResolvedToken;
  /** Base env for compose interpolation (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

function upService(
  svc: MarchService,
  opts: {
    run: CommandRunner;
    locate: (basename: string) => string | null;
    env: NodeJS.ProcessEnv;
  },
): ServiceUpResult {
  const composePath = opts.locate(svc.compose);
  if (!composePath) {
    return {
      service: svc.name,
      outcome: "skipped",
      detail: `could not locate docker/${svc.compose}`,
    };
  }
  try {
    // `--no-build` enforces the never-build contract at the compose layer too:
    // a missing image errors here instead of silently building (the pre-flight
    // check should already have caught it). otel-lgtm is pulled, not built.
    opts.run("docker", [
      "compose",
      "-f",
      composePath,
      "up",
      "-d",
      "--no-build",
    ], opts.env);
    return { service: svc.name, outcome: "started" };
  } catch (err) {
    return {
      service: svc.name,
      outcome: "failed",
      detail: describeExecError(err),
    };
  }
}

/** Bring up the March service stack. See {@link StackUpOptions}. */
export async function stackUp(
  opts: StackUpOptions = {},
): Promise<StackUpResult> {
  const run = opts.run ?? runCommand;
  const locate = opts.locate ?? ((b: string) => locateCompose(b));
  const imagePresent = opts.imagePresent ?? imageExists;
  const token = (opts.resolveToken ?? (() => resolveCastraToken(opts.env)))();

  // Pre-flight: every locally-built image must be present. Abort before
  // starting anything rather than leaving a partial stack — building is
  // `march upgrade`'s job.
  const missingImages: MissingImage[] = [];
  for (const svc of MARCH_SERVICES) {
    if (svc.image && !imagePresent(svc.image)) {
      missingImages.push({ service: svc.name, image: svc.image });
    }
  }
  if (missingImages.length > 0) {
    return { token, missingImages, services: [] };
  }

  // Inject the shared token so every service agrees on the secret.
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    [CASTRA_TOKEN_ENV]: token.token,
  };

  // Claim the host tmux server before castra starts, so its sessions (and the
  // operator's own shells) land on the host rather than inside the container.
  const tmuxAnchor = ensureHostTmuxServer(run, env);

  const services: ServiceUpResult[] = [];
  // Forward dependency order: otel-lgtm (network owner) first, legate last.
  for (const svc of MARCH_SERVICES) {
    services.push(upService(svc, { run, locate, env }));
  }

  return { token, missingImages, tmuxAnchor, services };
}
