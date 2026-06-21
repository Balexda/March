// generate-skills.mjs — build-time generator for the shared `march.*` skills.
//
// The `march.*` skills are authored ONCE as dotprompt sources under
// `src/templates/skills/<skill>/` (a `SKILL.prompt`, parameterized scripts such
// as `lib.sh.prompt`, plain `*.sh`, and fixtures) plus shared handlebars
// partials under `src/templates/skills/snippets/`. The same skill runs in more
// than one execution context that needs different service addressing, so this
// generator renders one VARIANT per context with the correct service URLs and
// `march` CLI invocation baked in at generation time — there is no runtime
// "am I in a container?" detection in the shipped scripts (issue #424).
//
// Two variants are emitted today:
//   - `repo`   → committed into `.claude/skills/` (regenerated on every build so
//                new versions just check in). For the march repo / host operator
//                shell: services on `localhost` via compose-published ports.
//   - `castra` → dropped into the build dir `dist/skills/castra/` (gitignored) so
//                the hatchery/Castra images can bundle it. For in-container
//                sessions (legate agent, stewards, agent-deck): services reached
//                over the docker network by service hostname.
//
// This module exports its pure pieces for unit testing; running it directly
// (`npm run skills:generate`, also invoked by `npm run build`) writes the files.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dotprompt } from "dotprompt";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

/**
 * Execution contexts. Each entry produces one variant of every skill in
 * {@link SKILLS}. `vars` are the handlebars inputs the `.prompt` sources
 * substitute; `outDir` is relative to the repo root. `committed` is advisory
 * metadata (the repo variant lands in a tracked tree; the castra variant lands
 * in the gitignored build dir).
 */
export const CONTEXTS = [
  {
    id: "repo",
    label: "march repo / host operator shell",
    committed: true,
    outDir: ".claude/skills",
    vars: {
      CONTEXT: "repo",
      IS_CONTAINER: false,
      ADDRESSING:
        "host shell — services are reached on `localhost` via the compose-published ports",
      HERALD_BASE: "http://localhost:8818",
      LEGATE_BASE: "http://localhost:8787",
      CASTRA_BASE: "http://localhost:9264",
      HATCHERY_BASE: "http://localhost:8080",
      BROOD_BASE: "http://localhost:9748",
      MARCH_CLI: "march",
    },
  },
  {
    id: "castra",
    label: "Castra in-container session (legate agent / steward / agent-deck)",
    committed: false,
    outDir: "dist/skills/castra",
    vars: {
      CONTEXT: "castra",
      IS_CONTAINER: true,
      ADDRESSING:
        "an in-container session — services are reached over the docker network by service hostname",
      HERALD_BASE: "http://herald:8818",
      LEGATE_BASE: "http://legate:8787",
      CASTRA_BASE: "http://castra:9264",
      HATCHERY_BASE: "http://hatchery:8080",
      BROOD_BASE: "http://brood:9748",
      MARCH_CLI: "march",
    },
  },
];

/** Skills authored as dotprompt sources. Add a dir under src/templates/skills/. */
export const SKILLS = ["march.debug"];

export const SKILLS_SRC_ROOT = path.join(REPO_ROOT, "src", "templates", "skills");
export const SNIPPETS_DIR = path.join(SKILLS_SRC_ROOT, "snippets");

/**
 * Load the shared handlebars partials (snippets) as a `name → content` map.
 * `service-addressing.md` becomes the partial `{{>service-addressing}}`. README
 * files are dev docs, never partials. Missing dir → empty map.
 */
export async function loadSnippets(dir = SNIPPETS_DIR) {
  const out = {};
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "README.md") continue;
    out[entry.replace(/\.md$/, "")] = await fs.readFile(path.join(dir, entry), "utf8");
  }
  return out;
}

/**
 * The output filename for a source file: `.prompt` is stripped; a name that is
 * left extensionless (e.g. `SKILL.prompt` → `SKILL`) becomes a `.md`. Non-prompt
 * files keep their name (copied verbatim).
 *   SKILL.prompt   → SKILL.md
 *   lib.sh.prompt  → lib.sh
 *   fold-state.sh  → fold-state.sh
 */
