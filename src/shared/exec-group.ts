import { spawn } from "node:child_process";

const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Run a timed child as the leader of its own process group and signal the whole
 * group on timeout (#601 review). Killing
 * only the direct child is not enough: `git fetch`/`pull` start helpers
 * (`git-remote-https`, `fetch-pack`) that inherit the stdout/stderr pipes, so they
 * would outlive the kill and hold the call open past its timeout. Failures include
 * `.stdout` and `.stderr`. A timeout sets `.killed` and `.signal`.
 */
export function execTextInGroup(
  command: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<string> {
  const timeout = options.timeout as number;
  const killSignal = (options.killSignal as NodeJS.Signals | undefined) ?? "SIGKILL";
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Node's own timeout kills the direct child; the timer below (same delay,
    // registered just after, so it fires in the same timers phase) then kills
    // the rest of the group and settles without waiting for the pipes to close.
    const child = spawn(command, args, {
      cwd: options.cwd as string | undefined,
      env: options.env as NodeJS.ProcessEnv | undefined,
      timeout,
      killSignal,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      if (stderr && !String(err.message).includes(stderr)) err.message = err.message + "\n" + stderr;
      reject(err);
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, killSignal);
      } catch {
        // The group already exited.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      killGroup();
      fail(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")} (timed out after ${timeout}ms)`), {
        killed: true,
        signal: killSignal,
      }));
    }, timeout);
    const maxBuffer = typeof options.maxBuffer === "number" ? options.maxBuffer : EXEC_MAX_BUFFER;
    let bytes = 0;
    const collect = (append: (chunk: string) => void) => (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBuffer) {
        killGroup();
        fail(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")} (output exceeded ${maxBuffer} bytes)`), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }));
        return;
      }
      append(chunk);
    };
    child.stdout?.setEncoding("utf-8").on("data", collect((chunk) => { stdout += chunk; }));
    child.stderr?.setEncoding("utf-8").on("data", collect((chunk) => { stderr += chunk; }));
    child.on("error", fail);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        resolve(stdout);
        return;
      }
      fail(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")}`), { code, signal }));
    });
  });
}
