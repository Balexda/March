/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import type { ProfileRecord } from "../herald/profiles/types.js";
import type { SessionRecord } from "../brood/service/types.js";
import type { CastraSession } from "../castra/types.js";
import type { SystemState, SliceState, ObservedSession } from "../herald/events.js";
import type { CastraAuthVerdict, DoctorContext } from "./context.js";
import { runDoctor } from "./run.js";
import { formatReport } from "./format.js";
import { checkTokenWiring } from "./checks/token-wiring.js";
import { checkSessionConsistency } from "./checks/session-consistency.js";
import { checkDispatchHealth } from "./checks/dispatch-health.js";
import { checkWorktreeHygiene } from "./checks/worktree-hygiene.js";
import { checkSyncHealth } from "./checks/sync-health.js";
import { checkTmuxOwnership } from "./checks/tmux-ownership.js";
import type { Finding, Severity } from "./types.js";

// ---- builders -------------------------------------------------------------

function profile(over: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    profile: "march",
    repoName: "march",
    repoPath: "/repos/march",
    workerGroup: "legate-workers",
    status: "active",
    createdAt: "t0",
    updatedAt: "t0",
    ...over,
  };
}

function brood(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    kind: "steward",
    status: "running",
    profile: "march",
    createdAt: "t0",
    updatedAt: "t0",
    ...over,
  };
}

function castra(over: Partial<CastraSession> = {}): CastraSession {
  return {
    sessionId: "c1",
    title: "t",
    group: "legate-workers",
    branch: "",
    worktreePath: "",
    createdAt: "t0",
    status: "running",
    ...over,
  };
}

function slice(over: Partial<SliceState> = {}): SliceState {
  return { sliceId: "sl1", ...over };
}

function state(over: Partial<SystemState> = {}): SystemState {
  return {
    seq: 1,
    ts: "t0",
    statePresent: true,
    stateError: null,
    slices: {},
    sessions: {},
    workers: null,
    smithy: { dispatchable: 0, blocked: 0, total: 0 },
    retries: {},
    ...over,
  };
}

interface FakeOpts {
  profiles?: ProfileRecord[];
  containerEnv?: Record<string, Record<string, string | undefined>>;
  castraSessions?: Record<string, CastraSession[]>;
  castraThrows?: boolean;
  /** Verdict the status-aware Castra auth probe returns (default "accepted"). */
  castraAuth?: CastraAuthVerdict;
  broodRecords?: SessionRecord[];
  broodThrows?: boolean;
  states?: Record<string, SystemState>;
  paths?: Set<string>;
  git?: (repoPath: string, args: readonly string[]) => string | null;
  /** Hostname the tmux server reports (default null = no server reachable). */
  tmuxServerHost?: string | null;
  /** This host's name (default "host-machine"). */
  localHostname?: string;
  env?: NodeJS.ProcessEnv;
}

function ctx(opts: FakeOpts = {}): DoctorContext {
  return {
    profiles: opts.profiles ?? [profile()],
    castra: {
      async listSessions(p: string) {
        if (opts.castraThrows) throw new Error("castra down");
        return opts.castraSessions?.[p] ?? [];
      },
    },
    castraAuthProbe: async () => opts.castraAuth ?? "accepted",
    brood: {
      async list() {
        if (opts.broodThrows) throw new Error("brood down");
        return opts.broodRecords ?? [];
      },
    },
    herald: {
      async state(_at?: number, p?: string) {
        return opts.states?.[p ?? ""] ?? state();
      },
    },
    containerEnv: (container, name) => opts.containerEnv?.[container]?.[name] ?? null,
    containerState: () => "running",
    git: opts.git ?? (() => null),
    pathExists: (p) => opts.paths?.has(p) ?? false,
    tmuxServerHost: () => (opts.tmuxServerHost === undefined ? null : opts.tmuxServerHost),
    localHostname: opts.localHostname ?? "host-machine",
    env: opts.env ?? {},
  };
}

function sev(findings: readonly Finding[]): Severity[] {
  return findings.map((f) => f.severity);
}

// ---- token wiring ---------------------------------------------------------

