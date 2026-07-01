import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TAXONOMY_AXES } from "./test-taxonomy.mjs";

const LAYERS = {
  l0: { scope: "@l0", script: "test:l0" },
  l1: { scope: "@l1", script: "test:l1" },
  "l2-cassette": { scope: "@l2", script: "test:l2-cassette" },
  "l3-cassette": { scope: "@l3", script: "test:l3-cassette" },
};

const REQUIRED_TAGS = ["@deterministic", "@ci"];
const TEST_FILE_RE = /\.test\.(?:mjs|ts)$/;
const IGNORED_DIRS = new Set([".git", "dist", "node_modules"]);
const QUARANTINE_PREFIX = "tests/quarantine/";
// Shares Feature 1's tag vocabulary so the guard classifies against the same
// taxonomy the whole-repo lint enforces, rather than any bare `@`-token.
const TAXONOMY_TAGS = new Set(Object.values(TAXONOMY_AXES).flat());
// Bound the per-file diagnostic output so a large drift cannot flood CI logs,
// matching scripts/docs-contracts/check.mjs.
const MAX_DIAGNOSTICS = 50;

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function walkTestFiles(rootDir, dir = rootDir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkTestFiles(rootDir, path.join(dir, entry.name), out);
      }
      continue;
    }

    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(toPosixPath(path.relative(rootDir, path.join(dir, entry.name))));
    }
  }

  return out.sort();
}

function leadingCommentBlock(source) {
  const trimmed = source.replace(/^\uFEFF/, "").trimStart();
  if (!trimmed.startsWith("/**")) {
    return "";
  }

  const end = trimmed.indexOf("*/");
  return end === -1 ? "" : trimmed.slice(0, end + 2);
}

function tagsInLeadingBlock(source) {
  const block = leadingCommentBlock(source);
  return new Set(block.match(/@[a-z0-9-]+/g) ?? []);
}

// A candidate is classifiable only when its leading block carries at least one
// recognized taxonomy tag. A block with only non-taxonomy annotations (e.g.
// `@vitest-environment jsdom`) is unclassified: it would be excluded from every
// layer, so the guard must treat it as untagged and fail loudly rather than let
// the file be silently omitted.
function hasRecognizedTaxonomyTag(source) {
  for (const tag of tagsInLeadingBlock(source)) {
    if (TAXONOMY_TAGS.has(tag)) {
      return true;
    }
  }
  return false;
}

function isQuarantined(relativePath) {
  return toPosixPath(relativePath).startsWith(QUARANTINE_PREFIX);
}

export function findUntaggedCandidateTestFiles(rootDir) {
  return walkTestFiles(rootDir).filter((relativePath) => {
    if (isQuarantined(relativePath)) {
      return false;
    }

    const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
    return !hasRecognizedTaxonomyTag(source);
  });
}

export function selectLayerTestFiles(rootDir, layerName) {
  const layer = LAYERS[layerName];
  if (!layer) {
    throw new Error(`Unknown test layer: ${layerName}`);
  }

  return walkTestFiles(rootDir).filter((relativePath) => {
    if (isQuarantined(relativePath)) {
      return false;
    }

    const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
    const tags = tagsInLeadingBlock(source);
    return (
      tags.has(layer.scope) && REQUIRED_TAGS.every((tag) => tags.has(tag))
    );
  });
}

export function layerCommandContract() {
  return Object.fromEntries(
    Object.entries(LAYERS).map(([layerName, config]) => [
      config.script,
      {
        layer: layerName,
        scope: config.scope,
        requiredTags: [...REQUIRED_TAGS],
        excludedPath: QUARANTINE_PREFIX,
      },
    ]),
  );
}

function runLayer(layerName, rootDir = process.cwd()) {
  const layer = LAYERS[layerName];
  if (!layer) {
    console.error(
      `Unknown test layer "${layerName}". Expected one of: ${Object.keys(LAYERS).join(", ")}`,
    );
    return 2;
  }

  const untaggedCandidates = findUntaggedCandidateTestFiles(rootDir);
  if (untaggedCandidates.length > 0) {
    console.error(
      `${layer.script}: refused to run ${untaggedCandidates.length} untagged test file(s) outside ${QUARANTINE_PREFIX}.`,
    );
    for (const relativePath of untaggedCandidates.slice(0, MAX_DIAGNOSTICS)) {
      console.error(
        `${layer.script}: ${relativePath} has no recognized taxonomy tag block.`,
      );
    }
    const undiagnosed = untaggedCandidates.length - MAX_DIAGNOSTICS;
    if (undiagnosed > 0) {
      console.error(
        `${layer.script}: … and ${undiagnosed} more untagged file(s) not listed.`,
      );
    }
    return 1;
  }

  const selected = selectLayerTestFiles(rootDir, layerName);
  if (selected.length === 0) {
    console.log(
      `${layer.script}: no ${layer.scope} @deterministic @ci tests selected outside ${QUARANTINE_PREFIX}; layer passes empty.`,
    );
    return 0;
  }

  console.log(
    `${layer.script}: running ${selected.length} ${layer.scope} @deterministic @ci test file(s) outside ${QUARANTINE_PREFIX}.`,
  );

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["run", "test:vitest", "--", ...selected],
    { cwd: rootDir, stdio: "inherit" },
  );

  if (result.error) {
    console.error(`${layer.script}: failed to launch npm test runner`);
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  process.exitCode = runLayer(process.argv[2]);
}
