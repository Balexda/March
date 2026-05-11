# Snippets

Shared content fragments injected into `CLAUDE.prompt` and the per-skill
`SKILL.prompt` files via Dotprompt's Handlebars partials. These are **not**
deployed as standalone files — they are resolved at deploy time by `march
legate init` into the rendered output.

## How partials work

In any `.prompt` file, use `{{>partial-name}}` to include a snippet.
Dotprompt resolves the partial by looking up `snippets/<partial-name>.md`
and inlining its contents. The snippet file itself is never copied to the
conductor's home dir; only the rendered output is.

This mirrors the convention SmithyCli uses for its own agent-skill templates.

## Current snippets

| Snippet | Used by |
|---|---|
| `state-json-schema.md` | CLAUDE.prompt, legate.resume, legate.babysit, legate.cleanup, legate.dispatch (universal contract) |
| `status-grammar.md` | CLAUDE.prompt (universal worker-state vocabulary) |
| `escalation-grammar.md` | CLAUDE.prompt (the `[STATUS]` reply format with AUTO:/NEED: lines) |
| `auto-mode-rules.md` | CLAUDE.prompt (tool calls the loop will never produce) |
| `boundaries.md` | CLAUDE.prompt (universal hard rules — no push to main, no merge, etc.) |
| `fix-msg-via-file.md` | legate.babysit (the Write-then-send-to-worker pattern for `/smithy.fix`) |
| `verification-rule.md` | legate.babysit (next-heartbeat verification after any action) |

## Adding a snippet

1. Drop a `<name>.md` in this dir.
2. Reference it from one or more `.prompt` files as `{{>name}}`.
3. Update the table above.
4. Run `npm test` — the integration test that renders every template should
   exercise your snippet via at least one consumer.
