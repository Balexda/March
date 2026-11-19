/**
 * @l1 @deterministic @ci
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { apply, assess } from "../../legate/loop/handlers/babysit.js";
import type { LoopMeta } from "../../legate/loop/meta.js";
import { senseFromHerald } from "../../legate/loop/state/sense.js";
import type { HandlerContext } from "../../legate/loop/state/types.js";
import { TesseraClient } from "../../tessera/client.js";
import { buildServer, observeProfiles } from "./server.js";
import { sqliteAvailable } from "./sqlite.js";

const { execFile, startHeraldSpan, listSessions } = vi.hoisted(() => ({
  execFile: vi.fn(),
  listSessions: vi.fn(),
  startHeraldSpan: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("../../observability/herald-trace.js", () => ({ startHeraldSpan }));
vi.mock("../../castra/client.js", () => ({
  CastraClient: class {
    listSessions = listSessions;
    async sessionOutput() { return ""; }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it.skipIf(!sqliteAvailable).each([false, true])("observes independent profiles with scoped credentials (sync: %s)", async (sync) => {
  listSessions.mockResolvedValue([]);
  const home = mkdtempSync(join(tmpdir(), "herald-auth-test-"));
  const operatorConfig = join(home, ".config", "gh");
  mkdirSync(operatorConfig, { recursive: true });
  writeFileSync(join(operatorConfig, "hosts.yml"), "github.com:\n  user: operator\n");
  vi.stubEnv("HOME", home);
  vi.stubEnv("GH_CONFIG_DIR", operatorConfig);
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "mounted-enterprise-token");
  vi.stubEnv("MARCH_TESSERA_GH_TOKEN_FALLBACK", undefined);
  vi.stubEnv("MARCH_HERALD_SYNC", sync ? "1" : undefined);

  const requests: Array<{ repo: string; identity: string; access: string; refresh?: boolean }> = [];
  const directories = new Set<string>();
  const networkGit: string[] = [];
  const ended: Array<{ name: string; dispatchKey?: string; error?: boolean }> = [];
  startHeraldSpan.mockImplementation(({ name, dispatchKey }) => ({
    end: ({ error }: { error?: boolean } = {}) => ended.push({ name, dispatchKey, error }),
  }));
  const tessera = new TesseraClient({
    baseUrl: "http://tessera",
    clientKey: "herald-key",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer herald-key");
      if (request.repo === "denied/repo") throw new Error("secret transport detail");
      return Response.json({
        token: `issued-${request.repo}${request.refresh ? "-fresh" : ""}`,
        identity: "march[bot]",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        access: "read",
        repo: request.repo,
        commit_identity: { name: "March", email: "march@example.test" },
      });
    },
  });

  const prs = [
    { number: 11, author: { login: "operator" }, headRefName: "legacy", isCrossRepository: false },
    { number: 12, author: { login: "march[bot]" }, headRefName: "new", isCrossRepository: false },
    { number: 13, author: { login: "fork-user" }, headRefName: "legacy", isCrossRepository: true },
    { number: 14, author: { login: "fork-user" }, headRefName: "fork-only", isCrossRepository: true },
  ].map((pr) => ({ ...pr, state: "OPEN", createdAt: pr.isCrossRepository ? "2026-11-19" : "2026-11-18" }));
  const operator = { login: "operator", __typename: "User" };
  const march = { login: "March", __typename: "Bot" };
  const externalBot = { login: "external[bot]", __typename: "Bot" };
  const comment = (id: number, author: typeof operator, body = "Please fix this.") => ({
    databaseId: id, author, body, createdAt: `2026-11-19T12:00:${id}Z`,
  });
  let distinctReplies = false;
  let rejectOnce = true;
  execFile.mockImplementation((cmd, args: string[], options, cb) => {
    const reply = (value: unknown) => cb(null, typeof value === "string" ? value : JSON.stringify(value), "");
    const reject = (stderr: string) => cb(new Error("fake command failed"), "", stderr);
    if (cmd === "smithy") return reply({ records: [], graph: {} });
    if (cmd === "git") {
      if (args[0] === "config") {
        return reply(options.cwd === "/denied" ? "https://github.com/denied/repo" : "git@github.com:allowed/repo.git");
      }
      if (args[0] === "symbolic-ref") return reject("no origin/HEAD");
      if (args[0] === "ls-remote") return reply(args.at(-1));
      if (args.includes("fetch") || args.includes("pull")) {
        const url = args.at(-2);
        expect(url).toBe("https://github.com/allowed/repo.git");
        expect(args).toContain("credential.helper=");
        expect(options.env.GIT_ALLOW_PROTOCOL).toBe("https");
        expect(options.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(options.env.GH_TOKEN).toBeUndefined();
        const header: string = options.env.MARCH_GIT_AUTH_HEADER;
        expect(header).toBe("Authorization: Basic " + Buffer.from("x-access-token:issued-allowed/repo").toString("base64"));
        expect(args.join(" ")).not.toContain(header);
        networkGit.push(args.includes("fetch") ? "fetch" : "pull");
        return reply("");
      }
      expect(options.env.MARCH_GIT_AUTH_HEADER).toBeUndefined();
      return reply(args[0] === "rev-parse" ? "abcdef" : "");
    }
    expect(cmd).toBe("gh");
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.env.HOME).toBe(home);
    expect(options.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(options.env.GH_TOKEN).toMatch(/^issued-allowed\/repo(?:-fresh)?$/);
    expect(args.join(" ")).not.toContain(options.env.GH_TOKEN);
    expect(options.env.GH_CONFIG_DIR).not.toBe(operatorConfig);
    expect(readdirSync(options.env.GH_CONFIG_DIR)).toEqual([]);
    expect(directories.has(options.env.GH_CONFIG_DIR)).toBe(false);
    directories.add(options.env.GH_CONFIG_DIR);
    writeFileSync(join(options.env.GH_CONFIG_DIR, "hosts.yml"), "used by fake child");
    if (args[0] === "repo") {
      expect(args).toEqual(["repo", "view", "github.com/allowed/repo", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
      return reply("main");
    }
    if (args[0] === "api") {
      expect(args).toContain("owner=allowed");
      expect(args).toContain("name=repo");
      if (args.some((arg) => arg.includes("pullRequests(states: OPEN"))) {
        return reply({ data: { repository: { pullRequests: { nodes: [] } } } });
      }
      const legacy = args.includes("pr=11");
      const comments = legacy
        ? [comment(21, operator), comment(22, march), comment(23, operator, "  [march-bot] fixed")]
        : [comment(31, externalBot), comment(32, march)];
      if (distinctReplies && !legacy) comments.push(comment(33, externalBot));
      const threads = legacy
        ? [
          [comment(41, externalBot), comment(42, march)],
          [comment(43, externalBot), comment(44, operator, "[march-bot] fixed")],
          [comment(45, operator), ...(distinctReplies ? [comment(46, operator)] : [])],
        ]
        : [[comment(47, march)]];
      return reply({ data: { repository: { pullRequest: {
        headRefOid: "abcdef",
        comments: { nodes: comments },
        reviewThreads: { nodes: threads.map((nodes) => ({ isResolved: false, comments: { nodes } })) },
        reviews: { nodes: [
          { state: "CHANGES_REQUESTED", author: march, submittedAt: "2026-11-19T12:00:49Z" },
          { state: "APPROVED", author: externalBot, submittedAt: "2026-11-19T12:00:50Z" },
        ] },
      } } } });
    }
    expect(args).toContain("github.com/allowed/repo");
    if (args[1] === "list") {
      expect(args).not.toContain("--author");
      expect(args[args.indexOf("--json") + 1]).toContain("isCrossRepository");
      if (rejectOnce) {
        rejectOnce = false;
        return reject("gh: Bad credentials (HTTP 401)");
      }
      expect(options.env.GH_TOKEN).toBe("issued-allowed/repo-fresh");
      return reply(prs.filter((pr) => pr.headRefName === args[args.indexOf("--head") + 1]));
    }
    expect(args[1]).toBe("view");
    expect([11, 12]).toContain(Number(args[2]));
    return reply(prs.find((pr) => pr.number === Number(args[2])));
  });

  const { app, store, profileStore } = await buildServer({
    storeOptions: { dbPath: ":memory:" },
    profileStoreOptions: { dbPath: ":memory:" },
  });
  const logError = vi.spyOn(app.log, "error").mockImplementation(() => {});
  try {
    const denied = profileStore.register({ profile: "denied", repoPath: "/denied", repoName: "repo", workerGroup: "workers" });
    const allowed = profileStore.register({ profile: "allowed", repoPath: "/allowed", repoName: "repo", workerGroup: "workers" });
    function seed(profile: string, branch: string) {
      store.append({ source: "legate", profile, type: "slice.dispatched", sliceId: branch, branch });
      store.append({ source: "legate", profile, type: "slice.stage.changed", sliceId: branch, stage: "escalated" });
    }
    seed("denied", "denied-slice");
    for (const branch of ["legacy", "new", "fork-only"]) seed("allowed", branch);
    const before = structuredClone(store.projectionFor("denied"));
    await observeProfiles(app, store, [denied, allowed], tessera);
    expect(store.projectionFor("denied")).toEqual(before);
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ profile: "denied", code: "unreachable" }), expect.any(String));
    const slices = store.projectionFor("allowed").slices;
    expect(slices.legacy.pr).toMatchObject({ number: 11, head_sha: "abcdef" });
    expect(slices.new.pr).toMatchObject({ number: 12, head_sha: "abcdef" });
    expect(slices["fork-only"].pr).toEqual({ skipped: true, reason: "missing_pr_number" });

    if (!sync) {
      expect(slices.legacy.pr).toMatchObject({
        needs_response_count: 1, changes_requested_count: 0, bot_approval_count: 1,
        unresolved_threads: [
          { id: 41, needs_response: false, last_comment_is_march: true },
          { id: 43, needs_response: false, last_comment_is_march: true },
          { id: 45, needs_response: true, comment_ids: [45] },
        ],
        conversation_comments: [{ id: 21, author: "operator" }],
      });
      expect(slices.new.pr).toMatchObject({
        needs_response_count: 0,
        conversation_comments: [{ id: 31, author: "external[bot]" }],
      });

      const meta = { profile: "allowed", worker_group: "workers", repo: { path: "/allowed" } } as LoopMeta;
      const ts = "2026-11-19T11:00:00Z";
      const senseDeps = { meta, now: () => ts, readSmithyStatus: async () => ({ records: [], graph: {} }) };
      const inbox = { consume: async () => store.projectionFor("allowed") };
      const workerBranches = ["legacy", "new"];
      listSessions.mockResolvedValue(workerBranches.map((branch) => ({
        sessionId: `worker-${branch}`, group: "workers", status: "idle", branch,
      })));
      for (const branch of workerBranches) {
        store.append({
          source: "legate", profile: "allowed", type: "slice.stage.changed", sliceId: branch,
          stage: "pr-open", sessionId: `worker-${branch}`,
        });
      }
      await observeProfiles(app, store, [allowed], tessera);
      const sendMessage = vi.fn(async () => {});
      const feedbackDeps = { sendMessage, requestJudgement: vi.fn() };
      const feedbackDecisions = (state: Awaited<ReturnType<typeof senseFromHerald>>) =>
        assess(state).filter((d) => d.kind === "review-fix" || d.kind === "comment-fix");

      const state = await senseFromHerald(senseDeps, inbox, null);
      // A warm slice's recency heuristic must also leave March-answered threads alone.
      state.slices.legacy.pr_open_at = ts;
      const decisions = feedbackDecisions(state);
      expect(decisions).toMatchObject([
        { kind: "review-fix", sliceId: "legacy", pr: { number: 11 }, commentIds: ["45"] },
        { kind: "comment-fix", sliceId: "new", pr: { number: 12 }, commentIds: ["31"] },
      ]);
      const transitions: Promise<{ statusCode: number }>[] = [];
      const ctx = {
        meta, ts, emit: vi.fn(), log: vi.fn(), castra: {} as HandlerContext["castra"], broodTeardown: vi.fn(),
        emitTransition: (event) => {
          transitions.push(app.inject({ method: "POST", url: "/events", payload: { ...event, profile: "allowed" } }));
        },
      } satisfies HandlerContext;
      await apply(decisions, ctx, state, feedbackDeps);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect((await Promise.all(transitions)).map((response) => response.statusCode)).toEqual([201, 201]);

      await observeProfiles(app, store, [allowed], tessera);
      expect(feedbackDecisions(await senseFromHerald(senseDeps, inbox, state.raw))).toEqual([]);
      expect(feedbackDecisions(await senseFromHerald(senseDeps, inbox, null))).toEqual([]);

      distinctReplies = true;
      await observeProfiles(app, store, [allowed], tessera);
      expect(feedbackDecisions(await senseFromHerald(senseDeps, inbox, null))).toMatchObject([
        { kind: "review-fix", sliceId: "legacy", commentIds: ["46"] },
        { kind: "comment-fix", sliceId: "new", commentIds: ["33"] },
      ]);
    }
    expect(networkGit).toEqual(sync ? ["fetch", "pull"] : []);
    expect(requests).toEqual([
      { repo: "denied/repo", identity: "app", access: "read" },
      { repo: "allowed/repo", identity: "app", access: "read" },
      { repo: "allowed/repo", identity: "app", access: "read", refresh: true },
    ]);
    expect(ended).toContainEqual({
      name: "herald.github.read", dispatchKey: sync ? undefined : "denied-slice", error: true,
    });
    expect(ended).toContainEqual(expect.objectContaining({ name: "herald.observe.failed", error: true }));
    expect([...directories].every((dir) => !existsSync(dir))).toBe(true);
    expect(process.env.GH_TOKEN).toBeUndefined();
  } finally {
    await app.close();
    store.close();
    profileStore.close();
    rmSync(home, { recursive: true, force: true });
  }
});
