/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import type { CastraClient } from "../castra/client.js";
import { launchAgentDeckManager, ManagerLaunchAbortedError } from "./spawn-handoff.js";

const input = {
  repoPath: "/repo", spawnId: "spawn-1", branch: "b", title: "t", group: "g", profile: "p",
};

function castra(over: Partial<CastraClient>): CastraClient {
  return {
    launchSession: vi.fn(async () => { throw new Error("aborted"); }),
    listSessions: vi.fn(async () => []),
    ...over,
  } as unknown as CastraClient;
}

describe("launchAgentDeckManager Steward deadline", () => {
  it("passes the deadline signal to Castra", async () => {
    const launchSession = vi.fn(async () => ({
      sessionId: "s", title: "t", group: "g", branch: "b", worktreePath: "/wt", createdAt: "", status: "",
    }));
    const signal = new AbortController().signal;
    await launchAgentDeckManager({ ...input, signal }, castra({ launchSession }));
    expect(launchSession).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });

  it("reports a session Castra created after the deadline aborted the launch", async () => {
    const controller = new AbortController();
    controller.abort();
    const listSessions = vi.fn(async () => [
      { sessionId: "other", title: "", group: "g", branch: "", worktreePath: "/x", createdAt: "", status: "",
        metadata: { spawnId: "spawn-0" } },
      { sessionId: "late", title: "t", group: "g", branch: "b", worktreePath: "/wt", createdAt: "", status: "",
        metadata: { spawnId: "spawn-1" } },
    ]);
    const error = await launchAgentDeckManager({ ...input, signal: controller.signal }, castra({ listSessions }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagerLaunchAbortedError);
    expect((error as ManagerLaunchAbortedError).manager).toMatchObject({ sessionId: "late", worktreePath: "/wt" });
    expect(listSessions).toHaveBeenCalledWith("p", "g", expect.any(AbortSignal));
  });

  it("fails the launch normally when no late session exists", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await launchAgentDeckManager({ ...input, signal: controller.signal }, castra({}))
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ManagerLaunchAbortedError);
    expect((error as Error).message).toMatch(/Castra session launch failed/);
  });
});
