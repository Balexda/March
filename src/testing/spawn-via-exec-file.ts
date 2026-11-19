import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

type ExecFileCallback = (err: any, stdout?: string, stderr?: string) => void;
type ExecFileMock = (command: string, args: string[], options: unknown, callback: ExecFileCallback) => unknown;

/**
 * Test shim: a `spawn` replacement driven by an existing `execFile` mock, so a
 * test that canned `execFile` output also covers sense-io's timed commands
 * (which spawn into their own process group, #601 review). The fake child
 * emits the canned stdout/stderr, then `close` with the error's exit code.
 */
export function spawnViaExecFile(execFile: ExecFileMock) {
  return (command: string, args: string[], options: unknown) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid?: number };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    execFile(command, args, options, (err, stdout = "", stderr = "") => {
      let open = 2;
      const closed = () => {
        if (--open === 0) child.emit("close", err ? (typeof err.code === "number" ? err.code : 1) : 0, null);
      };
      child.stdout.on("end", closed);
      child.stderr.on("end", closed);
      child.stdout.end(stdout ?? "");
      child.stderr.end(stderr ?? "");
    });
    return child;
  };
}
