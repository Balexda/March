import { execFile } from "node:child_process";

const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Run a command, resolving stdout as text; rejects on non-zero exit. The
 * rejection mirrors execFileSync's error shape (message folds in stderr, plus
 * `.stdout`/`.stderr`/`.code`) so callers that inspect failure text keep working.
 */
export function execText(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf-8", maxBuffer: MAX_BUFFER, ...options },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
          e.stdout = stdout;
          e.stderr = stderr;
          if (stderr && !String(e.message).includes(stderr)) e.message = `${e.message}\n${stderr}`;
          reject(e);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : "");
      },
    );
  });
}
