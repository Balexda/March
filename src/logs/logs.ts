import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * `march logs [service]` — tail the logs of one or all March service
 * containers.
 *
 * The defining constraint (issue #399): this must work from a plain
 * `npm i -g march` install with **no source checkout**, so it cannot shell out
 * to `docker compose -f docker/<svc>.docker-compose.yml logs` — those compose
 * files live in the source tree. Instead every service is resolved to its
 * **running container by name** (`docker logs <container>`), with the
 * service→container mapping baked into the CLI below. The names mirror the
 * `container_name:` fields in `docker/*.docker-compose.yml`, read at dev time;
 * the runtime command never touches those files.
 */

/** One March service and the container it runs as. */
export interface LogsService {
  /** Identity/display name the operator types (`march logs <name>`). */
  readonly name: string;
  /** The running container's name (its compose `container_name:`). */
  readonly container: string;
}

/**
 * The six March services, in the canonical bring-up order so the interleaved
 * "all services" view reads dependency-first. Container names are the
 * `container_name:` values from `docker/*.docker-compose.yml`.
 */
export const LOG_SERVICES: readonly LogsService[] = [
  { name: "otel-lgtm", container: "march-otel-lgtm" },
  { name: "castra", container: "march-castra" },
  { name: "hatchery", container: "march-hatchery" },
  { name: "brood", container: "march-brood" },
  { name: "herald", container: "march-herald" },
  { name: "legate", container: "march-legate" },
];

/**
 * Lines whose content reads as error-level, for the `--errors` convenience
 * filter. Matches the common shapes: bare `error`/`fatal`/`panic`/`critical`
 * (covers `ERROR`, `[error]`, and pino's `"level":"error"`). Warnings are not
 * errors and are intentionally excluded.
 */
const ERROR_LINE_RE = /error|fatal|panic|critical/i;

/** Minimal child-process surface the runner needs — `spawn`'s return value. */
export interface LogsChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Spawns `docker logs ...`; injectable so tests don't touch a real daemon. */
export type LogsSpawner = (file: string, args: string[]) => LogsChild;

const defaultSpawner: LogsSpawner = (file, args) =>
  spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });

export interface LogsOptions {
  /** A single service name to scope to; undefined tails all six. */
  readonly service?: string;
  /** Stream new lines as they arrive (`docker logs --follow`). */
  readonly follow?: boolean;
  /** Only show logs since this duration/timestamp (`docker logs --since`). */
  readonly since?: string;
  /** Show at most the last N lines per service (`docker logs --tail`). */
  readonly tail?: string;
  /** Keep only error-level lines (client-side filter). */
  readonly errors?: boolean;
  /** Injected spawner (defaults to a real `docker logs` child). */
  readonly spawn?: LogsSpawner;
  /** Injected sink (defaults to `process.stdout.write`). */
  readonly write?: (chunk: string) => void;
  /** Whether to colorize tags (defaults to stdout being a TTY). */
  readonly color?: boolean;
}

export interface LogsResult {
  /** Per-service exit codes (null = killed by signal, e.g. Ctrl-C). */
  readonly services: { readonly name: string; readonly exitCode: number | null }[];
}

/** ANSI colors cycled across service tags so the interleaved view is legible. */
const TAG_COLORS = [36, 32, 33, 35, 34, 31]; // cyan, green, yellow, magenta, blue, red

/**
 * Resolve the services to tail. With no name, that's all six; with a name, just
 * the matching service. An unknown name throws so the caller can report the
 * valid set (the command surfaces it as a usage error).
 */
export function resolveLogServices(service?: string): readonly LogsService[] {
  if (!service) return LOG_SERVICES;
  const match = LOG_SERVICES.find((s) => s.name === service);
  if (!match) {
    const valid = LOG_SERVICES.map((s) => s.name).join(", ");
    throw new Error(`Unknown service "${service}". Valid services: ${valid}.`);
  }
  return [match];
}

/** Build the `docker logs` argv for one container from the bounding options. */
export function buildDockerLogsArgs(
  container: string,
  opts: Pick<LogsOptions, "follow" | "since" | "tail">,
): string[] {
  const args = ["logs"];
  if (opts.follow) args.push("--follow");
  if (opts.since) args.push("--since", opts.since);
  // Bound the backfill so `march logs` (all six) doesn't dump entire histories.
  args.push("--tail", opts.tail ?? "100");
  args.push(container);
  return args;
}

/**
 * Tail one or all March service containers.
 *
 * Spawns one `docker logs` per resolved service, tags every line with the
 * service name (so the interleaved all-services view stays readable), applies
 * the optional `--errors` filter, and resolves once every child exits. In
 * `--follow` mode it runs until the children are killed — Ctrl-C (SIGINT) is
 * handled here so the children are torn down cleanly.
 */
export async function runLogs(opts: LogsOptions = {}): Promise<LogsResult> {
  const services = resolveLogServices(opts.service);
  const spawner = opts.spawn ?? defaultSpawner;
  const write = opts.write ?? ((chunk: string) => process.stdout.write(chunk));
  const useColor = opts.color ?? Boolean(process.stdout.isTTY);

  // Pad tags to a common width so the interleaved columns line up.
  const tagWidth = Math.max(...services.map((s) => s.name.length));

  const formatTag = (name: string, colorIdx: number): string => {
    const padded = name.padEnd(tagWidth);
    if (!useColor) return `${padded} | `;
    const color = TAG_COLORS[colorIdx % TAG_COLORS.length];
    return `[${color}m${padded}[0m | `;
  };

  const emit = (tag: string, line: string): void => {
    if (opts.errors && !ERROR_LINE_RE.test(line)) return;
    write(`${tag}${line}\n`);
  };

  const children: LogsChild[] = [];
  const results: { name: string; exitCode: number | null }[] = [];

  const exits = services.map(
    (svc, idx) =>
      new Promise<void>((resolve) => {
        const tag = formatTag(svc.name, idx);
        const child = spawner(
          "docker",
          buildDockerLogsArgs(svc.container, opts),
        );
        children.push(child);

        // `docker logs` writes the container's stdout and stderr on the
        // corresponding child streams; app logs land on both, so both are
        // tagged and emitted (stderr is not treated as errors-only).
        for (const stream of [child.stdout, child.stderr]) {
          if (!stream) continue;
          createInterface({ input: stream }).on("line", (line) =>
            emit(tag, line),
          );
        }

        child.on("error", (err) => {
          // `docker` missing / un-spawnable: report and resolve this leg so the
          // others still run.
          emit(tag, `failed to run docker logs: ${err.message}`);
          results.push({ name: svc.name, exitCode: 1 });
          resolve();
        });
        child.on("exit", (code) => {
          results.push({ name: svc.name, exitCode: code });
          resolve();
        });
      }),
  );

  const onSigint = (): void => {
    for (const child of children) child.kill("SIGINT");
  };
  if (opts.follow) process.once("SIGINT", onSigint);

  try {
    await Promise.all(exits);
  } finally {
    if (opts.follow) process.removeListener("SIGINT", onSigint);
  }

  // Preserve canonical service order in the result regardless of exit timing.
  results.sort(
    (a, b) =>
      services.findIndex((s) => s.name === a.name) -
      services.findIndex((s) => s.name === b.name),
  );
  return { services: results };
}
