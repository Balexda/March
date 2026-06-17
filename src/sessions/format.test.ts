/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import type { UnifiedSession } from "./types.js";
import {
  divergenceFlag,
  filterSessions,
  formatJson,
  formatTable,
  humanizeAge,
} from "./format.js";

function row(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    sliceId: "foo-cut",
    profile: "march",
    state: "in-steward",
    presence: { herald: true, castra: true, brood: true },
    divergence: "ok",
    ...overrides,
  };
}

describe("filterSessions", () => {
  const rows = [
    row({ sliceId: "a", profile: "march", state: "in-steward", divergence: "ok" }),
    row({ sliceId: "b", profile: "smithy", state: "errored", divergence: "castra-only" }),
    row({ sliceId: "c", profile: "march", state: "errored", divergence: "brood-only" }),
  ];

  it("filters by profile", () => {
    expect(filterSessions(rows, { profile: "march" }).map((r) => r.sliceId)).toEqual(["a", "c"]);
  });

  it("filters by state", () => {
    expect(filterSessions(rows, { state: "errored" }).map((r) => r.sliceId)).toEqual(["b", "c"]);
  });

  it("filters to divergent rows with --orphans", () => {
    expect(filterSessions(rows, { orphans: true }).map((r) => r.sliceId)).toEqual(["b", "c"]);
  });

  it("composes filters", () => {
    expect(filterSessions(rows, { orphans: true, profile: "march" }).map((r) => r.sliceId)).toEqual(["c"]);
  });
});

describe("humanizeAge", () => {
  it("renders compact units", () => {
    expect(humanizeAge(undefined)).toBe("—");
    expect(humanizeAge(45_000)).toBe("45s");
    expect(humanizeAge(12 * 60_000)).toBe("12m");
    expect(humanizeAge(3 * 3_600_000)).toBe("3h");
    expect(humanizeAge(2 * 86_400_000)).toBe("2d");
  });
});

describe("divergenceFlag", () => {
  it("maps each divergence to a short label", () => {
    expect(divergenceFlag("ok")).toBe("");
    expect(divergenceFlag("castra-only")).toBe("leak");
    expect(divergenceFlag("brood-only")).toBe("orphan");
    expect(divergenceFlag("fold-only")).toBe("stale");
  });
});

describe("formatTable", () => {
  it("renders a header and aligned rows", () => {
    const out = formatTable([
      row({ sliceId: "foo-cut", pr: 412, branch: "feature/x", containerId: "abcdef1234567890", castraSessionId: "sess-1", broodStatus: "running", ageMs: 3_600_000, divergence: "ok" }),
    ]);
    expect(out).toContain("SLICE");
    expect(out).toContain("foo-cut");
    expect(out).toContain("#412");
    expect(out).toContain("abcdef123456"); // container trimmed to 12
    expect(out).toContain("1h");
  });

  it("reports an empty set without a table", () => {
    expect(formatTable([])).toBe("No in-flight sessions.");
  });

  it("footnotes source errors so a partial view is explicit", () => {
    const out = formatTable([], [{ source: "castra", profile: "smithy", message: "boom" }]);
    expect(out).toContain("! castra (smithy) unavailable: boom");
  });

  it("flags divergent rows inline", () => {
    const out = formatTable([row({ divergence: "castra-only" })]);
    expect(out).toContain("leak");
  });
});

describe("formatJson", () => {
  it("emits sessions and errors", () => {
    const parsed = JSON.parse(formatJson({ sessions: [row()], errors: [] }));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.errors).toEqual([]);
  });
});