describe("token-wiring", () => {
  const allSame = {
    "march-castra": { CASTRA_API_TOKEN: "tok" },
    "march-hatchery": { CASTRA_API_TOKEN: "tok" },
    "march-brood": { CASTRA_API_TOKEN: "tok" },
    "march-herald": { CASTRA_API_TOKEN: "tok" },
    "march-legate": { CASTRA_API_TOKEN: "tok" },
  };

  it("passes when the token is consistent and Castra accepts it", async () => {
    const r = await checkTokenWiring(ctx({ containerEnv: allSame, castraAuth: "accepted" }));
    expect(sev(r.findings)).toEqual(["pass"]);
  });

  it("fails on drift across containers and names a remedy", async () => {
    const drift = { ...allSame, "march-legate": { CASTRA_API_TOKEN: "other" } };
    const r = await checkTokenWiring(ctx({ containerEnv: drift, castraAuth: "accepted" }));
    const fail = r.findings.find((f) => f.severity === "fail");
    expect(fail).toBeDefined();
    expect(fail!.detail).toContain("drift");
    expect(fail!.remedy).toContain("march up");
  });

  it("fails when the token is missing on some containers", async () => {
    const partial = { ...allSame, "march-brood": {} };
    const r = await checkTokenWiring(ctx({ containerEnv: partial, castraAuth: "accepted" }));
    const fail = r.findings.find((f) => f.severity === "fail");
    expect(fail!.detail).toContain("unset on");
    expect(fail!.detail).toContain("brood");
  });

  it("fails when Castra rejects a consistent token (explicit 401/403)", async () => {
    const r = await checkTokenWiring(ctx({ containerEnv: allSame, castraAuth: "rejected" }));
    const fail = r.findings.find((f) => f.severity === "fail");
    expect(fail!.detail).toContain("rejected the shared token");
  });

  it("passes (auth unverifiable) when consistent but Castra is unreachable, not a 401/403", async () => {
    // A 5xx / unreachable backend (no profiles either) must not read as a token
    // fault — the status-aware probe returns "unverified", not "rejected".
    const r = await checkTokenWiring(
      ctx({ containerEnv: allSame, profiles: [], castraAuth: "unverified" }),
    );
    expect(sev(r.findings)).toEqual(["pass"]);
    expect(r.findings[0].detail).toContain("not verifiable");
  });

  it("probes auth with the CONTAINER token, not the host token", async () => {
    // Even when the host has no token, a consistent container token that Castra
    // accepts must pass (regression for the stale-host-token false-fail).
    let probedWith: string | undefined = "UNSET";
    const c = ctx({ containerEnv: allSame, castraAuth: "accepted" });
    const spied: DoctorContext = {
      ...c,
      castraAuthProbe: async (token) => {
        probedWith = token;
        return "accepted";
      },
    };
    const r = await checkTokenWiring(spied);
    expect(probedWith).toBe("tok"); // the value read from the containers
    expect(sev(r.findings)).toEqual(["pass"]);
  });

  it("warns (not fails) when no container exposes the token", async () => {
    const r = await checkTokenWiring(ctx({ containerEnv: {}, castraAuth: "unverified" }));
    expect(sev(r.findings)).toEqual(["warn"]);
    expect(r.findings[0].detail).toContain("could not read");
  });
});

// ---- session consistency --------------------------------------------------

describe("session-consistency", () => {
  it("passes when Castra/Brood/fold agree", async () => {
    const c = ctx({
      castraSessions: { march: [castra({ sessionId: "x", worktreePath: "/w/x" })] },
      broodRecords: [brood({ id: "x", worktreePath: "/w/x" })],
      states: { march: state({ sessions: { x: present("x") } }) },
    });
    const r = await checkSessionConsistency(c);
    expect(sev(r.findings)).toEqual(["pass"]);
  });

  it("warns on a leaked steward (Castra-live, no Brood record) with sweep remedy", async () => {
    const c = ctx({
      castraSessions: { march: [castra({ sessionId: "ghost", worktreePath: "/w/g" })] },
      broodRecords: [],
    });
    const r = await checkSessionConsistency(c);
    const leak = r.findings.find((f) => f.detail.includes("leaked"));
    expect(leak?.severity).toBe("warn");
    expect(leak?.remedy).toBe("march brood sweep");
  });

  it("warns on a dead orphan (active Brood record, no Castra session)", async () => {
    const c = ctx({
      castraSessions: { march: [] },
      broodRecords: [brood({ id: "dead", kind: "steward", worktreePath: "/w/d" })],
    });
    const r = await checkSessionConsistency(c);
    expect(r.findings.some((f) => f.detail.includes("dead orphan"))).toBe(true);
  });

  it("warns on a stale fold projection", async () => {
    const c = ctx({
      castraSessions: { march: [] },
      broodRecords: [],
      states: { march: state({ sessions: { gone: present("gone") } }) },
    });
    const r = await checkSessionConsistency(c);
    expect(r.findings.some((f) => f.detail.includes("stale fold"))).toBe(true);
  });

  it("fails (not throws) when Brood is unreachable", async () => {
    const r = await checkSessionConsistency(ctx({ broodThrows: true }));
    expect(sev(r.findings)).toEqual(["fail"]);
  });
});

