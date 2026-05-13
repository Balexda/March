import { describe, it, expect, afterEach } from "vitest";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PromptSourceError,
  resolveRawPrompt,
  type RawPromptSource,
} from "./prompt-source.js";

/**
 * Tests for the prompt-source module — the prompt-ingestion layer that
 * resolves `march spawn dispatch`'s raw prompt from one of three operator
 * sources with the precedence `--prompt-file` > `--prompt` > stdin.
 *
 * All tests exercise real temp files for the file-source path and a
 * `node:stream`-based `Readable` for stdin injection — no mocking of
 * module internals.
 */

describe("prompt-source", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-prompt-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  /**
   * Build a `Readable` stream that emits the given chunks and closes,
   * mimicking a piped stdin (non-TTY, finite buffer).
   */
  function fakeStdin(chunks: string[]): NodeJS.ReadableStream {
    return Readable.from(chunks);
  }

  describe("--prompt-file source", () => {
    it("reads file contents as the raw prompt", async () => {
      const dir = makeTmpDir();
      const promptPath = path.join(dir, "prompt.txt");
      fs.writeFileSync(promptPath, "Implement the login page.");

      const result: RawPromptSource = await resolveRawPrompt({
        promptFile: promptPath,
      });

      expect(result.source).toBe("prompt-file");
      expect(result.prompt).toBe("Implement the login page.");
    });

    it("preserves multi-line file contents verbatim", async () => {
      const dir = makeTmpDir();
      const promptPath = path.join(dir, "prompt.txt");
      const content = "Line one\nLine two\nLine three\n";
      fs.writeFileSync(promptPath, content);

      const result = await resolveRawPrompt({ promptFile: promptPath });

      expect(result.prompt).toBe(content);
    });
  });

  describe("--prompt source", () => {
    it("returns inline prompt when only `prompt` is set", async () => {
      const result = await resolveRawPrompt({ prompt: "do the thing" });

      expect(result.source).toBe("prompt");
      expect(result.prompt).toBe("do the thing");
    });
  });

  describe("stdin source", () => {
    it("reads stdin contents when neither flag is set and stdin is piped", async () => {
      const stdin = fakeStdin(["raw piped prompt"]);
      const result = await resolveRawPrompt({
        stdin,
        isTTY: false,
      });

      expect(result.source).toBe("stdin");
      expect(result.prompt).toBe("raw piped prompt");
    });

    it("concatenates chunks emitted by stdin in order", async () => {
      const stdin = fakeStdin(["chunk one ", "chunk two"]);
      const result = await resolveRawPrompt({
        stdin,
        isTTY: false,
      });

      expect(result.prompt).toBe("chunk one chunk two");
    });
  });

  describe("precedence", () => {
    it("prefers --prompt-file over --prompt and stdin", async () => {
      const dir = makeTmpDir();
      const promptPath = path.join(dir, "prompt.txt");
      fs.writeFileSync(promptPath, "from file");
      const stdin = fakeStdin(["from stdin"]);

      const result = await resolveRawPrompt({
        promptFile: promptPath,
        prompt: "from inline",
        stdin,
        isTTY: false,
      });

      expect(result.source).toBe("prompt-file");
      expect(result.prompt).toBe("from file");
    });

    it("prefers --prompt over stdin when --prompt-file is absent", async () => {
      const stdin = fakeStdin(["from stdin"]);

      const result = await resolveRawPrompt({
        prompt: "from inline",
        stdin,
        isTTY: false,
      });

      expect(result.source).toBe("prompt");
      expect(result.prompt).toBe("from inline");
    });
  });

  describe("error: missing/unreadable prompt file", () => {
    it("throws PromptSourceError with exitCode 1 when the file does not exist", async () => {
      const dir = makeTmpDir();
      const missingPath = path.join(dir, "nope.txt");

      await expect(
        resolveRawPrompt({ promptFile: missingPath }),
      ).rejects.toMatchObject({
        name: "PromptSourceError",
        exitCode: 1,
      });
    });

    it("error message mentions 'not found or not readable' for a missing file", async () => {
      const dir = makeTmpDir();
      const missingPath = path.join(dir, "nope.txt");

      try {
        await resolveRawPrompt({ promptFile: missingPath });
        // If we reach here the test must fail — we expected a throw.
        expect.fail("resolveRawPrompt should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PromptSourceError);
        expect((err as PromptSourceError).message).toContain(
          "not found or not readable",
        );
        expect((err as PromptSourceError).exitCode).toBe(1);
      }
    });
  });

  describe("error: no source provided", () => {
    it("throws PromptSourceError with exitCode 2 when no flags and stdin is a TTY", async () => {
      await expect(
        resolveRawPrompt({ isTTY: true }),
      ).rejects.toMatchObject({
        name: "PromptSourceError",
        exitCode: 2,
      });
    });

    it("throws PromptSourceError with exitCode 2 when no flags and piped stdin is empty", async () => {
      const stdin = fakeStdin([""]);

      await expect(
        resolveRawPrompt({ stdin, isTTY: false }),
      ).rejects.toMatchObject({
        name: "PromptSourceError",
        exitCode: 2,
      });
    });

    it("throws PromptSourceError with exitCode 2 when no inputs at all are supplied", async () => {
      await expect(resolveRawPrompt({})).rejects.toMatchObject({
        name: "PromptSourceError",
        exitCode: 2,
      });
    });
  });
});
