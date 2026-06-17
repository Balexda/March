/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { emptyMultiProfileState, type MultiProfileState } from "../herald/events.js";
import type { CastraSession } from "../castra/types.js";
import type { SessionRecord } from "../brood/service/types.js";
import { gatherSessions, type SessionClients } from "./gather.js";

function clients(opts: {
  brood?: SessionRecord[] | Error;
  castra?: Record<string, CastraSession[]> | ((p: string) => CastraSession[] | never);
  fold?: MultiProfileState;
  profiles?: string[] | Error;
  listedProfiles?: string[];
}): { impl: SessionClients; listed: string[] } {
  const listed: string[] = [];
  const impl: SessionClients = {
    brood: {
      async list() {
        if (opts.brood instanceof Error) throw opts.brood;
        return opts.brood ?? [];
      },
    },
    castra: {
      async listSessions(profile: string) {
        listed.push(profile);
        if (typeof opts.castra === "function") return opts.castra(profile);
        return opts.castra?.[profile] ?? [];
      },
    },
    herald: {
      async stateAll() {
        return opts.fold ?? emptyMultiProfileState();
      },
    },
    profiles: {
      async list() {
        if (opts.profiles instanceof Error) throw opts.profiles;
        return (opts.profiles ?? []).map((profile) => ({ profile }) as never);
      },
    },
  };
  return { impl, listed };
}

describe("gatherSessions", () => {
  it("scans the union of profiles from the registry, the fold, and Brood records", async () => {
    const fold = emptyMultiProfileState();
    fold.byProfile["from-fold"] = { ...emptyMultiProfileState().byProfile, ...{} } as never;
    fold.byProfile["from-fold"] = {
      seq: 0, ts: "", statePresent: true, stateError: null, slices: {}, sessions: {}, workers: null,
      smithy: { dispatchable: 0, blocked: 0, total: 0 }, retries: {},
    };
    const { impl, listed } = clients({
      profiles: ["registered"],
      fold,
      brood: [
        { id: "x", kind: "spawn", status: "running", profile: "from-brood", createdAt: "", updatedAt: "" },
      ],
    });
    const sources = await gatherSessions(impl);
    expect(sources.profiles).toEqual(["from-brood", "from-fold", "registered"]);
    expect(listed.sort()).toEqual(["from-brood", "from-fold", "registered"]);
  });

  it("records a source failure instead of throwing (partial view)", async () => {
    const { impl } = clients({ brood: new Error("brood down"), profiles: ["march"] });
    const sources = await gatherSessions(impl);
    expect(sources.brood).toEqual([]);
    expect(sources.errors).toContainEqual({ source: "brood", message: "brood down" });
  });

  it("scopes a per-profile Castra failure", async () => {
    const { impl } = clients({
      profiles: ["a", "b"],
      castra: (p) => {
        if (p === "a") throw new Error("a down");
        return [];
      },
    });
    const sources = await gatherSessions(impl);
    expect(sources.errors).toContainEqual({ source: "castra", profile: "a", message: "a down" });
    expect(sources.castraByProfile.has("b")).toBe(true);
  });
});
