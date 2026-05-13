import { describe, it, expect } from "vitest";
import {
  BASE_IMAGE,
  CONTAINER_WORKDIR,
  PROMPT_PATH,
  SPAWN_CONFIG,
  claudeCodeBackend,
  type SpawnBackend,
  type SpawnConfig,
} from "./spawn-config.js";

/**
 * Tests for the spawn-config module.
 *
 * `SPAWN_CONFIG` is the single auditable source of truth for the hardcoded
 * container security and resource posture consumed by Stage 4 of the
 * dispatch pipeline. Per SD-001 of the US5 tasks file, the values come
 * verbatim from the data-model SpawnConfig entity examples; if any of
 * these literals drift, downstream rollback / launch tests will hide
 * security regressions, so the asserts below are intentionally exact.
 */

describe("spawn-config", () => {
  describe("BASE_IMAGE", () => {
    it("preserves the previously published tag exactly", () => {
      // Story 4's snapshot-build module imports this literal — any drift
      // here breaks the build/launch pipeline. Asserted explicitly so
      // future refactors must update the test alongside the constant.
      expect(BASE_IMAGE).toBe("march-base:latest");
    });
  });

  describe("SPAWN_CONFIG", () => {
    it("is typeable as the SpawnConfig interface", () => {
      // Compile-time only — the assignment fails typecheck if the
      // exported interface no longer matches the constant's shape.
      const cfg: SpawnConfig = SPAWN_CONFIG;
      expect(cfg).toBe(SPAWN_CONFIG);
    });

    it("drops every Linux capability (AS 5.1)", () => {
      expect(SPAWN_CONFIG.capDrop).toEqual(["ALL"]);
    });

    it("runs as the non-root `march` user (AS 5.2)", () => {
      // Matches `--chown=march:march` baked into the Dockerfile by
      // `writeSpawnDockerfile` so file ownership inside the container
      // lines up with the runtime user.
      expect(SPAWN_CONFIG.user).toBe("march");
      expect(SPAWN_CONFIG.user).not.toBe("root");
      expect(SPAWN_CONFIG.user).not.toBe("0");
      expect(SPAWN_CONFIG.user).not.toBe("0:0");
      expect(SPAWN_CONFIG.user.length).toBeGreaterThan(0);
    });

    it("uses the default Docker bridge network (AS 5.5)", () => {
      // Documented gap: Feature 4 owns network-policy hardening.
      expect(SPAWN_CONFIG.networkMode).toBe("bridge");
    });

    it("applies hardcoded memory and CPU limits matching Docker's formats (AS 5.3)", () => {
      expect(SPAWN_CONFIG.memoryLimit).toBe("4g");
      // Docker memory format: `<positive integer><b|k|m|g>?` (case-
      // insensitive). Asserted with a permissive but non-empty regex
      // to catch obvious drift like `""` or `"4 GB"`.
      expect(SPAWN_CONFIG.memoryLimit).toMatch(/^\d+[bkmg]?$/i);
      expect(SPAWN_CONFIG.memoryLimit.length).toBeGreaterThan(0);

      expect(SPAWN_CONFIG.cpuLimit).toBe("2");
      // Docker `--cpus` accepts a positive decimal-as-string.
      expect(SPAWN_CONFIG.cpuLimit.length).toBeGreaterThan(0);
      const cpuValue = Number(SPAWN_CONFIG.cpuLimit);
      expect(Number.isFinite(cpuValue)).toBe(true);
      expect(cpuValue).toBeGreaterThan(0);
    });

    it("uses a positive integer execution timeout", () => {
      expect(SPAWN_CONFIG.timeoutSeconds).toBe(3600);
      expect(Number.isInteger(SPAWN_CONFIG.timeoutSeconds)).toBe(true);
      expect(SPAWN_CONFIG.timeoutSeconds).toBeGreaterThan(0);
    });

    it("whitelists exactly ANTHROPIC_API_KEY and nothing else (AS 5.4)", () => {
      // Backend-specific auth key only — narrowing this further is
      // Feature 4's responsibility per the contracts.
      expect(SPAWN_CONFIG.envWhitelist).toEqual(["ANTHROPIC_API_KEY"]);
    });
  });

  describe("PROMPT_PATH", () => {
    it("is the in-container path the Stage 5 handoff helper writes to (SD-004)", () => {
      // Single source of truth shared by `claudeCodeBackend.buildEntrypoint`
      // (which embeds the path in the `sh -c` command) and Task 4's Stage 5
      // handoff helper (which writes the prompt to this path inside the
      // container). Asserted as a literal so the entrypoint argv test below
      // and the Stage 5 destination cannot drift apart.
      expect(PROMPT_PATH).toBe("/march/prompt.txt");
    });
  });

  describe("CONTAINER_WORKDIR", () => {
    it("is the in-container working directory baked into the Dockerfile WORKDIR", () => {
      // Single source of truth shared by `writeSpawnDockerfile` in
      // `snapshot-build.ts` (which emits the literal as both the COPY
      // destination and the WORKDIR) and the `finalizePrompt` helper in
      // `prompt-finalize.ts` (which embeds it in the `Working Directory: ...`
      // header line). Asserted as a literal so the Dockerfile content test
      // in `snapshot-build.test.ts` and the prompt-finalize tests cannot
      // drift apart.
      expect(CONTAINER_WORKDIR).toBe("/march/workspace");
    });
  });

  describe("claudeCodeBackend", () => {
    it("is typeable as the SpawnBackend interface", () => {
      // Compile-time only — the assignment fails typecheck if the exported
      // interface no longer matches the constant's shape.
      const backend: SpawnBackend = claudeCodeBackend;
      expect(backend).toBe(claudeCodeBackend);
    });

    it("identifies itself as `claude-code`", () => {
      // Verbatim from the contracts' Claude Code Implementation block.
      // Feature 3 will key its backend-selection mechanism on this name.
      expect(claudeCodeBackend.name).toBe("claude-code");
    });

    it("uses BASE_IMAGE as its baseImage (single source of truth)", () => {
      // Locks the consistency requirement from the slice: BASE_IMAGE and
      // `claudeCodeBackend.baseImage` must agree so existing consumers in
      // `src/cli.ts` and `src/snapshot-build.ts` keep compiling without
      // import-path churn.
      expect(claudeCodeBackend.baseImage).toBe(BASE_IMAGE);
      expect(claudeCodeBackend.baseImage).toBe("march-base:latest");
    });

    it("requires exactly ANTHROPIC_API_KEY in requiredEnvVars", () => {
      // Verbatim from the contracts' Claude Code Implementation block.
      // Story 5's Stage 4 Launch will source the `-e VAR` passthrough flags
      // from this list (currently sourced from `SPAWN_CONFIG.envWhitelist`,
      // which mirrors the same single auth key).
      expect(claudeCodeBackend.requiredEnvVars).toEqual(["ANTHROPIC_API_KEY"]);
    });

    it("buildEntrypoint(PROMPT_PATH) returns the contracts' exact 3-element argv", () => {
      // Verbatim from the contracts' Claude Code Implementation block.
      // The shell wrapper (`sh -c`) is required because Docker's exec form
      // does not invoke a shell, and the entrypoint relies on `$(cat ...)`
      // shell expansion to inline the prompt without exposing it on the
      // argv. AS 6.5 is satisfied by this exact array.
      expect(claudeCodeBackend.buildEntrypoint(PROMPT_PATH)).toEqual([
        "sh",
        "-c",
        `claude -p "$(cat /march/prompt.txt)" --output-format json --dangerously-skip-permissions --bare --no-session-persistence`,
      ]);
    });

    it("parameterises the prompt path through to the `$(cat ...)` substitution", () => {
      // Different prompt path → different `$(cat <path>)` substitution.
      // Guards against a future refactor that accidentally hardcodes
      // `/march/prompt.txt` inside the implementation instead of using the
      // argument, which would silently break the Feature 3 migration that
      // expects `buildEntrypoint` to be a pure function of its input.
      const argv = claudeCodeBackend.buildEntrypoint("/some/other/path");
      expect(argv).toHaveLength(3);
      expect(argv[0]).toBe("sh");
      expect(argv[1]).toBe("-c");
      expect(argv[2]).toContain("$(cat /some/other/path)");
      expect(argv[2]).not.toContain("/march/prompt.txt");
    });
  });
});
