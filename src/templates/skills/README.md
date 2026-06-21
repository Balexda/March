# `march.*` skill sources (dotprompt)

The shared `march.*` skills are authored **once** here as
[dotprompt](https://github.com/google/dotprompt) sources and **generated** into
one variant per execution context. The same skill runs in places that reach the
stack by different addresses, so the service URLs (and the `march` CLI
invocation) are **baked at generation time** — there is no runtime
"am I in a container?" detection in the shipped scripts (issue #424; this
supersedes the stopgap that detected context in `lib.sh`).

This mirrors the legate-template pipeline (`src/templates/legate/*.prompt`
rendered by `src/legate/init.ts`), reusing the `dotprompt` dependency the repo
already ships.

## Layout

```
src/templates/skills/
├── README.md                      # this file
├── snippets/                      # shared handlebars partials ({{>name}})
│   └── service-addressing.md
└── <skill>/                       # one dir per skill, e.g. march.debug/
    ├── SKILL.prompt               # → SKILL.md   (frontmatter is rendered too)
    └── scripts/
        ├── lib.sh.prompt          # → lib.sh     (URLs/CLI baked per context)
        ├── *.sh                   # copied verbatim (context-neutral)
        └── fixtures/**            # copied verbatim (self-test data)
```

Authoring rules:

- A file ending in `.prompt` is rendered through dotprompt; everything else is
  copied verbatim. `SKILL.prompt` → `SKILL.md`; `lib.sh.prompt` → `lib.sh`.
- Templates use Handlebars: `{{VAR}}` / `{{{VAR}}}` (triple = no HTML-escape, use
  it for URLs), `{{#if IS_CONTAINER}}…{{/if}}` conditionals, and `{{>partial}}`
  includes resolved from `snippets/`.
- Keep per-context values out of the `*.sh` scripts: put them in `lib.sh.prompt`
  (defaults the scripts source) so each script stays a verbatim copy.

## Generating

```bash
npm run skills:generate     # standalone
npm run build               # also runs it (so committed variants stay fresh)
```

Output variants (see `CONTEXTS` in [`scripts/generate-skills.mjs`](../../../scripts/generate-skills.mjs)):

| Context | Output | Addressing | Consumer |
|---|---|---|---|
| `repo` | `.claude/skills/` (committed) | `localhost` (compose-published ports) | march repo / host operator shell |
| `castra` | `dist/skills/castra/` (gitignored build dir) | docker-network service hostnames (`http://herald:8818`, …) | in-container sessions: the legate agent, stewards, agent-deck |

The `repo` variant is regenerated on every build and checked in, so a source
change just shows up as a normal diff. The `castra` variant lands in the build
dir for the hatchery/Castra images to bundle. An explicit `MARCH_*_URL` env var
still overrides the baked default in any variant.

## Verifying a skill

Each skill ships a fixture-backed self-test that needs no running stack:

```bash
bash .claude/skills/march.debug/scripts/tests.sh                 # repo variant
bash dist/skills/castra/march.debug/scripts/tests.sh             # castra variant
```

The generator itself is unit-tested in
[`scripts/generate-skills.test.mjs`](../../../scripts/generate-skills.test.mjs).
