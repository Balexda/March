/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  classForReason,
  isAgentDeclined,
  isHeldPolicy,
  lastAgentMessage,
  launchFailureFromReason,
  MAX_AGENT_MESSAGE_CHARS,
  NO_COMMIT_MARKER,
  parseLaunchFailure,
  parseLsTreeBlobs,
  redactSecrets,
} from "./launch-failure.js";
import { dispatchReasonCode } from "./dispatch-reason.js";

// The exact shape of the live tessera us3-s1 spawn log's tail.
const DECLINED_LOG = [
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"cat specs/x.tasks.md"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Reading the task file."}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Slice 1 is blocked. The tasks file requires the parent spec to resolve SD-001 and SD-006 before implementation.\\n\\nThe working tree is clean."}}',
  '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
  "march-spawn: " + NO_COMMIT_MARKER,
].join("\n");

describe("agent_declined detection", () => {
  it("exit 3 with the scaffold's no-commit marker is a deliberate decline", () => {
    expect(isAgentDeclined(3, DECLINED_LOG)).toBe(true);
    expect(isAgentDeclined(1, DECLINED_LOG)).toBe(false);
    expect(isAgentDeclined(3, "something else")).toBe(false);
  });

  it("the agent's LAST message is the evidence", () => {
    expect(lastAgentMessage(DECLINED_LOG)).toMatch(/^Slice 1 is blocked\. .*SD-001 and SD-006/s);
  });

  it("bounds and redacts the message", () => {
    const long = '{"type":"agent_message","text":"' + "x".repeat(5000) + ' ghp_' + "a".repeat(36) + '"}';
    const msg = lastAgentMessage(long)!;
    expect(msg.length).toBeLessThanOrEqual(MAX_AGENT_MESSAGE_CHARS);
    expect(redactSecrets("token ghp_" + "a".repeat(36))).toBe("token [redacted]");
    expect(redactSecrets("key sk-" + "b".repeat(40) + " end")).toBe("key [redacted] end");
  });

  it("the legacy reason code no longer lumps exit 3 into other", () => {
    expect(dispatchReasonCode(new Error("Spawn 20261128-70a87c exited 3; manager prompt was not sent. Logs: /x"))).toBe("agent_declined");
  });
});

describe("classes and policies", () => {
  it("maps bounded reason codes to classes with today's auto retry", () => {
    expect(launchFailureFromReason("castra_error")).toEqual({ class: "castra_error", retry: "auto", reason: "castra_error" });
    expect(classForReason("tessera:unreachable")).toBe("tessera_unreachable");
    expect(classForReason("tessera:unconfigured")).toBe("auth");
    expect(classForReason("something-new")).toBe("other");
    expect(launchFailureFromReason("agent_declined").retry).toBe("until_input_changes");
  });

  it("only adopt/operator/until_input_changes hold", () => {
    expect(isHeldPolicy("auto")).toBe(false);
    expect(isHeldPolicy(undefined)).toBe(false);
    expect(isHeldPolicy("operator")).toBe(true);
    expect(isHeldPolicy("adopt")).toBe(true);
    expect(isHeldPolicy("until_input_changes")).toBe(true);
  });
});

describe("parseLaunchFailure", () => {
  it("accepts a known class + policy and keeps only bounded evidence", () => {
    const parsed = parseLaunchFailure({
      class: "branch_collision", retry: "operator", reason: "branch_collision",
      evidence: {
        branch: "feature/x", commits: ["ada24ade" + "0".repeat(32), "not-a-sha"], commitCount: 1,
        touchedFileCount: 13, stderr: "secret output", prNumbers: [0, 7],
      },
    });
    expect(parsed).toEqual({
      class: "branch_collision", retry: "operator", reason: "branch_collision",
      evidence: { branch: "feature/x", commits: ["ada24ade" + "0".repeat(32)], commitCount: 1, touchedFileCount: 13, prNumbers: [7] },
    });
  });

  it("rejects unknown classes and policies (never a new label)", () => {
    expect(parseLaunchFailure({ class: "made_up", retry: "auto" })).toBeUndefined();
    expect(parseLaunchFailure({ class: "other", retry: "sometimes" })).toBeUndefined();
    expect(parseLaunchFailure("castra_error")).toBeUndefined();
  });
});

describe("parseLsTreeBlobs", () => {
  it("reports each path's blob, null when absent", () => {
    const out = "100644 blob 1111111111111111111111111111111111111111\tspecs/a.tasks.md\0";
    expect(parseLsTreeBlobs(out, ["specs/a.tasks.md", "specs/a.spec.md"])).toEqual([
      { path: "specs/a.tasks.md", blob: "1111111111111111111111111111111111111111" },
      { path: "specs/a.spec.md", blob: null },
    ]);
  });

  it("a ./-prefixed path resolves to the same blob, keeping the caller's spelling", () => {
    const out = "100644 blob 1111111111111111111111111111111111111111\tspecs/a.tasks.md\0";
    expect(parseLsTreeBlobs(out, ["./specs/a.tasks.md"])).toEqual([
      { path: "./specs/a.tasks.md", blob: "1111111111111111111111111111111111111111" },
    ]);
  });

  it("matches a name git would quote without -z (non-ASCII)", () => {
    const out = "100644 blob 2222222222222222222222222222222222222222\tspecs/café.tasks.md\0";
    expect(parseLsTreeBlobs(out, ["specs/café.tasks.md"])).toEqual([
      { path: "specs/café.tasks.md", blob: "2222222222222222222222222222222222222222" },
    ]);
  });
});
