import { describe, expect, it } from "vitest";
import { checksSummary, failedChecks, ghPrArgs } from "./gh.js";

describe("gh client pure parsers", () => {
  it("checksSummary rolls up to NONE/FAIL/PENDING/PASS", () => {
    expect(checksSummary([])).toBe("NONE");
    expect(checksSummary([{ conclusion: "FAILURE" }])).toBe("FAIL");
    expect(checksSummary([{ status: "IN_PROGRESS" }])).toBe("PENDING");
    expect(checksSummary([{ conclusion: "SUCCESS" }])).toBe("PASS");
    // failure dominates pending
    expect(checksSummary([{ status: "IN_PROGRESS" }, { conclusion: "TIMED_OUT" }])).toBe("FAIL");
  });

  it("failedChecks lists failing checks with name + url", () => {
    expect(
      failedChecks([
        { conclusion: "SUCCESS", name: "ok" },
        { conclusion: "FAILURE", name: "ci", detailsUrl: "u" },
        { conclusion: "CANCELLED", context: "lint" },
      ]),
    ).toEqual([
      { name: "ci", url: "u" },
      { name: "lint", url: null },
    ]);
  });

  it("ghPrArgs skips without a PR number, and targets -R owner when known", () => {
    expect(ghPrArgs({}, {}, "number", "/repo").skipped).toBe(true);
    const withOwner = ghPrArgs({ pr: { number: 5 } }, { repo: { owner_with_name: "o/r" } }, "number,state", "/repo");
    expect(withOwner.args).toEqual(["pr", "view", "5", "--json", "number,state", "-R", "o/r"]);
    expect(withOwner.options).toEqual({}); // owner known → no cwd needed
  });
});