function present(id: string): ObservedSession {
  return { id, present: true };
}

// ---- dispatch health ------------------------------------------------------

describe("dispatch-health", () => {
  it("fails when the cap is saturated while work is dispatchable", async () => {
    const slices: Record<string, SliceState> = {};
    for (let i = 0; i < 10; i++) slices[`s${i}`] = slice({ sliceId: `s${i}`, stage: "implementing" });
    const c = ctx({
      env: { MARCH_MAX_CONCURRENT_SPAWNS: "10" },
      states: { march: state({ slices, smithy: { dispatchable: 4, blocked: 0, total: 14 } }) },
    });
    const r = await checkDispatchHealth(c);
    const fail = r.findings.find((f) => f.severity === "fail");
    expect(fail!.detail).toContain("cap saturated");
    expect(fail!.remedy).toContain("march brood sweep");
  });

  it("fails when there is a backlog but nothing live (stalled dispatch)", async () => {
    const c = ctx({
      env: { MARCH_MAX_CONCURRENT_SPAWNS: "10" },
      states: { march: state({ slices: {}, smithy: { dispatchable: 3, blocked: 0, total: 3 } }) },
    });
    const r = await checkDispatchHealth(c);
    const fail = r.findings.find((f) => f.severity === "fail");
    expect(fail!.detail).toContain("stalled");
  });

  it("passes when live is under cap with no backlog", async () => {
    const c = ctx({
      env: { MARCH_MAX_CONCURRENT_SPAWNS: "10" },
      states: { march: state({ slices: { a: slice({ stage: "implementing" }) } }) },
    });
    const r = await checkDispatchHealth(c);
    expect(r.findings.some((f) => f.severity === "pass")).toBe(true);
  });

  it("counts a pr-open slice that still owes a review response as LIVE", async () => {
    // Mirrors canonical liveSpawnCount: PASS + non-conflicting is NOT
    // ready-to-merge while the steward owes replies, so it stays live and can
    // saturate the cap (regression for the undercount that read saturated as ok).
    const owingPr = { state: "OPEN", checks: "PASS", mergeable: "MERGEABLE", needs_response_count: 1 };
    const slices: Record<string, SliceState> = {
      a: slice({ sliceId: "a", stage: "pr-open", pr: owingPr }),
      b: slice({ sliceId: "b", stage: "pr-open", pr: owingPr }),
    };
    const c = ctx({
      env: { MARCH_MAX_CONCURRENT_SPAWNS: "2" },
      states: { march: state({ slices, smithy: { dispatchable: 3, blocked: 0, total: 5 } }) },
    });
    const r = await checkDispatchHealth(c);
    expect(r.findings.some((f) => f.severity === "fail" && f.detail.includes("cap saturated"))).toBe(true);
  });

  it("treats a settled pr-open slice (owes nothing) as ready-to-merge, not live", async () => {
    const settledPr = { state: "OPEN", checks: "PASS", mergeable: "MERGEABLE", needs_response_count: 0 };
    const c = ctx({
      env: { MARCH_MAX_CONCURRENT_SPAWNS: "2" },
      states: {
        march: state({
          slices: { a: slice({ sliceId: "a", stage: "pr-open", pr: settledPr }) },
          smithy: { dispatchable: 0, blocked: 0, total: 1 },
        }),
      },
    });
    const r = await checkDispatchHealth(c);
    // live should be 0 (ready-to-merge excluded), so a "0/2 live" pass.
    expect(r.findings.some((f) => f.detail.includes("0/2"))).toBe(true);
  });

  it("flags stranded escalated stewards", async () => {
    const c = ctx({
      states: {
        march: state({
          slices: { e: slice({ sliceId: "e", stage: "implementing", escalatedReason: "stuck" }) },
        }),
      },
    });
    const r = await checkDispatchHealth(c);
    const stranded = r.findings.find((f) => f.title === "stranded stewards");
    expect(stranded?.detail).toContain("e (stuck)");
    expect(stranded?.remedy).toContain("march legate recover");
  });

  it("reads the cap from the legate container env over the host env", async () => {
    const slices: Record<string, SliceState> = {};
    for (let i = 0; i < 2; i++) slices[`s${i}`] = slice({ sliceId: `s${i}`, stage: "implementing" });
    const c = ctx({
      containerEnv: { "march-legate": { MARCH_MAX_CONCURRENT_SPAWNS: "2" } },
      env: { MARCH_MAX_CONCURRENT_SPAWNS: "100" },
      states: { march: state({ slices, smithy: { dispatchable: 1, blocked: 0, total: 3 } }) },
    });
    const r = await checkDispatchHealth(c);
    // cap=2, live=2 → saturated despite host env saying 100.
    expect(r.findings.some((f) => f.detail.includes("2/2"))).toBe(true);
  });
});

