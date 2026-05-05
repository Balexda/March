#!/usr/bin/env node
// Smithy session-title hook for Claude Code.
//
// Wired into .claude/settings.json as a UserPromptSubmit hook by `smithy init`.
// On every user prompt that starts with `/smithy.<cmd>` for an artifact-producing
// command AND carries a recognizable artifact path, derive a kebab-case session
// title (`<parent-slug>-<cmd>[-<n>[-<m>]]`) and emit it as `sessionTitle`. For
// non-rename commands, description-only invocations, or non-smithy prompts, exit
// silently so Claude Code's own auto-naming stays in charge. Any error path also
// exits silently — this hook never blocks a user prompt.

import { pathToFileURL } from 'node:url';

const SMITHY_PREFIX = /^\/smithy\.([a-z][a-z0-9-]*)\b/i;
const RENAME_COMMANDS = new Set(['spark', 'ignite', 'mark', 'cut', 'forge', 'strike', 'render']);

// Path-shape regexes. Each captures the human-readable slug AFTER any
// date/uniqueness prefix, and keeps multi-word kebab slugs whole.
const SPEC_FOLDER_RE   = /specs?\/\d{4}-\d{2}-\d{2}-\d{3}-([a-z0-9][a-z0-9-]*)/i;
const PRD_RFC_FOLDER_RE = /docs\/(?:prds|rfcs)\/\d{4}-\d{3}-([a-z0-9][a-z0-9-]*)/i;
const TASKS_FILE_RE    = /(?:^|[\s/])(\d{1,3})-([a-z0-9][a-z0-9-]*)\.tasks\.md\b/i;
const FEATURES_FILE_RE = /(?:^|[\s/])\d{1,3}-([a-z0-9][a-z0-9-]*)\.features\.md\b/i;
// Strike files live at specs/strikes/YYYY-MM-DD-<slug>.strike.md (per smithy.strike).
// The date prefix is optional — bare `<slug>.strike.md` is also accepted.
const STRIKE_FILE_RE   = /(?:^|[\s/])(?:\d{4}-\d{2}-\d{2}-)?([a-z][a-z0-9-]*)\.strike\.md\b/i;
const TRAILING_INT_RE  = /(?:^|\s)(\d{1,3})\s*$/;

function trailingInt(rest) {
  const m = rest.match(TRAILING_INT_RE);
  return m ? String(parseInt(m[1], 10)) : null;
}

function joinTitle(parts) {
  return parts.filter(p => p !== null && p !== undefined && p !== '').join('-');
}

/**
 * Derive a Claude Code session title from a user prompt.
 * Returns null when the prompt should not trigger a rename.
 *
 * @param {string} prompt
 * @returns {string | null}
 */
export function deriveTitle(prompt) {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  const match = trimmed.match(SMITHY_PREFIX);
  if (!match) return null;

  const cmd = match[1].toLowerCase();
  if (!RENAME_COMMANDS.has(cmd)) return null;

  const rest = trimmed.slice(match[0].length).trim();
  if (!rest) return null;

  const tasks    = rest.match(TASKS_FILE_RE);
  const features = rest.match(FEATURES_FILE_RE);
  const strike   = rest.match(STRIKE_FILE_RE);
  const spec     = rest.match(SPEC_FOLDER_RE);
  const prdRfc   = rest.match(PRD_RFC_FOLDER_RE);
  const tail     = trailingInt(rest);

  // Per-command format-by-shape table.
  switch (cmd) {
    case 'forge': {
      // Tasks file: <spec-slug>-forge-<storyN>[-<sliceN>]
      if (tasks && spec) {
        const storyN = String(parseInt(tasks[1], 10));
        return joinTitle([spec[1], 'forge', storyN, tail]);
      }
      // Strike file: <strike-slug>-forge
      if (strike) return joinTitle([strike[1], 'forge']);
      return null;
    }

    case 'cut': {
      // Spec folder + optional trailing story number.
      if (spec) return joinTitle([spec[1], 'cut', tail]);
      return null;
    }

    case 'mark': {
      // Features file + optional trailing feature number takes precedence.
      if (features) return joinTitle([features[1], 'mark', tail]);
      // Plain RFC path → <rfc-slug>-mark.
      if (prdRfc) return joinTitle([prdRfc[1], 'mark']);
      return null;
    }

    case 'render': {
      // A features.md path lives inside an RFC folder and matches both regexes;
      // prefer the features-file slug so Phase-0 review titles use the feature
      // map (`core-render`) rather than the parent RFC (`foo-render`).
      if (features) return joinTitle([features[1], 'render', tail]);
      if (prdRfc) return joinTitle([prdRfc[1], 'render', tail]);
      return null;
    }

    case 'ignite':
    case 'spark': {
      // Phase-0 review of an existing PRD/RFC: <slug>-<cmd>.
      if (prdRfc) return joinTitle([prdRfc[1], cmd]);
      return null;
    }

    case 'strike': {
      // Phase-0 review of an existing strike file: <slug>-strike.
      if (strike) return joinTitle([strike[1], 'strike']);
      return null;
    }

    default:
      return null;
  }
}

// --- main: read stdin JSON, emit sessionTitle if applicable ---
async function main() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
    }
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    const title = deriveTitle(data.prompt);
    if (!title) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        sessionTitle: title,
      },
    }));
  } catch {
    // Silent — never block a user prompt.
  }
}

// Run main only when executed directly (not when imported by tests).
let isMain = false;
try {
  isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
} catch {
  isMain = false;
}
if (isMain) {
  await main();
}
