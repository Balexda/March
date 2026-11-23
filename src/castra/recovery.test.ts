/**
 * @l0 @deterministic @ci
 */
import { describe, it, expect, vi } from "vitest";
import type { RecoveryRuntime, RecoverySessionView } from "./adapter.js";
import {
  looksLikeResumePicker,
  recoverErrorSessions,
  selectRecoverable,
  type RecoverDeps,
} from "./recovery.js";

function view(overrides: Partial<RecoverySessionView> = {}): RecoverySessionView {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    title: overrides.title ?? "forge: Tasks",
    group: overrides.group ?? "legate-workers",
    status: overrides.status ?? "error",
    tmuxSession: overrides.tmuxSession ?? "agentdeck_forge_abc",
  };
}

const PICKER_PANE = [
  "╭───────────────────────────────────────────────╮",
  "│ This conversation is long.                     │",
  "│ ❯ Resume from summary                          │",
  "│   Resume full session                          │",
  "╰───────────────────────────────────────────────╯",
].join("\n");

/**
 * Build a RecoveryRuntime fake plus an advancing-clock sleep/now pair. The
 * advancing clock is what keeps the picker/status poll loops fast and finite in
 * tests: each injected `sleep(ms)` bumps the same clock `now()` reads.
 */
function harness(opts: {
  sessions: RecoverySessionView[];
  restart?: (profile: string, id: string) => void;
  readSession?: (profile: string, id: string) => RecoverySessionView | undefined;
  capturePane?: (tmuxSession: string) => string;
}): {
  runtime: RecoveryRuntime;
  deps: RecoverDeps;
  sendEnter: ReturnType<typeof vi.fn>;
  sendKey: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
} {
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const now = () => clock;
  const sendEnter = vi.fn(async () => {});
  const sendKey = vi.fn(async (_tmux: string, _key: string) => {});
  const restartImpl = opts.restart ?? (() => {});
  const readImpl =
    opts.readSession ?? ((_p: string, id: string) => opts.sessions.find((s) => s.sessionId === id));
  const captureImpl = opts.capturePane ?? (() => "");
  const restart = vi.fn(async (p: string, id: string) => restartImpl(p, id));
  const runtime: RecoveryRuntime = {
    listSessions: vi.fn(async () => opts.sessions),
    restart,
    readSession: vi.fn(async (p: string, id: string) => readImpl(p, id)),
    capturePane: vi.fn(async (t: string) => captureImpl(t)),
    sendEnter,
    sendKey,
  };
  return { runtime, deps: { runtime, sleep, now }, sendEnter, sendKey, restart };
}

describe("looksLikeResumePicker", () => {
  it("matches only when both picker markers are present", () => {
    expect(looksLikeResumePicker(PICKER_PANE)).toBe(true);
    expect(looksLikeResumePicker("Resume from summary is a thing")).toBe(false);
    expect(looksLikeResumePicker("❯ ready to work")).toBe(false);
  });

  it("ignores ANSI colour codes around the markers", () => {
    const colored = "\x1b[1mResume from summary\x1b[0m\n\x1b[2mResume full session\x1b[0m";
    expect(looksLikeResumePicker(colored)).toBe(true);
  });
});

describe("selectRecoverable", () => {
  it("keeps only errored sessions and excludes the conductor by default", () => {
    const sessions = [
      view({ sessionId: "a", status: "error", group: "legate-workers" }),
      view({ sessionId: "b", status: "idle", group: "legate-workers" }),
      view({ sessionId: "c", status: "error", group: "conductor" }),
      view({ sessionId: "d", status: "error", group: "march-spawn-managers" }),
    ];
    const picked = selectRecoverable(sessions, { profile: "march" }).map((s) => s.sessionId);
    expect(picked).toEqual(["a", "d"]);
  });

  it("scopes to a single group when one is given (even the conductor)", () => {
    const sessions = [
      view({ sessionId: "a", status: "error", group: "legate-workers" }),
      view({ sessionId: "c", status: "error", group: "conductor" }),
    ];
    const picked = selectRecoverable(sessions, { profile: "march", group: "conductor" });
    expect(picked.map((s) => s.sessionId)).toEqual(["c"]);
  });

  it("targets exact sessionIds (overriding the conductor exclusion), only errored", () => {
    const sessions = [
      view({ sessionId: "a", status: "error", group: "legate-workers" }),
      view({ sessionId: "b", status: "error", group: "legate-workers" }),
      view({ sessionId: "c", status: "error", group: "conductor" }),
      view({ sessionId: "d", status: "idle", group: "legate-workers" }),
    ];
    const picked = selectRecoverable(sessions, { profile: "march", sessionIds: ["b", "c", "d"] });
    // d is excluded (not errored); c is included despite being the conductor.
    expect(picked.map((s) => s.sessionId)).toEqual(["b", "c"]);
  });

  it("intersects sessionIds with group when both are given", () => {
    const sessions = [
      view({ sessionId: "a", status: "error", group: "legate-workers" }),
      view({ sessionId: "c", status: "error", group: "conductor" }),
    ];
    const picked = selectRecoverable(sessions, {
      profile: "march",
      group: "legate-workers",
      sessionIds: ["a", "c"],
    });
    expect(picked.map((s) => s.sessionId)).toEqual(["a"]);
  });
});

