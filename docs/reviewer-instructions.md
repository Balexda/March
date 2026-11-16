# Reviewer instructions

Automated reviewers read instruction files from this repository as their
prompt. This page says which files exist, who reads them, how they are
layered, how a rule gets added, how CodeRabbit is pointed at the same files,
and how Copilot approvals are switched on.

The layout mirrors SmithyCLI's
([Balexda/SmithyCLI#623](https://github.com/Balexda/SmithyCLI/pull/623)). The
Smithy-general files were copied from there by hand; deploying them through
`smithy init` is tracked in
[Balexda/SmithyCLI#622](https://github.com/Balexda/SmithyCLI/issues/622).

## Who reads what

| Reviewer | Reads |
|----------|-------|
| Copilot code review | `.github/copilot-instructions.md`; every `.github/instructions/*.instructions.md` whose `applyTo` matches a changed file; `.github/skills/*/SKILL.md` on demand; `AGENTS.md` and `CLAUDE.md` |
| Copilot coding agent | The same, minus files marked `excludeAgent: "coding-agent"`; plus `coding-agent.instructions.md` |
| Codex code review | The `## Code Review Rules` section of `AGENTS.md` |
| CodeRabbit | `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md` by its default patterns; every instruction file and skill that `.coderabbit.yaml` maps to a changed file |

Copilot reads these from the pull request's own branch. A change to an
instruction file is therefore reviewed under the changed version, which makes
a rule easy to try and means a pull request can alter its own reviewer.

## Layers

| Layer | Files | Says |
|-------|-------|------|
| Smithy-general | `.github/instructions/smithy.*.instructions.md`, `.github/skills/smithy-*/` | How Smithy artifacts and Smithy-pipeline pull requests work in any repository |
| Repository | Everything else under `.github/instructions/` and `.github/skills/`, and the `AGENTS.md` section | March's own rules |

General-layer files name nothing that exists only in March, so they stay
byte-identical to SmithyCLI's copies. `scripts/reviewer-instructions.test.mjs`
enforces that, along with the shape each reviewer requires, a
4,000-character budget per instruction file, and the CodeRabbit path map.

| File | Applies to | Layer |
|------|------------|-------|
| `smithy.review-stance.instructions.md` | every change | general |
| `smithy.planning-artifacts.instructions.md` | planning artifacts, by suffix | general |
| `planning-artifacts.instructions.md` | `specs/`, `docs/rfcs/` | repository |
| `runtime-source.instructions.md` | `src/**/*.ts`, `scripts/**/*.mjs` | repository |
| `observability.instructions.md` | `src/observability/`, Grafana, the OTLP stack | repository |
| `tests.instructions.md` | test files, `tests/`, the layer runner | repository |
| `contracts.instructions.md` | `docs/subsystems/` | repository |
| `containers.instructions.md` | `docker/`, `.github/workflows/` | repository |
| `templates.instructions.md` | `src/templates/`, generated `march.*` skills | repository |
| `deployed-snapshot.instructions.md` | the manifest-tracked Smithy snapshot | repository |
| `coding-agent.instructions.md` | every change, Copilot coding agent only | repository |
| `smithy-review-planning` skill | on demand | general |
| `march-review-runtime` skill | on demand | repository |

## What goes where

- **Instruction files say how to read.** What the files are, the conventions
  that are not defects, the rules a change can break, and which skill to
  load. They load for every path they match, so they stay short.
- **Skills say how to review.** The procedure and the judgement calls. They
  load on demand.
- **Nothing is stated in both.** A line that fits either belongs in the
  skill.
- **Cite, do not copy.** Philosophy lives in `docs/vision.md` and
  `docs/operating-philosophy.md`; the open/closed line in
  `docs/open-core-boundary.md`; test rules in `docs/testing-strategy.md` and
  `CONTRIBUTING.md`; telemetry in `docs/Observability.md`; contract shape in
  `docs/subsystems/contract-scaffold.md`.

## Adding or changing a rule

A rule earns its place when it traces to something observed: a reviewer
finding declined with a reason, a defect review missed, or a maintainer
comment restating a convention.

1. **Is it mechanical?** Write a test or lint instead.
2. **Is it a durable principle?** Put it in the doc that owns it and cite
   that doc from the instruction file.
3. **Otherwise** add one bullet to the narrowest file that covers it. Say what
   to flag and name the exception.

Phrase a "do not flag" rule as how to weigh a finding, and keep the case that
still deserves a comment.

## Where the first rules came from

A sample of about 250 review threads on 70 merged pull requests (#63 to
#559): a third landed on planning artifacts, just over half on `src/` and
`scripts/`, and none on the Smithy snapshot. About 60 were declined with a
reason. Each rule traces to these pull requests.

| Rule | Evidence |
|------|----------|
| Later-slice work is out of scope; checked boxes are the loop's signal | #502, #347, #348, #361, #415, #531, #474 |
| Moved or parity-preserving code keeps its old bugs | #177, #422, #429, #279 |
| Verify formatting in the raw file (`\|`, `||`, YAML list indent) | #106, #321, #203, #251, #197, #195, #80 |
| Match sibling planning files | #451, #377, #516, #329, #330 |
| Check planning claims against the source; debt over redesign | #534, #535, #540, #509, #387 |
| A tasks file's cross-story dependencies appear in the spec | #511, #534, #329 |
| A documentation slice does not change runtime; the code is the authority | #513, #529, #534 |
| Contracts match wire payloads and current labels | #474, #514 |
| Sessions run in auto permission mode; no skill allowlists | #365 |
| No cache pruning from one profile's path; a reducer overwrite by design | #266, #218 |
| The publish workflow mirrors Smithy's | #80 |
| Verify an API claim before making it | #162, #143, #92, #163 |
| Spans and errored spans with the right failure stage | #350, #540 |
| Metric units, cached instruments, correct PromQL/LogQL | #152, #143, #373 |
| Bounded request logs with no raw URLs | #521 |
| Teardown: 404 is failure, immutable `kind`, validated input, parent lookup | #164, #540 |
| Fail loudly: no silent exit 0, JSON contract on failure, timeouts | #436, #92, #164, #540 |
| Images copy every runtime input; UID/GID and read-only `HOME` | #429, #365, #162, #494 |
| Tag blocks in JSDoc form; quarantine excluded | #421, #330 |
| Per-profile reads pass the profile | #429 |
| Herald forces the legate source and owns sequencing | #415, #177 |
| `src/cli.ts` is only the wrapper | #143 |
| Unrelated commits do not belong in a slice | #433 |

The snapshot rule has no March evidence; it carries over from SmithyCLI and
the `Smithy upgrade` workflow, which produces those pull requests.

## CodeRabbit

CodeRabbit calls files like these *code guidelines*. `.coderabbit.yaml` holds
no rule text. Under `knowledge_base.code_guidelines.filePatterns` it lists
each rule file with the paths that file governs:

```yaml
- files: ".github/instructions/runtime-source.instructions.md"
  applyTo: "src/**/*.ts,scripts/**/*.mjs"
```

- **The map repeats each file's `applyTo`.** By default CodeRabbit applies a
  guideline file to the directory it sits in, which for `.github/instructions/`
  is not the code the rule is about. The entry states the scope instead, in
  the same comma-separated form the frontmatter uses.
- **A skill is mapped like an instruction file.** CodeRabbit finds
  `.github/skills/*/SKILL.md` on its own as an Agent Skill, but with no path
  scope stated, so a skill takes the `applyTo` of the one instruction file
  that sends the reviewer to it.
- **`coding-agent.instructions.md` is not mapped.** It opts out of code review.
- **`AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md` need no
  entry.** CodeRabbit's default patterns find them.
- **A new or rescoped rule file changes the map in the same pull request.**
  The test fails on a missing entry, a drifted `applyTo`, an entry for a file
  that is not a rule file, and inline instruction text such as
  `path_instructions`.

The entries for `smithy.*` and `smithy-*` files are the same in every
repository that uses Smithy.

### Requesting a review

A comment on the pull request starts a review whether or not automatic
reviews are on:

| Comment | Reviews |
|---------|---------|
| `@coderabbitai review` | The commits pushed since CodeRabbit's last review |
| `@coderabbitai full review` | Every file in the pull request, from scratch |

`@coderabbitai configuration` prints the settings in force and which layer
supplied each one. A requested review counts toward the review rate limit.

### Automatic or on demand

`.coderabbit.yaml` sets `inheritance: true` and leaves `reviews.auto_review`
out, so that choice stays in the CodeRabbit app's settings for this
repository. Without `inheritance: true`, a key the file leaves out falls back
to CodeRabbit's schema default, not to the app's settings.

| Option | Setting | Effect |
|--------|---------|--------|
| Automatic | `auto_review.enabled: true`, the schema default | A review when a pull request opens and on each push. Drafts are skipped. Automatic reviews pause after 5 reviewed commits; a comment restarts them. |
| On demand | `auto_review.enabled: false` | A review only on `@coderabbitai review` or `@coderabbitai full review`. |
| By label | `auto_review.enabled: false` with `auto_review.labels: ["<label>"]` | A review when the pull request carries the label, and on a comment. |

CodeRabbit's plans page says a public repository with fewer than 10 stars
gets reviews only on request, whatever this setting says.

Reviews of public repositories are free and carry the knowledge-base features
this map relies on. They are rate-limited per repository, at 1 to 10 reviews
an hour depending on star count. `@coderabbitai rate limit` says whether a
review is available now.

Sources, checked on 2026-11-16: CodeRabbit's
[code guidelines](https://docs.coderabbit.ai/knowledge-base/code-guidelines),
[configuration reference](https://docs.coderabbit.ai/reference/configuration),
[configuration inheritance](https://docs.coderabbit.ai/configuration/configuration-inheritance),
[automatic review controls](https://docs.coderabbit.ai/configuration/auto-review),
[review commands](https://docs.coderabbit.ai/reference/review-commands), and
[plans](https://docs.coderabbit.ai/management/plans).

## Copilot approvals

Copilot code review can submit approving reviews. It is off by default and is
switched on in GitHub settings, so these steps are manual:

1. **Organization.** Settings → Copilot → code review approvals: "Let
   repositories decide", or enable it for this repository.
2. **Repository.** Settings → Copilot → Code review → Auto-approval: turn on
   "Allow Copilot to approve pull requests".
3. **Paths.** List the paths Copilot may approve, one glob per line. An
   approval counts only when every changed file matches. Start with the output
   of `smithy.cut`:

   ```
   specs/**/*.tasks.md
   specs/**/*.spec.md
   ```

4. **Keep these out of the list:** `.github/`, `.claude/`, `AGENTS.md`,
   `CLAUDE.md`, `src/`, `docker/`, and `src/templates/`. They are the
   reviewer's own prompt or the product's behaviour.

With no ruleset requiring an approval, a Copilot approval is advisory. Making
it count changes how every pull request merges, so decide that separately.

## Known gaps

- The copied `smithy-review-planning` skill points at "The steering test" in
  the deployed `smithy-plan-review` agent. This repository's snapshot
  (Smithy 0.5.13) predates that section; the next Smithy upgrade adds it.
- About 20 sampled threads, mostly on `cut` and `mark` pull requests the loop
  merged, had no reply. Whether those findings were right is unknown.
- The CodeRabbit map was written from CodeRabbit's documentation and has not
  been observed on a pull request. On the first reviewed pull request, run
  `@coderabbitai configuration` and check that the review summary lists the
  mapped files.
- CodeRabbit posts its summary as a pull request conversation comment. The
  Legate loop treats an unanswered conversation comment as feedback to fix,
  whoever wrote it.
- Codex reads only `AGENTS.md`, so its copy of the rules is a short list and a
  pointer to the files above.
- The read/review split relies on a reviewer loading a skill when an
  instruction file tells it to. If that proves unreliable, the most valuable
  checks move back into the always-loaded files.
