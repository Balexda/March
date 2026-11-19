/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { execTextInGroup } from "./sense-io.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("execTextInGroup (#601 review)", () => {
  it("resolves stdout and rejects non-zero exits with stderr folded in", async () => {
    await expect(execTextInGroup("sh", ["-c", "echo hi"], { timeout: 5_000 })).resolves.toBe("hi\n");
    await expect(execTextInGroup("sh", ["-c", "echo boom >&2; exit 3"], { timeout: 5_000 }))
      .rejects.toMatchObject({ code: 3, stderr: "boom\n", message: expect.stringContaining("boom") });
  });

  it("kills the whole process group on timeout, including a grandchild holding the pipes", async () => {
    const started = Date.now();
    // The background sleep inherits stdout/stderr, like git's remote helpers do.
    const err = await execTextInGroup("sh", ["-c", "sleep 30 & echo $!; wait"], { timeout: 300, killSignal: "SIGKILL" })
      .catch((e: any) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toMatchObject({ killed: true, signal: "SIGKILL" });
    const grandchild = Number(String(err.stdout).trim());
    expect(grandchild).toBeGreaterThan(0);
    const deadline = Date.now() + 2_000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(alive(grandchild)).toBe(false);
  });
});
