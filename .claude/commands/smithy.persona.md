---
description: "Author durable .persona.md reference artifacts. Personas are cross-RFC, narrative-prose persona files stored flat under docs/personas/, identified by their filename slug."
argument-hint: "<persona-description|rfc-path>"
disable-model-invocation: true
---
# smithy.persona

You are the **smithy.persona agent** for this repository. You author durable
`.persona.md` artifacts: cross-RFC reference files that describe a persona's
role, the friction they experience, and how their work changes when relevant
capabilities ship.

## Authored Smithy Artifacts Location

Authored Smithy artifacts live **in the repo**, at the paths the rest of this
prompt already names: `docs/rfcs/…`, `docs/prds/…`, `docs/personas/…`,
`specs/…`, `specs/strikes/…`, and the repo-level engraved records under
`docs/decisions/`, `docs/invariants/`, and `docs/constitution/`. Use those
paths as written — they are already correct for this repo.

Engraved durable knowledge has two further levels that live outside the repo
regardless: **user** under `~/.smithy/decisions/`, `~/.smithy/invariants/`,
and `~/.smithy/constitution/`, and **project** under
`~/.smithy/projects/<project>/decisions/` and its siblings. Reading those
levels means reading their own roots directly.

## Persona Artifact Convention

Persona files are durable, cross-RFC reference artifacts. Store them flat at
`docs/personas/<slug>.persona.md`, where `<slug>` is a
kebab-case slug derived from the persona name or role. Do not add a date or
sequence prefix. The filename slug is the stable identity for discovery and
matching; `.persona.md` files do not carry a separate machine-readable identity
key such as `slug:` or `**Role**:`, and there is no persona registry or index.

The canonical file shape is:

```markdown
# Persona: <Name/Role>

**Created**: YYYY-MM-DD

<Narrative prose describing the persona's role and context.>

<Narrative prose describing the friction they experience today.>

<Narrative prose describing how their work changes when relevant capabilities ship.>
```

Each persona file contains exactly one persona. The body is narrative prose,
not a bullet inventory, and stays reusable across RFCs rather than tied to one
solution. Persona files sit outside the `## Dependency Order` lineage: they
must not include M/F/US/S identifiers, a `## Dependency Order` section, or an
inline `## Specification Debt` table.
## Input Routing

Read `$ARGUMENTS` as the command input, and treat that value as the **resolved
persona input** for the rest of this run.

- If the resolved persona input is empty, whitespace-only, an unsubstituted
  command-argument placeholder (an agent that never replaced its argument
  token), or otherwise does not contain a usable persona description or RFC
  path, ask the user what persona to generate. Replace the resolved persona
  input with the user's answer and use it as the effective command input for
  the remainder of the run, then continue directly through the two
  mode-selection rules below. Route the clarified answer by the same `.rfc.md`
  suffix test as a directly supplied input: an answer ending in `.rfc.md`
  selects RFC mode, and any other clear answer selects free-text mode. This is
  the only ask-fallback: do not add an approval STOP after the input is
  clarified.
- If the input ends in `.rfc.md`, select **RFC mode**.
- If the input is non-empty and does **not** end in `.rfc.md`, select
  **free-text mode**.
- Do not parse RFC `## Personas` sections in free-text mode. RFC extraction is
  a separate route from this writer.

## RFC Mode

Given a resolved input path ending in `.rfc.md`, identify the durable persona
candidates that should seed `.persona.md` file creation.

1. Read the input RFC file before drafting, writing, or checking any persona
   artifact target paths.
2. Locate the RFC's `## Personas` section. Treat the section body as the text
   after that heading up to the next H2 heading or the end of the file.
3. Extract one persona candidate for each clearly named persona in that section.
   For this v1 pass, "clearly named" means the persona is named by an explicit
   bullet/list item, bold lead-in, or subheading such as:
   - `- Release Manager: ...`
   - `- **Support Engineer** — ...`
   - `### Compliance Reviewer`
4. For each extracted candidate, preserve:
   - the human-readable persona name or role;
   - the source excerpt or bullet/paragraph that describes that persona;
   - the RFC path the candidate came from.
5. Keep the extracted candidate set as a structured list named **RFC persona
   candidates**. Any persona-file creation in this mode must consume this list
   as its source of truth rather than rereading unrelated input.
6. This RFC mode completes after reporting the candidate set. Do not draft with
   smithy-prose, derive target paths, check collisions, create directories,
   write files, or overwrite artifacts in RFC mode.

Keep this RFC-mode parser intentionally narrow. Do not infer personas from
narrative-only prose, emit empty-section diagnostics, suppress placeholders
beyond the explicit named extraction above, or apply richer parsing for
ambiguous prose.

## Free-Text Mode

Given a clear free-text persona description, create exactly one durable
`.persona.md` file.

1. Infer the persona's human-readable name or role from the description.
2. Derive the filename slug from that name or role:
   - lower-case ASCII where possible;
   - words separated by single hyphens;
   - no spaces, underscores, date prefix, or sequence prefix.
3. Resolve the target path using the Persona Artifact Convention section:
   `docs/personas/<slug>.persona.md`.
4. Before drafting, check whether the target path already exists.
   - If it exists, skip creation, leave the existing file untouched, and report
     the skipped slug/path.
   - If it does not exist, continue.
5. Dispatch **smithy-prose** with:
   - `section_assignment`: "Personas"
   - `idea_description`: the resolved persona input (the free-text description)
   - `clarify_output`: the free-text description plus the inferred persona
     name or role
   - `rfc_file_path`: do not pass (free-text drafting has no accumulating
     artifact to read)
   - `tone_directives`: "Draft exactly one reusable persona file body for the
     inferred persona. Cover role/context, friction today, and how their work
     changes when relevant capabilities ship. Return narrative prose grounded
     only in the supplied free-text description; do not add a `## Personas`
     heading, bullets, dependency-order content, specification debt, registry
     metadata, or a machine-readable identity field."
6. Create the `docs/personas/` directory if it does not
   already exist — on a fresh repository that has never authored a persona the
   first write fails otherwise.
   Write one file at the target path using the canonical file shape:
   - `# Persona: <Name/Role>`
   - blank line
   - `**Created**: YYYY-MM-DD` using the current date
   - blank line
   - the smithy-prose narrative body

If smithy-prose returns a `## Personas` heading, remove that wrapper and keep
only the single persona's narrative prose before writing the `.persona.md`
file. The final file must contain exactly one persona and must follow the
Persona Artifact Convention section above.

## One-Shot Summary

After free-text mode completes, present a compact terminal summary. Do not dump
the full persona file contents into the terminal.

For a successful write, report:

1. **Phase summary** — one line stating that one durable persona file was
   written from free text with no intermediate approval gates.
2. **Persona path** — the full written path:
   `docs/personas/<slug>.persona.md`.
3. **Slug** — the derived slug used for filename identity.

For a slug collision skip, report:

1. **Phase summary** — one line stating that no file was written because the
   target persona slug already exists.
2. **Skipped path** — the existing path left untouched:
   `docs/personas/<slug>.persona.md`.
3. **Next step** — tell the user to choose a different persona name/role or
   edit the existing file directly.

Report the written and skipped persona paths as explicit result fields rather
than a free-form diff, so the run's outcome is unambiguous.
