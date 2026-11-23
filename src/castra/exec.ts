import { spawn } from "node:child_process";

/**
 * Async child-process execution for Castra's request path.
 *
 * Castra used to drive agent-deck, tmux, and git with `execFileSync`. One stuck
 * steward made that fatal: each `agent-deck session send` to a session whose
 * composer was blocked took ~15s before agent-deck refused it, and for those 15s
 * the whole event loop was frozen — `/healthz` took 14s, Docker's healthcheck
 * timed out, and every Hatchery spawn-time call failed "Could not reach Castra".
 *
 * Every Castra child process now goes through {@link execCommand}: it never
 * blocks the event loop, always has a timeout, and kills with SIGKILL when the
 * timeout fires (a wedged agent-deck must not outlive the request).
 */

/** Cap on captured stdout/stderr, matching the old `execFileSync` maxBuffer. */
export const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

export interface ExecOptions {
  /** Capture stdout and resolve with it. False discards stdout and resolves `""`. */
  readonly capture: boolean;
  /** Kill the child with SIGKILL and reject after this many ms. */
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
}

/**
 * Run `cmd args` and resolve with its stdout. Rejects with an {@link ExecError}
 * on a non-zero exit, a spawn failure (ENOENT), a timeout, or output over
 * `maxBuffer`. Tests inject a fake with this signature.
 */
export type ExecFn = (cmd: string, args: readonly string[], opts: ExecOptions) => Promise<string>;

/** A failed child process. `stderr` carries the captured stderr text. */
export class ExecError extends Error {
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  /** The spawn failure's errno code (`ENOENT` when the executable is missing). */
  readonly code?: string;
  constructor(
    message: string,
    details: { stderr?: string; timedOut?: boolean; exitCode?: number | null; code?: string } = {},
  ) {
    super(message);
    this.name = "ExecError";
    this.stderr = details.stderr ?? "";
    this.timedOut = details.timedOut ?? false;
    this.exitCode = details.exitCode ?? null;
    this.code = details.code;
  }
}

/** The real {@link ExecFn}: `spawn` with stdin closed, a SIGKILL timeout, and a buffer cap. */
export const execCommand: ExecFn = (cmd, args, opts) =>
  new Promise<string>((resolve, reject) => {
    const maxBuffer = opts.maxBuffer ?? EXEC_MAX_BUFFER;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args as string[], {
        stdio: ["ignore", opts.capture ? "pipe" : "ignore", "pipe"],
        env: opts.env ?? process.env,
      });
    } catch (err) {
      reject(new ExecError((err as Error).message, { code: (err as NodeJS.ErrnoException).code }));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    timer.unref?.();

    const stderrText = () => Buffer.concat(stderr).toString("utf-8").trimEnd();
    const fail = (err: ExecError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stderr.push(chunk);
    });

    child.on("error", (err) => {
      fail(new ExecError(err.message, { stderr: stderrText(), code: (err as NodeJS.ErrnoException).code }));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        fail(
          new ExecError(`${cmd} timed out after ${opts.timeoutMs}ms and was killed`, {
            stderr: stderrText(),
            timedOut: true,
          }),
        );
        return;
      }
      if (overflow) {
        fail(new ExecError(`${cmd} output exceeded ${maxBuffer} bytes`, { stderr: stderrText() }));
        return;
      }
      if (code !== 0) {
        const reason = signal ? `killed by ${signal}` : `exit code ${code}`;
        fail(
          new ExecError(`Command failed: ${cmd} (${reason})`, {
            stderr: stderrText(),
            exitCode: code,
          }),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(stdout).toString("utf-8"));
    });
  });

/**
 * Serialize async work per key: calls for one key run one at a time in arrival
 * order, calls for different keys run concurrently. Castra keys sends by
 * session so two prompts to one steward are never typed into its composer at
 * the same time. A failed call does not break the chain.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      // Drop the entry once nothing newer is queued, so the map stays bounded.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with work queued or running (for tests and diagnostics). */
  activeKeys(): string[] {
    return [...this.tails.keys()];
  }
}
