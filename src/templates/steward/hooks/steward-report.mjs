#!/usr/bin/env node
// Steward self-report hook (March #371 — "Steward self-report — P3").
//
// Runs on Claude Code `Notification` and `Stop` events inside a steward
// (Hatchery "manager") session. It reads the steward's last message from the
// transcript, best-effort classifies its state, and POSTs a steward-report to
// Herald's `POST /steward-report` so the legate can escalate a steward that is
// parked awaiting a human (the failure mode #369 was built to surface).
//
// This file is SELF-CONTAINED and shipped verbatim into
// `~/.march/steward/hooks/` (see `src/castra/steward-skills.ts`). It runs under
// a plain `node` with NO March imports. It is wired by the generated
// `~/.march/steward/settings.json`, which the steward loads via
// `claude --settings` (added to `buildLaunchArgs`).
//
// The slice id / profile / Herald URL the report needs are written per-session
// by Castra at launch into `<root>/sessions/<worktree-dir>.json`; the hook
// echoes them back. Keyed by the session's working directory (the hook's `cwd`,
// which for a steward is its worktree), so no env-var propagation through
// agent-deck/tmux is required.
//
// BEST-EFFORT THROUGHOUT: a steward turn must never fail because of this hook,
// so every path resolves to exit 0 and all I/O is wrapped.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Cap a free-text summary so the report body stays small. */
export function clampSummary(text, max = 500) {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

/**
 * Extract the last assistant message from a Claude Code transcript (JSONL, one
 * record per line). Returns the concatenated text and whether that message
 * issued an `AskUserQuestion` tool call (the strongest "awaiting input" signal).
 * Tolerant of partial/garbage lines — they are skipped.
 */
export function extractLastAssistantMessage(transcriptText) {
  const lines = String(transcriptText ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const message = rec?.message ?? rec;
    const role = message?.role ?? rec?.role ?? rec?.type;
    if (role !== "assistant") continue;
    const content = message?.content;
    let text = "";
    let usedAskUserQuestion = false;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          usedAskUserQuestion = true;
        }
      }
      text = parts.join("\n");
    }
    return { text: text.trim(), usedAskUserQuestion };
  }
  return null;
}

const PR_URL_RE = /\bPR:\s*<?(https?:\/\/\S+?)>?\s*$/im;
const GH_PR_URL_RE = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;
// Phrases that mark a steward parked on a human decision even without a literal
// "?" — the steward-pr skill mandates a `NEED:` line for escalations.
const AWAITING_RE =
  /\bNEED:|\bchoose\b|which option|should i\b|would you like|let me know|waiting for|awaiting (?:your )?(?:input|response|decision|confirmation)|unable to proceed|can'?t proceed|blocked on|need your|please (?:confirm|advise|decide|clarify)/i;

/** Does the message's last non-empty line end with a question mark? */
function endsWithQuestion(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.endsWith("?");
}

/**
 * Best-effort classification of a steward's last message into a steward-report.
 *
 * Classification is driven by the steward's *actions in the transcript*, NOT by
 * which hook event fired. Claude Code's `Notification` fires both on a genuine
 * prompt AND on a ~60s idle timeout — including on a steward that has *finished*
 * and gone idle — so the event alone is not evidence of awaiting input. Treating
 * every `Notification` as `awaiting_input` was the dominant false-positive source
 * (a finished "PR opened, standing by" steward idles → `Notification` → escalated
 * as steward-stuck; see the escalation audit / #459). We instead read the last
 * assistant message and key off what the steward actually did:
 *
 * - `awaiting_input` — the steward invoked `AskUserQuestion` (the unambiguous
 *   "asking the user" action), or emitted a `NEED:` escalation / decision-request
 *   phrase / trailing question.
 * - `reported`   — the message carries a PR URL (`PR: <url>` or a github pull
 *   link); the steward finished and opened the PR.
 * - `working`    — substantive progress text that is none of the above; reported
 *   so a prior `awaiting_input` escalation clears.
 *
 * Anything we cannot read (no message) → `{ classified: false }` with no status,
 * leaving it for the local classifier (#459). A `Notification` with no readable
 * transcript message is likewise left unclassified rather than asserting
 * awaiting_input — we have no evidence the steward is parked vs merely idle.
 * `eventName` is intentionally not consulted for the status decision.
 * Returns the POST body fields.
 */
