/**
 * @l1
 * @deterministic
 * @scheduled
 */
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "tests/fixtures/work-module/consumer.mts");
const compiler = join(root, "node_modules/typescript/bin/tsc");

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 }).trim();
}

function checkConsumer(source, outDir, cwd) {
  run(process.execPath, [
    compiler, "--ignoreConfig", "--strict", "--module", "NodeNext", "--types", "node",
    "--typeRoots", join(root, "node_modules/@types"), "--rootDir", cwd, "--outDir", outDir, source,
  ], cwd);
  return run(process.execPath, [join(outDir, relative(cwd, source).replace(/\.mts$/, ".mjs"))], cwd);
}

const external = mkdtempSync(join(tmpdir(), "march-module-consumer-"));
try {
  const inTreeOutput = mkdtempSync(join(root, ".work-module-consumer-"));
  try {
    const inTreeVersion = checkConsumer(fixture, inTreeOutput, root);
    const [pack] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", external]));
    run("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund", join(external, pack.filename),
    ], external);

    const externalSource = join(external, "consumer.mts");
    copyFileSync(fixture, externalSource);
    const externalVersion = checkConsumer(externalSource, join(external, "dist"), external);
    strictEqual(externalVersion, inTreeVersion);
    strictEqual(run(join(external, "node_modules/.bin/march"), ["version"], external), pack.version);
    console.log(`In-tree and packed consumers verified contract ${externalVersion}.`);
  } finally {
    rmSync(inTreeOutput, { recursive: true, force: true });
  }
} finally {
  rmSync(external, { recursive: true, force: true });
}
