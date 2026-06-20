import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE_RE = /\.test\.ts$/;
const IGNORED_DIRS = new Set([".git", "dist", "node_modules"]);

export const TAXONOMY_AXES = {
  scope: ["@l0", "@l1", "@l2", "@l3"],
  determinism: ["@deterministic", "@stochastic"],
  executionChannel: ["@ci", "@scheduled"],
};

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function discoverTestFiles(rootDir, dir = rootDir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        discoverTestFiles(rootDir, path.join(dir, entry.name), out);
      }
      continue;
    }

    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(toPosixPath(path.relative(rootDir, path.join(dir, entry.name))));
    }
  }

  return out.sort();
}

export function leadingTagBlock(source) {
  const trimmed = source.replace(/^﻿/, "").trimStart();
  if (!trimmed.startsWith("/*")) {
    return "";
  }

  const end = trimmed.indexOf("*/");
  return end === -1 ? "" : trimmed.slice(0, end + 2);
}

function parsedAxisTags(block, validTags) {
  const allTags = block.match(/@[a-z0-9-]+/g) ?? [];
  return allTags.filter((tag) => validTags.includes(tag));
}

function duplicateTags(tags) {
  const seen = new Set();
  const duplicates = new Set();

  for (const tag of tags) {
    if (seen.has(tag)) {
      duplicates.add(tag);
    }
    seen.add(tag);
  }

  return [...duplicates];
}

export function validateTestFile(relativePath, source) {
  const block = leadingTagBlock(source);
  const failures = [];

  for (const [axis, validTags] of Object.entries(TAXONOMY_AXES)) {
    const tags = parsedAxisTags(block, validTags);
    const uniqueTags = new Set(tags);
    const duplicates = duplicateTags(tags);

    if (tags.length === 0) {
      failures.push({ path: relativePath, axis, reason: "missing" });
      continue;
    }

    if (duplicates.length > 0) {
      failures.push({
        path: relativePath,
        axis,
        reason: "duplicate",
        detail: duplicates.join(", "),
      });
    }

    if (uniqueTags.size > 1) {
      failures.push({
        path: relativePath,
        axis,
        reason: "conflicting",
        detail: [...uniqueTags].join(", "),
      });
    }
  }

  return failures;
}

export function lintTaxonomy(rootDir = process.cwd()) {
  const checkedFiles = discoverTestFiles(rootDir);
  const failures = [];

  for (const relativePath of checkedFiles) {
    const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
    failures.push(...validateTestFile(relativePath, source));
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    checkedFiles,
    failures,
  };
}

export function formatFailures(failures) {
  return failures.map((failure) => {
    const detail = failure.detail ? ` (${failure.detail})` : "";
    return `${failure.path}: ${failure.axis} ${failure.reason}${detail}`;
  });
}

export function runTaxonomyLint(rootDir = process.cwd()) {
  const verdict = lintTaxonomy(rootDir);

  if (verdict.status === "pass") {
    console.log(
      `test:taxonomy: checked ${verdict.checkedFiles.length} test file(s); taxonomy tags complete.`,
    );
    return 0;
  }

  console.error(
    `test:taxonomy: ${verdict.failures.length} taxonomy failure(s) across ${verdict.checkedFiles.length} test file(s).`,
  );
  for (const line of formatFailures(verdict.failures)) {
    console.error(line);
  }

  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  process.exitCode = runTaxonomyLint(process.cwd());
}
