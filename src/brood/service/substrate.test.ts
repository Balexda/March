import { describe, expect, it } from "vitest";
import { removeSpawnContainer } from "../../spawn/container-launch.js";
import { removeSpawnWorktreeExact } from "../worktree.js";
import { hostTeardownSubstrate } from "./substrate.js";

describe("hostTeardownSubstrate", () => {
  it("reclaims the container through removeSpawnContainer (host docker socket)", () => {
    expect(hostTeardownSubstrate.removeContainer).toBe(removeSpawnContainer);
  });

  // Asserts the wiring only; the exact-path / never-prune behavior (#155) is
  // covered by worktree-exact.test.ts.
  it("delegates checkout reclamation to removeSpawnWorktreeExact", () => {
    expect(hostTeardownSubstrate.removeWorktreeExact).toBe(
      removeSpawnWorktreeExact,
    );
  });
});
