import fs from "node:fs";

/**
 * The prompt-ingestion module for `march spawn dispatch`.
 *
 * Resolves the operator's raw prompt from one of three sources with the
 * precedence defined by the spawn-dispatch contracts' `march spawn dispatch`
 * Inputs table:
 *
 *   `--prompt-file` > `--prompt` > stdin
 *
 * Resolution failures map to the contracts' Error Conditions table:
 * - Missing / unreadable prompt file → exit code 1 with the message
 *   "prompt file not found or not readable".
 * - Absence of all three sources (or piped stdin closes empty, or stdin is
 *   a TTY with no flag set) → exit code 2 (usage error). Per SD-005 we
 *   treat TTY stdin as a usage error rather than block on a blank
 *   operator-facing prompt.
 *
 * The module is consumed by `src/cli.ts`'s dispatch action and is exercised
 * in isolation by `prompt-source.test.ts`. It is intentionally pure with
 * respect to its inputs: filesystem reads are unavoidable for
 * `--prompt-file`, and the stdin stream is dependency-injected, so the test
 * surface uses real temp files and a `Readable.from(...)` fake stream — no
 * mocking of module internals.
 */

/**
 * Origin of a resolved raw prompt. Mirrors the three sources defined in the
 * contracts' `march spawn dispatch` Inputs table.
 */
export type PromptSourceKind = "prompt-file" | "prompt" | "stdin";

/**
 * Resolved raw prompt plus its origin. Returned by {@link resolveRawPrompt}
 * on success.
 */
export interface RawPromptSource {
  /** Which of the three sources produced this prompt. */
  source: PromptSourceKind;
  /** The operator's raw prompt text, verbatim, with no finalization. */
  prompt: string;
}

/**
 * Options accepted by {@link resolveRawPrompt}. `stdin` and `isTTY` are
 * dependency-injected so the unit tests can exercise the stdin branch
 * against a `Readable.from(...)` fake without touching `process.stdin`.
 */
export interface ResolveRawPromptOptions {
  /** Path supplied via `--prompt-file <path>`. Takes precedence over all other sources. */
  promptFile?: string;
  /** Inline string supplied via `--prompt <string>`. Takes precedence over stdin. */
  prompt?: string;
  /** Stream to read piped prompt content from. Defaults to {@link process.stdin}. */
  stdin?: NodeJS.ReadableStream;
  /**
   * Whether the stdin stream is attached to a TTY. When neither flag is
   * supplied and `isTTY` is true, we surface a usage error rather than
   * block on operator input — matching US1's fail-fast behavior (SD-005).
   */
  isTTY?: boolean;
}

/**
 * Error thrown by {@link resolveRawPrompt} when the operator's prompt
 * cannot be resolved. The {@link exitCode} field carries the process exit
 * code the dispatch action should set on the failure path:
 *
 * - `1` — missing or unreadable prompt file (contracts' Error Conditions
 *   row "Prompt file not found or not readable").
 * - `2` — no prompt source provided (contracts' Error Conditions row
 *   "No prompt provided" — usage error).
 *
 * Callers (`src/cli.ts`'s dispatch action) detect this error via
 * `err instanceof PromptSourceError`, route its message to stderr, and
 * map `exitCode` to the process exit code via the standard
 * {@link ERROR}/{@link USAGE_ERROR} constants from `./exit-codes.js`.
 */
export class PromptSourceError extends Error {
  public readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.name = "PromptSourceError";
    this.exitCode = exitCode;
  }
}

/**
 * Read a `Readable` stream to end and return its contents as a UTF-8 string.
 * Uses the async-iterator protocol so listeners are attached and detached by
 * the Node runtime automatically — no manual `removeListener` cleanup needed,
 * no risk of listener accumulation if the same stream is reused, and stream
 * errors propagate as rejections directly.
 */
async function readStreamToString(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Resolve the operator's raw prompt from one of three sources.
 *
 * Precedence: `promptFile` > `prompt` > `stdin`. The first source that is
 * present wins; later sources are ignored even if non-empty.
 *
 * @throws {PromptSourceError} with `exitCode: 1` when `promptFile` is
 *   provided but the file is missing or unreadable.
 * @throws {PromptSourceError} with `exitCode: 2` when no source is provided,
 *   or when the only available source is a TTY-attached stdin (which would
 *   block forever waiting for operator input), or when piped stdin closes
 *   without emitting any data.
 */
export async function resolveRawPrompt(
  opts: ResolveRawPromptOptions,
): Promise<RawPromptSource> {
  // 1. --prompt-file wins outright. Resolution failure here is a hard
  //    error with exitCode 1 per the contracts' Error Conditions table,
  //    NOT a fallthrough to --prompt or stdin: passing a path the operator
  //    cannot read is unambiguously a configuration mistake we should
  //    surface immediately, not paper over by silently using a different
  //    source.
  if (opts.promptFile !== undefined) {
    let contents: string;
    try {
      contents = fs.readFileSync(opts.promptFile, "utf-8");
    } catch {
      throw new PromptSourceError(
        `prompt file not found or not readable: ${opts.promptFile}`,
        1,
      );
    }
    return { source: "prompt-file", prompt: contents };
  }

  // 2. --prompt is the next precedence step. An empty string is still a
  //    valid (if unusual) prompt — the operator explicitly opted into it.
  if (opts.prompt !== undefined) {
    return { source: "prompt", prompt: opts.prompt };
  }

  // 3. stdin is the final fallback. If stdin is attached to a TTY there is
  //    no piped input available; blocking on a `read` call would hang the
  //    dispatch waiting on operator input that the contract does not
  //    accept — surface a usage error instead (SD-005, matches US1's
  //    fail-fast behavior for the update downgrade flow).
  if (opts.isTTY) {
    throw new PromptSourceError(
      "no prompt source provided: pass --prompt-file <path>, --prompt <string>, or pipe a prompt to stdin",
      2,
    );
  }

  if (opts.stdin === undefined) {
    throw new PromptSourceError(
      "no prompt source provided: pass --prompt-file <path>, --prompt <string>, or pipe a prompt to stdin",
      2,
    );
  }

  const stdinContents = await readStreamToString(opts.stdin);
  if (stdinContents.length === 0) {
    // Piped stdin closed without emitting any data — per the spec edge
    // case, treat this as "no source provided" rather than silently
    // dispatching with an empty prompt.
    throw new PromptSourceError(
      "no prompt source provided: pass --prompt-file <path>, --prompt <string>, or pipe a prompt to stdin",
      2,
    );
  }

  return { source: "stdin", prompt: stdinContents };
}
