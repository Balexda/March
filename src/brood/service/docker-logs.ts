import { spawn } from "node:child_process";

/** Upper bound on one `docker logs` read before it is killed. */
export const DOCKER_LOGS_TIMEOUT_MS = 15_000;

/** Combined stdout+stderr cap; a larger log is a read failure, not a truncation. */
export const DOCKER_LOGS_MAX_BYTES = 16 * 1024 * 1024;

export interface DockerLogsOptions {
  /** Binary to run (tests point this at a fake `docker`). */
  readonly bin?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/**
 * Read `docker logs <containerId>` without blocking the event loop.
 *
 * Docker replays a non-TTY container's stderr on its own stderr, so both
 * streams are captured, decoded per stream, and kept in arrival order — an
 * error-only container must not read back as an empty successful log. A
 * non-zero exit, spawn
 * failure, timeout, or oversized output rejects, which the logs reader treats
 * as a live-source failure (archive fallback, else the contracted 502).
 */
export function readContainerLogsAsync(
  containerId: string,
  opts: DockerLogsOptions = {},
): Promise<string> {
  const bin = opts.bin ?? "docker";
  const timeoutMs = opts.timeoutMs ?? DOCKER_LOGS_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DOCKER_LOGS_MAX_BYTES;

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const stderrChunks: string[] = [];
    let bytes = 0;
    let failure: string | undefined;
    let settled = false;

    const child = spawn(bin, ["logs", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const fail = (message: string): void => {
      failure ??= message;
      child.kill("SIGKILL");
    };

    const timer = setTimeout(
      () => fail(`timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    // Each stream gets its own UTF-8 decoder, so a multibyte character split
    // across stdout chunks survives an interleaved stderr chunk; only decoded
    // text is merged.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (isStderr: boolean) => (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxBytes) {
        fail(`output exceeded ${maxBytes} bytes`);
        return;
      }
      chunks.push(chunk);
      if (isStderr) stderrChunks.push(chunk);
    };
    child.stdout.on("data", collect(false));
    child.stderr.on("data", collect(true));

    const settle = (err: string | undefined, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(new Error(`docker logs failed for "${containerId}": ${err}`));
      } else {
        resolve(value ?? "");
      }
    };

    child.on("error", (err) => settle(failure ?? err.message));
    child.on("close", (code, signal) => {
      if (failure) return settle(failure);
      if (code !== 0) {
        const tail = stderrChunks.join("").trimEnd();
        return settle(
          tail.length > 0
            ? `exit ${code ?? signal}:\n${tail.slice(-2000)}`
            : `exit ${code ?? signal}`,
        );
      }
      settle(undefined, chunks.join(""));
    });
  });
}
