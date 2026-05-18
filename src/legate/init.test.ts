import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import nodeCrypto from "node:crypto";
import {
  buildColdStartPrompt,
  checkBridgeRequirements,
  DEFAULT_HEARTBEAT_INTERVAL,
  deriveDefaults,
  discoverRepoMetadata,
  ensureInitialState,
  initLegate,
  LegateError,
  LEGATE_SKILLS,
  renderPrompt,
  renderTemplate,
  slugify,
  writeHeartbeatTimerOverride,
  writeLegateHeartbeatScript,
} from "./init.js";

describe("legate module", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-legate-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpDirs.length = 0;
  });

  describe("slugify", () => {
    it("lowercases and replaces non-alphanumeric runs with single hyphens", () => {
      expect(slugify("March")).toBe("march");
      expect(slugify("Agent Deck")).toBe("agent-deck");
      expect(slugify("My_Project.v2")).toBe("my-project-v2");
    });

    it("trims leading and trailing hyphens", () => {
      expect(slugify("__weird__")).toBe("weird");
      expect(slugify("---trim---")).toBe("trim");
    });

    it("returns an empty string when the input has no slug-able characters", () => {
      expect(slugify("")).toBe("");
      expect(slugify("___")).toBe("");
    });

    it("caps length at 56 chars to leave headroom for the legate- prefix", () => {
      const long = "x".repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(56);
    });
  });

  describe("deriveDefaults", () => {
    it("derives profile, conductor name, and worker group from the repo basename", () => {
      const defaults = deriveDefaults("/home/user/Development/March");
      expect(defaults.repoName).toBe("March");
      expect(defaults.profile).toBe("march");
      expect(defaults.conductorName).toBe("march-legate-agent");
      expect(defaults.loopName).toBe("march-legate-loop");
      expect(defaults.processorName).toBe("march-legate-loop");
      expect(defaults.workerGroup).toBe("legate-workers");
    });

    it("falls back to a path-hashed slug when the repo basename has no slug-able characters", () => {
      const a = deriveDefaults("/path/to/___");
      const b = deriveDefaults("/other/path/to/___");
      expect(a.conductorName).not.toBe(b.conductorName);
      expect(a.profile).not.toBe(b.profile);
      expect(a.conductorName).toMatch(/^repo-[0-9a-f]{8}-legate-agent$/);
      expect(a.processorName).toMatch(/^repo-[0-9a-f]{8}-legate-loop$/);
      expect(b.conductorName).toMatch(/^repo-[0-9a-f]{8}-legate-agent$/);

      const a2 = deriveDefaults("/path/to/___");
      expect(a2.conductorName).toBe(a.conductorName);
    });

    it("encodes the repo slug into the conductor name so per-repo legates do not collide", () => {
      expect(deriveDefaults("/path/to/Smithy").conductorName).toBe("smithy-legate-agent");
      expect(deriveDefaults("/path/to/AgentDeck").conductorName).toBe("agentdeck-legate-agent");
    });
  });

  describe("checkBridgeRequirements", () => {
    it("returns the host's actual python3 version on success", () => {
      const result = checkBridgeRequirements();
      if (result.ok) {
        expect(result.pythonVersion).toMatch(/^\d+\.\d+$/);
      } else {
        expect(["missing", "too-old", "unparseable"]).toContain(result.reason);
        expect(result.message).toMatch(/python|Python/);
        expect(result.message).toContain("--no-bridge-check");
      }
    });
  });

  describe("renderTemplate / renderPrompt", () => {
    const baseVars = {
      REPO_NAME: "March",
      REPO_PATH: "/home/u/March",
      PROFILE: "march",
      CONDUCTOR_NAME: "march-legate-agent",
      LOOP_NAME: "march-legate-loop",
      PROCESSOR_NAME: "march-legate-loop",
      WORKER_GROUP: "legate-workers",
    };

    it("substitutes Handlebars-style {{INPUT}} placeholders in one pass", async () => {
      const tpl =
        "name={{REPO_NAME}} path={{REPO_PATH}} profile={{PROFILE}} " +
        "name-again={{REPO_NAME}} cond={{CONDUCTOR_NAME}} group={{WORKER_GROUP}}";
      const out = await renderTemplate(tpl, baseVars);
      expect(out).toContain("name=March");
      expect(out).toContain("path=/home/u/March");
      expect(out).toContain("profile=march");
      expect(out).toContain("name-again=March");
      expect(out).toContain("cond=march-legate-agent");
      expect(out).toContain("group=legate-workers");
    });

    it("resolves a {{>partial}} include from the supplied snippets map", async () => {
      // Snippet content references the same {{INPUT}} variables — the partial
      // is rendered in the consuming template's scope, so substitutions take
      // effect there too.
      const out = await renderPrompt(
        "Header\n\n{{>state-schema}}\n\nFooter for {{REPO_NAME}}",
        { "state-schema": "Schema for {{REPO_NAME}} at {{REPO_PATH}}." },
        baseVars,
      );
      expect(out).toContain("Header");
      expect(out).toContain("Schema for March at /home/u/March.");
      expect(out).toContain("Footer for March");
    });

    it("preserves frontmatter verbatim (Dotprompt's strict schema does not see SKILL allowed-tools)", async () => {
      // SKILL.prompt files carry frontmatter with `allowed-tools` (not in
      // dotprompt's schema). renderPrompt strips frontmatter, renders the
      // body, and re-attaches the original frontmatter unchanged.
      const tpl =
        "---\nname: test\nallowed-tools: Bash(./foo.sh:*)\n---\nBody for {{REPO_NAME}}\n";
      const out = await renderPrompt(tpl, {}, baseVars);
      expect(out).toContain("---\nname: test\nallowed-tools: Bash(./foo.sh:*)\n---\n");
      expect(out).toContain("Body for March");
    });
  });

  describe("initLegate", () => {
    /**
     * Build a fake template *directory* that mirrors the production layout:
     *   <dir>/CLAUDE.prompt
     *   <dir>/snippets/<name>.md       (optional)
     *   <dir>/skills/<name>/SKILL.prompt
     *   <dir>/skills/<name>/scripts/*.sh
     *
     * Skills follow the production names (legate.babysit, legate.issue)
     * because the deploy code enumerates them via LEGATE_SKILLS.
     */
    function makeTemplateDir(claudeContent: string): string {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, "CLAUDE.prompt"), claudeContent);
      const snippetsDir = path.join(dir, "snippets");
      fs.mkdirSync(snippetsDir, { recursive: true });
      // README in snippets/ should not be treated as a partial.
      fs.writeFileSync(path.join(snippetsDir, "README.md"), "snippets dev docs\n");
      for (const skillName of LEGATE_SKILLS) {
        const skillDir = path.join(dir, "skills", skillName);
        fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.prompt"),
          `---\nname: ${skillName}\nallowed-tools: Bash(.claude/skills/${skillName}/scripts/noop.sh:*)\n---\n# ${skillName}\n\nrepo: {{REPO_NAME}}\n`,
        );
        fs.writeFileSync(
          path.join(skillDir, "scripts", "noop.sh"),
          "#!/bin/sh\nexit 0\n",
        );
      }
      return dir;
    }

    it("renders CLAUDE.prompt into the staging dir and returns expected fields", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir(
        "Repo: {{REPO_NAME}} ({{REPO_PATH}})\nProfile: {{PROFILE}}\nConductor: {{CONDUCTOR_NAME}}\nGroup: {{WORKER_GROUP}}\n",
      );

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      expect(result.profile).toBe("march");
      expect(result.conductorName).toBe("march-legate-agent");
      expect(result.loopName).toBe("march-legate-loop");
      expect(result.workerGroup).toBe("legate-workers");
      expect(result.repoName).toBe("March");
      expect(result.setupRan).toBe(false);

      const expected = path.join(
        home,
        ".march",
        "legate",
        "march-legate-agent",
        "CLAUDE.md",
      );
      expect(result.templateOutputPath).toBe(expected);
      expect(fs.existsSync(expected)).toBe(true);

      const rendered = fs.readFileSync(expected, "utf-8");
      expect(rendered).toContain("Repo: March (/some/repo/March)");
      expect(rendered).toContain("Profile: march");
      expect(rendered).toContain("Conductor: march-legate-agent");
      expect(rendered).toContain("Group: legate-workers");
    });

    it("includes the agent-deck setup command in the result for caller display", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      expect(result.setupCommand[0]).toBe("agent-deck");
      expect(result.setupCommand).toContain("-p");
      expect(result.setupCommand).toContain("march");
      expect(result.setupCommand).toContain("setup");
      expect(result.setupCommand).toContain("march-legate-agent");
      expect(result.setupCommand).toContain("-no-heartbeat");
      expect(result.setupCommand).not.toContain("-claude-md");
      expect(result.summary).toContain("Setup skipped");
      expect(result.summary).toContain(
        "no conductor has been created and nothing has been copied",
      );
      expect(result.summary).not.toContain("symlinked to the template above");
      expect(result.summary).toContain(
        "Then enable auto mode, pin model, restart, and deliver the",
      );
      expect(result.summary).toContain("auto-mode true");
      expect(result.summary).toContain("--model sonnet");
      expect(result.summary).toContain("session restart");
      // The --no-setup summary must tell the user to deliver the cold-start
      // priming prompt; otherwise auto-mode runs without alignment context.
      expect(result.summary).toContain("session send");
      expect(result.summary).toContain("cold-start-prompt.txt");
      expect(result.summary).toMatch(/"\$\(cat .*cold-start-prompt\.txt\)"/);
      // The full multi-paragraph prompt body must not be inlined in the
      // printable summary (it's the file's contents, not the command).
      expect(result.summary).not.toContain("Cold start as the Legate for March");
    });

    it("stages a deterministic loop scaffold by default", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("processor={{PROCESSOR_NAME}}");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      expect(result.loopName).toBe("march-legate-loop");
      expect(result.processorName).toBe("march-legate-loop");
      expect(result.processorStagingDir).toBe(
        path.join(home, ".march", "legate", "march-legate-agent", "loop"),
      );
      expect(result.processorConductorDir).toBe(
        path.join(home, ".agent-deck", "conductor", "march-legate-loop"),
      );
      expect(result.processorSetupCommand).toEqual([
        "agent-deck",
        "-p",
        "march",
        "conductor",
        "setup",
        "march-legate-loop",
        "-description",
        "Deterministic Legate loop for March",
        "-no-heartbeat",
      ]);
      expect(result.processorSetupRan).toBe(false);
      expect(result.processorConfigured).toBe(false);

      const loopPath = path.join(result.processorStagingDir!, "legate-loop.mjs");
      const metaPath = path.join(result.processorStagingDir!, "legate-loop-meta.json");
      expect(fs.existsSync(loopPath)).toBe(true);
      expect(fs.statSync(loopPath).mode & 0o111).not.toBe(0);
      expect(() =>
        execFileSync(process.execPath, ["--check", loopPath], { stdio: "pipe" }),
      ).not.toThrow();
      const loop = fs.readFileSync(loopPath, "utf-8");
      expect(loop).toContain("console.log(text)");
      expect(loop).toContain("function printText");
      expect(loop).toContain("function replayRecentActionEvents");
      expect(loop).toContain("recent processor action event(s) to stdout");
      expect(loop).toContain("function runBabysit");
      expect(loop).toContain("function queryPrForBabysit");
      expect(loop).toContain("function requestLegateJudgement");
      expect(loop).toContain('"[PROCESSOR]"');
      expect(loop).toContain("processor_requests_path");
      expect(loop).toContain("review-fix");
      expect(loop).toContain("conflict-fix");
      expect(loop).toContain("function expectedPrBranches");
      expect(loop).toContain("function prMatchesSliceBranch");
      expect(loop).toContain("!prMatchesSliceBranch(slice, pr) ? null : pr");
      expect(loop).toContain("candidates.filter((candidate) => prMatchesSliceBranch(slice, candidate))");
      expect(loop).toContain('pr.checks === "PASS" && pr.needs_response_count === 0');
      expect(loop).toContain("CI failure requires Legate judgement");
      expect(loop).toContain("worker_session_error");
      expect(loop).toContain("claude_api_401_login_required");
      expect(loop).toContain("function hasClaudeLoginBlock");
      expect(loop).toContain("login-resume");
      expect(loop).toContain("function workerErrorRequestKey");
      expect(loop).toContain('return `worker-error:${sessionId}:${stage}:${pr}:${outputHash}`');
      expect(loop).toContain("function workerErrorDetail");
      expect(loop).toContain("agent-deck error state");
      expect(loop).not.toContain("restartWorker(");
      expect(loop).toContain("] heartbeat slice_count=");
      expect(loop).toContain("function formatCleanupLine");
      expect(loop).toContain("${prefix}cleaned up");
      expect(loop).toContain('list", "-json"');
      expect(loop).toContain('"session", "remove", sessionId, "--prune-worktree", "--force"');
      expect(loop).toContain('terminalState !== "MERGED" && terminalState !== "CLOSED"');
      expect(loop).toContain('reason: "session_not_found"');
      expect(loop).toContain('terminal_state: terminalState');
      expect(loop).toContain("function cleanupTerminalPrs");
      expect(loop).toContain("function runDispatch");
      expect(loop).toContain("function readySmithyItems");
      expect(loop).toContain("function execMarch");
      expect(loop).toContain('import { execFileSync, spawn } from "node:child_process";');
      expect(loop).toContain("meta.march_cli_path");
      expect(loop).toContain("hashText(dispatchItemKey(item))");
      expect(loop).toContain("function forgeNodeId");
      expect(loop).toContain("status?.graph?.nodes");
      expect(loop).toContain("function dependencySatisfied");
      expect(loop).toContain("dispatchSliceId(depItem)");
      expect(loop).toContain("function readyLayerNodeIds");
      expect(loop).toContain("readyLayerNodeIds(status)");
      // dependenciesClear used to gate forge dispatches behind row-level
      // `depends_on` resolution, but it disagreed with smithy's own layer-0
      // ready set when a row's depends_on referenced a tasks.md without a
      // slice suffix. Trust smithy as the readiness authority; the loop
      // dispatches every item in `readySmithyItems(status)` that isn't
      // already in flight.
      expect(loop).not.toContain("!dependenciesClear(state, status, item)");
      expect(loop).toContain("alreadyArchivedSlice(state, item, sliceId)");
      expect(loop).toContain('kind: "dispatch_failure"');
      expect(loop).toContain('kind: "dispatch_read_failure"');
      expect(loop).toContain("function launchHatcheryDispatch");
      expect(loop).toContain("child.unref()");
      expect(loop).toContain("function completePendingHatcheryDispatches");
      expect(loop).toContain('stage: "hatchery-pending"');
      // Escalated/closed-unmerged slices must still block re-dispatch of the
      // same artifact — only a merged slice releases the artifact.
      expect(loop).toContain("function sliceReleasesArtifact");
      expect(loop).toContain('slice.stage === "merged"');
      expect(loop).toContain("if (sliceReleasesArtifact(slice)) continue;");
      // Legacy stub archive entries (no command, no branch) must not block
      // fresh dispatches by SID collision alone.
      expect(loop).toContain("function isStubArchivedSlice");
      expect(loop).toContain("!isStubArchivedSlice(archived[sliceId])");
      // Runner crash guard: any runner-side exception must still produce a
      // result file so the loop can transition the slice out of hatchery-pending.
      expect(loop).toContain("hatchery runner crashed:");
      // Stuck hatchery-pending slices must time out and escalate so a crashed
      // runner doesn't park a slice forever.
      expect(loop).toContain("HATCHERY_PENDING_TIMEOUT_MS");
      expect(loop).toContain("produced no result file");
      expect(loop).toContain("left an empty result file");
      expect(loop).toContain("hatchery_result_path");
      expect(loop).toContain('"hatchery"');
      expect(loop).toContain('"--backend"');
      expect(loop).toContain('"codex"');
      expect(loop).toContain('"--json"');
      expect(loop).toContain("dispatch_action_count");
      expect(loop).toContain("Number.isFinite(rawIntervalSeconds)");
      expect(loop).toContain("function safeTick()");
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      expect(meta.paired_legate).toBe("march-legate-agent");
      expect(meta.loop_name).toBe("march-legate-loop");
      expect(meta.processor_name).toBe("march-legate-loop");
      expect(meta.march_cli_path).toBeTruthy();
      expect(meta.legate_state_path).toBe(
        path.join(home, ".agent-deck", "conductor", "march-legate-agent", "state.json"),
      );
      expect(meta.legate_conductor_dir).toBe(
        path.join(home, ".agent-deck", "conductor", "march-legate-agent"),
      );
      expect(meta.loop_requests_path).toBe(
        path.join(home, ".agent-deck", "conductor", "march-legate-loop", "legate-loop-requests.ndjson"),
      );
      expect(meta.mode).toBe("terminal-pr-maintenance");

      const rendered = fs.readFileSync(result.templateOutputPath, "utf-8");
      expect(rendered).toContain("processor=march-legate-loop");
      expect(result.summary).toContain("Loop:");
      expect(result.summary).toContain("march-legate-loop");
      expect(result.summary).toContain("terminal PR maintenance");
    });

    // The functions below live inside the LEGATE_LOOP_MJS template literal
    // and run only inside the deployed loop process, so we can't import them
    // directly. We extract each function's source via regex and reconstruct
    // a callable with `new Function`. The goal is to test the *behavior* of
    // the generated code — substring assertions higher up missed three real
    // bugs (runner syntax, stub-archive dedup, escalated dedup) that these
    // tests now lock in.
    async function stageLoop(home: string): Promise<string> {
      const tplDir = makeTemplateDir("ok");
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });
      return path.join(result.processorStagingDir!, "legate-loop.mjs");
    }

    function extractFn(loopSrc: string, name: string, deps: string[] = []): Function {
      const grab = (n: string) => {
        const re = new RegExp(`function ${n}\\([^)]*\\)\\s*\\{[\\s\\S]+?\\n\\}`);
        const match = loopSrc.match(re);
        if (!match) throw new Error(`could not extract function ${n}`);
        return match[0];
      };
      const blobs = [...deps, name].map(grab);
      // The loop file's hashText calls crypto.createHash from a top-level
      // `import crypto from "node:crypto"`. In our isolated `new Function`
      // sandbox there's no module scope, so we pass crypto in as a parameter.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function("crypto", `${blobs.join("\n")}; return ${name};`)(nodeCrypto);
    }

    it("generated hatchery runner code parses as valid JavaScript", async () => {
      // Regression guard for the escape bug where "\\n" in the template
      // literal collapsed to a real newline inside the runner's "..." string
      // literal, producing a SyntaxError that silently killed every spawn.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const hatcheryRunnerCode = extractFn(loop, "hatcheryRunnerCode") as () => string;
      const runner = hatcheryRunnerCode();
      expect(() => new Function(runner)).not.toThrow();
      // Also confirm node -e accepts it — this is what the loop actually does.
      expect(() =>
        execFileSync(process.execPath, ["--check", "-"], { input: runner, stdio: "pipe" }),
      ).not.toThrow();
    });

    it("generated hatchery runner writes an error result when the spawn exits non-zero", async () => {
      // End-to-end: build the runner, run it against a request that fails,
      // verify it writes the expected error JSON and stderr log. Catches both
      // the syntax bug (runner wouldn't execute at all) and any future
      // regression in the success/failure branching.
      const home = makeTmpDir();
      const loop = fs.readFileSync(await stageLoop(home), "utf-8");
      const hatcheryRunnerCode = extractFn(loop, "hatcheryRunnerCode") as () => string;
      const requestPath = path.join(home, "req.json");
      const resultPath = path.join(home, "result.json");
      const logPath = path.join(home, "result.log");
      fs.writeFileSync(
        requestPath,
        JSON.stringify({
          command: "/bin/sh",
          args: ["-c", "printf 'boom\\n' 1>&2; exit 7"],
          cwd: home,
          resultPath,
          logPath,
        }),
      );
      execFileSync(process.execPath, ["-e", hatcheryRunnerCode(), requestPath, resultPath, logPath], { stdio: "pipe" });
      const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      expect(result.exitCode).toBe(7);
      expect(String(result.error)).toContain("boom");
      expect(fs.readFileSync(logPath, "utf-8")).toContain("boom");
    });

    it("generated hatchery runner writes a crash result when the request file is malformed", async () => {
      // Regression guard: previously the crash branch only wrote when
      // `request` had parsed successfully (which exposed request.resultPath).
      // A malformed request file left request = null, the catch block had no
      // path to write to, and the slice sat in hatchery-pending until the
      // 15-min stale timeout fired. Now resultPath/logPath come in as
      // separate argv entries so the crash guard can always write.
      const home = makeTmpDir();
      const loop = fs.readFileSync(await stageLoop(home), "utf-8");
      const hatcheryRunnerCode = extractFn(loop, "hatcheryRunnerCode") as () => string;
      const requestPath = path.join(home, "bad-req.json");
      const resultPath = path.join(home, "result.json");
      const logPath = path.join(home, "result.log");
      fs.writeFileSync(requestPath, "not valid json{{{");
      try {
        execFileSync(process.execPath, ["-e", hatcheryRunnerCode(), requestPath, resultPath, logPath], { stdio: "pipe" });
      } catch {
        // runner exits 1 on crash; that's fine, we just need the result file.
      }
      const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      expect(String(result.error)).toContain("hatchery runner crashed:");
      expect(result.exitCode).toBeNull();
      expect(fs.readFileSync(logPath, "utf-8")).toContain("runner crash:");
    });

    it("isStubArchivedSlice distinguishes legacy stubs from real archive entries", async () => {
      // Regression guard for the smithy outage where 8 legacy stub archive
      // entries (cmd=null, branch=null) silently blocked every fresh
      // dispatch via SID collision.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const isStub = extractFn(loop, "isStubArchivedSlice") as (s: unknown) => boolean;
      expect(isStub(null)).toBe(true);
      expect(isStub({})).toBe(true);
      expect(isStub({ command: null, arguments: null, branch: null })).toBe(true);
      expect(isStub({ command: "smithy.forge" })).toBe(false);
      expect(isStub({ branch: "smithy/forge/x-abc12345" })).toBe(false);
      expect(isStub({ actual_branch: "feature/smithy/forge/x" })).toBe(false);
    });

    it("dispatch identity derives semantic stems from structured records", async () => {
      // Regression guard: the prior hash-based scheme produced opaque names
      // (smithy/forge/tasks-deployment-location-...-cc245ea6) where a
      // collision told the operator nothing. The new derivation should
      // produce stems that match the hand-curated march pattern
      // (us6-s1, m1, etc.) so a collision reads as "this exact slice is
      // re-attempting" rather than "this hash is re-attempting."
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const deps = ["smithyVerb", "actionArguments", "slugifyDispatchPart", "hashText", "dispatchItemKey", "dispatchArtifactSlug", "dispatchIdentity"];
      const dispatchSliceId = extractFn(loop, "dispatchSliceId", deps) as (item: unknown) => string;
      const dispatchBranch = extractFn(loop, "dispatchBranch", deps) as (item: unknown) => string;

      const forge = {
        path: "specs/2026-03-21-002-smithy-orders-issue-templates/03-deployment-location-honored-end-to-end.tasks.md",
        parent_path: "specs/2026-03-21-002-smithy-orders-issue-templates/smithy-orders-issue-templates.spec.md",
        parent_row_id: "US3",
        next_action: { command: "smithy.forge", arguments: ["specs/...whatever.tasks.md", "2"] },
      };
      expect(dispatchSliceId(forge)).toBe("smithy-orders-issue-templates-us3-s2-forge");
      expect(dispatchBranch(forge)).toBe("smithy/forge/smithy-orders-issue-templates-us3-s2");

      const cut = {
        parent_path: "specs/2026-05-15-006-smithy-implement/smithy-implement.spec.md",
        parent_row_id: "US1",
        next_action: { command: "smithy.cut", arguments: ["specs/2026-05-15-006-smithy-implement", "1"] },
      };
      expect(dispatchSliceId(cut)).toBe("smithy-implement-us1-s1-cut");
      expect(dispatchBranch(cut)).toBe("smithy/cut/smithy-implement-us1-s1");

      const mark = {
        path: "docs/rfcs/2026-001-token-savings/01-measurement-foundation.features.md",
        parent_path: "docs/rfcs/2026-001-token-savings/token-savings.rfc.md",
        parent_row_id: "M1",
        next_action: { command: "smithy.mark", arguments: ["docs/rfcs/2026-001-token-savings/01-measurement-foundation.features.md"] },
      };
      expect(dispatchSliceId(mark)).toBe("token-savings-m1-mark");
      expect(dispatchBranch(mark)).toBe("smithy/mark/token-savings-m1");

      const render = {
        next_action: { command: "smithy.render", arguments: ["docs/rfcs/2026-001-token-savings/token-savings.rfc.md", "3"] },
      };
      expect(dispatchSliceId(render)).toBe("token-savings-m3-render");
      expect(dispatchBranch(render)).toBe("smithy/render/token-savings-m3");
    });

    it("dispatch identity falls back to hash-based stem when record lacks structure", async () => {
      // Records without parent_path / parent_row_id (or unusual verbs) still
      // need to dispatch — fall back to the legacy hash scheme rather than
      // produce an ambiguous stem.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const deps = ["smithyVerb", "actionArguments", "slugifyDispatchPart", "hashText", "dispatchItemKey", "dispatchArtifactSlug", "dispatchIdentity"];
      const dispatchSliceId = extractFn(loop, "dispatchSliceId", deps) as (item: unknown) => string;
      const dispatchBranch = extractFn(loop, "dispatchBranch", deps) as (item: unknown) => string;
      const dispatchIdentity = extractFn(loop, "dispatchIdentity", deps) as (item: unknown) => { semantic: boolean };

      const orphan = {
        path: "some/loose/artifact.md",
        title: "Free-floating record",
        next_action: { command: "smithy.forge", arguments: ["some/loose/artifact.md", "1"] },
      };
      expect(dispatchIdentity(orphan).semantic).toBe(false);
      // Fallback IDs use the legacy <stem>-<verb>-<hash> order so existing
      // state.json / archive entries keyed by the legacy ID keep matching.
      expect(dispatchSliceId(orphan)).toMatch(/-forge-[0-9a-f]{8}$/);
      expect(dispatchBranch(orphan)).toMatch(/^smithy\/forge\/.+-[0-9a-f]{8}$/);
    });

    it("parseBranchCollisionError extracts the branch name from hatchery spawn errors", async () => {
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const parse = extractFn(loop, "parseBranchCollisionError") as (s: string) => string | null;
      expect(parse("agent-deck manager launch failed:\nError: branch 'feature/smithy/forge/foo-bar' already exists (remove -b flag to use existing branch)\n")).toBe("feature/smithy/forge/foo-bar");
      expect(parse("some unrelated error")).toBeNull();
      expect(parse("")).toBeNull();
    });

    it("classifyBranchCollision returns autoSafe verdicts only for risk-free cases", async () => {
      // Locks in the loop's policy: never auto-delete a branch with an open
      // PR or with diverged work whose status is unknown. Open-PR and
      // diverged-unknown must require operator/agent review.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const classify = extractFn(loop, "classifyBranchCollision") as (info: unknown) => { verdict: string; autoSafe: boolean };

      // HEAD already on default branch => orphan ref, no diverged work
      expect(classify({ head: "abc", isAncestor: true, prs: [], prsKnown: true })).toMatchObject({ verdict: "orphan-ref", autoSafe: true });
      // Merged PR + no open PR + diverged HEAD (squash-merge case)
      expect(classify({ head: "abc", isAncestor: false, prs: [{ number: 1, state: "MERGED" }], prsKnown: true })).toMatchObject({ verdict: "post-merge-stale", autoSafe: true });
      // Open PR — must escalate even if also merged
      expect(classify({ head: "abc", isAncestor: false, prs: [{ number: 1, state: "OPEN" }, { number: 2, state: "MERGED" }], prsKnown: true })).toMatchObject({ verdict: "open-pr", autoSafe: false });
      expect(classify({ head: "abc", isAncestor: true, prs: [{ number: 1, state: "OPEN" }], prsKnown: true })).toMatchObject({ verdict: "open-pr", autoSafe: false });
      // Diverged HEAD + no PR data — unknown work, escalate
      expect(classify({ head: "abc", isAncestor: false, prs: [], prsKnown: true })).toMatchObject({ verdict: "diverged-unknown", autoSafe: false });
      // Null info (branch already gone) — nothing to recover
      expect(classify(null)).toMatchObject({ verdict: "no-such-branch", autoSafe: false });
      // gh pr list failed — cannot prove there's no open PR, must refuse
      // autoSafe even for an ancestor-of-master branch.
      expect(classify({ head: "abc", isAncestor: true, prs: [], prsKnown: false })).toMatchObject({ verdict: "pr-lookup-unknown", autoSafe: false });
      expect(classify({ head: "abc", isAncestor: false, prs: [], prsKnown: false })).toMatchObject({ verdict: "pr-lookup-unknown", autoSafe: false });
    });

    it("parseWrongWorktreeRaceError detects the agent-deck launch-race refusal", async () => {
      // The error text in spawn-handoff.ts is the contract; if it changes
      // there, this regex must change in lockstep.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const parse = extractFn(loop, "parseWrongWorktreeRaceError") as (s: string) => boolean;
      expect(parse(
        'agent-deck manager session "abc-123" attached to worktree "/tmp/feature-wrong" but this launch requested branch "smithy/forge/x" which should produce worktree dir "feature-smithy-forge-x". Refusing to apply patch to the wrong worktree.',
      )).toBe(true);
      // Branch-already-exists is a different recovery path and must not
      // match — otherwise tryRecoverWrongWorktreeRace would swallow it
      // before tryRecoverBranchCollision gets a chance.
      expect(parse("agent-deck manager launch failed:\nError: branch 'feature/smithy/forge/x' already exists")).toBe(false);
      expect(parse("git apply --index failed in manager worktree: corrupt patch")).toBe(false);
      expect(parse("")).toBe(false);
    });

    it("tryRecoverWrongWorktreeRace releases the slice for the first 3 attempts then escalates", async () => {
      // Race-victim auto-release path. The wrong-worktree refusal is a
      // known-transient upstream agent-deck race; escalating immediately
      // would strand the slice on operator review for something that
      // would have resolved on the next tick. Cap retries so a persistent
      // race still surfaces to the operator.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const recover = extractFn(
        loop,
        "tryRecoverWrongWorktreeRace",
        ["transientRetryCounts", "parseWrongWorktreeRaceError", "deleteHatcheryArtifacts"],
      ) as (state: any, slice: any, sliceId: string, errorText: string) => any;

      const errorText =
        'agent-deck manager session "abc-123" attached to worktree "/tmp/feature-wrong" but this launch requested branch "smithy/forge/x" which should produce worktree dir "feature-smithy-forge-x". Refusing to apply patch to the wrong worktree.';
      const sliceId = "s1";
      const state: any = { slices: { [sliceId]: { hatchery: {} } } };

      const r1 = recover(state, state.slices[sliceId], sliceId, errorText);
      expect(r1).toMatchObject({ recovered: true, verdict: "wrong-worktree-race" });
      expect(state.slices[sliceId]).toBeUndefined();
      expect(state.transient_retry_counts[sliceId]).toBe(1);

      state.slices[sliceId] = { hatchery: {} };
      const r2 = recover(state, state.slices[sliceId], sliceId, errorText);
      expect(r2).toMatchObject({ recovered: true });
      expect(state.transient_retry_counts[sliceId]).toBe(2);

      state.slices[sliceId] = { hatchery: {} };
      const r3 = recover(state, state.slices[sliceId], sliceId, errorText);
      expect(r3).toMatchObject({ recovered: true });
      expect(state.transient_retry_counts[sliceId]).toBe(3);

      // Fourth attempt exceeds the limit — does NOT delete the slice
      // (caller falls through to escalation) and clears the counter so a
      // future successful dispatch starts fresh.
      state.slices[sliceId] = { hatchery: {} };
      const r4 = recover(state, state.slices[sliceId], sliceId, errorText);
      expect(r4).toMatchObject({ recovered: false, verdict: "wrong-worktree-race-persistent" });
      expect(state.slices[sliceId]).toBeDefined();
      expect(state.transient_retry_counts[sliceId]).toBeUndefined();
    });

    it("tryRecoverWrongWorktreeRace returns null for non-race errors", async () => {
      // Other recovery paths must not be hijacked. A corrupt-patch or
      // branch-collision error has its own escalation behavior.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const recover = extractFn(
        loop,
        "tryRecoverWrongWorktreeRace",
        ["transientRetryCounts", "parseWrongWorktreeRaceError", "deleteHatcheryArtifacts"],
      ) as (state: any, slice: any, sliceId: string, errorText: string) => any;

      const state: any = { slices: { s1: { hatchery: {} } } };
      expect(recover(state, state.slices.s1, "s1", "git apply --index failed in manager worktree: corrupt patch")).toBeNull();
      expect(recover(state, state.slices.s1, "s1", "agent-deck manager launch failed:\nError: branch 'feature/x' already exists")).toBeNull();
      // Slice must NOT have been deleted by a null return.
      expect(state.slices.s1).toBeDefined();
    });

    it("maybeNudgeStrandedSteward re-nudges every 5 min after first nudge until 25 min budget", async () => {
      // Watchdog for stewards that exit between push and `gh pr create`.
      // sonnet typically completes only one stage per turn (commit, then
      // push, then gh pr create), so a single nudge often only advances the
      // workflow one step. The watchdog re-nudges every interval until the
      // PR opens or the total budget runs out.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const nudge = extractFn(
        loop,
        "maybeNudgeStrandedSteward",
        ["strandedStewardConfig"],
      ) as (slice: any, sliceId: string, sessionId: string, ts: string, sendMessage: any) => string | null;

      const sends: Array<{ sessionId: string; msg: string }> = [];
      const sendStub = (sessionId: string, msg: string) => { sends.push({ sessionId, msg }); };

      // Just-handed-off: too early to nudge.
      const slice: any = { stage: "implementing", implementing_started_at: "2026-05-18T10:00:00.000Z" };
      expect(nudge(slice, "s1", "sess-1", "2026-05-18T10:05:00.000Z", sendStub)).toBeNull();
      expect(sends.length).toBe(0);

      // 10 min in: first nudge.
      const r1 = nudge(slice, "s1", "sess-1", "2026-05-18T10:10:00.000Z", sendStub);
      expect(r1).toBe("nudged");
      expect(sends.length).toBe(1);
      expect(sends[0].msg).toContain("[STRANDED-STEWARD-NUDGE]");
      expect(sends[0].msg).toContain("gh pr create");
      expect(slice.steward_nudge_sent_at).toBe("2026-05-18T10:10:00.000Z");
      expect(slice.steward_nudge_count).toBe(1);

      // 1 min after first nudge: too soon for re-nudge.
      expect(nudge(slice, "s1", "sess-1", "2026-05-18T10:11:00.000Z", sendStub)).toBeNull();
      expect(sends.length).toBe(1);

      // 5 min after first nudge (15 min total): re-nudge.
      const r2 = nudge(slice, "s1", "sess-1", "2026-05-18T10:15:00.000Z", sendStub);
      expect(r2).toBe("nudged");
      expect(sends.length).toBe(2);
      expect(slice.steward_nudge_count).toBe(2);

      // Another 5 min (20 min total): re-nudge again.
      const r3 = nudge(slice, "s1", "sess-1", "2026-05-18T10:20:00.000Z", sendStub);
      expect(r3).toBe("nudged");
      expect(sends.length).toBe(3);
      expect(slice.steward_nudge_count).toBe(3);

      // 25 min total: escalate.
      const r4 = nudge(slice, "s1", "sess-1", "2026-05-18T10:25:00.000Z", sendStub);
      expect(r4).toBe("escalate");
      expect(slice.steward_stranded_escalated_at).toBe("2026-05-18T10:25:00.000Z");

      // Once escalated, subsequent ticks must NOT re-escalate.
      expect(nudge(slice, "s1", "sess-1", "2026-05-18T10:30:00.000Z", sendStub)).toBeNull();
    });

    it("maybeNudgeStrandedSteward ignores slices that aren't in implementing", async () => {
      // Other stages have their own logic — never nudge into a stage we
      // don't own.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const nudge = extractFn(
        loop,
        "maybeNudgeStrandedSteward",
        ["strandedStewardConfig"],
      ) as (slice: any, sliceId: string, sessionId: string, ts: string, sendMessage: any) => string | null;
      const sendStub = () => { };

      for (const stage of ["pr-open", "pr-in-fix", "escalated", "merged", "hatchery-pending"]) {
        const slice: any = { stage, implementing_started_at: "2026-05-18T10:00:00.000Z" };
        expect(nudge(slice, "s1", "sess-1", "2026-05-18T11:00:00.000Z", sendStub)).toBeNull();
      }
    });

    it("parseSpawnPatchError matches corrupt-patch + already-exists-in-index + generic git apply failures", async () => {
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const parse = extractFn(loop, "parseSpawnPatchError") as (s: string) => boolean;
      expect(parse("git apply --index failed in manager worktree:\nerror: corrupt patch at /tmp/p.diff:42")).toBe(true);
      expect(parse("git apply --index failed in manager worktree:\nerror: evals/cases/x.yaml: already exists in index")).toBe(true);
      expect(parse("git apply --index failed in manager worktree:\nerror: something else")).toBe(true);
      // Branch-collision and wrong-worktree errors must NOT match — they
      // have their own recovery paths.
      expect(parse("agent-deck manager launch failed:\nError: branch 'feature/x' already exists")).toBe(false);
      expect(parse("agent-deck manager session \"abc\" attached to worktree \"/tmp/wrong\" but this launch")).toBe(false);
      expect(parse("")).toBe(false);
    });

    it("tryRecoverSpawnPatchError retries up to limit times then escalates with a distinct counter key", async () => {
      // Codex-side patch failures (truncation, malformed diff) are deeply
      // non-deterministic — re-running codex produces different output, often
      // correct on the next attempt. Limit is generous (10) because each
      // retry is cheap (one codex container) and we'd rather burn compute
      // than strand a slice that would've succeeded on attempt 7. Verify the
      // counter is stored under "spawn-error:<sliceId>" so it doesn't
      // collide with the wrong-worktree-race counter.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const recover = extractFn(
        loop,
        "tryRecoverSpawnPatchError",
        ["transientRetryCounts", "parseSpawnPatchError", "deleteHatcheryArtifacts"],
      ) as (state: any, slice: any, sliceId: string, errorText: string) => any;

      const errorText = "git apply --index failed in manager worktree:\nerror: corrupt patch at /tmp/p.diff:42";
      const state: any = { slices: { s1: { hatchery: {} } } };

      for (let i = 1; i <= 10; i++) {
        const r = recover(state, state.slices.s1 || (state.slices.s1 = { hatchery: {} }), "s1", errorText);
        expect(r).toMatchObject({ recovered: true, verdict: "spawn-error-retry" });
        expect(state.transient_retry_counts["spawn-error:s1"]).toBe(i);
      }
      // Beyond limit → escalate, slice retained, counter cleared.
      state.slices.s1 = { hatchery: {} };
      const escalated = recover(state, state.slices.s1, "s1", errorText);
      expect(escalated).toMatchObject({ recovered: false, verdict: "spawn-error-persistent" });
      expect(state.slices.s1).toBeDefined();
      expect(state.transient_retry_counts["spawn-error:s1"]).toBeUndefined();

      // Non-matching errors return null and don't touch state.
      expect(recover(state, state.slices.s1, "s1", "agent-deck manager launch failed:\nError: branch 'x' already exists")).toBeNull();
    });

    it("stages legate.unwedge skill with inspect + clean-stale scripts", async () => {
      // Regression guard: adding legate.unwedge to LEGATE_SKILLS is necessary
      // but not sufficient — the skill template directory has to exist and
      // ship both scripts, executable. Without this the deploy silently
      // skips the new skill.
      //
      // Use the real src/templates/legate dir (not the synthetic test
      // fixture) so we exercise the actual scripts shipped in the repo.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const unwedge = result.skills.find((s) => s.name === "legate.unwedge");
      expect(unwedge).toBeDefined();
      expect(fs.existsSync(path.join(unwedge!.stagedDir, "SKILL.md"))).toBe(true);
      const inspect = path.join(unwedge!.stagedDir, "scripts", "inspect-partial-work.sh");
      const clean = path.join(unwedge!.stagedDir, "scripts", "clean-stale-branch.sh");
      expect(fs.existsSync(inspect)).toBe(true);
      expect(fs.existsSync(clean)).toBe(true);
      expect(fs.statSync(inspect).mode & 0o111).not.toBe(0);
      expect(fs.statSync(clean).mode & 0o111).not.toBe(0);
      const skillBody = fs.readFileSync(path.join(unwedge!.stagedDir, "SKILL.md"), "utf-8");
      expect(skillBody).toContain("inspect-partial-work.sh");
      expect(skillBody).toContain("clean-stale-branch.sh");
    });

    it("hatchery escalations notify the legate agent via processor_requests", async () => {
      // Regression guard for the silent-loop bug: prior to this fix, every
      // dispatch escalation only wrote state.json and the log file. The
      // legate agent waits for a [PROCESSOR] message and so stayed idle
      // indefinitely while artifacts piled up in escalated state.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      // Both escalation sites must call requestLegateJudgement.
      expect(loop).toContain('reason: "hatchery_dispatch_failed"');
      // runDispatch catch path (launchHatcheryDispatch throws).
      expect(loop).toMatch(/requestLegateJudgement\([\s\S]*?launch-throw/);
      expect(loop).toContain("Hatchery dispatch launch threw");
      // completePendingHatcheryDispatches forwards a notifications batch up.
      expect(loop).toContain("queueDispatchEscalation");
      expect(loop).toContain("hatchery-failure:");
      // The caller in runDispatch must drain those notifications.
      expect(loop).toMatch(/for \(const n of completed\.notifications/);
    });

    it("sliceReleasesArtifact treats only merged slices as releasing the artifact", async () => {
      // Regression guard for the dedup bug where escalated slices were
      // treated as terminal, allowing the loop to re-dispatch artifacts an
      // operator had explicitly stood down.
      const loop = fs.readFileSync(await stageLoop(makeTmpDir()), "utf-8");
      const releases = extractFn(loop, "sliceReleasesArtifact") as (s: unknown) => boolean;
      expect(releases({ stage: "merged" })).toBe(true);
      expect(releases({ pr: { state: "MERGED" } })).toBe(true);
      // Anything else — including escalated and closed-unmerged — must
      // continue to block re-dispatch.
      expect(releases({ stage: "escalated" })).toBe(false);
      expect(releases({ stage: "implementing" })).toBe(false);
      expect(releases({ pr: { state: "CLOSED" } })).toBe(false);
      expect(releases({})).toBe(false);
      expect(releases(null)).toBe(false);
    });

    it("derives the processor name from the selected conductor name", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/SmithyCli",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
        conductorName: "legate-smithy",
      });

      expect(result.conductorName).toBe("legate-smithy");
      expect(result.processorName).toBe("legate-smithy-loop");
      expect(result.processorConductorDir).toBe(
        path.join(home, ".agent-deck", "conductor", "legate-smithy-loop"),
      );
      expect(result.processorSetupCommand).toContain("legate-smithy-loop");
    });

    it("uses the effective profile in default conductor names", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/SmithyCli",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
        profile: "smithy",
      });

      expect(result.conductorName).toBe("smithy-legate-agent");
      expect(result.loopName).toBe("smithy-legate-loop");
      expect(result.processorName).toBe("smithy-legate-loop");
      expect(result.processorConductorDir).toBe(
        path.join(home, ".agent-deck", "conductor", "smithy-legate-loop"),
      );
      expect(result.processorSetupCommand).toContain("smithy-legate-loop");
    });

    it("expands the bare legate-agent role name with the effective profile", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/SmithyCli",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
        profile: "smithy",
        conductorName: "legate-agent",
      });

      expect(result.conductorName).toBe("smithy-legate-agent");
      expect(result.loopName).toBe("smithy-legate-loop");
      expect(result.processorName).toBe("smithy-legate-loop");
    });

    it("keeps processor names valid for long custom conductor names", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");
      const conductorName = `legate-${"x".repeat(57)}`;

      const result = await initLegate({
        repoPath: "/some/repo/SmithyCli",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
        conductorName,
      });

      expect(result.conductorName).toBe(conductorName);
      expect(result.processorName).toMatch(/^legate-x+-[0-9a-f]{8}$/);
      expect(result.processorName!.length).toBeLessThanOrEqual(64);
      expect(result.processorSetupCommand).toContain(result.processorName);
    });

    it("can disable processor staging with processor=false", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
        processor: false,
      });

      expect(result.processorName).toBeUndefined();
      expect(result.processorSetupCommand).toBeUndefined();
      expect(
        fs.existsSync(path.join(home, ".march", "legate", "march-legate-agent", "loop")),
      ).toBe(false);
      expect(result.summary).toContain("disabled (--no-loop)");
    });

    it("can deploy only the deterministic processor without configuring the Claude conductor", async () => {
      const home = makeTmpDir();
      const binDir = makeTmpDir();
      const agentDeck = path.join(binDir, "agent-deck");
      fs.writeFileSync(
        agentDeck,
        [
          "#!/bin/sh",
          'if [ "$1" = "-p" ]; then shift 2; fi',
          'if [ "$1" = "conductor" ] && [ "$2" = "setup" ]; then mkdir -p "$HOME/.agent-deck/conductor/$3"; exit 0; fi',
          "exit 0",
          "",
        ].join("\n"),
      );
      fs.chmodSync(agentDeck, 0o755);
      const oldPath = process.env.PATH;
      const oldHome = process.env.HOME;
      process.env.PATH = [binDir, oldPath ?? ""].join(path.delimiter);
      process.env.HOME = home;
      try {
        const result = await initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          processorOnly: true,
        });

        expect(result.setupRan).toBe(false);
        expect(result.processorSetupRan).toBe(true);
        expect(result.processorConfigured).toBe(true);
        expect(fs.existsSync(result.conductorDir)).toBe(false);
        expect(
          fs.existsSync(path.join(result.processorConductorDir!, "legate-loop.mjs")),
        ).toBe(true);
        expect(result.summary).toContain("loop-only configured");
        expect(result.summary).toContain("Agent:          march-legate-agent (not deployed");
        expect(result.summary).toContain("Auto mode:      skipped (--loop-only)");
        expect(result.summary).toContain(
          "The Claude Legate agent was not",
        );
        expect(result.summary).toContain(
          "agent-deck -p march session attach conductor-march-legate-loop",
        );
        expect(result.summary).not.toContain("auto-mode true");
      } finally {
        process.env.PATH = oldPath;
        process.env.HOME = oldHome;
      }
    });

    it("configures managed containers to run the loop while the loop conductor tails docker logs", async () => {
      const home = makeTmpDir();
      const binDir = makeTmpDir();
      const commandLog = path.join(home, "commands.log");
      const agentDeck = path.join(binDir, "agent-deck");
      fs.writeFileSync(
        agentDeck,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}`,
          'if [ "$1" = "-p" ]; then shift 2; fi',
          'if [ "$1" = "conductor" ] && [ "$2" = "setup" ]; then mkdir -p "$HOME/.agent-deck/conductor/$3"; exit 0; fi',
          "exit 0",
          "",
        ].join("\n"),
      );
      fs.chmodSync(agentDeck, 0o755);
      const docker = path.join(binDir, "docker");
      fs.writeFileSync(
        docker,
        [
          "#!/bin/sh",
          `printf 'docker %s\\n' "$*" >> ${JSON.stringify(commandLog)}`,
          'if [ "$1" = "run" ]; then echo container-id-managed; fi',
          "exit 0",
          "",
        ].join("\n"),
      );
      fs.chmodSync(docker, 0o755);
      const systemctl = path.join(binDir, "systemctl");
      fs.writeFileSync(systemctl, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(systemctl, 0o755);

      const oldPath = process.env.PATH;
      const oldHome = process.env.HOME;
      process.env.PATH = [binDir, oldPath ?? ""].join(path.delimiter);
      process.env.HOME = home;
      try {
        const result = await initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          withContainer: true,
        });

        expect(result.legateContainer?.containerId).toBe("container-id-managed");
        expect(
          fs.existsSync(path.join(result.loopConductorDir!, "legate-loop.mjs")),
        ).toBe(true);
        const log = fs.readFileSync(commandLog, "utf-8");
        expect(log).toContain(
          "docker run -d --name march-legate-march-legate-agent",
        );
        expect(log).toContain('exec node "');
        expect(log).toContain("legate-loop.mjs");
        expect(log).toContain(
          "session set conductor-march-legate-loop command docker logs -f --tail=200 march-legate-march-legate-agent",
        );
        const heartbeat = fs.readFileSync(
          path.join(result.conductorDir, "heartbeat.sh"),
          "utf-8",
        );
        expect(heartbeat).toContain("march-managed: march-legate-agent is reactive");
        expect(heartbeat).not.toContain("[HEARTBEAT]");
      } finally {
        process.env.PATH = oldPath;
        process.env.HOME = oldHome;
      }
    });

    it("renders processor-only no-setup instructions without Claude setup steps", async () => {
      const home = makeTmpDir();

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
        processorOnly: true,
      });

      expect(result.setupRan).toBe(false);
      expect(result.processorSetupRan).toBe(false);
      expect(result.summary).toContain("Loop-only setup skipped");
      expect(result.summary).toContain("Claude Legate agent will not be created");
      expect(result.summary).toContain("conductor setup march-legate-loop");
      expect(result.summary).toContain("Then copy the staged loop files");
      expect(result.summary).toContain("legate-loop.mjs");
      expect(result.summary).toContain("legate-loop-meta.json");
      expect(result.summary).not.toContain("conductor setup march-legate-agent");
      expect(result.summary).not.toContain("auto-mode true");
      expect(result.summary).not.toContain("session send conductor-march-legate-agent");
    });

    it("rejects contradictory processor-only options", async () => {
      const home = makeTmpDir();

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          processorOnly: true,
          processor: false,
          heartbeatInterval: "not-valid",
        }),
      ).rejects.toThrow("cannot be combined");

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          processorOnly: true,
          withContainer: true,
          heartbeatInterval: "not-valid",
        }),
      ).rejects.toThrow("cannot be combined");
    });

    it("stages the cold-start prompt to a file in the staging dir", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      const promptPath = path.join(
        home,
        ".march",
        "legate",
        "march-legate-agent",
        "cold-start-prompt.txt",
      );
      expect(fs.existsSync(promptPath)).toBe(true);
      const body = fs.readFileSync(promptPath, "utf-8");
      expect(body).toMatch(/Cold start as the Legate for March/);
    });

    it("returns post-setup auto-mode commands targeting the conductor session", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      const expectedLength = process.platform === "linux" ? 5 : 4;
      expect(result.postSetupCommands).toHaveLength(expectedLength);
      const [setAutoMode, setModel, restart, sendColdStart] =
        result.postSetupCommands;

      expect(setAutoMode).toEqual([
        "agent-deck",
        "-p",
        "march",
        "session",
        "set",
        "conductor-march-legate-agent",
        "auto-mode",
        "true",
      ]);
      expect(setModel).toEqual([
        "agent-deck",
        "-p",
        "march",
        "session",
        "set",
        "conductor-march-legate-agent",
        "extra-args",
        "--",
        "--model",
        "sonnet",
      ]);
      expect(restart).toEqual([
        "agent-deck",
        "-p",
        "march",
        "session",
        "restart",
        "conductor-march-legate-agent",
      ]);
      expect(sendColdStart.slice(0, 6)).toEqual([
        "agent-deck",
        "-p",
        "march",
        "session",
        "send",
        "conductor-march-legate-agent",
      ]);
      // The 7th element is the rendered priming prompt — assert it carries
      // the legate persona marker rather than re-snapshotting the full body.
      expect(sendColdStart[6]).toMatch(/Cold start as the Legate for March/);
      if (process.platform === "linux") {
        expect(result.postSetupCommands[4]).toEqual([
          "systemctl",
          "--user",
          "start",
          "agent-deck-conductor-bridge",
        ]);
      }

      expect(result.autoModeConfigured).toBe(false);
      expect(result.bridgeActive).toBe(false);
    });

    it("respects an explicit --model override", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
        model: "claude-opus-4-7",
      });

      const setModel = result.postSetupCommands[1];
      expect(setModel[setModel.length - 1]).toBe("claude-opus-4-7");
      expect(result.summary).toContain("Model:          claude-opus-4-7");
    });

    it("shell-quotes the setup command in the --no-setup summary", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      const desc = "Legate orchestrator for March (Smithy plan→PR→fix loop)";
      expect(result.summary).toContain(`'${desc}'`);
      expect(result.setupCommand).toContain(desc);
    });

    it("rendered for vs configured for varies with runSetup outcome", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });
      expect(result.summary.split("\n")[0]).toContain("rendered for March");
      expect(result.summary.split("\n")[0]).not.toContain("configured for");
    });

    it("respects explicit profile, name, description, and worker-group overrides", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir(
        "p={{PROFILE}} n={{CONDUCTOR_NAME}} g={{WORKER_GROUP}}",
      );

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
        profile: "shared",
        conductorName: "march-bot",
        workerGroup: "march-workers",
        description: "custom desc",
      });

      expect(result.profile).toBe("shared");
      expect(result.conductorName).toBe("march-bot");
      expect(result.workerGroup).toBe("march-workers");
      const idx = result.setupCommand.indexOf("-description");
      expect(idx).toBeGreaterThan(-1);
      expect(result.setupCommand[idx + 1]).toBe("custom desc");

      const rendered = fs.readFileSync(result.templateOutputPath, "utf-8");
      expect(rendered).toBe("p=shared n=march-bot g=march-workers");
    });

    it("is idempotent: re-running overwrites the staged template at the same path", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("v1 {{REPO_NAME}}");

      const first = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });
      expect(fs.readFileSync(first.templateOutputPath, "utf-8")).toContain(
        "v1 March",
      );

      // Edit template and re-run — same staging path, fresh content.
      fs.writeFileSync(path.join(tplDir, "CLAUDE.prompt"), "v2 {{REPO_NAME}}");
      const second = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });
      expect(second.templateOutputPath).toBe(first.templateOutputPath);
      expect(fs.readFileSync(second.templateOutputPath, "utf-8")).toContain(
        "v2 March",
      );
    });

    it("stages every skill alongside the rendered template", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      const expectedSkillsDir = path.join(
        home,
        ".march",
        "legate",
        "march-legate-agent",
        "skills",
      );
      expect(result.skillsStagedDir).toBe(expectedSkillsDir);
      expect(result.skills).toHaveLength(LEGATE_SKILLS.length);

      for (const skill of result.skills) {
        expect(LEGATE_SKILLS).toContain(skill.name);
        expect(skill.stagedDir).toBe(path.join(expectedSkillsDir, skill.name));
        expect(fs.existsSync(path.join(skill.stagedDir, "SKILL.md"))).toBe(true);
        expect(
          fs.existsSync(path.join(skill.stagedDir, "scripts", "noop.sh")),
        ).toBe(true);
        // Scripts must be executable (mode +x) so the conductor can `bash` them
        // or invoke them directly without a shell prefix.
        const scriptStat = fs.statSync(
          path.join(skill.stagedDir, "scripts", "noop.sh"),
        );
        expect(scriptStat.mode & 0o111).not.toBe(0);
        // SKILL.prompt frontmatter survives rendering; body is interpolated.
        const skillRendered = fs.readFileSync(
          path.join(skill.stagedDir, "SKILL.md"),
          "utf-8",
        );
        expect(skillRendered).toContain("---");
        expect(skillRendered).toContain(`name: ${skill.name}`);
        expect(skillRendered).toContain("repo: March");
      }

      // With --no-setup, the conductor dir doesn't exist yet so the copy
      // step is skipped — every skill stays deployed:false.
      expect(result.skills.every((s) => !s.deployed)).toBe(true);
      expect(result.summary).toContain("staged at");
    });

    it("re-staging cleans up a removed script from a previous render", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      const first = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });
      // Add a ghost script to one skill's staged dir — simulates a script
      // removed in a newer template.
      const ghostSkill = first.skills[0];
      const ghost = path.join(ghostSkill.stagedDir, "scripts", "ghost.sh");
      fs.writeFileSync(ghost, "#!/bin/sh\nexit 0\n");
      expect(fs.existsSync(ghost)).toBe(true);

      // Re-run init.
      await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templateDir: tplDir,
        runSetup: false,
      });

      // Stale script is gone; canonical scripts are back across all skills.
      expect(fs.existsSync(ghost)).toBe(false);
      for (const s of first.skills) {
        expect(
          fs.existsSync(path.join(s.stagedDir, "scripts", "noop.sh")),
        ).toBe(true);
      }
    });

    it("rejects path-traversal in conductor name before composing the staging path", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templateDir: tplDir,
          runSetup: false,
          conductorName: "../../.ssh",
        }),
      ).rejects.toThrow(/Invalid conductor name/);

      const escapeTarget = path.join(path.dirname(home), ".ssh");
      expect(fs.existsSync(escapeTarget)).toBe(false);
    });

    it("rejects an empty or oversized conductor name", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templateDir: tplDir,
          runSetup: false,
          conductorName: "",
        }),
      ).rejects.toThrow(/Conductor name cannot be empty/);

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templateDir: tplDir,
          runSetup: false,
          conductorName: "x".repeat(65),
        }),
      ).rejects.toThrow(/Conductor name too long/);
    });

    it("rejects path-traversal in profile name", async () => {
      const home = makeTmpDir();
      const tplDir = makeTemplateDir("ok");

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templateDir: tplDir,
          runSetup: false,
          profile: "../escape",
        }),
      ).rejects.toThrow(/Invalid profile name/);
    });

    it("throws LegateError when an explicit template dir is missing CLAUDE.prompt", async () => {
      const home = makeTmpDir();
      const emptyDir = makeTmpDir(); // exists but has no CLAUDE.prompt
      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templateDir: emptyDir,
          runSetup: false,
        }),
      ).rejects.toBeInstanceOf(LegateError);
    });

    it("locates the bundled template when no explicit dir is provided", async () => {
      // Smoke test: with the default template-resolution path, initLegate
      // should find src/templates/legate/CLAUDE.prompt and render the real
      // prompt + every skill.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const rendered = fs.readFileSync(result.templateOutputPath, "utf-8");
      expect(rendered).toContain("Legate: Smithy Workflow Conductor for March");
      expect(rendered).toContain("/some/repo/March");
      expect(rendered).toContain("march-legate-agent");
      expect(rendered).toContain("march-legate-loop");
      // The rendered CLAUDE.md should have the snippets resolved — pick a
      // distinctive line from one of them.
      expect(rendered).toContain("State Management");
      // Every skill should be staged with a rendered SKILL.md.
      expect(result.skills.length).toBeGreaterThan(0);
      for (const skill of result.skills) {
        const sm = path.join(skill.stagedDir, "SKILL.md");
        expect(fs.existsSync(sm)).toBe(true);
        const content = fs.readFileSync(sm, "utf-8");
        // Frontmatter survived render.
        expect(content.startsWith("---")).toBe(true);
        // Variables interpolated into the body. Every skill's protocol
        // ultimately invokes one or more scripts that take the repo path,
        // so {{REPO_PATH}} is the one variable every skill is guaranteed
        // to render — {{WORKER_GROUP}} is only used by skills that scan
        // or launch worker sessions.
        expect(content).toContain("/some/repo/March");
      }
    });

    it("does not stage the legacy legate.dispatch skill", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const dispatch = result.skills.find((s) => String(s.name) === "legate.dispatch");
      expect(dispatch).toBeUndefined();
      expect(
        fs.existsSync(
          path.join(home, ".march", "legate", "legate-march", "skills", "legate.dispatch"),
        ),
      ).toBe(false);
    });

    it("does not stage loop-owned babysit scripts", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const babysit = result.skills.find((s) => s.name === "legate.babysit");
      const scriptsDir = path.join(babysit!.stagedDir, "scripts");
      expect(fs.existsSync(path.join(scriptsDir, "discover-pr.sh"))).toBe(false);
      expect(fs.existsSync(path.join(scriptsDir, "recover-stranded-worker.sh"))).toBe(false);
      expect(fs.existsSync(path.join(scriptsDir, "request-conflict-resolution.sh"))).toBe(false);
    });

    it("processor stages dispatch-msg files for Hatchery-launched managers", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const loop = fs.readFileSync(
        path.join(result.processorStagingDir!, "legate-loop.mjs"),
        "utf-8",
      );
      expect(loop).toContain("function stageDispatchMessage");
      expect(loop).toContain('"dispatch-msg-" + sliceId + ".md"');
      expect(loop).toContain("managerPromptPath");
      expect(loop).toContain("The Hatchery patch has already been applied and staged");
      expect(loop).not.toContain("Read the Hatchery artifacts, apply the patch");
    });

    it("does not stage the legacy legate.cleanup skill", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const cleanup = result.skills.find((s) => String(s.name) === "legate.cleanup");
      expect(cleanup).toBeUndefined();
      expect(
        fs.existsSync(
          path.join(home, ".march", "legate", "legate-march", "skills", "legate.cleanup"),
        ),
      ).toBe(false);
    });

    it("stages legate.issue with its three operator-issue-intake scripts", async () => {
      // legate.issue is the operator-driven (non-heartbeat) skill that
      // converts a GitHub issue handoff into a tracked worker. The three
      // scripts named here are the entire surface area its SKILL.prompt's
      // `allowed-tools` declares — if any one is missing on disk after a
      // render, the deployed conductor will pause for permission on the
      // first script invocation and stall the operator-reply path.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const issue = result.skills.find((s) => s.name === "legate.issue");
      expect(issue).toBeDefined();
      const scriptsDir = path.join(issue!.stagedDir, "scripts");
      for (const name of [
        "fetch-issue.sh",
        "sync-default-branch.sh",
        "launch-issue-worker.sh",
      ]) {
        const p = path.join(scriptsDir, name);
        expect(fs.existsSync(p)).toBe(true);
        // Scripts must be +x; otherwise the conductor's `bash <path>` calls
        // succeed but direct invocation pauses on a permission-denied prompt.
        expect(fs.statSync(p).mode & 0o111).not.toBe(0);
      }
      const launcher = fs.readFileSync(
        path.join(scriptsDir, "launch-issue-worker.sh"),
        "utf-8",
      );
      expect(launcher).toContain("if [[ $# -ne 7 ]]");
      expect(launcher).toContain('SLICE_ID="$7"');
      expect(launcher).toContain('DISPATCH_MSG_PATH="./dispatch-msg-${SLICE_ID}.md"');
      expect(launcher).toContain('printf \'%s\\n\' "$PROMPT" >"$DISPATCH_MSG_PATH"');
      expect(() =>
        execFileSync("bash", ["-n", path.join(scriptsDir, "launch-issue-worker.sh")], {
          stdio: "pipe",
        }),
      ).not.toThrow();
    });

    it("stages legate.error with its worker-error recovery scripts", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const skill = result.skills.find((s) => s.name === "legate.error");
      expect(skill).toBeDefined();
      const scriptsDir = path.join(skill!.stagedDir, "scripts");
      for (const name of [
        "inspect-worker-error.sh",
        "send-error-message.sh",
        "restart-worker.sh",
      ]) {
        const p = path.join(scriptsDir, name);
        expect(fs.existsSync(p)).toBe(true);
        expect(fs.statSync(p).mode & 0o111).not.toBe(0);
      }
    });
  });

  describe("writeLegateHeartbeatScript", () => {
    async function render(opts?: {
      name?: string;
      profile?: string;
      group?: string;
    }): Promise<{ scriptPath: string; body: string }> {
      const dir = makeTmpDir();
      const name = opts?.name ?? "legate-march";
      const profile = opts?.profile ?? "march";
      const group = opts?.group ?? "legate-workers";
      await writeLegateHeartbeatScript(dir, name, profile, group);
      const scriptPath = path.join(dir, "heartbeat.sh");
      const body = fs.readFileSync(scriptPath, "utf-8");
      return { scriptPath, body };
    }

    it("substitutes the conductor name, profile, and worker group", async () => {
      const { body } = await render({
        name: "legate-myrepo",
        profile: "myrepo",
        group: "legate-workers",
      });
      expect(body).toContain(`NAME="legate-myrepo"`);
      expect(body).toContain(`PROFILE="myrepo"`);
      expect(body).toContain(`GROUP="legate-workers"`);
    });

    it("expands TARGET via $NAME (no braces) so the {NAME} placeholder substitution doesn't corrupt it", async () => {
      // Regression: if TARGET uses ${NAME}, the {NAME}→conductorName replace
      // matches the inner {NAME} substring and produces e.g.
      // `conductor-$legate-march`, which then fails under `set -u` because
      // `$legate` is unset. Use $NAME (no braces) to keep the placeholder
      // and the bash variable disjoint.
      const { body } = await render({ name: "legate-myrepo" });
      expect(body).toContain(`TARGET="conductor-$NAME"`);
      expect(body).not.toContain(`TARGET="conductor-$legate-myrepo"`);
    });

    it("emits a payload that uses the [HEARTBEAT] format the legate CLAUDE.md triggers on", async () => {
      const { body } = await render();
      // The python builder produces "[HEARTBEAT] [<name>] Status: ..."
      expect(body).toContain(
        `"[HEARTBEAT] [%s] Status: %d waiting, %d running, %d idle, %d error, %d stopped."`,
      );
    });

    it("omits the substrings agent-deck's auto-migrator uses to identify managed scripts", async () => {
      // MigrateConductorHeartbeatScripts in
      // internal/session/conductor.go classifies a script as "managed" iff
      // it contains BOTH of these substrings; if either is absent the
      // migrator leaves the file alone.
      const { body } = await render();
      expect(body).not.toContain("# Heartbeat for conductor:");
      expect(body).not.toContain(`SESSION="conductor-`);
    });

    it("writes an executable file (mode 0755)", async () => {
      const { scriptPath } = await render();
      const stats = fs.statSync(scriptPath);
      // POSIX mode bits: owner rwx, group rx, other rx -> 0o755 = 493
      expect(stats.mode & 0o777).toBe(0o755);
    });

    it("produces a script that passes `bash -n` syntax check", async () => {
      const { scriptPath } = await render();
      // bash -n parses without executing; a non-zero exit means a syntax
      // error in the generated script.
      expect(() =>
        execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" }),
      ).not.toThrow();
    });

    it("overwrites an existing heartbeat.sh in place", async () => {
      const dir = makeTmpDir();
      const target = path.join(dir, "heartbeat.sh");
      fs.writeFileSync(target, "#!/bin/bash\necho stale\n", { mode: 0o755 });
      await writeLegateHeartbeatScript(dir, "legate-march", "march", "legate-workers");
      const body = fs.readFileSync(target, "utf-8");
      expect(body).not.toContain("echo stale");
      expect(body).toContain(`NAME="legate-march"`);
    });

    it("skips only on running/stopped/unknown states, not on transient 'error'", async () => {
      // Regression: the previous gate (`case $STATE in idle|waiting) ;;
      // *) exit 0 ;;`) silently no-op'd whenever agent-deck's classifier
      // transiently flipped the conductor to "error" — which it does
      // when the TUI has half-typed text or a stale spinner. Conductors
      // got stranded overnight because every timer fire bailed without
      // delivering the heartbeat that would have unstuck them. The new
      // gate must skip only on "running" (genuinely busy) and "stopped"
      // (no tmux to deliver into), and send the heartbeat on every
      // other state including "error".
      const { body } = await render();
      expect(body).toContain("running|stopped) exit 0 ;;");
      expect(body).not.toMatch(/case "\$STATE" in\s*\n\s*idle\|waiting\) ;;/);
    });

    it("prepends the operator's tmux dir to PATH when one is provided", async () => {
      // The systemd unit's restricted PATH otherwise resolves `tmux` to
      // /usr/bin/tmux, which can't talk to a server started by a
      // brew-installed tmux (protocol mismatch → `server exited
      // unexpectedly` → agent-deck reports the conductor as "not
      // running"). Baking the operator's tmux dir into PATH at deploy
      // time keeps the systemd-fired heartbeat using the same binary
      // the user's shell does.
      const dir = makeTmpDir();
      await writeLegateHeartbeatScript(
        dir,
        "legate-march",
        "march",
        "legate-workers",
        "/home/linuxbrew/.linuxbrew/bin",
      );
      const body = fs.readFileSync(path.join(dir, "heartbeat.sh"), "utf-8");
      expect(body).toContain(
        `export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"`,
      );
    });

    it("emits a commented placeholder when tmux is not findable at init time", async () => {
      // Don't silently bake a bad PATH; surface an actionable hint so
      // operators know what knob to turn if heartbeats don't deliver.
      const dir = makeTmpDir();
      await writeLegateHeartbeatScript(
        dir,
        "legate-march",
        "march",
        "legate-workers",
        null,
      );
      const body = fs.readFileSync(path.join(dir, "heartbeat.sh"), "utf-8");
      expect(body).toContain("tmux not found on PATH");
      expect(body).toContain(`# export PATH=`);
      expect(body).not.toMatch(/^export PATH=/m);
    });

    it("refuses to embed a tmux dir containing shell-special characters", async () => {
      // The substituted dir lands inside a double-quoted bash string;
      // characters that stay "live" inside double quotes — `"`, `$`,
      // backslash, backtick (command substitution), and any newline —
      // would let an attacker escape the string and inject arbitrary
      // shell that the systemd-fired heartbeat would then execute on
      // every tick. Reject at write time rather than ship a mis-quoted
      // heartbeat.sh.
      const dir = makeTmpDir();
      const cases: Array<[string, string]> = [
        [`"`, `/tmp/"; rm -rf /; #`],
        [`$`, `/tmp/$HOME`],
        [`\\n`, `/tmp/foo\nrm -rf /`],
        // Backticks — caught by the PR #99 review (Copilot + Codex
        // both flagged this). Inside a double-quoted string,
        // \`command\` still runs.
        [`backtick`, "/tmp/`whoami`"],
        // Backslash — could be used to smuggle a metacharacter past a
        // single-pass regex (e.g. \\" → \" after one round of bash
        // parsing).
        [`backslash`, `/tmp/foo\\$HOME`],
      ];
      for (const [label, value] of cases) {
        await expect(
          writeLegateHeartbeatScript(
            dir,
            "legate-march",
            "march",
            "legate-workers",
            value,
          ),
          `should reject ${label}: ${value}`,
        ).rejects.toThrow(/shell-special characters/);
      }
    });
  });

  describe("writeHeartbeatTimerOverride", () => {
    function overridePath(home: string, name: string): string {
      return path.join(
        home,
        ".config",
        "systemd",
        "user",
        `agent-deck-conductor-heartbeat-${name}.timer.d`,
        "override.conf",
      );
    }

    it("defaults to 5min — faster than agent-deck's 15min so stuck workers are noticed promptly", () => {
      expect(DEFAULT_HEARTBEAT_INTERVAL).toBe("5min");
    });

    it("writes the drop-in at the systemd user path keyed on the conductor name", async () => {
      const home = makeTmpDir();
      const written = await writeHeartbeatTimerOverride(home, "legate-march", "5min");
      expect(written).toBe(overridePath(home, "legate-march"));
      expect(fs.existsSync(written)).toBe(true);
    });

    it("blanks the parent unit's [Timer] keys before re-setting them so systemd does not accumulate two cadences", async () => {
      // Regression guard for the systemd drop-in semantics: omitting the
      // empty `OnBootSec=` / `OnUnitActiveSec=` lines causes systemd to
      // keep BOTH the 15-min default and the new value, so the timer fires
      // at the shorter of the two and effectively ignores the override.
      const home = makeTmpDir();
      await writeHeartbeatTimerOverride(home, "legate-march", "10min");
      const body = fs.readFileSync(overridePath(home, "legate-march"), "utf-8");
      const blank = body.indexOf("OnBootSec=\n");
      const set = body.indexOf("OnBootSec=10min");
      expect(blank).toBeGreaterThan(0);
      expect(set).toBeGreaterThan(blank);
      expect(body).toContain("OnUnitActiveSec=\n");
      expect(body).toContain("OnUnitActiveSec=10min");
    });

    it("includes a reversal recipe in the header comment so operators can undo without grepping man pages", async () => {
      const home = makeTmpDir();
      await writeHeartbeatTimerOverride(home, "legate-march", "5min");
      const body = fs.readFileSync(overridePath(home, "legate-march"), "utf-8");
      expect(body).toContain(
        "rm -rf ~/.config/systemd/user/agent-deck-conductor-heartbeat-legate-march.timer.d",
      );
      expect(body).toContain("systemctl --user daemon-reload");
      expect(body).toContain(
        "systemctl --user restart agent-deck-conductor-heartbeat-legate-march.timer",
      );
    });

    it("accepts every common single-unit systemd time-span suffix (review feedback: PR #98)", async () => {
      // Review caught that the initial regex `(s|min|h|d)` rejected
      // legitimate single-unit forms like `500ms`, `1w`, and the short
      // aliases `5m` / `1hr`. Broadened to a common-units alphabet; this
      // is the positive test guarding regression in that direction.
      const home = makeTmpDir();
      for (const value of [
        "5min",
        "10min",
        "300s",
        "1h",
        "2d",
        "500ms",
        "1w",
        "1y",
        "5m", // alias for 5min
        "1hr", // alias for 1h
        "100us",
        "10ns",
      ]) {
        await writeHeartbeatTimerOverride(home, "legate-march", value);
        const body = fs.readFileSync(overridePath(home, "legate-march"), "utf-8");
        expect(body).toContain(`OnBootSec=${value}`);
        expect(body).toContain(`OnUnitActiveSec=${value}`);
      }
    });

    it("rejects malformed intervals before composing a path or writing anything", async () => {
      const home = makeTmpDir();
      // Note: `5m` is *valid* (alias for 5 minutes per systemd.time); not
      // included here. Composite forms (`1h 30min`) and unknown suffixes
      // remain rejected — we narrow systemd's full grammar to single-unit
      // forms so validation can run march-side.
      for (const bad of [
        "",
        "5",
        "abc",
        "0min",
        "-5min",
        "5 min",
        "1h 30min", // composite — deliberately unsupported
        "5mins", // plural — not a systemd suffix
        "5weeks", // long form — not a systemd suffix
      ]) {
        await expect(
          writeHeartbeatTimerOverride(home, "legate-march", bad),
        ).rejects.toBeInstanceOf(LegateError);
      }
      // No partial dir creation when validation fails.
      expect(
        fs.existsSync(
          path.join(home, ".config", "systemd", "user", "agent-deck-conductor-heartbeat-legate-march.timer.d"),
        ),
      ).toBe(false);
    });

    it("rejects malicious conductor names so override path cannot escape the systemd dir", async () => {
      const home = makeTmpDir();
      await expect(
        writeHeartbeatTimerOverride(home, "../../etc", "5min"),
      ).rejects.toBeInstanceOf(LegateError);
    });

    it("overwrites an existing override.conf in place (re-running init updates the cadence)", async () => {
      const home = makeTmpDir();
      await writeHeartbeatTimerOverride(home, "legate-march", "15min");
      await writeHeartbeatTimerOverride(home, "legate-march", "5min");
      const body = fs.readFileSync(overridePath(home, "legate-march"), "utf-8");
      expect(body).toContain("OnBootSec=5min");
      expect(body).not.toContain("OnBootSec=15min");
    });
  });

  describe("initLegate heartbeat override", () => {
    it("threads the heartbeat-interval option through to the result regardless of whether setup ran", async () => {
      // runSetup: false skips the systemd write — but the resolved interval
      // (after defaulting + validation) should still surface in the result
      // so callers can echo it in their summary.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        heartbeatInterval: "10min",
        runSetup: false,
      });
      expect(result.heartbeatInterval).toBe("10min");
      expect(result.heartbeatOverrideWritten).toBe(false);
    });

    it("defaults the heartbeat interval to 5min when no flag is passed", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      expect(result.heartbeatInterval).toBe(DEFAULT_HEARTBEAT_INTERVAL);
      expect(result.heartbeatInterval).toBe("5min");
    });

    it("rejects an invalid heartbeat-interval value before any agent-deck work begins", async () => {
      const home = makeTmpDir();
      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          heartbeatInterval: "five-minutes",
          runSetup: false,
        }),
      ).rejects.toBeInstanceOf(LegateError);
    });

    it("reports that agent heartbeats are disabled in the summary", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        heartbeatInterval: "7min",
        runSetup: false,
      });
      expect(result.summary).toContain("Heartbeat:");
      expect(result.summary).toContain(
        "disabled for legate-agent (deferred — run setup first)",
      );
      expect(result.summary).not.toContain("7min");
    });

    it("rejects withContainer when setup is skipped because no conductor dir exists to mount", async () => {
      const home = makeTmpDir();
      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          runSetup: false,
          withContainer: true,
        }),
      ).rejects.toThrow(/requires setup/);
    });

    it("rejects withContainer when loop deployment is disabled", async () => {
      const home = makeTmpDir();
      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          withContainer: true,
          loop: false,
        }),
      ).rejects.toThrow(/cannot be combined with --no-loop/);
    });
  });

  describe("buildColdStartPrompt", () => {
    const opts = {
      profile: "march",
      workerGroup: "legate-workers",
      repoName: "March",
      repoPath: "/some/repo/March",
    };

    it("substitutes every placeholder (no leftover {…} markers)", () => {
      const prompt = buildColdStartPrompt(opts);
      expect(prompt).toContain("March");
      expect(prompt).toContain("/some/repo/March");
      expect(prompt).toContain("agent-deck profile march");
      expect(prompt).toContain("group: legate-workers");
      expect(prompt).not.toMatch(/\{REPO_NAME\}|\{REPO_PATH\}|\{PROFILE\}|\{WORKER_GROUP\}/);
    });

    it("introduces the legate persona and goals so auto-mode has alignment context", () => {
      const prompt = buildColdStartPrompt(opts);
      // Persona lead-in.
      expect(prompt).toMatch(/Cold start as the Legate for March/);
      // Auto-mode scope statement.
      expect(prompt).toContain("--permission-mode auto");
      // The core skills must be named so the classifier sees them in
      // recent context before the model invokes Skill(legate.*).
      expect(prompt).toContain("legate.resume");
      expect(prompt).toContain("legate.error");
      expect(prompt).toContain("legate.babysit");
      expect(prompt).toContain("legate.merge");
      expect(prompt).toContain("legate.issue");
      // Defers strict mechanics to CLAUDE.md.
      expect(prompt).toMatch(/CLAUDE\.md is the authoritative spec/);
    });

    it("ends with the on-this-turn checklist so the first reply is the alignment ack, not tool work", () => {
      const prompt = buildColdStartPrompt(opts);
      expect(prompt).toMatch(/On this turn:/);
      expect(prompt).toMatch(/cold-start acknowledgement/);
      expect(prompt).toMatch(
        /Online for March \(march\)\. Skills available: legate\.resume, legate\.error, legate\.babysit, legate\.merge, legate\.issue, legate\.unwedge\./,
      );
      expect(prompt).toMatch(
        /Wait for a \[PROCESSOR\] loop escalation or operator message/,
      );
    });
  });

  describe("discoverRepoMetadata", () => {
    it("returns nulls when the path is not a git checkout", () => {
      // A bare tmp dir has no .git, so `gh repo view` fails fast.
      const dir = makeTmpDir();
      const result = discoverRepoMetadata(dir);
      expect(result).toEqual({ ownerWithName: null, defaultBranch: null });
    });

    it("returns nulls when the path does not exist", () => {
      // execFileSync throws when cwd doesn't exist; we swallow it.
      const result = discoverRepoMetadata("/nonexistent/path/should/never/exist");
      expect(result).toEqual({ ownerWithName: null, defaultBranch: null });
    });
  });

  describe("ensureInitialState", () => {
    it("creates a fresh state.json with discovered repo fields when missing", async () => {
      const dir = makeTmpDir();
      const mutated = await ensureInitialState(dir, {
        profile: "gatecli",
        repoName: "GateCLI",
        repoPath: "/some/repo/GateCLI",
        ownerWithName: "Owner/GateCLI",
        defaultBranch: "main",
      });
      expect(mutated).toBe(true);
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "state.json"), "utf-8"),
      );
      expect(written).toEqual({
        profile: "gatecli",
        repo: {
          name: "GateCLI",
          path: "/some/repo/GateCLI",
          default_branch: "main",
          owner_with_name: "Owner/GateCLI",
        },
        slices: {},
        archived_slices: {},
      });
    });

    it("writes nulls when discovery returned nulls (operator-visible signal)", async () => {
      const dir = makeTmpDir();
      const mutated = await ensureInitialState(dir, {
        profile: "gatecli",
        repoName: "GateCLI",
        repoPath: "/some/repo/GateCLI",
        ownerWithName: null,
        defaultBranch: null,
      });
      expect(mutated).toBe(true);
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "state.json"), "utf-8"),
      );
      expect(written.repo.owner_with_name).toBeNull();
      expect(written.repo.default_branch).toBeNull();
    });

    it("preserves existing slices and archived_slices when filling in repo fields", async () => {
      const dir = makeTmpDir();
      // State the conductor wrote during a prior heartbeat — slug + branch
      // were unknown then because gh repo view paused on auto-mode, but a
      // worker was still launched and recorded.
      const prior = {
        profile: "gatecli",
        repo: {
          name: "GateCLI",
          path: "/some/repo/GateCLI",
          default_branch: null,
          owner_with_name: null,
        },
        slices: {
          "feature-1-cut": {
            worker_session_id: "abc123",
            worker_title: "cut: feature-1",
            stage: "pr-open",
          },
        },
        archived_slices: {
          "feature-0-cut": { pr_number: 7, merged_at: "2026-05-01T00:00:00Z" },
        },
        last_heartbeat: "2026-05-10T17:00:00Z",
      };
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(prior));

      const mutated = await ensureInitialState(dir, {
        profile: "gatecli",
        repoName: "GateCLI",
        repoPath: "/some/repo/GateCLI",
        ownerWithName: "Owner/GateCLI",
        defaultBranch: "main",
      });
      expect(mutated).toBe(true);

      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "state.json"), "utf-8"),
      );
      expect(written.repo.owner_with_name).toBe("Owner/GateCLI");
      expect(written.repo.default_branch).toBe("main");
      // Operator-managed fields untouched.
      expect(written.slices).toEqual(prior.slices);
      expect(written.archived_slices).toEqual(prior.archived_slices);
      expect(written.last_heartbeat).toBe("2026-05-10T17:00:00Z");
    });

    it("does not overwrite existing non-null repo fields with discovered values", async () => {
      // If an operator manually corrected the slug, a re-run of init must
      // not blow that away with whatever gh reports today.
      const dir = makeTmpDir();
      const prior = {
        profile: "gatecli",
        repo: {
          name: "GateCLI",
          path: "/some/repo/GateCLI",
          default_branch: "develop",
          owner_with_name: "OperatorChosen/GateCLI",
        },
        slices: {},
        archived_slices: {},
      };
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(prior));

      const mutated = await ensureInitialState(dir, {
        profile: "gatecli",
        repoName: "GateCLI",
        repoPath: "/some/repo/GateCLI",
        ownerWithName: "Discovered/GateCLI",
        defaultBranch: "main",
      });
      expect(mutated).toBe(false);

      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "state.json"), "utf-8"),
      );
      expect(written.repo.owner_with_name).toBe("OperatorChosen/GateCLI");
      expect(written.repo.default_branch).toBe("develop");
    });

    it("treats malformed state.json as missing and writes a fresh skeleton", async () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, "state.json"), "this is not json {{{");

      const mutated = await ensureInitialState(dir, {
        profile: "gatecli",
        repoName: "GateCLI",
        repoPath: "/some/repo/GateCLI",
        ownerWithName: "Owner/GateCLI",
        defaultBranch: "main",
      });
      expect(mutated).toBe(true);

      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "state.json"), "utf-8"),
      );
      expect(written.repo.owner_with_name).toBe("Owner/GateCLI");
      expect(written.slices).toEqual({});
    });

    it("backfills missing repo subfields one at a time", async () => {
      const dir = makeTmpDir();
      // Half-populated: slug present, branch absent.
      const prior = {
        profile: "gatecli",
        repo: {
          name: "GateCLI",
          path: "/some/repo/GateCLI",
          owner_with_name: "Owner/GateCLI",
        },
        slices: {},
        archived_slices: {},
      };
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(prior));

      await ensureInitialState(dir, {
        profile: "gatecli",
        repoName: "GateCLI",
        repoPath: "/some/repo/GateCLI",
        ownerWithName: "Owner/GateCLI",
        defaultBranch: "main",
      });
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "state.json"), "utf-8"),
      );
      expect(written.repo.owner_with_name).toBe("Owner/GateCLI");
      expect(written.repo.default_branch).toBe("main");
    });
  });
});
