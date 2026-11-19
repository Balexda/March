/** @l0 @deterministic @ci */
import { describe, expect, it, vi } from "vitest";
import type { ReviewRequestRecord } from "../../../herald/events.js";
import { reviewCapSamples, reviewRequestLimits } from "./review-budget.js";

function intent(reviewer: ReviewRequestRecord["reviewer"], at: string): ReviewRequestRecord {
  return { sliceId: "forge/1", pr: 1, headSha: "a".repeat(40), reason: "initial", reviewer, at };
}

describe("review cap samples", () => {
  it("counts durable intents across profiles and resets at UTC day and month boundaries", () => {
    const limits = reviewRequestLimits({
      MARCH_CODERABBIT_REVIEWS_PER_DAY: "1",
      MARCH_COPILOT_REVIEWS_PER_DAY: "4",
      MARCH_COPILOT_REVIEWS_PER_MONTH: "5",
    }, vi.fn());
    const beforeMidnight = "2026-11-30T23:59:59.999Z";
    const history = {
      first: [intent("copilot", "2026-11-29T03:00:00Z"), intent("coderabbit", beforeMidnight)],
      second: [intent("copilot", beforeMidnight), intent("coderabbit", beforeMidnight)],
    };
    const balancesAt = (at: string) => Object.fromEntries(reviewCapSamples(history, limits, at)
      .map(({ reviewer, window, remaining }) => [reviewer + "/" + window, remaining]));
    expect(balancesAt(beforeMidnight)).toEqual({ "coderabbit/day": 0, "copilot/day": 3, "copilot/month": 3 });

    history.first.push(intent("copilot", beforeMidnight));
    expect(balancesAt(beforeMidnight)).toEqual({ "coderabbit/day": 0, "copilot/day": 2, "copilot/month": 2 });
    expect(balancesAt("2026-11-29T23:59:59.999Z")["copilot/day"]).toBe(3);
    expect(balancesAt("2026-12-01T00:00:00.000Z")).toEqual({ "coderabbit/day": 1, "copilot/day": 4, "copilot/month": 5 });
  });

  it("keeps zero caps visible and omits unlimited windows", () => {
    const warn = vi.fn();
    const limits = reviewRequestLimits({ MARCH_COPILOT_REVIEWS_PER_MONTH: "-1" }, warn);
    expect(reviewCapSamples({}, limits, "2026-12-01T00:00:00Z")).toEqual([
      { reviewer: "copilot", window: "day", remaining: 0 },
      { reviewer: "copilot", window: "month", remaining: 0 },
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
