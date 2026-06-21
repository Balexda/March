/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUBSYSTEM_MANIFEST_PATH,
  checkRequiredContracts,
  contractPathForSubsystem,
  findH2Headings,
  formatVerdict,
  run,
} from "./check.mjs";

// The required set is now discovered from the manifest, so the tests declare
// their own subsystem list and write it into the temp repo's manifest.
const SUBSYSTEMS = [
  "hatchery",
  "brood",
  "herald",
  "castra",
  "spawn",
  "legate",
  "steward",
];

function withTempRepo(run) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "march-contracts-"));
  try {
    return run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function writeFile(repoRoot, relativePath, body) {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, body);
}

function writeManifest(repoRoot, names) {
  writeFile(repoRoot, SUBSYSTEM_MANIFEST_PATH, `${JSON.stringify(names, null, 2)}\n`);
}

const validContract = `# Contract

## Public Interface

The public interface is documented here.

## Invariants

The observable invariants are documented here.

## Error Modes

The externally visible errors are documented here.
`;

describe("docs contract checker", () => {
  it("passes presence and section schema for the complete required contract set", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("pass");
      expect(verdict.checks).toEqual([
        {
          category: "presence",
          status: "pass",
          checkedCount: SUBSYSTEMS.length,
          diagnostics: [],
        },
        {
          category: "section-schema",
          status: "pass",
          checkedCount: SUBSYSTEMS.length,
          diagnostics: [],
        },
      ]);
      expect(output).toContain(`contracts=${SUBSYSTEMS.join(",")}`);
    }));

  it("requires every subsystem named in the manifest", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, [...SUBSYSTEMS, "statio"]);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(verdict.checks[0].checkedCount).toBe(SUBSYSTEMS.length + 1);
      expect(output).toContain("category=presence");
      expect(output).toContain("docs/subsystems/statio/contract.md");
    }));

  it("fails presence with the missing repo-relative path", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS.slice(1)) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=presence");
      expect(output).toContain("docs/subsystems/hatchery/contract.md");
    }));

  it("fails section schema for missing and duplicate required H2 headings", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      writeFile(
        repoRoot,
        "docs/subsystems/hatchery/contract.md",
        `# Contract

## Public Interface

## Public Interface

### Invariants

\`\`\`md
## Error Modes
\`\`\`
`,
      );

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=section-schema");
      expect(output).toContain("docs/subsystems/hatchery/contract.md");
      expect(output).toContain("duplicate required H2 heading: ## Public Interface");
      expect(output).toContain("missing required H2 heading: ## Invariants");
      expect(output).toContain("missing required H2 heading: ## Error Modes");
    }));

  it("exits with a configuration error when the manifest is missing", () =>
    withTempRepo((repoRoot) => {
      const stderr = [];
      const code = run(["--repo-root", repoRoot], {
        stdout: { write: () => {} },
        stderr: { write: (line) => stderr.push(line) },
      });

      expect(code).toBe(2);
      expect(stderr.join("")).toContain(SUBSYSTEM_MANIFEST_PATH);
    }));

  it("exits with a configuration error when the manifest is malformed", () =>
    withTempRepo((repoRoot) => {
      writeFile(repoRoot, SUBSYSTEM_MANIFEST_PATH, "{ not an array }");
      const stderr = [];
      const code = run(["--repo-root", repoRoot], {
        stdout: { write: () => {} },
        stderr: { write: (line) => stderr.push(line) },
      });

      expect(code).toBe(2);
      expect(stderr.join("")).toContain(SUBSYSTEM_MANIFEST_PATH);
    }));

  it("detects only structural H2 headings outside fenced code blocks", () => {
    expect(
      findH2Headings(`The prose mentions ## Public Interface.

### Public Interface

\`\`\`
## Invariants
\`\`\`

  ## Error Modes

## Public Interface
`),
    ).toEqual(["Error Modes", "Public Interface"]);
  });
});
