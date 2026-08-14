/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  BEGIN_AUTOGEN_MARKER,
  END_AUTOGEN_MARKER,
  renderGeneratedContractBlock,
} from "./contract-region.js";
import {
  formatArgumentDiagnostics,
  formatAutogenCommandResult,
  parseAutogenCommandArgs,
  runAutogenCommand,
} from "./autogen-command.js";
import {
  DEFAULT_EXTRACTION_OWNERSHIP_CONFIG_PATH,
  REQUIRED_M2_EXTRACTION_OWNER_NAMES,
} from "./extraction-ownership.js";
import { extractPublicTypeScriptSurface } from "./public-surface.js";

const createdRepos: string[] = [];

function fixtureRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "march-autogen-command-"));
  createdRepos.push(repoRoot);

  writeFile(
    repoRoot,
    DEFAULT_EXTRACTION_OWNERSHIP_CONFIG_PATH,
    `${JSON.stringify(
      {
        version: 1,
        contracts: REQUIRED_M2_EXTRACTION_OWNER_NAMES.map((name) => ownerConfig(name)),
      },
      null,
      2,
    )}\n`,
  );

  for (const ownerName of REQUIRED_M2_EXTRACTION_OWNER_NAMES) {
    writeFile(
      repoRoot,
      sourcePathFor(ownerName),
      `export const ${ownerName}PublicValue: string = "${ownerName}";\n`,
    );
    writeContract(repoRoot, ownerName, generatedBlock(repoRoot, ownerName));
  }

  return repoRoot;
}

function ownerConfig(name: string) {
  return {
    name,
    contractPath: contractPathFor(name),
    publicSourcePaths:
      name === "steward"
        ? ["src/castra/client.ts"]
        : [sourcePathFor(name)],
  };
}

function sourcePathFor(ownerName: string): string {
  if (ownerName === "steward") return "src/castra/client.ts";
  return `src/${ownerName}/public.ts`;
}

function contractPathFor(ownerName: string): string {
  return `docs/subsystems/${ownerName}/contract.md`;
}

function generatedBlock(repoRoot: string, ownerName: string): string {
  const contractPath = contractPathFor(ownerName);
  const extraction = extractPublicTypeScriptSurface({
    repoRoot,
    sourcePaths: [sourcePathFor(ownerName)],
  });
  expect(extraction.diagnostics).toEqual([]);
  return renderGeneratedContractBlock({
    ownerName,
    contractPath,
    exports: extraction.summaries,
  }).content;
}

function writeContract(repoRoot: string, ownerName: string, generatedContent: string): void {
  writeFile(repoRoot, contractPathFor(ownerName), contractBody(ownerName, generatedContent));
}

function contractBody(ownerName: string, generatedContent: string): string {
  return [
    `# ${ownerName} Contract`,
    "",
    "## Public Interface",
    "",
    "Human-authored public intro.",
    "",
    BEGIN_AUTOGEN_MARKER,
    generatedContent.trimEnd(),
    END_AUTOGEN_MARKER,
    "",
    "Human-authored public outro.",
    "",
    "## Invariants",
    "",
    "Human-authored invariant.",
    "",
    "## Error Modes",
    "",
    "Human-authored errors.",
    "",
  ].join("\n");
}

function writeFile(repoRoot: string, relativePath: string, body: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, body);
}

