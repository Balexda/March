/**
 * @l1 @deterministic @ci
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildStewardSettings,
  ensureStewardSkills,
  recordStewardSession,
  stewardSessionFilePath,
  stewardSettingsPath,
  stewardSkillsRoot,
  stewardPluginDir,
  STEWARD_PLUGIN_NAME,
} from "./steward-skills.js";

const prevOverride = process.env.MARCH_STEWARD_SKILLS_DIR;

afterEach(() => {
  if (prevOverride === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
  else process.env.MARCH_STEWARD_SKILLS_DIR = prevOverride;
});

describe("stewardSkillsRoot", () => {
  it("defaults to ~/.march/steward", () => {
    delete process.env.MARCH_STEWARD_SKILLS_DIR;
    expect(stewardSkillsRoot()).toBe(path.join(os.homedir(), ".march", "steward"));
  });

  it("honors the MARCH_STEWARD_SKILLS_DIR override", () => {
    process.env.MARCH_STEWARD_SKILLS_DIR = "/custom/steward";
    expect(stewardSkillsRoot()).toBe("/custom/steward");
  });
});

describe("ensureStewardSkills", () => {
  it("materializes the steward-pr skill as the march-steward plugin and is idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-skills-"));
    process.env.MARCH_STEWARD_SKILLS_DIR = root;
    // A legacy --add-dir layout from an older Castra is removed.
    const legacy = path.join(root, ".claude", "skills", "steward-pr", "SKILL.md");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "old");

    const returned = await ensureStewardSkills();
    expect(returned).toBe(root);
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(false);

    expect(stewardPluginDir()).toBe(path.join(root, "plugin"));
    const manifest = JSON.parse(
      await fsp.readFile(path.join(root, "plugin", ".claude-plugin", "plugin.json"), "utf-8"),
    );
    expect(manifest.name).toBe(STEWARD_PLUGIN_NAME);

    const skillPath = path.join(root, "plugin", "skills", "steward-pr", "SKILL.md");
    const body = await fsp.readFile(skillPath, "utf-8");
    expect(body).toContain("name: steward-pr");
    // The skill encodes the title rule (no `smithy ` prefix, no US/S numbers).
    expect(body).toContain("<verb>: <concise goal>");

    // Re-running overwrites cleanly rather than throwing.
    await expect(ensureStewardSkills()).resolves.toBe(root);
    expect(fs.existsSync(skillPath)).toBe(true);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it("provisions the self-report hook + a settings.json that wires it (#371)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-skills-"));
    process.env.MARCH_STEWARD_SKILLS_DIR = root;

    await ensureStewardSkills();

    const hookPath = path.join(root, "hooks", "steward-report.mjs");
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(await fsp.readFile(hookPath, "utf-8")).toContain("steward-report");

    const settings = JSON.parse(await fsp.readFile(stewardSettingsPath(), "utf-8"));
    // Both turn-boundary events fire the shipped hook by absolute path.
    for (const event of ["Notification", "Stop"]) {
      const command = settings.hooks[event][0].hooks[0].command;
      expect(command).toContain("steward-report.mjs");
      expect(command).toContain(hookPath);
    }

    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe("buildStewardSettings", () => {
  it("restores the shim path for Claude commands after shell startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "host's steward "));
    try {
      const envFile = path.join(root, "claude.env");
      const env = { ...process.env, CLAUDE_ENV_FILE: envFile };
      const settings = buildStewardSettings(root);
      const shellOptions = { env, encoding: "utf8" as const, timeout: 5_000 };
      execFileSync("sh", ["-c", settings.hooks.SessionStart[0].hooks[0].command], shellOptions);
      const result = execFileSync("sh", ["-c",
        'PATH=/usr/bin; . "$CLAUDE_ENV_FILE"; printf "%s" "$PATH"',
      ], shellOptions);
      expect(result).toBe(`${path.join(root, "bin")}:/usr/bin`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("wires Notification + Stop to the hook script under the given root", () => {
    const settings = buildStewardSettings("/srv/steward");
    const expected = `node '${path.join("/srv/steward", "hooks", "steward-report.mjs")}'`;
    expect(settings.hooks.Notification[0].hooks[0].command).toBe(expected);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(expected);
  });
});

describe("recordStewardSession", () => {
  it("writes a per-worktree sidecar with profile/sliceId/heraldUrl", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-sessions-"));
    process.env.MARCH_STEWARD_SKILLS_DIR = root;

    recordStewardSession({
      worktreePath: "/repos/feature-march-spawn-x",
      profile: "march",
      sliceId: "slice-7",
      heraldUrl: "http://herald:9099",
    });

    const file = stewardSessionFilePath("/repos/feature-march-spawn-x");
    // Keyed by the full-path hash, with the basename kept as a readable prefix.
    expect(path.basename(file)).toMatch(/^feature-march-spawn-x-[0-9a-f]{12}\.json$/);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({
      profile: "march",
      sliceId: "slice-7",
      heraldUrl: "http://herald:9099",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keys distinct worktree paths with the same basename to distinct files (collision fix)", () => {
    // Two repos/profiles launching the same branch name → same basename, but the
    // full paths differ, so the sidecars must not collide and overwrite.
    const a = stewardSessionFilePath("/repos/march/feature-smithy-forge-01");
    const b = stewardSessionFilePath("/repos/smithy/feature-smithy-forge-01");
    expect(a).not.toBe(b);
    // ...and the keying is deterministic for a given path.
    expect(stewardSessionFilePath("/repos/march/feature-smithy-forge-01")).toBe(a);
  });

  it("prunes sidecars older than the TTL on the next write", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-sessions-"));
    process.env.MARCH_STEWARD_SKILLS_DIR = root;

    // A stale sidecar from a long-gone session, backdated well past the TTL.
    const stale = stewardSessionFilePath("/repos/feature-ancient");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "{}", "utf-8");
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60; // 30 days ago (seconds)
    fs.utimesSync(stale, old, old);

    // Any fresh write triggers the GC.
    recordStewardSession({
      worktreePath: "/repos/feature-fresh",
      profile: "march",
      sliceId: "slice-1",
      heraldUrl: "http://herald:9099",
    });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(stewardSessionFilePath("/repos/feature-fresh"))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op without a sliceId (nothing to tag)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-sessions-"));
    process.env.MARCH_STEWARD_SKILLS_DIR = root;

    recordStewardSession({ worktreePath: "/repos/feature-x", profile: "march" });
    expect(fs.existsSync(stewardSessionFilePath("/repos/feature-x"))).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
