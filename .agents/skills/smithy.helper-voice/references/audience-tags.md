# Audience tag grammar

The `<!-- audience: ... -->` syntax Smithy templates use to declare a
section's voice spec. Read this file when you are writing a tag, editing a
template's tags, or checking an artifact's tags against the lint. The
policy for *where* tags live is in `SKILL.md` §8.

Grammar (the syntax templates use):

```
## <Section title>
<!-- audience: <role>[+ai-input]; mode: <mode>; length: <budget>; diagram: <required|recommended|optional>; examples: <required|recommended|discouraged|forbidden>[; applicability: <free-text>] -->
```

Keys:

- `audience` — `stakeholder` | `reviewer` | `builder`. Append
  `+ai-input` when a sub-agent is the primary consumer
  (e.g., `builder+ai-input`).
- `mode` — `explanation` | `reference` | `how-to` | `tutorial`.
- `length` — sentence or paragraph budget (`2-3 sentences`,
  `3-6 paragraphs`, `tables only`, `5-15 steps`).
- `diagram` — `required` | `recommended` | `optional`.
- `examples` — `required` | `recommended` | `discouraged` | `forbidden`.
- `applicability` (optional) — free-text condition under which the
  section legitimately resolves to `N/A` (e.g., `code-shaped features
  only`).

Example — the `## Summary` section's voice spec, as it would appear
in a `.spec.md` template (and as the audit command would cite it in a
finding):

```
## Summary
<!-- audience: stakeholder; mode: explanation; length: 2-3 sentences; diagram: optional; examples: discouraged -->
```

`smithy.audit` enforces these specs per section via its voice-tag lint
(`snippets/audit-checklist-voice.md`): it parses the tags and flags
unknown keys/values, length-budget violations, and missing/forbidden
diagrams and examples. The lint currently carries the per-section specs
directly; as the template surface is wired through it will read them from
the same template files, keeping the enforcement surface and the
templates in lockstep.