function readFile(repoRoot: string, relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

afterEach(() => {
  while (createdRepos.length > 0) {
    const repoRoot = createdRepos.pop();
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("runAutogenCommand", () => {
  it("reports bounded diagnostics for missing, conflicting, and unsupported mode flags", () => {
    const missing = parseAutogenCommandArgs([]);
    const conflicting = parseAutogenCommandArgs(["--check", "--write"]);
    const unsupported = parseAutogenCommandArgs(["--check", "--surprise"]);

    expect(missing.mode).toBeUndefined();
    expect(formatArgumentDiagnostics(missing.diagnostics)).toContain(
      "message=exactly one mode flag is required: --check or --write.",
    );
    expect(conflicting.mode).toBeUndefined();
    expect(formatArgumentDiagnostics(conflicting.diagnostics)).toContain(
      "message=exactly one mode flag is required: --check or --write.",
    );
    expect(unsupported.mode).toBe("check");
    expect(formatArgumentDiagnostics(unsupported.diagnostics)).toContain(
      "message=unsupported argument: --surprise.",
    );
    expect(
      [...missing.diagnostics, ...conflicting.diagnostics, ...unsupported.diagnostics]
        .every((diagnostic) => diagnostic.message.length <= 300),
    ).toBe(true);
  });

  it("passes check mode with stable counts when generated regions are current", () => {
    const repoRoot = fixtureRepo();

    const result = runAutogenCommand({ repoRoot, mode: "check" });
    const output = formatAutogenCommandResult(result);

    expect(result).toMatchObject({
      mode: "check",
      status: "pass",
      checkedContracts: REQUIRED_M2_EXTRACTION_OWNER_NAMES.length,
      extractedExports: REQUIRED_M2_EXTRACTION_OWNER_NAMES.length,
      staleContracts: [],
      updatedContracts: [],
      diagnostics: [],
    });
    expect(output).toContain(
      "checkedContracts=7 extractedExports=7 staleContracts=0 updatedContracts=0 diagnostics=0",
    );
  });

  it("fails check mode for stale output without editing the owning contract", () => {
    const repoRoot = fixtureRepo();
    const staleContractPath = contractPathFor("hatchery");
    const before = contractBody("hatchery", "stale generated content\n");
    writeFile(repoRoot, staleContractPath, before);

    const result = runAutogenCommand({ repoRoot, mode: "check" });

    expect(result.status).toBe("fail");
    expect(result.staleContracts).toEqual([staleContractPath]);
    expect(result.diagnostics).toContainEqual({
      category: "stale-output",
      severity: "error",
      ownerName: "hatchery",
      contractPath: staleContractPath,
      message: "contract AUTOGEN region is stale; run write mode to refresh it.",
    });
    expect(readFile(repoRoot, staleContractPath)).toBe(before);
  });

  it("refreshes stale generated regions in write mode without changing surrounding prose", () => {
    const repoRoot = fixtureRepo();
    const staleContractPath = contractPathFor("hatchery");
    const before = contractBody("hatchery", "stale generated content\n");
    writeFile(repoRoot, staleContractPath, before);

    const prefix = before.slice(0, before.indexOf(BEGIN_AUTOGEN_MARKER));
    const suffix = before.slice(before.indexOf("Human-authored public outro."));
    const result = runAutogenCommand({ repoRoot, mode: "write" });
    const after = readFile(repoRoot, staleContractPath);

    expect(result.status).toBe("pass");
    expect(result.staleContracts).toEqual([staleContractPath]);
    expect(result.updatedContracts).toEqual([staleContractPath]);
    expect(after).toContain(generatedBlock(repoRoot, "hatchery").trimEnd());
    expect(after.slice(0, prefix.length)).toBe(prefix);
    expect(after.slice(after.indexOf("Human-authored public outro."))).toBe(suffix);
  });

  it("leaves all contracts unchanged when write mode finds an invalid marker region", () => {
    const repoRoot = fixtureRepo();
    const staleContractPath = contractPathFor("hatchery");
    const invalidContractPath = contractPathFor("brood");
    const staleBefore = contractBody("hatchery", "stale generated content\n");
    const invalidBefore = [
      "# brood Contract",
      "",
      "## Public Interface",
      "",
      "No markers here.",
      "",
      "## Invariants",
      "",
      "Human-authored invariant.",
      "",
      "## Error Modes",
      "",
      "Human-authored errors.",
      "",
    ].join("\n");
    writeFile(repoRoot, staleContractPath, staleBefore);
    writeFile(repoRoot, invalidContractPath, invalidBefore);

    const result = runAutogenCommand({ repoRoot, mode: "write" });

    expect(result.status).toBe("fail");
    expect(result.updatedContracts).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      category: "marker",
      severity: "error",
      ownerName: "brood",
      contractPath: invalidContractPath,
      message: "AUTOGEN marker pair is missing.",
    });
    expect(readFile(repoRoot, staleContractPath)).toBe(staleBefore);
    expect(readFile(repoRoot, invalidContractPath)).toBe(invalidBefore);
  });

  it("treats a CRLF contract with current generated content as unchanged", () => {
    const repoRoot = fixtureRepo();
    const crlfContractPath = contractPathFor("hatchery");
    const before = contractBody(
      "hatchery",
      generatedBlock(repoRoot, "hatchery"),
    ).replace(/\n/g, "\r\n");
    writeFile(repoRoot, crlfContractPath, before);

    const checkResult = runAutogenCommand({ repoRoot, mode: "check" });
    const writeResult = runAutogenCommand({ repoRoot, mode: "write" });

    expect(checkResult.status).toBe("pass");
    expect(checkResult.staleContracts).toEqual([]);
    expect(writeResult.updatedContracts).toEqual([]);
    expect(readFile(repoRoot, crlfContractPath)).toBe(before);
  });

  it("refreshes a CRLF contract without introducing mixed line endings", () => {
    const repoRoot = fixtureRepo();
    const crlfContractPath = contractPathFor("hatchery");
    const before = contractBody("hatchery", "stale generated content\n").replace(
      /\n/g,
      "\r\n",
    );
    writeFile(repoRoot, crlfContractPath, before);

    const result = runAutogenCommand({ repoRoot, mode: "write" });
    const after = readFile(repoRoot, crlfContractPath);

    expect(result.status).toBe("pass");
    expect(result.updatedContracts).toEqual([crlfContractPath]);
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(runAutogenCommand({ repoRoot, mode: "check" }).staleContracts).toEqual([]);
  });

  it("restores earlier contracts when a later filesystem write fails", () => {
    if (process.getuid?.() === 0) return;

    const repoRoot = fixtureRepo();
    const writableContractPath = contractPathFor("hatchery");
    const unwritableContractPath = contractPathFor("steward");
    const writableBefore = contractBody("hatchery", "stale generated content\n");
    const unwritableBefore = contractBody("steward", "stale generated content\n");
    writeFile(repoRoot, writableContractPath, writableBefore);
    writeFile(repoRoot, unwritableContractPath, unwritableBefore);
    fs.chmodSync(path.join(repoRoot, unwritableContractPath), 0o444);

    const result = runAutogenCommand({ repoRoot, mode: "write" });
    fs.chmodSync(path.join(repoRoot, unwritableContractPath), 0o644);

    expect(result.status).toBe("fail");
    // Owners write in name order, so hatchery is written before steward fails —
    // the restored hatchery file below is a rollback, not a skipped write.
    expect(result.staleContracts).toEqual([writableContractPath, unwritableContractPath]);
    expect(result.updatedContracts).toEqual([]);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.category === "write-safety" &&
          diagnostic.contractPath === unwritableContractPath &&
          diagnostic.message.startsWith("contract file cannot be written."),
      ),
    ).toBe(true);
    expect(readFile(repoRoot, writableContractPath)).toBe(writableBefore);
    expect(readFile(repoRoot, unwritableContractPath)).toBe(unwritableBefore);
  });

  it("runs through the public npm script without Docker or live March services", () => {
    const repoRoot = fixtureRepo();

    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "run",
        "docs:contracts:extract",
        "--",
        "--check",
        "--repo-root",
        repoRoot,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_HOST: "tcp://127.0.0.1:1",
          CASTRA_URL: "http://127.0.0.1:1",
          HATCHERY_URL: "http://127.0.0.1:1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Autogen Command Result");
    expect(result.stdout).toContain("mode=check status=pass");
    expect(result.stdout).toContain("diagnostics: none");
    expect(result.stderr).not.toContain("docker");
  });
});
