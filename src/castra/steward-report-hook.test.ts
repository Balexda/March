/**
 * @l1 @deterministic @ci
 *
 * Unit tests for the steward self-report hook's pure classification (#371).
 * The hook ships verbatim into ~/.march/steward/hooks; we import it from the
 * template source. Its main() is guarded so importing has no side effects.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  classify,
  clampSummary,
  extractLastAssistantMessage,
  sessionFileFor,
  stewardRootFromHook,
} from "../templates/steward/hooks/steward-report.mjs";
import { stewardSessionFilePath } from "./steward-skills.js";

function transcript(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

function assistant(content: unknown): unknown {
  return { type: "assistant", message: { role: "assistant", content } };
}

describe("extractLastAssistantMessage", () => {
  it("returns the last assistant message's text, joining text blocks", () => {
    const t = transcript([
      assistant([{ type: "text", text: "older" }]),
      { type: "user", message: { role: "user", content: "go" } },
      assistant([
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ]),
    ]);
    expect(extractLastAssistantMessage(t)).toEqual({
      text: "line 1\nline 2",
      usedAskUserQuestion: false,
    });
  });

  it("flags an AskUserQuestion tool_use in the last assistant message", () => {
    const t = transcript([
      assistant([
        { type: "text", text: "Which approach?" },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ]),
    ]);
    expect(extractLastAssistantMessage(t)?.usedAskUserQuestion).toBe(true);
  });

  it("tolerates a string content body and skips unparseable lines", () => {
    const t = ["{ broken", JSON.stringify(assistant("plain string body")), ""].join("\n");
    expect(extractLastAssistantMessage(t)).toEqual({
      text: "plain string body",
      usedAskUserQuestion: false,
    });
  });

  it("returns null when there is no assistant message", () => {
    expect(extractLastAssistantMessage("")).toBeNull();
    expect(extractLastAssistantMessage(JSON.stringify({ type: "user" }))).toBeNull();
  });
});

describe("classify", () => {
  it("a bare Notification with no readable message → classified:false (not awaiting_input)", () => {
    // The ~60s idle-timeout Notification fires on a *finished* steward too, so
    // the event alone is not evidence of awaiting input (#459 false positives).
    expect(classify(null, "Notification")).toEqual({ classified: false });
  });

  it("Notification is classified off the transcript, not the event: a completion message → reported", () => {
    const r = classify(
      { text: "PR opened successfully. Standing by.\nPR: https://github.com/o/r/pull/7", usedAskUserQuestion: false },
      "Notification",
    );
    expect(r).toMatchObject({ status: "reported", classified: true });
  });

  it("a finished-then-idle Notification with a 'Done' message → working, not awaiting_input", () => {
    expect(
      classify({ text: "Done — zero unresolved threads remain on PR #433.", usedAskUserQuestion: false }, "Notification"),
    ).toMatchObject({ status: "working", classified: true });
  });

  it("an AskUserQuestion on a Notification → awaiting_input", () => {
    expect(
      classify({ text: "Which approach?", usedAskUserQuestion: true }, "Notification"),
    ).toMatchObject({ status: "awaiting_input", classified: true });
  });

  it("a PR url → reported", () => {
    const r = classify(
      { text: "Done.\nPR: https://github.com/Balexda/March/pull/372", usedAskUserQuestion: false },
      "Stop",
    );
    expect(r).toMatchObject({ status: "reported", classified: true });
    expect(r.summary).toContain("/pull/372");
  });

  it("a bare github pull url anywhere → reported", () => {
    const r = classify(
      { text: "opened https://github.com/o/r/pull/9 for review", usedAskUserQuestion: false },
      "Stop",
    );
    expect(r.status).toBe("reported");
  });

  it("AskUserQuestion on Stop → awaiting_input", () => {
    expect(
      classify({ text: "Pick one.", usedAskUserQuestion: true }, "Stop"),
    ).toMatchObject({ status: "awaiting_input", classified: true });
  });

  it("a NEED: escalation line → awaiting_input", () => {
    expect(
      classify(
        { text: "NEED: cannot resolve conflict — operator must choose ours/theirs", usedAskUserQuestion: false },
        "Stop",
      ).status,
    ).toBe("awaiting_input");
  });

  it("a trailing question → awaiting_input", () => {
    expect(
      classify({ text: "I finished the diff.\nShould I force-push?", usedAskUserQuestion: false }, "Stop").status,
    ).toBe("awaiting_input");
  });

  it("substantive progress with no PR/question → working", () => {
    expect(
      classify({ text: "Ran the tests and committed the fix.", usedAskUserQuestion: false }, "Stop"),
    ).toMatchObject({ status: "working", classified: true });
  });

  it("an unreadable message on Stop → classified:false with no status", () => {
    expect(classify(null, "Stop")).toEqual({ classified: false });
    expect(classify({ text: "", usedAskUserQuestion: false }, "Stop")).toEqual({ classified: false });
  });
});

describe("clampSummary", () => {
  it("trims and caps overlong text", () => {
    expect(clampSummary("  hi  ")).toBe("hi");
    const long = "x".repeat(600);
    const out = clampSummary(long, 500);
    expect(out.length).toBe(500);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("path helpers", () => {
  it("derives the steward root from the hook's <root>/hooks location", () => {
    expect(stewardRootFromHook("/srv/steward/hooks/steward-report.mjs")).toBe(
      path.join("/srv", "steward"),
    );
  });

  it("keys the session sidecar by a full-path hash with a readable basename prefix", () => {
    const file = sessionFileFor("/srv/steward", "/repos/feature-march-spawn-x");
    expect(path.dirname(file)).toBe(path.join("/srv/steward", "sessions"));
    expect(path.basename(file)).toMatch(/^feature-march-spawn-x-[0-9a-f]{12}\.json$/);
  });

  it("does not collide on same-basename worktrees in different repos", () => {
    expect(sessionFileFor("/srv/steward", "/repos/march/feature-x")).not.toBe(
      sessionFileFor("/srv/steward", "/repos/smithy/feature-x"),
    );
  });

  it("agrees byte-for-byte with Castra's stewardSessionFilePath (writer/reader parity)", () => {
    // The hook (reader) and Castra (writer) must derive the SAME sidecar path
    // from the worktree they share, or every report would miss.
    const prev = process.env.MARCH_STEWARD_SKILLS_DIR;
    process.env.MARCH_STEWARD_SKILLS_DIR = "/srv/steward";
    try {
      const cwd = "/repos/march/feature-smithy-forge-01";
      expect(sessionFileFor("/srv/steward", cwd)).toBe(stewardSessionFilePath(cwd));
    } finally {
      if (prev === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
      else process.env.MARCH_STEWARD_SKILLS_DIR = prev;
    }
  });
});
