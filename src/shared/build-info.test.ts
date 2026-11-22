/**
 * @l0 @deterministic @ci
 */
import { describe, it, expect } from "vitest";
import { buildInfo } from "./build-info.js";
import { CLI_VERSION } from "./version.js";

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

describe("buildInfo", () => {
  it("populates fields from env and trims them", () => {
    const b = buildInfo("herald", {
      env: { MARCH_GIT_SHA: " abc123 ", MARCH_GIT_DESCRIBE: "v0.1.2-3-gabc", MARCH_BUILD_TIME: "2026-11-20T07:00:41Z" },
    });
    expect(b).toMatchObject({
      service: "herald",
      describe: "v0.1.2-3-gabc",
      commit: "abc123",
      built_at: "2026-11-20T07:00:41Z",
    });
  });

  it("returns null for unset, empty, and whitespace env values", () => {
    for (const env of [{}, { MARCH_GIT_SHA: "", MARCH_GIT_DESCRIBE: "", MARCH_BUILD_TIME: "" }, { MARCH_GIT_SHA: "  ", MARCH_GIT_DESCRIBE: " \t", MARCH_BUILD_TIME: "\n" }]) {
      const b = buildInfo("legate", { env });
      expect(b.describe).toBeNull();
      expect(b.commit).toBeNull();
      expect(b.built_at).toBeNull();
    }
  });

  it("reports CLI_VERSION and echoes the service", () => {
    const b = buildInfo("legate", { env: {} });
    expect(b.version).toBe(CLI_VERSION);
    expect(b.service).toBe("legate");
  });

  it("has a stable RFC3339 started_at across calls", () => {
    const a = buildInfo("x", { env: {} });
    const b = buildInfo("x", { env: {} });
    expect(a.started_at).toBe(b.started_at);
    expect(a.started_at).toMatch(RFC3339);
  });

  it("honors startedAtMs, rounded to seconds", () => {
    const b = buildInfo("x", { env: {}, startedAtMs: Date.UTC(2026, 10, 20, 7, 1, 10, 999) });
    expect(b.started_at).toBe("2026-11-20T07:01:10Z");
  });
});
