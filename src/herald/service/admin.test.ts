import { describe, expect, it } from "vitest";
import { buildAdminEventBody } from "./admin.js";

describe("buildAdminEventBody (#265)", () => {
  const base = {
    profile: "march",
    type: "slice.steward.attached",
    note: "legacy slice pre-#213; unstick PR #240",
    operator: "jmbattista",
  };

  it("builds the request body with the inner event from type-specific flags", () => {
    const body = buildAdminEventBody({
      ...base,
      sliceId: "01-spawn-f5-s2-cut",
      sessionId: "e3bde73d-1779515948",
      worktreePath: "/home/op/wt/feature-x",
      branch: "smithy/cut/01-spawn-f5-s2",
    });
    expect(body).toEqual({
      profile: "march",
      operator: "jmbattista",
      note: "legacy slice pre-#213; unstick PR #240",
      event: {
        type: "slice.steward.attached",
        sliceId: "01-spawn-f5-s2-cut",
        sessionId: "e3bde73d-1779515948",
        worktreePath: "/home/op/wt/feature-x",
        branch: "smithy/cut/01-spawn-f5-s2",
      },
    });
  });

  it("omits unset type-specific flags from the inner event", () => {
    const body = buildAdminEventBody({ ...base, sliceId: "s1", sessionId: "sess-1" });
    expect(body.event).toEqual({ type: "slice.steward.attached", sliceId: "s1", sessionId: "sess-1" });
    expect(body.event).not.toHaveProperty("branch");
    expect(body.event).not.toHaveProperty("worktreePath");
  });

  it("trims the universal fields", () => {
    const body = buildAdminEventBody({ ...base, profile: "  march  ", note: "  why  ", operator: " op " });
    expect(body.profile).toBe("march");
    expect(body.note).toBe("why");
    expect(body.operator).toBe("op");
  });

  it.each([
    ["profile", { ...base, profile: undefined }],
    ["type", { ...base, type: undefined }],
    ["note", { ...base, note: undefined }],
    ["operator", { ...base, operator: undefined }],
  ])("throws when %s is missing", (field, flags) => {
    expect(() => buildAdminEventBody(flags)).toThrow(new RegExp(field));
  });
});
