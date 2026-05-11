import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildColdStartPrompt,
  checkBridgeRequirements,
  deriveDefaults,
  initLegate,
  LegateError,
  LEGATE_SKILLS,
  renderPrompt,
  renderTemplate,
  slugify,
  writeLegateHeartbeatScript,
} from "./legate.js";

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
});
