import { execFile } from "node:child_process";

/**
 * Read the smithy graph for a local checkout (`smithy status --format json
 * --pending`). A pure READ — no git sync, no `gh`, no Castra.
 *
 * `--pending` = shorthand for `--status in-progress,not-started`. It filters out
 * all done records up-front; layer 0 of the returned graph still means "ready to
 * dispatch right now".
 *
 * Split out of {@link ../observe/sense-io.ts sense-io.ts} so it can be shared
 * WITHOUT dragging in the gh-based world observation: Herald's observer pulls it
 * via sense-io (the full {@link SenseDeps}), and the legate's Herald-fold sense
 * pulls it via `fold-deps.ts` — letting the legate read its own smithy queue
 * without importing (and thus without owning) the gh sensing path.
 */
export async function readSmithyStatus(repoPath: string): Promise<any> {
  const out = await execText("smithy", ["status", "--format", "json", "--pending"], { cwd: repoPath });
  return JSON.parse(out);
}

// Async command runner: rejects on non-zero exit with the stderr folded into the
// error (mirrors sense-io's execText so failure text reads the same).
function execText(command: string, args: string[], options: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, ...options },
      (err: any, stdout: string, stderr: string) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          if (stderr && !String(err.message).includes(stderr)) {
            err.message = err.message + "\n" + stderr;
          }
          reject(err);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : "");
      },
    );
  });
}