export function outputName(filename) {
  if (!filename.endsWith(".prompt")) return filename;
  const stripped = filename.slice(0, -".prompt".length);
  return path.extname(stripped) ? stripped : `${stripped}.md`;
}

/**
 * Render a `.prompt` source (frontmatter + body) through Dotprompt, resolving
 * `{{>partials}}`, `{{vars}}`, and `{{#if}}` conditionals.
 *
 * Unlike the legate template renderer (which deliberately preserves frontmatter
 * verbatim), march skills carry per-context values in the `allowed-tools`
 * frontmatter line, so the frontmatter is rendered too. Dotprompt strips a
 * leading `---` block as its own frontmatter, so we split it off, render each
 * half as plain template text, and re-assemble.
 */
export async function renderPromptText(promptContent, partials, vars) {
  const renderer = new Dotprompt({ partials });
  const render = async (text) => {
    if (text === "") return "";
    const result = await renderer.render(text, { input: vars });
    return result.messages
      .map((m) => m.content.map((p) => ("text" in p ? p.text : "")).join(""))
      .join("\n");
  };

  const fmMatch = promptContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return render(promptContent);

  const renderedFm = await render(fmMatch[1]);
  const renderedBody = await render(promptContent.slice(fmMatch[0].length));
  return `---\n${renderedFm}\n---\n${renderedBody}`;
}

/** Recursively list files under `dir`, returned as paths relative to `dir`. */
async function walkFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
}

/**
 * Generate one skill variant for one context into `outRoot` (defaults to the
 * repo root; the per-context `outDir` is joined onto it). Wipes the target skill
 * dir first so a removed source file does not linger. Returns the list of
 * written file paths (relative to `outRoot`), sorted.
 */
export async function generateSkill({
  skill,
  context,
  srcRoot = SKILLS_SRC_ROOT,
  outRoot = REPO_ROOT,
  snippets,
}) {
  const resolvedSnippets = snippets ?? (await loadSnippets());
  const srcDir = path.join(srcRoot, skill);
  const destDir = path.join(outRoot, context.outDir, skill);

  await fs.rm(destDir, { recursive: true, force: true });

  const written = [];
  for (const rel of await walkFiles(srcDir)) {
    const srcFile = path.join(srcDir, rel);
    const destRel = path.join(path.dirname(rel), outputName(path.basename(rel)));
    const destFile = path.join(destDir, destRel);
    await fs.mkdir(path.dirname(destFile), { recursive: true });

    if (rel.endsWith(".prompt")) {
      const content = await fs.readFile(srcFile, "utf8");
      await fs.writeFile(destFile, await renderPromptText(content, resolvedSnippets, context.vars));
    } else {
      await fs.copyFile(srcFile, destFile);
    }
    // Only the shell scripts are executable; data fixtures (JSON/ndjson/log)
    // stay at the default mode so regeneration never flips their bits.
    if (destFile.endsWith(".sh")) {
      await fs.chmod(destFile, 0o755);
    }
    written.push(path.relative(outRoot, destFile));
  }
  return written.sort();
}

/** Generate every skill for every context. Returns a per-variant summary. */
export async function generateAll({ outRoot = REPO_ROOT } = {}) {
  const snippets = await loadSnippets();
  const results = [];
  for (const context of CONTEXTS) {
    for (const skill of SKILLS) {
      const files = await generateSkill({ skill, context, outRoot, snippets });
      results.push({ context: context.id, skill, outDir: context.outDir, files });
    }
  }
  return results;
}

async function main() {
  const results = await generateAll();
  for (const r of results) {
    console.log(
      `skills:generate: ${r.skill} → ${r.outDir}/${r.skill} (${r.files.length} file(s))`,
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("skills:generate failed:", err);
    process.exitCode = 1;
  });
}
