#!/usr/bin/env node
// Smithy session-title hook for Claude Code.
//
// Wired into .claude/settings.json as a UserPromptSubmit hook by `smithy init`.
// On every user prompt that starts with `/smithy.<cmd>`, derive a short session
// title (slug + command + IDs) and emit it as `sessionTitle`. For non-smithy
// prompts, exits silently. Any error path also exits silently so this hook
// never blocks a user prompt.

import { pathToFileURL } from 'node:url';

const SMITHY_PREFIX = /^\/smithy\.([a-z][a-z0-9-]*)\b/i;

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? '0' + s : s;
}

// Try to extract slug + numeric IDs from the argument string of a smithy command.
function parseArgs(cmd, rest) {
  let slug;
  let storyNum;
  let sliceNum;

  // Tasks file pattern: <NN>-<slug>.tasks.md (anywhere in path)
  const tasksMatch = rest.match(/(?:^|[\s/])(\d{1,3})-([a-z0-9][a-z0-9-]*)\.tasks\.md\b/i);
  if (tasksMatch) {
    storyNum = pad2(parseInt(tasksMatch[1], 10));
    slug = tasksMatch[2];
  }

  // Strike file pattern: <slug>.strike.md
  if (!slug) {
    const strikeMatch = rest.match(/(?:^|[\s/])([a-z0-9][a-z0-9-]*)\.strike\.md\b/i);
    if (strikeMatch) {
      slug = strikeMatch[1];
    }
  }

  // Spec folder pattern: specs/<YYYY>-<MM>-<DD>-<NNN>-<slug>
  if (!slug) {
    const specMatch = rest.match(/specs?\/\d{4}-\d{2}-\d{2}-\d{3}-([a-z0-9][a-z0-9-]*)/i);
    if (specMatch) {
      slug = specMatch[1];
    }
  }

  // Quoted-string fallback: first quoted run, take its first word
  if (!slug) {
    const quoted = rest.match(/["']([^"']+)["']/);
    if (quoted) {
      const firstQuotedWord = quoted[1].trim().split(/\s+/)[0];
      if (firstQuotedWord) slug = firstQuotedWord;
    }
  }

  // First non-flag, non-numeric token fallback
  if (!slug) {
    const firstWord = rest.trim().split(/\s+/)[0];
    if (firstWord && !firstWord.startsWith('-') && /[a-z]/i.test(firstWord)) {
      const last = firstWord.split('/').filter(Boolean).pop() || firstWord;
      slug = last.replace(/\.[^.]+$/, '').replace(/^\d+-/, '');
    }
  }

  // Trailing bare integer: slice number for forge, story number for cut
  const trailingInt = rest.match(/(?:^|\s)(\d{1,3})\s*$/);
  if (trailingInt) {
    const n = pad2(parseInt(trailingInt[1], 10));
    if (cmd === 'forge') {
      sliceNum = n;
    } else if (cmd === 'cut' && !storyNum) {
      storyNum = n;
    }
  }

  return { slug, storyNum, sliceNum };
}

/**
 * Derive a Claude Code session title from a user prompt.
 * Returns null if the prompt is not a `/smithy.<cmd>` invocation.
 *
 * @param {string} prompt
 * @param {{ branch?: string }} [options]
 * @returns {string | null}
 */
export function deriveTitle(prompt, options = {}) {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  const match = trimmed.match(SMITHY_PREFIX);
  if (!match) return null;

  const cmd = match[1].toLowerCase();
  const rest = trimmed.slice(match[0].length).trim();

  const { slug, storyNum, sliceNum } = parseArgs(cmd, rest);

  // Build the display slug: take the first dash/space-separated segment, capitalize.
  let display = '';
  if (slug) {
    display = capitalize(slug.split(/[-\s]/)[0]);
  }
  if (!display && options.branch) {
    const branchTail = options.branch.split(/[/_-]/).pop() || '';
    display = capitalize(branchTail);
  }
  if (!display) {
    display = 'Smithy';
  }

  const numbers = [storyNum, sliceNum].filter(Boolean).join(' ');
  return [display, cmd, numbers].filter(Boolean).join(' ');
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
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
