/**
 * @l1 @deterministic @ci
 */
// Kept outside the governed legacy L2 `snapshot-build.test.ts` (see
// CONTRIBUTING.md#test-layer-migration): this covers only the deadline on the
// rollback's `docker image rm`, not the existing build/remove scenarios.
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMock.execFileSync,
}));

import { removeSpawnImage, SPAWN_IMAGE_RM_TIMEOUT_MS } from "./snapshot-build.js";

afterEach(() => {
  childProcessMock.execFileSync.mockReset();
});

describe("removeSpawnImage deadline", () => {
  it("bounds `docker image rm` so a stalled daemon cannot block rollback", () => {
    removeSpawnImage("20260504-abc123");

    expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
      "docker",
      ["image", "rm", "march-spawn-20260504-abc123"],
      expect.objectContaining({ timeout: SPAWN_IMAGE_RM_TIMEOUT_MS, killSignal: "SIGKILL" }),
    );
  });

  it("swallows a timeout kill like any other removal failure", () => {
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGKILL" });
    });
    expect(() => removeSpawnImage("20260504-abc123")).not.toThrow();
  });
});
