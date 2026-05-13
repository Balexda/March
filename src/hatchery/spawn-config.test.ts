import { describe, it, expect } from "vitest";
import { BASE_IMAGE, SPAWN_CONFIG, type SpawnConfig } from "./spawn-config.js";

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
    it("points direct Dockerfile helper calls at the default Claude backend image", () => {
      expect(BASE_IMAGE).toBe("march-spawn-claude:latest");
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

  });
});
