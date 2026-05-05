import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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

    it("falls back to 'repo' for an empty result", () => {
      expect(slugify("")).toBe("repo");
      expect(slugify("___")).toBe("repo");
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

    it("encodes the repo slug into the conductor name so per-repo legates do not collide", () => {
      // agent-deck conductor names are unique system-wide; repo-slug encoding
      // ensures `march legate init` works in two different repos under the
      // same agent-deck install without manual --name overrides.
      expect(deriveDefaults("/path/to/Smithy").conductorName).toBe("legate-smithy");
      expect(deriveDefaults("/path/to/AgentDeck").conductorName).toBe("legate-agentdeck");
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
    function makeTemplate(content: string): string {
      const dir = makeTmpDir();
      const tplPath = path.join(dir, "CLAUDE.md");
      fs.writeFileSync(tplPath, content);
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
      expect(result.setupCommand).toContain("-claude-md");
      expect(result.setupCommand).toContain(result.templateOutputPath);
      // Skipped-setup branch surfaces the manual command in the summary.
      expect(result.summary).toContain("Setup skipped");
      expect(result.summary).toContain(result.setupCommand.join(" "));
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