export function classify(message, eventName) {
  void eventName; // deliberately not used: the event does not determine status.

  if (!message || !message.text) {
    // No readable transcript message. We cannot tell a parked steward from a
    // finished-then-idle one (both fire `Notification`), so do not assert
    // awaiting_input — leave it for the local classifier (#459).
    return { classified: false };
  }
  const text = message.text;

  // Strongest deterministic signal: the steward actually invoked AskUserQuestion.
  // An unambiguous "asking the user" action, independent of prose or hook event.
  if (message.usedAskUserQuestion) {
    return { status: "awaiting_input", summary: clampSummary(text), classified: true };
  }

  // A PR URL means the steward finished and opened the PR.
  const prMatch = text.match(PR_URL_RE) ?? text.match(GH_PR_URL_RE);
  if (prMatch) {
    return { status: "reported", summary: clampSummary(prMatch[1] ?? prMatch[0]), classified: true };
  }

  // A structured escalation (`NEED:` per the steward-pr skill), a decision-request
  // phrase, or a trailing question — the steward wants a human.
  if (AWAITING_RE.test(text) || endsWithQuestion(text)) {
    return { status: "awaiting_input", summary: clampSummary(text), classified: true };
  }

  // Substantive final message that is neither a PR report nor an ask: treat as
  // progress so any stale awaiting_input escalation clears on the fold.
  return { status: "working", summary: clampSummary(text, 200), classified: true };
}

/** Resolve `<root>` (the steward dir) from this script's location (`<root>/hooks`). */
export function stewardRootFromHook(scriptPath) {
  return path.dirname(path.dirname(scriptPath));
}

/**
 * Per-session sidecar path Castra writes at launch. Keyed by a hash of the FULL
 * (resolved) worktree path so it can't collide across repos/profiles that
 * launch the same branch name. MUST stay byte-identical to Castra's
 * `stewardSessionFilePath` (`src/castra/steward-skills.ts`) — both derive the
 * key from the worktree path they share (Castra's launch `worktreePath`, the
 * hook's `cwd`).
 */
export function sessionFileFor(root, cwd) {
  const resolved = path.resolve(cwd || "");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return path.join(root, "sessions", `${path.basename(resolved)}-${hash}.json`);
}

// ---------------------------------------------------------------------------
// runtime (only when invoked directly, not when imported by tests)
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

async function postReport(heraldUrl, body) {
  const base = String(heraldUrl ?? "").replace(/\/+$/, "");
  if (!base) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${base}/steward-report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Best-effort: Herald unreachable / aborted — nothing more we can do.
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const input = (() => {
    try {
      return JSON.parse(readStdin());
    } catch {
      return {};
    }
  })();

  const eventName = input.hook_event_name ?? input.hookEventName ?? "";
  const cwd = input.cwd ?? process.cwd();

  const root = stewardRootFromHook(fileURLToPath(import.meta.url));
  const session = readJsonFile(sessionFileFor(root, cwd));
  // Without the launch-time sidecar we have no slice id to tag the report, so
  // there is nothing useful to send. Exit quietly.
  if (!session || !session.profile || !session.sliceId) return;

  const transcriptPath = input.transcript_path ?? input.transcriptPath ?? "";
  let message = null;
  if (transcriptPath) {
    try {
      message = extractLastAssistantMessage(fs.readFileSync(transcriptPath, "utf-8"));
    } catch {
      message = null;
    }
  }

  const result = classify(message, eventName);
  const body = {
    profile: session.profile,
    sliceId: session.sliceId,
    classified: result.classified,
    ...(result.status ? { status: result.status } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
  };

  await postReport(session.heraldUrl, body);
}

const invokedDirectly =
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // Never let a hook failure surface to the steward — swallow and exit 0.
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
