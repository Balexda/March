/**
 * @l1 @deterministic @ci
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ExecError, execCommand, KeyedSerializer } from "./exec.js";

const node = process.execPath;

describe("execCommand (real child processes)", () => {
  it("resolves with captured stdout", async () => {
    await expect(
      execCommand(node, ["-e", "process.stdout.write('hello')"], { capture: true, timeoutMs: 10_000 }),
    ).resolves.toBe("hello");
  });

  it("discards stdout when capture is false", async () => {
    await expect(
      execCommand(node, ["-e", "process.stdout.write('hello')"], { capture: false, timeoutMs: 10_000 }),
    ).resolves.toBe("");
  });

  it("rejects a non-zero exit with the captured stderr", async () => {
    const err = await execCommand(
      node,
      ["-e", "process.stderr.write('composer is occupied or unreadable\\n'); process.exit(3)"],
      { capture: true, timeoutMs: 10_000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).stderr).toBe("composer is occupied or unreadable");
    expect((err as ExecError).exitCode).toBe(3);
    expect((err as ExecError).timedOut).toBe(false);
  });

  it("SIGKILLs a child that outlives its timeout, without waiting for it", async () => {
    const started = Date.now();
    const err = await execCommand(node, ["-e", "setTimeout(() => {}, 30000)"], {
      capture: true,
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).timedOut).toBe(true);
    expect((err as Error).message).toMatch(/timed out after 200ms and was killed/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("rejects at the timeout even while a descendant holds stderr open, and kills it", async () => {
    // The child spawns a grandchild that inherits stderr and outlives it; the
    // grandchild's pid goes to a file (stdout is discarded on timeout).
    const dir = mkdtempSync(path.join(os.tmpdir(), "castra-exec-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const script = "const { spawn } = require('node:child_process'); const fs = require('node:fs');"
      + "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'ignore', 'inherit'] });"
      + `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setTimeout(() => {}, 30000);`;
    try {
      const started = Date.now();
      const err = await execCommand(node, ["-e", script], { capture: true, timeoutMs: 1_000 }).catch((e: unknown) => e);
      expect((err as ExecError).timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_500);
      // The grandchild was recorded before the timeout fired.
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      // Killing the group took the grandchild too: poll until it has stopped.
      // Gone (ESRCH) counts; so does a zombie on Linux, which kill(pid, 0) still
      // reaches until its adoptive parent reaps it. EPERM is alive.
      const zombie = () => {
        try {
          // /proc/<pid>/stat: "pid (comm) S ...": the state follows the last ")".
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
        } catch {
          return false;
        }
      };
      const alive = () => {
        try {
          process.kill(pid, 0);
        } catch (e) {
          return (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
        return !zombie();
      };
      const deadline = Date.now() + 3_000;
      while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects at once on output over maxBuffer, even while a descendant holds stdout open", async () => {
    const script = "const { spawn } = require('node:child_process');"
      + "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref();"
      + "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 30000);";
    const started = Date.now();
    const err = await execCommand(node, ["-e", script], { capture: true, timeoutMs: 10_000, maxBuffer: 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).timedOut).toBe(false);
    expect((err as Error).message).toMatch(/output exceeded 1024 bytes/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("carries the spawn error code for a missing command", async () => {
    const err = await execCommand("castra-no-such-binary-xyz", [], { capture: true, timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(["ENOENT", "EACCES"]).toContain((err as ExecError).code);
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      execCommand("castra-no-such-binary-xyz", [], { capture: true, timeoutMs: 10_000 }),
    ).rejects.toThrow(/spawn castra-no-such-binary-xyz (ENOENT|EACCES)/);
  });

  it("keeps the event loop free while a child runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await execCommand(node, ["-e", "setTimeout(() => {}, 300)"], { capture: false, timeoutMs: 10_000 });
    } finally {
      clearInterval(timer);
    }
    // execFileSync would have frozen the loop for the whole 300ms (0 ticks).
    expect(ticks).toBeGreaterThan(3);
  });
});

describe("KeyedSerializer", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("runs calls for one key one at a time, in order", async () => {
    const serializer = new KeyedSerializer();
    const order: string[] = [];
    const first = deferred();
    const a = serializer.run("s1", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = serializer.run("s1", async () => {
      order.push("b:start");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("runs calls for different keys concurrently", async () => {
    const serializer = new KeyedSerializer();
    const order: string[] = [];
    const gate = deferred();
    const a = serializer.run("s1", async () => {
      order.push("s1:start");
      await gate.promise;
    });
    const b = serializer.run("s2", async () => {
      order.push("s2:start");
    });
    await b;
    expect(order).toEqual(["s1:start", "s2:start"]);
    gate.resolve();
    await a;
  });

  it("keeps the chain going after a failure and drops idle keys", async () => {
    const serializer = new KeyedSerializer();
    await expect(serializer.run("s1", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(serializer.run("s1", async () => "ok")).resolves.toBe("ok");
    await new Promise((r) => setTimeout(r, 0));
    expect(serializer.activeKeys()).toEqual([]);
  });
});
