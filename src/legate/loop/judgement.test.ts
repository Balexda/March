/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { requestJudgement, type JudgementDeps } from "./judgement.js";

function deps(over: Partial<JudgementDeps> = {}): JudgementDeps {
  return {
    processorName: "proc",
    pairedLegate: "leg",
    appendRequest: vi.fn(),
    appendEvent: vi.fn(),
    sendDoorbell: vi.fn(async () => true),
    log: vi.fn(),
    ...over,
  };
}

describe("requestJudgement", () => {
  it("builds the processor_request event and records it to both logs", async () => {
    const d = deps();
    const event = await requestJudgement(
      { ts: "T", sliceId: "s", sessionId: "sess", pr: { number: 9 }, reason: "needs review", detail: "why" },
      d,
    );
    expect(event).toMatchObject({
      kind: "processor_request",
      processor: "proc",
      paired_legate: "leg",
      slice_id: "s",
      session_id: "sess",
      pr_number: 9,
      reason: "needs review",
      detail: "why",
    });
    expect(d.appendRequest).toHaveBeenCalledWith(event);
    expect(d.appendEvent).toHaveBeenCalledWith(event);
    expect(d.sendDoorbell).toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("requested legate judgement for s"));
  });

  it("falls back to prNumber and null session when pr/sessionId are absent", async () => {
    const event = await requestJudgement({ ts: "T", sliceId: "s", prNumber: 3, reason: "r", detail: "d" }, deps());
    expect(event).toMatchObject({ pr_number: 3, session_id: null });
  });

  it("is idempotent: a repeat requestKey on the same slice is a no-op", async () => {
    const slice: any = { last_processor_request_key: "k" };
    const d = deps();
    const out = await requestJudgement({ ts: "T", slice, requestKey: "k", sliceId: "s", reason: "r", detail: "d" }, d);
    expect(out).toBeNull();
    expect(d.appendEvent).not.toHaveBeenCalled();
    expect(d.sendDoorbell).not.toHaveBeenCalled();
  });

  it("stamps the dedup key + timestamp on the slice for a fresh request", async () => {
    const slice: any = {};
    await requestJudgement({ ts: "T", slice, requestKey: "k", sliceId: "s", reason: "r", detail: "d" }, deps());
    expect(slice.last_processor_request_key).toBe("k");
    expect(slice.last_processor_request_at).toBe("T");
  });

  it("notes a doorbell delivery failure in the log line", async () => {
    const d = deps({ sendDoorbell: vi.fn(async () => false) });
    await requestJudgement({ ts: "T", sliceId: "s", reason: "r", detail: "d" }, d);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("(doorbell delivery failed)"));
  });
});
