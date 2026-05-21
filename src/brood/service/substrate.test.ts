import { describe, expect, it } from "vitest";
import { removeSpawnContainer } from "../../spawn/container-launch.js";
import { removeSpawnWorktreeExact } from "../worktree.js";
import { hostTeardownSubstrate } from "./substrate.js";

describe("hostTeardownSubstrate", () => {
  it("reclaims the spawn through removeSpawnContainer (host docker socket)", () => {
    expect(hostTeardownSubstrate.removeSpawn).toBe(removeSpawnContainer);
  });

  // Asserts the wiring only; the exact-path / never-prune behavior (#155) is
  // covered by worktree-exact.test.ts.
  it("delegates workspace reclamation to removeSpawnWorktreeExact", () => {
    expect(hostTeardownSubstrate.removeWorkspace).toBe(removeSpawnWorktreeExact);
  });
});