describe("recoverErrorSessions", () => {
  it("restarts an errored worker and reports it recovered when no picker shows", async () => {
    // readSession returns a healthy status after restart; pane never shows a picker.
    const { runtime, deps, sendEnter, restart } = harness({
      sessions: [view({ sessionId: "w1", status: "error" })],
      readSession: () => view({ sessionId: "w1", status: "waiting" }),
      capturePane: () => "❯ ",
    });

    const report = await recoverErrorSessions(deps, { profile: "march" });

    expect(restart).toHaveBeenCalledWith("march", "w1");
    expect(sendEnter).not.toHaveBeenCalled();
    expect(report.recovered).toEqual([
      {
        sessionId: "w1",
        title: "forge: Tasks",
        group: "legate-workers",
        outcome: "recovered",
        pickerResolved: false,
        finalStatus: "waiting",
      },
    ]);
    expect(runtime.listSessions).toHaveBeenCalledWith("march");
  });

  it("confirms the resume picker and reports picker_resolved", async () => {
    const { deps, sendEnter } = harness({
      sessions: [view({ sessionId: "w1", status: "error" })],
      readSession: () => view({ sessionId: "w1", status: "waiting", tmuxSession: "tmux-new" }),
      capturePane: () => PICKER_PANE,
    });

    const report = await recoverErrorSessions(deps, { profile: "march" });

    expect(sendEnter).toHaveBeenCalledTimes(1);
    expect(sendEnter).toHaveBeenCalledWith("tmux-new");
    expect(report.recovered[0]).toMatchObject({
      outcome: "picker_resolved",
      pickerResolved: true,
      finalStatus: "waiting",
    });
  });

  it("captures a restart failure as restart_failed without aborting the sweep", async () => {
    const { deps, sendEnter } = harness({
      sessions: [
        view({ sessionId: "w1", status: "error" }),
        view({ sessionId: "w2", status: "error" }),
      ],
      restart: (_p, id) => {
        if (id === "w1") throw new Error("agent-deck session restart failed: boom");
      },
      readSession: () => view({ sessionId: "w2", status: "idle" }),
      capturePane: () => "",
    });

    const report = await recoverErrorSessions(deps, { profile: "march" });

    expect(report.recovered).toHaveLength(2);
    expect(report.recovered[0]).toMatchObject({
      sessionId: "w1",
      outcome: "restart_failed",
      finalStatus: "error",
      error: "agent-deck session restart failed: boom",
    });
    expect(report.recovered[1]).toMatchObject({ sessionId: "w2", outcome: "recovered" });
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it("does not abort the sweep when post-restart observation (readSession) throws", async () => {
    const { deps } = harness({
      sessions: [
        view({ sessionId: "w1", status: "error" }),
        view({ sessionId: "w2", status: "error" }),
      ],
      readSession: (_p, id) => {
        if (id === "w1") throw new Error("agent-deck session show failed: boom");
        return view({ sessionId: "w2", status: "idle" });
      },
      capturePane: () => "",
    });

    const report = await recoverErrorSessions(deps, { profile: "march" });

    expect(report.recovered).toHaveLength(2);
    // w1's observation threw AFTER a successful restart → reported, not thrown.
    expect(report.recovered[0]).toMatchObject({
      sessionId: "w1",
      outcome: "still_error",
      error: "agent-deck session show failed: boom",
    });
    // The sweep continued to w2.
    expect(report.recovered[1]).toMatchObject({ sessionId: "w2", outcome: "recovered" });
  });

  it("reports still_error when the session never leaves error after restart", async () => {
    const { deps } = harness({
      sessions: [view({ sessionId: "w1", status: "error" })],
      readSession: () => view({ sessionId: "w1", status: "error" }),
      capturePane: () => "",
    });

    const report = await recoverErrorSessions(deps, { profile: "march" });

    expect(report.recovered[0]).toMatchObject({
      outcome: "still_error",
      pickerResolved: false,
      finalStatus: "error",
    });
  });

  it("recovers nothing when there are no errored sessions in scope", async () => {
    const { deps, restart } = harness({
      sessions: [view({ sessionId: "ok", status: "idle" })],
    });
    const report = await recoverErrorSessions(deps, { profile: "march" });
    expect(report.recovered).toEqual([]);
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("stopped sessions (#587)", () => {
  it("selects a stopped session only under explicit id targeting", () => {
    const sessions = [
      view({ sessionId: "stopped-1", status: "stopped" }),
      view({ sessionId: "err-1", status: "error" }),
      view({ sessionId: "run-1", status: "running" }),
    ];
    // Group-wide sweep: stopped sessions are never revived.
    expect(selectRecoverable(sessions, { profile: "p" }).map((s) => s.sessionId)).toEqual(["err-1"]);
    expect(
      selectRecoverable(sessions, { profile: "p", group: "legate-workers" }).map((s) => s.sessionId),
    ).toEqual(["err-1"]);
    // Explicit targeting: stopped + errored named ids are eligible, running is not.
    expect(
      selectRecoverable(sessions, { profile: "p", sessionIds: ["stopped-1", "err-1", "run-1"] }).map(
        (s) => s.sessionId,
      ),
    ).toEqual(["stopped-1", "err-1"]);
  });

  it("restarts an explicitly targeted stopped session and reports it recovered", async () => {
    let status = "stopped";
    const { deps, restart } = harness({
      sessions: [view({ sessionId: "s1", status: "stopped" })],
      restart: () => {
        status = "running";
      },
      readSession: (_p, id) => view({ sessionId: id, status }),
    });
    const report = await recoverErrorSessions(deps, { profile: "p", sessionIds: ["s1"] });
    expect(restart).toHaveBeenCalledWith("p", "s1");
    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0]).toMatchObject({ sessionId: "s1", outcome: "recovered", finalStatus: "running" });
  });

  it("reports still_error when a stopped session stays stopped after restart", async () => {
    const { deps } = harness({
      sessions: [view({ sessionId: "s1", status: "stopped" })],
      readSession: (_p, id) => view({ sessionId: id, status: "stopped" }),
    });
    const report = await recoverErrorSessions(deps, { profile: "p", sessionIds: ["s1"] });
    expect(report.recovered[0]).toMatchObject({ outcome: "still_error", finalStatus: "stopped" });
  });

  it("does not restart a stopped session during a group sweep", async () => {
    const { deps, restart } = harness({ sessions: [view({ sessionId: "s1", status: "stopped" })] });
    const report = await recoverErrorSessions(deps, { profile: "p", group: "legate-workers" });
    expect(restart).not.toHaveBeenCalled();
    expect(report.recovered).toEqual([]);
  });

  it("treats an errored session that comes back stopped as still not live", async () => {
    const { deps } = harness({
      sessions: [view({ sessionId: "e1", status: "error" })],
      readSession: (_p, id) => view({ sessionId: id, status: "stopped" }),
    });
    const report = await recoverErrorSessions(deps, { profile: "p" });
    expect(report.recovered[0]).toMatchObject({ outcome: "still_error", finalStatus: "stopped" });
  });
});

describe("directory-trust dialogs during recovery", () => {
  const OWN = "/home/u/.march/steward";

  function trustPane(dir: string, cursorOnYes: boolean): string {
    return [
      " Adding a new directory:",
      ` ${dir}`,
      ` ${cursorOnYes ? " " : "❯"} No, exit`,
      ` ${cursorOnYes ? "❯" : " "} Yes, add it`,
    ].join("\n");
  }

  /** A pane per tmux session showing a trust dialog that Down/Enter answer. */
  function dialogHarness(sessions: RecoverySessionView[], dirs: Record<string, string>) {
    const state = new Map(Object.keys(dirs).map((t) => [t, { open: true, yes: false }]));
    const h = harness({
      sessions,
      capturePane: (t) => {
        const s = state.get(t);
        return s?.open ? trustPane(dirs[t]!, s.yes) : "❯ ";
      },
    });
    h.sendKey.mockImplementation(async (t: string, key: string) => {
      const s = state.get(t);
      if (!s) return;
      if (key === "Down") s.yes = true;
      if (key === "Enter" && s.yes) s.open = false;
    });
    return { ...h, state };
  }

  it("answers Castra's own trust dialog on a live session and reports it", async () => {
    const { deps, sendKey, restart, state } = dialogHarness(
      [view({ sessionId: "st1", status: "waiting", group: "march-spawn-managers", tmuxSession: "t1" })],
      { t1: OWN },
    );
    const report = await recoverErrorSessions(
      { ...deps, trustDialog: { ownedDirs: [OWN] } },
      { profile: "march" },
    );
    expect(restart).not.toHaveBeenCalled();
    expect(report.recovered).toEqual([]);
    expect(report.trustDialogs).toEqual([
      { sessionId: "st1", title: "forge: Tasks", group: "march-spawn-managers", outcome: "resolved", dir: OWN },
    ]);
    expect(sendKey.mock.calls.map((c) => c[1])).toEqual(["Down", "Enter"]);
    expect(state.get("t1")!.open).toBe(false);
  });

  it("reports another directory's trust dialog without typing anything", async () => {
    const { deps, sendKey } = dialogHarness(
      [view({ sessionId: "st1", status: "waiting", tmuxSession: "t1" })],
      { t1: "/home/u/src/other" },
    );
    const report = await recoverErrorSessions(
      { ...deps, trustDialog: { ownedDirs: [OWN] } },
      { profile: "march" },
    );
    expect(report.trustDialogs).toEqual([
      expect.objectContaining({ sessionId: "st1", outcome: "not_owned", dir: "/home/u/src/other" }),
    ]);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("answers the trust dialog a restarted session opens with, then keeps watching for the picker", async () => {
    const { deps, sendKey } = dialogHarness(
      [view({ sessionId: "e1", status: "error", tmuxSession: "t1" })],
      { t1: OWN },
    );
    // After restart the session reports live on tmux session t1.
    (deps.runtime.readSession as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      view({ sessionId: "e1", status: "waiting", tmuxSession: "t1" }),
    );
    const report = await recoverErrorSessions(
      { ...deps, trustDialog: { ownedDirs: [OWN] } },
      { profile: "march" },
    );
    expect(report.recovered[0]).toMatchObject({ sessionId: "e1", outcome: "recovered" });
    expect(report.trustDialogs).toEqual([expect.objectContaining({ sessionId: "e1", outcome: "resolved" })]);
    expect(sendKey.mock.calls.map((c) => c[1])).toEqual(["Down", "Enter"]);
  });

  it("skips the conductor and sessions without a pane", async () => {
    const { deps, runtime } = dialogHarness(
      [
        view({ sessionId: "c1", status: "waiting", group: "conductor", tmuxSession: "t1" }),
        view({ sessionId: "n1", status: "waiting", tmuxSession: "" }),
      ],
      { t1: OWN },
    );
    const report = await recoverErrorSessions(deps, { profile: "march" });
    expect(report.trustDialogs).toEqual([]);
    expect(runtime.capturePane).not.toHaveBeenCalled();
  });
});

describe("explicit-id group scope includes subgroups (#587)", () => {
  it("admits a targeted session in a subgroup of the requested group, not a sibling group", () => {
    const sessions = [
      view({ sessionId: "sub", status: "stopped", group: "legate-workers/forge" }),
      view({ sessionId: "base", status: "error", group: "legate-workers" }),
      view({ sessionId: "other", status: "error", group: "legate-workers-x" }),
    ];
    expect(
      selectRecoverable(sessions, {
        profile: "p",
        group: "legate-workers",
        sessionIds: ["sub", "base", "other"],
      }).map((s) => s.sessionId),
    ).toEqual(["sub", "base"]);
  });
});
