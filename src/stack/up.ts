import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpanStatusCode } from "@opentelemetry/api";
import { getActiveOtel } from "../observability/otel.js";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import {
  runCommand,
  imageExists,
  describeExecError,
  readTmuxServerHost,
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
  /** GitHub tokens may still reach steward panes; `march up` must exit non-zero. */
  readonly credentialScrubFailed?: boolean;
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
 * `os.hostname()` and tmux `#{host}` can differ in case across platforms;
 * normalize before comparing for ownership so a casing mismatch isn't read as a
 * foreign server. Original hostnames are still surfaced in result details.
 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export interface EnsureHostTmuxOptions {
  /**
   * Reads the default tmux server's host (defaults to a real `#{host}` probe).
   * Used to detect a foreign-owned socket before creating the anchor.
   */
  readonly readServerHost?: (env: NodeJS.ProcessEnv) => string | null;
  /** This host's name (defaults to `os.hostname()`). */
  readonly localHost?: string;
}

const GITHUB_TMUX_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"];

function scrubTmuxGitHubTokens(tmux: (args: string[]) => string | void): boolean {
  const otel = getActiveOtel();
  const span = otel.enabled ? otel.getTracer().startSpan("stack.tmux.scrub_github_tokens") : undefined;
  try {
    const scopes = [["-g"]];
    const sessions = tmux(["list-sessions", "-F", "#{session_id}"]) ?? "";
    for (const session of sessions.trim().split("\n").filter(Boolean)) {
      scopes.push(["-t", session]);
    }
    for (const scope of scopes) {
      const value = tmux(["show-options", "-qv", ...scope, "update-environment"]) ?? "";
      const patterns = value.trim().split(/\s+/).filter(Boolean);
      const retained = patterns.filter(pattern =>
        !GITHUB_TMUX_TOKENS.some(token => path.matchesGlob(token, pattern)));
      if (retained.length !== patterns.length) {
        tmux(["set-option", ...scope, "update-environment", retained.join(" ")]);
      }
      for (const token of GITHUB_TMUX_TOKENS) {
        tmux(["set-environment", ...scope, scope[0] === "-g" ? "-u" : "-r", token]);
      }
    }
    return true;
  } catch {
    span?.setStatus({ code: SpanStatusCode.ERROR });
    return false;
  } finally {
    span?.end();
  }
}

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
  opts: EnsureHostTmuxOptions = {},
): TmuxAnchorResult {
  const localHost = opts.localHost ?? os.hostname();
  const tmuxEnv = { ...env };
  // Castra addresses the default socket even if march up runs in another tmux server.
  delete tmuxEnv.TMUX;
  for (const token of GITHUB_TMUX_TOKENS) delete tmuxEnv[token];
  const tmux = (args: string[]) => run("tmux", args, tmuxEnv);

  let anchorPresent = false;
  try {
    tmux(["has-session", "-t", HOST_TMUX_ANCHOR_SESSION]);
    anchorPresent = true;
  } catch {
    // A server can be running without an anchor.
  }
  const serverHost = anchorPresent ? localHost : (opts.readServerHost ?? readTmuxServerHost)(tmuxEnv);
  if (serverHost && normalizeHost(serverHost) !== normalizeHost(localHost)) {
    return {
      outcome: "failed",
      detail:
        `default tmux server is owned by "${serverHost}", not this host ` +
        `("${localHost}") — likely the march-castra container; run ` +
        "`march down && march up` to reclaim the host tmux server before castra starts",
    };
  }
  const scrubFailed = {
    outcome: "failed",
    detail: "Could not scrub GitHub credentials from the host tmux environment.",
    credentialScrubFailed: true,
  } as const;
  if (serverHost && !scrubTmuxGitHubTokens(tmux)) return scrubFailed;
  if (anchorPresent) return { outcome: "present" };
  try {
    tmux(["new-session", "-d", "-E", "-s", HOST_TMUX_ANCHOR_SESSION]);
  } catch (err) {
    return { outcome: "failed", detail: describeExecError(err) };
  }
  if (!serverHost && !scrubTmuxGitHubTokens(tmux)) return scrubFailed;
  return { outcome: "created" };
}

/**
 * Whether `march up` must exit non-zero: a service failed to start, or the
 * GitHub credential scrub failed so steward panes could inherit host tokens.
 * Other anchor failures stay advisory.
 */
export function stackUpFailed(result: Pick<StackUpResult, "tmuxAnchor" | "services">): boolean {
  return result.tmuxAnchor?.credentialScrubFailed === true ||
    result.services.some(svc => svc.outcome === "failed");
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
  /**
   * Injected reader for the default tmux server's host (defaults to a real
   * `#{host}` probe via {@link readTmuxServerHost}). Lets the anchor detect a
   * foreign-owned socket before claiming host ownership.
   */
  readonly readServerHost?: (env: NodeJS.ProcessEnv) => string | null;
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

  // The tmux anchor must NOT carry CASTRA_API_TOKEN: tmux exports the server's
  // environment into every pane it spawns, which would leak the bearer into
  // interactive operator shells. Only the docker compose calls below need it.
  const tmuxEnv: NodeJS.ProcessEnv = { ...env };
  delete tmuxEnv[CASTRA_TOKEN_ENV];

  // Claim the host tmux server before castra starts, so its sessions (and the
  // operator's own shells) land on the host rather than inside the container.
  const tmuxAnchor = ensureHostTmuxServer(run, tmuxEnv, {
    readServerHost: opts.readServerHost ?? readTmuxServerHost,
  });

  const services: ServiceUpResult[] = [];
  // Forward dependency order: otel-lgtm (network owner) first, legate last.
  for (const svc of MARCH_SERVICES) {
    services.push(upService(svc, { run, locate, env }));
  }

  return { token, missingImages, tmuxAnchor, services };
}
