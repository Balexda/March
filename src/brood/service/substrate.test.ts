import { describe, expect, it } from "vitest";
import { removeSpawnContainer } from "../../spawn/container-launch.js";
import { removeSpawnWorktreeExact } from "../worktree.js";
import { hostTeardownSubstrate } from "./substrate.js";

describe("hostTeardownSubstrate", () => {
  it("reclaims the container through removeSpawnContainer (host docker socket)", () => {
    expect(hostTeardownSubstrate.removeContainer).toBe(removeSpawnContainer);
  });

  it("reclaims the checkout through removeSpawnWorktreeExact (exact path, never prune — #155)", () => {
    expect(hostTeardownSubstrate.removeWorktreeExact).toBe(
      removeSpawnWorktreeExact,
    );
  });
});
