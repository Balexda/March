/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { formatQueue } from "./legate-queue.js";

describe("formatQueue (#592 march legate queue)", () => {
  const body = {
    ok: true,
    profile: "march",
    last_tick_at: "2026-11-19T00:00:00.000Z",
    smithy_ok: true,
    queue: { dispatchable: 0, blocked: 3, total: 9 },
    checkout: { ok: true, defaultBranch: "main", head: "03d9486abcdef0123", behind: 0, at: "2026-11-19T00:00:00.000Z" },
    items: [
      {
        path: "specs/x/02-spawn.tasks.md",
        rowId: "S1",
        command: "smithy.forge",
        sliceId: "x-us2-s1-forge",
        decision: "archived_closed",
        heldBy: { sliceId: "x-us2-s1-forge", matchedOn: "id", prNumber: 333 },
      },
      { path: "specs/y.tasks.md", rowId: "S2", command: "smithy.forge", sliceId: "y-forge", decision: "spawn_cap" },
    ],
  };

  it("lists each row's decision, holder and the release hint", () => {
    const out = formatQueue(body);
    expect(out).toContain("march: dispatchable=0 blocked=3 total=9");
    expect(out).toContain("checkout: main @ 03d9486abcde, 0 behind, synced");
    expect(out).toMatch(/archived_closed\s+02-spawn\.tasks\.md#S1 forge\s+x-us2-s1-forge\s+held by x-us2-s1-forge PR #333/);
    expect(out).toMatch(/spawn_cap\s+y\.tasks\.md#S2 forge\s+y-forge/);
    expect(out).toContain("march legate requeue <held-by slice> --profile march");
  });

  it("reports an unreadable smithy and an unknown checkout", () => {
    const out = formatQueue({ ok: true, by_profile: { smithy: { smithy_ok: false, checkout: null, items: [] } } });
    expect(out).toContain("checkout: unknown");
    expect(out).toContain("smithy status could not be read");
  });

  it("shows a failed sync", () => {
    const out = formatQueue({ ...body, checkout: { ok: false, defaultBranch: "main", head: "abc", behind: 4, error: "fetch failed" } });
    expect(out).toContain("4 behind, sync FAILED: fetch failed");
  });
});
