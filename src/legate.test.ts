import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkBridgeRequirements,
  deriveDefaults,
  initLegate,
  LegateError,
  renderTemplate,
  slugify,
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
      // Callers (deriveDefaults) substitute a stable per-repo hash fallback;
      // slugify itself does not pick a fallback to avoid silent collisions.
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
      // Two repos whose basenames slug to empty must still produce
      // different defaults — otherwise both default to `legate-repo` and
      // collide in agent-deck's system-wide conductor namespace.
      const a = deriveDefaults("/path/to/___");
      const b = deriveDefaults("/other/path/to/___");
      expect(a.conductorName).not.toBe(b.conductorName);
      expect(a.profile).not.toBe(b.profile);
      expect(a.conductorName).toMatch(/^legate-repo-[0-9a-f]{8}$/);
      expect(b.conductorName).toMatch(/^legate-repo-[0-9a-f]{8}$/);

      // Hashing the absolute path → same path produces the same slug.
      const a2 = deriveDefaults("/path/to/___");
      expect(a2.conductorName).toBe(a.conductorName);
    });

    it("encodes the repo slug into the conductor name so per-repo legates do not collide", () => {
      // agent-deck conductor names are unique system-wide; repo-slug encoding
      // ensures `march legate init` works in two different repos under the
      // same agent-deck install without manual --name overrides.
      expect(deriveDefaults("/path/to/Smithy").conductorName).toBe("legate-smithy");
      expect(deriveDefaults("/path/to/AgentDeck").conductorName).toBe("legate-agentdeck");
    });
  });

  describe("checkBridgeRequirements", () => {
    it("returns the host's actual python3 version on success", () => {
      // The test host running CI/dev has *some* python3; we don't assume
      // a specific version, only that the function returns a structured
      // result. If python3 is missing entirely, fall through to the
      // ok=false branch with reason="missing".
      const result = checkBridgeRequirements();
      if (result.ok) {
        expect(result.pythonVersion).toMatch(/^\d+\.\d+$/);
      } else {
        // Acceptable on hosts where python3 is missing or too old; only
        // assert the structured fields are coherent.
        expect(["missing", "too-old", "unparseable"]).toContain(result.reason);
        expect(result.message).toMatch(/python|Python/);
        expect(result.message).toContain("--no-bridge-check");
      }
    });
  });

  describe("renderTemplate", () => {
    it("substitutes all five placeholders globally", () => {
      const tpl =
        "name={REPO_NAME} path={REPO_PATH} profile={PROFILE} " +
        "name-again={REPO_NAME} cond={CONDUCTOR_NAME} group={WORKER_GROUP}";
      const out = renderTemplate(tpl, {
        REPO_NAME: "March",
        REPO_PATH: "/home/u/March",
        PROFILE: "march",
        CONDUCTOR_NAME: "legate-march",
        WORKER_GROUP: "legate-workers",
      });
      expect(out).toBe(
        "name=March path=/home/u/March profile=march " +
          "name-again=March cond=legate-march group=legate-workers",
      );
    });

    it("leaves unrelated single-brace tokens alone", () => {
      const out = renderTemplate("keep {OTHER} drop {REPO_NAME}", {
        REPO_NAME: "X",
        REPO_PATH: "Y",
        PROFILE: "Z",
        CONDUCTOR_NAME: "C",
        WORKER_GROUP: "G",
      });
      expect(out).toBe("keep {OTHER} drop X");
    });
  });

  describe("initLegate", () => {
    /**
     * Build a fake template directory that mirrors the production layout
     * `src/templates/legate/{CLAUDE.md, skill/{SKILL.md, scripts/...}}` —
     * just enough that stageSkill can copy without erroring. Tests that don't
     * care about the skill contents get a no-op script.
     */
    function makeTemplate(content: string): string {
      const dir = makeTmpDir();
      const tplPath = path.join(dir, "CLAUDE.md");
      fs.writeFileSync(tplPath, content);
      const skillDir = path.join(dir, "skill");
      fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "test skill\n");
      fs.writeFileSync(
        path.join(skillDir, "scripts", "noop.sh"),
        "#!/bin/sh\nexit 0\n",
      );
      return tplPath;
    }

    it("renders the template into the staging dir and returns expected fields", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate(
        "Repo: {REPO_NAME} ({REPO_PATH})\nProfile: {PROFILE}\nConductor: {CONDUCTOR_NAME}\nGroup: {WORKER_GROUP}\n",
      );

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
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
      const tpl = makeTemplate("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });

      expect(result.setupCommand[0]).toBe("agent-deck");
      expect(result.setupCommand).toContain("-p");
      expect(result.setupCommand).toContain("march");
      expect(result.setupCommand).toContain("setup");
      expect(result.setupCommand).toContain("legate-march");
      // We deliberately do NOT pass `-claude-md` to agent-deck — that would
      // create a symlink that auto-mode flags as a cross-boundary read.
      // Instead, the rendered template is copied into the conductor's
      // CLAUDE.md after setup runs (see copyTemplateIntoConductor).
      expect(result.setupCommand).not.toContain("-claude-md");
      // Skipped-setup branch surfaces the shell-quoted manual command and
      // does NOT claim the conductor has been created yet (the symlink/
      // attach wording is reserved for the runSetup=true path), but it
      // *does* surface the post-setup auto-mode commands so the operator
      // can run the full sequence by hand.
      expect(result.summary).toContain("Setup skipped");
      expect(result.summary).toContain(
        "no conductor has been created and nothing has been copied",
      );
      // The symlink wording is gone — we copy on setup-run, not symlink.
      expect(result.summary).not.toContain("symlinked to the template above");
      expect(result.summary).toContain(
        "Then enable auto mode, pin model, and restart",
      );
      expect(result.summary).toContain("auto-mode true");
      expect(result.summary).toContain("--model sonnet");
      expect(result.summary).toContain("session restart");
    });

    it("returns post-setup auto-mode commands targeting the conductor session", async () => {
      // agent-deck's [conductors.<name>.claude] block does not support
      // auto_mode (only config_dir + env_file per userconfig.go); auto mode
      // has to be flipped on the conductor's ClaudeOptions via the direct
      // `auto-mode` mutable field (mutators.go:211), followed by a restart
      // so the new flag takes effect immediately.
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });

      // Post-setup commands: auto-mode + model + restart, plus bridge-start
      // on Linux/WSL2. Order is [auto-mode, model, restart, bridge?].
      const expectedLength = process.platform === "linux" ? 4 : 3;
      expect(result.postSetupCommands).toHaveLength(expectedLength);
      const [setAutoMode, setModel, restart] = result.postSetupCommands;

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
      // Default model is sonnet — orchestration-light, cheap on Claude Max.
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
      if (process.platform === "linux") {
        // The bridge-start command is required for the conductor to
        // receive heartbeats from agent-deck's bridge daemon. Without it
        // the conductor is functional but inert.
        expect(result.postSetupCommands[3]).toEqual([
          "systemctl",
          "--user",
          "start",
          "agent-deck-conductor-bridge",
        ]);
      }

      // With --no-setup, post-setup booleans stay false because nothing ran.
      expect(result.autoModeConfigured).toBe(false);
      expect(result.bridgeActive).toBe(false);
    });

    it("respects an explicit --model override", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
        model: "claude-opus-4-7",
      });

      const setModel = result.postSetupCommands[1];
      expect(setModel[setModel.length - 1]).toBe("claude-opus-4-7");
      expect(result.summary).toContain("Model:          claude-opus-4-7");
    });

    it("shell-quotes the setup command in the --no-setup summary", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      // Default description contains spaces and arrow punctuation, both of
      // which would split incorrectly under a naive `setupCommand.join(" ")`.
      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });

      const desc = "Legate orchestrator for March (Smithy plan→PR→fix loop)";
      expect(result.summary).toContain(`'${desc}'`);
      // setupCommand itself stores the raw argv (correct for execFileSync);
      // only the rendered string is quoted.
      expect(result.setupCommand).toContain(desc);
    });

    it("rendered for vs configured for varies with runSetup outcome", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });
      expect(result.summary.split("\n")[0]).toContain("rendered for March");
      expect(result.summary.split("\n")[0]).not.toContain("configured for");
    });

    it("respects explicit profile, name, description, and worker-group overrides", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate("p={PROFILE} n={CONDUCTOR_NAME} g={WORKER_GROUP}");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
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
      const tpl = makeTemplate("v1 {REPO_NAME}");

      const first = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });
      expect(fs.readFileSync(first.templateOutputPath, "utf-8")).toContain(
        "v1 March",
      );

      // Edit template and re-run — same staging path, fresh content.
      fs.writeFileSync(tpl, "v2 {REPO_NAME}");
      const second = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });
      expect(second.templateOutputPath).toBe(first.templateOutputPath);
      expect(fs.readFileSync(second.templateOutputPath, "utf-8")).toContain(
        "v2 March",
      );
    });

    it("stages the skill alongside the rendered template", async () => {
      // Production deploys put SKILL.md + scripts under the staged dir so
      // that re-running `march legate init` is the iteration loop for skill
      // changes too. The conductor's `.claude/skills/legate` symlink (set up
      // post-`agent-deck conductor setup`) points at this staged dir, so
      // edits here propagate to the live conductor on session restart.
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      const result = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });

      expect(result.skillStagedDir).toBe(
        path.join(home, ".march", "legate", "legate-march", "skill"),
      );
      expect(fs.existsSync(path.join(result.skillStagedDir, "SKILL.md"))).toBe(
        true,
      );
      expect(
        fs.existsSync(path.join(result.skillStagedDir, "scripts", "noop.sh")),
      ).toBe(true);
      // Scripts must be executable (mode +x) so the conductor can `bash` them
      // or invoke them directly without a shell prefix.
      const scriptStat = fs.statSync(
        path.join(result.skillStagedDir, "scripts", "noop.sh"),
      );
      expect(scriptStat.mode & 0o111).not.toBe(0);

      // With --no-setup, the conductor dir doesn't exist yet so the copy
      // step is skipped — skillDeployed stays false. The summary calls this
      // out so the operator knows the skill is staged but not yet copied.
      expect(result.skillDeployed).toBe(false);
      expect(result.summary).toContain("legate staged at");
    });

    it("re-staging cleans up a removed script from a previous render", async () => {
      // If a future template removes a script, re-running init should not
      // leave the old one behind in the staged dir.
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      const first = await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });
      // Add a script to the staged dir that isn't in the source — simulates
      // an old script removed in a newer version of the template.
      const ghost = path.join(first.skillStagedDir, "scripts", "ghost.sh");
      fs.writeFileSync(ghost, "#!/bin/sh\nexit 0\n");
      expect(fs.existsSync(ghost)).toBe(true);

      // Re-run init.
      await initLegate({
        repoPath: "/some/repo/March",
        homeDir: home,
        templatePath: tpl,
        runSetup: false,
      });

      // Stale script is gone; canonical script is back.
      expect(fs.existsSync(ghost)).toBe(false);
      expect(
        fs.existsSync(
          path.join(first.skillStagedDir, "scripts", "noop.sh"),
        ),
      ).toBe(true);
    });

    it("rejects path-traversal in conductor name before composing the staging path", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templatePath: tpl,
          runSetup: false,
          conductorName: "../../.ssh",
        }),
      ).rejects.toThrow(/Invalid conductor name/);

      // Staging dir should not contain anything outside ~/.march/legate.
      const escapeTarget = path.join(path.dirname(home), ".ssh");
      expect(fs.existsSync(escapeTarget)).toBe(false);
    });

    it("rejects an empty or oversized conductor name", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templatePath: tpl,
          runSetup: false,
          conductorName: "",
        }),
      ).rejects.toThrow(/Conductor name cannot be empty/);

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templatePath: tpl,
          runSetup: false,
          conductorName: "x".repeat(65),
        }),
      ).rejects.toThrow(/Conductor name too long/);
    });

    it("rejects path-traversal in profile name", async () => {
      const home = makeTmpDir();
      const tpl = makeTemplate("ok");

      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templatePath: tpl,
          runSetup: false,
          profile: "../escape",
        }),
      ).rejects.toThrow(/Invalid profile name/);
    });

    it("throws LegateError when an explicit template path is missing", async () => {
      const home = makeTmpDir();
      await expect(
        initLegate({
          repoPath: "/some/repo/March",
          homeDir: home,
          templatePath: "/no/such/file.md",
          runSetup: false,
        }),
      ).rejects.toBeInstanceOf(LegateError);
    });

    it("locates the bundled template when no explicit path is provided", async () => {
      // Smoke test: with the default template-resolution path, initLegate
      // should find src/templates/legate/CLAUDE.md and render the real prompt.
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
    });
  });
});