// ---- worktree hygiene -----------------------------------------------------

describe("worktree-hygiene", () => {
  it("flags a worktree on disk that belongs to no live/active session", async () => {
    const c = ctx({
      castraSessions: { march: [] },
      broodRecords: [brood({ id: "old", status: "torndown", worktreePath: "/w/leftover" })],
      paths: new Set(["/w/leftover"]),
    });
    const r = await checkWorktreeHygiene(c);
    const warn = r.findings.find((f) => f.severity === "warn");
    expect(warn?.detail).toContain("/w/leftover");
    expect(warn?.remedy).toContain("march brood");
  });

  it("passes when the tracked worktree backs a live Castra session", async () => {
    const c = ctx({
      castraSessions: { march: [castra({ sessionId: "live", worktreePath: "/w/live" })] },
      broodRecords: [brood({ id: "live", status: "running", worktreePath: "/w/live" })],
      paths: new Set(["/w/live"]),
    });
    const r = await checkWorktreeHygiene(c);
    expect(sev(r.findings)).toEqual(["pass"]);
  });

  it("does not flag a worktree that is no longer on disk", async () => {
    const c = ctx({
      castraSessions: { march: [] },
      broodRecords: [brood({ id: "gone", status: "torndown", worktreePath: "/w/gone" })],
      paths: new Set(),
    });
    const r = await checkWorktreeHygiene(c);
    expect(r.findings.every((f) => f.severity === "pass")).toBe(true);
  });
});

// ---- sync health ----------------------------------------------------------

describe("sync-health", () => {
  function gitFor(map: Record<string, string | null>) {
    return (_repo: string, args: readonly string[]): string | null => {
      const key = args.join(" ");
      if (key in map) return map[key];
      return null;
    };
  }

  it("passes when the default branch matches origin", async () => {
    const c = ctx({
      paths: new Set(["/repos/march"]),
      git: gitFor({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "rev-parse main": "abc123",
        "ls-remote origin main": "abc123\trefs/heads/main",
      }),
    });
    const r = await checkSyncHealth(c);
    expect(sev(r.findings)).toEqual(["pass"]);
  });

  it("warns with a git pull remedy when the local branch is a fetched ancestor of origin", async () => {
    const c = ctx({
      paths: new Set(["/repos/march"]),
      git: gitFor({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "rev-parse main": "local99",
        "ls-remote origin main": "remote88\trefs/heads/main",
        "cat-file -e remote88^{commit}": "", // remote object present locally
        "merge-base --is-ancestor local99 remote88": "", // ancestor → behind
      }),
    });
    const r = await checkSyncHealth(c);
    const warn = r.findings.find((f) => f.severity === "warn");
    expect(warn?.detail).toContain("behind origin");
    expect(warn?.remedy).toContain("pull");
  });

  it("reports 'behind' + git pull when origin advanced but the remote SHA is unfetched", async () => {
    // ls-remote returns a SHA not in the local object DB → cat-file -e fails
    // (no entry in the map → null). Must still read as behind, not diverged.
    const c = ctx({
      paths: new Set(["/repos/march"]),
      git: gitFor({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "rev-parse main": "local11",
        "ls-remote origin main": "unfetched99\trefs/heads/main",
        // no "cat-file -e unfetched99^{commit}" entry → unknown locally
        // no "merge-base ..." entry → would error, but must not be relied on
      }),
    });
    const r = await checkSyncHealth(c);
    const warn = r.findings.find((f) => f.severity === "warn");
    expect(warn?.detail).toContain("behind origin");
    expect(warn?.remedy).toContain("pull");
  });

  it("reports 'diverged' + inspect when the remote SHA is known and not an ancestor", async () => {
    const c = ctx({
      paths: new Set(["/repos/march"]),
      git: gitFor({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "rev-parse main": "local11",
        "ls-remote origin main": "remote22\trefs/heads/main",
        "cat-file -e remote22^{commit}": "", // remote object IS present locally
        // merge-base --is-ancestor absent from map → null → not an ancestor
      }),
    });
    const r = await checkSyncHealth(c);
    const warn = r.findings.find((f) => f.severity === "warn");
    expect(warn?.detail).toContain("diverged");
    expect(warn?.remedy).toContain("inspect");
  });

  it("warns 'unverified' when the repo is not on this host", async () => {
    const c = ctx({ paths: new Set() });
    const r = await checkSyncHealth(c);
    expect(r.findings[0].detail).toContain("not on this host");
  });
});

