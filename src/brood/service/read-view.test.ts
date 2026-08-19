/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  CONTAINER_LIVENESS_TIMEOUT_MS,
  defaultContainerLivenessObserver,
} from "./read-view.js";

describe("defaultContainerLivenessObserver", () => {
  it("bounds a hanging probe instead of blocking indefinitely", async () => {
    const started = Date.now();

    // `sleep 30` stands in for a wedged Docker CLI or daemon. The probe must
    // kill it and reject well before the sleep would finish, so the inspect
    // route can degrade to `reconciled: false` rather than pinning the
    // service's single-threaded event loop.
    await expect(
      defaultContainerLivenessObserver("c1", {
        command: "sleep",
        buildArgs: () => ["30"],
        timeoutMs: 100,
      }),
    ).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a definitively absent container rather than throwing", async () => {
    await expect(
      defaultContainerLivenessObserver("c1", {
        command: "sh",
        buildArgs: () => ["-c", 'echo "Error: No such object: c1" >&2; exit 1'],
      }),
    ).resolves.toEqual({ containerId: "c1", present: false });
  });

  it("reads running state from the probe's stdout", async () => {
    await expect(
      defaultContainerLivenessObserver("c1", {
        command: "sh",
        buildArgs: () => ["-c", "echo running"],
      }),
    ).resolves.toEqual({ containerId: "c1", present: true, running: true });

    await expect(
      defaultContainerLivenessObserver("c1", {
        command: "sh",
        buildArgs: () => ["-c", "echo exited"],
      }),
    ).resolves.toEqual({ containerId: "c1", present: true, running: false });
  });

  it("keeps a default bound for the real Docker probe", () => {
    expect(CONTAINER_LIVENESS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(CONTAINER_LIVENESS_TIMEOUT_MS)).toBe(true);
  });
});
