import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
      expect(defaults.conductorName).toBe("legate-march");
      expect(defaults.workerGroup).toBe("legate-workers");
    });

    it("falls back to a path-hashed slug when the repo basename has no slug-able characters", () => {
      const a = deriveDefaults("/path/to/___");
      const b = deriveDefaults("/other/path/to/___");
      expect(a.conductorName).not.toBe(b.conductorName);
      expect(a.profile).not.toBe(b.profile);
      expect(a.conductorName).toMatch(/^legate-repo-[0-9a-f]{8}$/);
      expect(b.conductorName).toMatch(/^legate-repo-[0-9a-f]{8}$/);

      const a2 = deriveDefaults("/path/to/___");
      expect(a2.conductorName).toBe(a.conductorName);
    });

    it("encodes the repo slug into the conductor name so per-repo legates do not collide", () => {
      expect(deriveDefaults("/path/to/Smithy").conductorName).toBe("legate-smithy");
      expect(deriveDefaults("/path/to/AgentDeck").conductorName).toBe("legate-agentdeck");
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
      CONDUCTOR_NAME: "legate-march",
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
      expect(out).toContain("cond=legate-march");
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
     * Skills follow the production names (legate.babysit, legate.dispatch)
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
      expect(result.conductorName).toBe("legate-march");
      expect(result.workerGroup).toBe("legate-workers");
      expect(result.repoName).toBe("March");
      expect(result.setupRan).toBe(false);

      const expected = path.join(
        home,
        ".march",
        "legate",
        "legate-march",
        "CLAUDE.md",
      );
      expect(result.templateOutputPath).toBe(expected);
      expect(fs.existsSync(expected)).toBe(true);

      const rendered = fs.readFileSync(expected, "utf-8");
      expect(rendered).toContain("Repo: March (/some/repo/March)");
      expect(rendered).toContain("Profile: march");
      expect(rendered).toContain("Conductor: legate-march");
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
      expect(result.setupCommand).toContain("legate-march");
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
        "legate-march",
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
        "conductor-legate-march",
        "auto-mode",
        "true",
      ]);
      expect(setModel).toEqual([
        "agent-deck",
        "-p",
        "march",
        "session",
        "set",
        "conductor-legate-march",
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
        "conductor-legate-march",
      ]);
      expect(sendColdStart.slice(0, 6)).toEqual([
        "agent-deck",
        "-p",
        "march",
        "session",
        "send",
        "conductor-legate-march",
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
        "legate-march",
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
      expect(rendered).toContain("legate-march");
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
        // or launch worker sessions (babysit, dispatch), not by cleanup
        // which operates on per-slice session IDs from state.json.
        expect(content).toContain("/some/repo/March");
      }
    });

    it("stages legate.dispatch with find-ready-slices.sh alongside the other dispatch scripts", async () => {
      // find-ready-slices.sh is the jq-based wrapper around smithy-status.sh
      // that the dispatch protocol uses to filter for dispatchable items.
      // Without it deployed, the conductor's only recourse is to inline
      // `python3 -c "..."` (or jq) against smithy-status.sh's stdout, which
      // the legate's auto-mode rules explicitly NEED-escalate — every
      // heartbeat would stall on operator approval.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const dispatch = result.skills.find((s) => s.name === "legate.dispatch");
      expect(dispatch).toBeDefined();
      const scriptsDir = path.join(dispatch!.stagedDir, "scripts");
      for (const name of [
        "find-ready-slices.sh",
        "inspect-worker.sh",
        "launch-worker.sh",
        "smithy-status.sh",
        "sync-default-branch.sh",
      ]) {
        const p = path.join(scriptsDir, name);
        expect(fs.existsSync(p)).toBe(true);
        // +x bit so the conductor's `bash <path>` calls succeed.
        expect(fs.statSync(p).mode & 0o111).not.toBe(0);
      }
    });

    it("launch-worker.sh post-launch jq filter binds .id before piping to index($b)", async () => {
      // Regression: the earlier filter `select($b | index(.id) | not)`
      // re-evaluated `.id` against $b (the array), not the outer session.
      // jq 1.6 dies with `Cannot index array with string "id"` and the
      // script exits 5 on every launch. The conductor recovered via
      // inspect-worker.sh so the bug went unnoticed, but every launch
      // logged a stack trace and lost the JSON output downstream consumers
      // expected. The corrected pattern binds the session into $s first.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const dispatch = result.skills.find((s) => s.name === "legate.dispatch");
      const launchScript = fs.readFileSync(
        path.join(dispatch!.stagedDir, "scripts", "launch-worker.sh"),
        "utf-8",
      );
      // String-content guard: the broken pattern must not reappear.
      expect(launchScript).not.toMatch(/select\(\s*\$b\s*\|\s*index\(\.id\)/);
      // Positive assertion: the corrected binding is present.
      expect(launchScript).toMatch(/\.\s+as\s+\$s/);
      expect(launchScript).toMatch(/index\(\$s\.id\)/);

      // Functional check: extract the jq filter and run it against fixture
      // data. Mirrors the agent-deck list --json schema (flat array of
      // objects). Verifies both the empty-BEFORE_IDS case (initial run with
      // no prior workers) and the populated case (worker already existed).
      const fixture = JSON.stringify([
        {
          id: "conductor-id",
          group: "conductor",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "old-worker",
          group: "legate-workers",
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "new-worker",
          group: "legate-workers",
          created_at: "2026-01-03T00:00:00Z",
        },
      ]);
      const filter = `[.[] | select(.group == $g) | . as $s | select($b | index($s.id) | not)] | sort_by(.created_at // 0) | last // null`;
      // Empty BEFORE_IDS: both workers are "new"; expect the latest by created_at.
      const emptyResult = execFileSync(
        "jq",
        ["--arg", "g", "legate-workers", "--argjson", "b", "[]", filter],
        { input: fixture, encoding: "utf-8" },
      );
      expect(JSON.parse(emptyResult).id).toBe("new-worker");
      // Populated BEFORE_IDS containing old-worker: only new-worker is new.
      const populatedResult = execFileSync(
        "jq",
        [
          "--arg",
          "g",
          "legate-workers",
          "--argjson",
          "b",
          '["old-worker"]',
          filter,
        ],
        { input: fixture, encoding: "utf-8" },
      );
      expect(JSON.parse(populatedResult).id).toBe("new-worker");
      // Populated BEFORE_IDS containing every worker: nothing new.
      const allKnownResult = execFileSync(
        "jq",
        [
          "--arg",
          "g",
          "legate-workers",
          "--argjson",
          "b",
          '["old-worker","new-worker"]',
          filter,
        ],
        { input: fixture, encoding: "utf-8" },
      );
      expect(JSON.parse(allKnownResult)).toBeNull();
    });

    it("stages legate.babysit with recover-stranded-worker.sh", async () => {
      // Revival recovery: agent-deck respawns a worker's Claude Code process
      // after a host restart without replaying the original `-m` argument,
      // leaving the worker pane an empty splash. recover-stranded-worker.sh
      // reads the verb-cmd staged by launch-worker.sh and re-sends it. Must
      // be deployed so the babysit decision tree can call it.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const babysit = result.skills.find((s) => s.name === "legate.babysit");
      const scriptsDir = path.join(babysit!.stagedDir, "scripts");
      const p = path.join(scriptsDir, "recover-stranded-worker.sh");
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).mode & 0o111).not.toBe(0);

      // Sanity: script syntax must parse — a typo would only surface at the
      // first failed heartbeat in production otherwise.
      expect(() =>
        execFileSync("bash", ["-n", p], { stdio: "pipe" }),
      ).not.toThrow();
    });

    it("launch-worker.sh accepts a slice-id arg and stages dispatch-msg-<slice-id>.md", async () => {
      // The 7th positional arg is what enables revival recovery: writing
      // the verb-cmd to a file the babysit skill can read back. Without
      // this arg, a host restart strands the worker with no way to
      // re-dispatch.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const dispatch = result.skills.find((s) => s.name === "legate.dispatch");
      const launchScript = fs.readFileSync(
        path.join(dispatch!.stagedDir, "scripts", "launch-worker.sh"),
        "utf-8",
      );
      // Arg count enforced.
      expect(launchScript).toMatch(/if \[\[ \$# -ne 7 \]\]/);
      // Usage line mentions slice-id.
      expect(launchScript).toMatch(/<slice-id>/);
      // SLICE_ID is bound to $7 and validated.
      expect(launchScript).toMatch(/SLICE_ID="\$7"/);
      expect(launchScript).toMatch(/\^\[a-zA-Z0-9\]\[a-zA-Z0-9\._\-\]\*\$/);
      // Stage file path is derived from the validated slice-id.
      expect(launchScript).toMatch(/dispatch-msg-\$\{SLICE_ID\}\.md/);
      // verb-cmd is written via printf (so newlines round-trip cleanly).
      expect(launchScript).toMatch(/printf '%s\\n' "\$VERB_CMD"/);
    });

    it("cleanup-merged-session.sh removes the staged dispatch-msg file before tearing the session down", async () => {
      // Stage files in the conductor's cwd survive across heartbeats by
      // design; without explicit cleanup on merge, the dir would accumulate
      // a file per slice ever launched. Order matters too: the rm must
      // happen before agent-deck session remove succeeds, so a re-run
      // after partial failure still completes the rm idempotently.
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        runSetup: false,
      });
      const cleanup = result.skills.find((s) => s.name === "legate.cleanup");
      const script = fs.readFileSync(
        path.join(cleanup!.stagedDir, "scripts", "cleanup-merged-session.sh"),
        "utf-8",
      );
      expect(script).toMatch(/dispatch-msg-\$\{SLICE_ID\}\.md/);
      expect(script).toMatch(/rm -f "\$DISPATCH_MSG_PATH"/);
      // rm must precede the actual `agent-deck ... session remove` call.
      // The header comment also mentions "session remove" — anchor on the
      // invocation form to skip past it.
      const rmIdx = script.indexOf('rm -f "$DISPATCH_MSG_PATH"');
      const removeCallIdx = script.indexOf('agent-deck -p "$PROFILE" session remove');
      expect(rmIdx).toBeGreaterThan(0);
      expect(removeCallIdx).toBeGreaterThan(rmIdx);
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

    it("includes the heartbeat cadence in the summary so operators see what was pinned", async () => {
      const home = makeTmpDir();
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        heartbeatInterval: "7min",
        runSetup: false,
      });
      expect(result.summary).toContain("Heartbeat:");
      expect(result.summary).toContain("7min");
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
      // The three skills must be named so the classifier sees them in
      // recent context before the model invokes Skill(legate.*).
      expect(prompt).toContain("legate.babysit");
      expect(prompt).toContain("legate.cleanup");
      expect(prompt).toContain("legate.dispatch");
      // Defers strict mechanics to CLAUDE.md.
      expect(prompt).toMatch(/CLAUDE\.md is the authoritative spec/);
    });

    it("ends with the on-this-turn checklist so the first reply is the alignment ack, not tool work", () => {
      const prompt = buildColdStartPrompt(opts);
      expect(prompt).toMatch(/On this turn:/);
      expect(prompt).toMatch(/cold-start acknowledgement/);
      expect(prompt).toMatch(
        /Online for March \(march\)\. Skills available: legate\.babysit, legate\.cleanup, legate\.dispatch\./,
      );
      expect(prompt).toMatch(/Wait for the first \[HEARTBEAT\]/);
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