// ---- tmux ownership -------------------------------------------------------

describe("tmux-ownership", () => {
  it("passes when the tmux server runs on this host", async () => {
    const c = ctx({ tmuxServerHost: "host-machine", localHostname: "host-machine" });
    const r = await checkTmuxOwnership(c);
    expect(sev(r.findings)).toEqual(["pass"]);
    expect(r.findings[0].detail).toContain("host-owned");
  });

  it("warns with a down/up remedy when the server runs inside the container", async () => {
    const c = ctx({ tmuxServerHost: "cd42c4740280", localHostname: "host-machine" });
    const r = await checkTmuxOwnership(c);
    const warn = r.findings.find((f) => f.severity === "warn");
    expect(warn?.detail).toContain("cd42c4740280");
    expect(warn?.detail).toContain("inside the container");
    expect(warn?.remedy).toContain("march down && march up");
  });

  it("passes (nothing to verify) when no tmux server is reachable", async () => {
    const c = ctx({ tmuxServerHost: null });
    const r = await checkTmuxOwnership(c);
    expect(sev(r.findings)).toEqual(["pass"]);
    expect(r.findings[0].detail).toContain("nothing to verify");
  });
});

// ---- aggregation + format -------------------------------------------------

describe("runDoctor aggregation", () => {
  it("ok=false when any finding fails; counts tally", async () => {
    const report = await runDoctor(
      ctx({ containerEnv: {}, broodThrows: true }), // token warn + session fail
    );
    expect(report.ok).toBe(false);
    expect(report.counts.fail).toBeGreaterThanOrEqual(1);
    expect(report.findings.length).toBe(report.counts.pass + report.counts.warn + report.counts.fail);
  });

  it("ok=true when nothing fails (warnings allowed)", async () => {
    const report = await runDoctor(
      ctx({
        containerEnv: {
          "march-castra": { CASTRA_API_TOKEN: "t" },
          "march-hatchery": { CASTRA_API_TOKEN: "t" },
          "march-brood": { CASTRA_API_TOKEN: "t" },
          "march-herald": { CASTRA_API_TOKEN: "t" },
          "march-legate": { CASTRA_API_TOKEN: "t" },
        },
        castraAuth: "accepted",
        profiles: [],
      }),
    );
    expect(report.ok).toBe(true);
  });

  it("prepends setup findings and counts them", async () => {
    const setup: Finding[] = [
      { check: "session-consistency", title: "Herald", severity: "fail", detail: "down" },
    ];
    const report = await runDoctor(ctx({ profiles: [] }), { setupFindings: setup, profile: "march" });
    expect(report.profile).toBe("march");
    expect(report.ok).toBe(false);
    expect(report.findings[0].title).toBe("Herald");
  });

  it("formatReport renders glyphs, remedies, and a verdict", async () => {
    const report = await runDoctor(ctx({ containerEnv: {}, profiles: [] }));
    const text = formatReport(report);
    expect(text).toContain("march doctor");
    expect(text).toContain("Result:");
    expect(text).toMatch(/[✓⚠✗]/);
  });
});
