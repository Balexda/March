/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { emptyMultiProfileState } from "../herald/events.js";
import type { CastraSession } from "../castra/types.js";
import type { SessionRecord } from "../brood/service/types.js";
import type { SessionClients } from "./gather.js";
import { runSessions } from "./command.js";

const NOW = Date.parse("2026-06-16T12:00:00.000Z");

/** Build fake clients returning the given fixtures (or throwing to simulate down). */
function fakeClients(opts: {
  brood?: SessionRecord[] | Error;
  castra?: Record<string, CastraSession[]> | Error;
  profiles?: string[] | Error;
}): SessionClients {
  return {
    brood: {
      async list() {
        if (opts.brood instanceof Error) throw opts.brood;
        return opts.brood ?? [];
      },
    },
    castra: {
      async listSessions(profile: string) {
        if (opts.castra instanceof Error) throw opts.castra;
        return opts.castra?.[profile] ?? [];
      },
    },
    herald: {
      async stateAll() {
        return emptyMultiProfileState();
      },
    },
    profiles: {
      async list() {
        if (opts.profiles instanceof Error) throw opts.profiles;
        return (opts.profiles ?? []).map((profile) => ({ profile }) as never);
      },
    },
  };
}

const steward: SessionRecord = {
  id: "stew-1",
  kind: "steward",
  status: "running",
  profile: "march",
  branch: "feature/x",
  createdAt: "2026-06-16T11:00:00.000Z",
  updatedAt: "2026-06-16T11:00:00.000Z",
};

describe("runSessions", () => {
  it("rejects an invalid --state with a usage error (exit 2)", async () => {
    const result = await runSessions({ state: "bogus" }, fakeClients({}), NOW);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Invalid --state "bogus"');
  });

  it("renders the joined table on success (exit 0)", async () => {
    const result = await runSessions(
      {},
      fakeClients({ brood: [steward], profiles: ["march"] }),
      NOW,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stew-1".slice(0, 12));
    expect(result.output).toContain("orphan"); // brood-only, no live castra
  });

  it("emits JSON with --json", async () => {
    const result = await runSessions(
      { json: true },
      fakeClients({ brood: [steward], profiles: ["march"] }),
      NOW,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.sessions[0].divergence).toBe("brood-only");
    expect(parsed.errors).toEqual([]);
  });

  it("returns a partial view (exit 0) with footnotes when one source is down", async () => {
    const result = await runSessions(
      {},
      fakeClients({ brood: [steward], profiles: ["march"], castra: new Error("castra down") }),
      NOW,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("castra (march) unavailable: castra down");
  });

  it("exits non-zero when every source fails (blind, not all-clear)", async () => {
    const result = await runSessions(
      {},
      fakeClients({
        brood: new Error("brood down"),
        profiles: new Error("herald down"),
      }),
      NOW,
    );
    expect(result.exitCode).toBe(1);
  });

  it("applies --orphans to the rendered rows", async () => {
    const result = await runSessions(
      { orphans: true, json: true },
      fakeClients({ brood: [steward], profiles: ["march"] }),
      NOW,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].divergence).not.toBe("ok");
  });
});
