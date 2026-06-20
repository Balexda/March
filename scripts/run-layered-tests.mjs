import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function isQuarantined(relativePath) {
  return toPosixPath(relativePath).startsWith(QUARANTINE_PREFIX);
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
