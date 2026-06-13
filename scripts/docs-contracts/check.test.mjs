import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRequiredContracts,
  findH2Headings,
  formatVerdict,
  REQUIRED_CONTRACTS,
} from "./check.mjs";

function withTempRepo(run) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "march-contracts-"));
  try {
    return run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function writeContract(repoRoot, contractPath, body) {
  const absolutePath = path.join(repoRoot, contractPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, body);
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
      for (const contract of REQUIRED_CONTRACTS) {
        writeContract(repoRoot, contract.contractPath, validContract);
      }

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("pass");
      expect(verdict.checks).toEqual([
        {
          category: "presence",
          status: "pass",
          checkedCount: 7,
          diagnostics: [],
        },
        {
          category: "section-schema",
          status: "pass",
          checkedCount: 7,
          diagnostics: [],
        },
      ]);
      expect(output).toContain(
        "contracts=hatchery,brood,herald,castra,spawn,legate,steward",
      );
    }));

  it("fails presence with the missing repo-relative path", () =>
    withTempRepo((repoRoot) => {
      for (const contract of REQUIRED_CONTRACTS.slice(1)) {
        writeContract(repoRoot, contract.contractPath, validContract);
      }

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=presence");
      expect(output).toContain("docs/subsystems/hatchery/contract.md");
    }));

  it("fails section schema for missing and duplicate required H2 headings", () =>
    withTempRepo((repoRoot) => {
      for (const contract of REQUIRED_CONTRACTS) {
        writeContract(repoRoot, contract.contractPath, validContract);
      }
      writeContract(
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
