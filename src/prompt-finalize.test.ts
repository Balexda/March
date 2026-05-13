import { describe, it, expect } from "vitest";
import { finalizePrompt } from "./prompt-finalize.js";
import { CONTAINER_WORKDIR } from "./spawn-config.js";

/**
 * Tests for the prompt-finalize module.
 *
 * `finalizePrompt` is a pure helper that prepends a 2-line header
 * (Spawn ID + Working Directory) and a blank separator line to the
 * operator's raw prompt. SD-001 from the US6 slice 1 tasks file pins
 * the exact format, so these asserts are intentionally precise — any
 * drift in the header format would silently change what the backend
 * CLI sees and require a downstream coordination dance to fix.
 */

describe("prompt-finalize", () => {
  describe("finalizePrompt", () => {
    it("returns a string that contains the raw prompt verbatim (AS 6.3)", () => {
      const raw = "Fix the failing snapshot tests in src/snapshot.test.ts";
      const got = finalizePrompt({
        rawPrompt: raw,
        spawnId: "20260411-a1b2c3",
      });
      expect(got).toContain(raw);
    });

    it("includes the spawn ID in a `Spawn ID: <id>` header line (AS 6.3)", () => {
      const got = finalizePrompt({
        rawPrompt: "hello",
        spawnId: "20260411-a1b2c3",
      });
      expect(got).toContain("Spawn ID: 20260411-a1b2c3");
    });

    it("defaults `Working Directory:` to CONTAINER_WORKDIR when no override is passed", () => {
      // Single source of truth: the helper must derive its default working
      // directory from `CONTAINER_WORKDIR` in spawn-config.ts so the value
      // cannot drift between the Dockerfile's WORKDIR and the finalized
      // prompt header. AS 6.3 specifies the container working directory.
      const got = finalizePrompt({
        rawPrompt: "hello",
        spawnId: "20260411-a1b2c3",
      });
      expect(got).toContain(`Working Directory: ${CONTAINER_WORKDIR}`);
      expect(got).toContain("Working Directory: /march/workspace");
    });

    it("uses the override `workingDirectory` when one is supplied", () => {
      // Parameter override exists primarily for testability — production
      // call sites are expected to use the default — but the value must
      // still flow through verbatim so a future caller can use it.
      const got = finalizePrompt({
        rawPrompt: "hello",
        spawnId: "20260411-a1b2c3",
        workingDirectory: "/tmp/elsewhere",
      });
      expect(got).toContain("Working Directory: /tmp/elsewhere");
      expect(got).not.toContain("Working Directory: /march/workspace");
    });

    it("emits the exact 4-line format pinned by SD-001 (header / header / blank / raw)", () => {
      // Locks the format defined in SD-001 of the slice 1 tasks file:
      //
      //   Spawn ID: <id>
      //   Working Directory: <workdir>
      //   <blank line>
      //   <raw prompt verbatim>
      //
      // If a reviewer wants a different format, that's a SD-001 conversation
      // with downstream effects on the backend CLI invocation — not a
      // freelance change to this helper.
      const got = finalizePrompt({
        rawPrompt: "do the thing",
        spawnId: "20260411-a1b2c3",
      });
      expect(got).toBe(
        "Spawn ID: 20260411-a1b2c3\n" +
          "Working Directory: /march/workspace\n" +
          "\n" +
          "do the thing",
      );
    });

    it("preserves a multiline raw prompt verbatim (newlines survive into the output)", () => {
      const raw = "line one\nline two\nline three\n";
      const got = finalizePrompt({
        rawPrompt: raw,
        spawnId: "20260411-a1b2c3",
      });
      expect(got).toContain(raw);
      expect(got).toBe(
        "Spawn ID: 20260411-a1b2c3\n" +
          "Working Directory: /march/workspace\n" +
          "\n" +
          raw,
      );
    });

    it("handles an empty raw prompt without dropping the header block", () => {
      // The prompt-source module accepts empty `--prompt ""` as a valid
      // (if unusual) operator opt-in, so the finalize helper must not
      // strip the header when the raw payload is empty — otherwise the
      // backend would receive a blank file and silently misbehave.
      const got = finalizePrompt({
        rawPrompt: "",
        spawnId: "20260411-a1b2c3",
      });
      expect(got).toBe(
        "Spawn ID: 20260411-a1b2c3\n" +
          "Working Directory: /march/workspace\n" +
          "\n",
      );
    });

    it("is pure: identical inputs produce identical output across calls (no clock/uuid leak)", () => {
      // Pure-function contract from the slice 1 acceptance criteria: no
      // filesystem, network, or clock side effects beyond its inputs.
      // Guards against a future refactor that accidentally inlines a
      // timestamp, hostname, or random nonce into the header.
      const input = {
        rawPrompt: "stable input",
        spawnId: "20260411-a1b2c3",
      };
      const a = finalizePrompt(input);
      const b = finalizePrompt(input);
      expect(a).toBe(b);
    });
  });
});
