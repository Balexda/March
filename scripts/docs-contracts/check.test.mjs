/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  FRESHNESS_CONFIG_PATH,
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
  "statio",
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
  writeFile(
    repoRoot,
    SUBSYSTEM_MANIFEST_PATH,
    `${JSON.stringify(names, null, 2)}\n`,
  );
}

function freshnessEntry(name, overrides = {}) {
  return {
    name,
    contractPath: contractPathForSubsystem(name),
    publicSourcePaths: [`src/${name}/**`],
    ...overrides,
  };
}

function validFreshnessConfig() {
  return {
    version: 1,
    contracts: [
      freshnessEntry("hatchery", {
        publicSourcePaths: [
          "src/hatchery/defaults.ts",
          "src/hatchery/orphan-branch.ts",
          "src/hatchery/service/**",
          "src/hatchery/spawn-config.ts",
        ],
      }),
      freshnessEntry("brood"),
      freshnessEntry("herald"),
      freshnessEntry("castra", {
        publicSourcePaths: [
          "src/castra/adapter.ts",
          "src/castra/config.ts",
          "src/castra/metrics.ts",
          "src/castra/recovery.ts",
          "src/castra/serve.ts",
          "src/castra/server.ts",
          "src/castra/types.ts",
        ],
      }),
      freshnessEntry("spawn"),
      freshnessEntry("legate"),
      freshnessEntry("steward", {
        publicSourcePaths: [
          "src/castra/client.ts",
          "src/castra/steward-skills.ts",
          "src/hatchery/spawn-handoff.ts",
        ],
        notes:
          "Role-consumer ownership spans the Castra client/steward skills and Hatchery spawn handoff.",
      }),
      freshnessEntry("statio"),
    ],
  };
}

function writeFreshnessConfig(repoRoot, config = validFreshnessConfig()) {
  writeFile(
    repoRoot,
    FRESHNESS_CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function writeCompleteRepo(repoRoot, config = validFreshnessConfig()) {
  writeManifest(repoRoot, SUBSYSTEMS);
  writeFreshnessConfig(repoRoot, config);
  for (const name of SUBSYSTEMS) {
    writeFile(repoRoot, contractPathForSubsystem(name), validContract);
  }
}

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      writeCompleteRepo(repoRoot);

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
        {
          category: "config",
          status: "pass",
          checkedCount: SUBSYSTEMS.length,
          diagnostics: [],
        },
        {
          category: "freshness",
          status: "pass",
          checkedCount: 0,
          diagnostics: [],
        },
      ]);
      expect(output).toContain(`config: pass checked=${SUBSYSTEMS.length}`);
      expect(output).toContain("freshness: pass checked=0 changedFiles=0");
      expect(output).toContain(`contracts=${SUBSYSTEMS.join(",")}`);
    }));

  it("passes freshness when an explicit mapped source change includes its contract", () =>
    withTempRepo((repoRoot) => {
      writeCompleteRepo(repoRoot);

      const verdict = checkRequiredContracts({
        repoRoot,
        changedFiles: [
          "src/hatchery/service/worker.ts",
          "docs/subsystems/hatchery/contract.md",
        ],
      });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("pass");
      expect(output).toContain("freshness: pass checked=2 changedFiles=2");
    }));

  it("fails freshness when an explicit mapped source changes without its contract", () =>
    withTempRepo((repoRoot) => {
      writeCompleteRepo(repoRoot);

      const verdict = checkRequiredContracts({
        repoRoot,
        changedFiles: ["src/hatchery/service/worker.ts"],
      });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=freshness");
      expect(output).toContain("name=hatchery");
      expect(output).toContain("sourcePath=src/hatchery/service/worker.ts");
      expect(output).toContain("contractPath=docs/subsystems/hatchery/contract.md");
      expect(output).toContain("mapped public source changed without owning contract");
    }));

  it("ignores contract-only and unmapped explicit changed paths for freshness", () =>
    withTempRepo((repoRoot) => {
      writeCompleteRepo(repoRoot);

      const verdict = checkRequiredContracts({
        repoRoot,
        changedFiles: [
          "README.md",
          "docs/subsystems/hatchery/contract.md",
          "src/unknown/private.ts",
        ],
      });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("pass");
      expect(output).toContain("freshness: pass checked=3 changedFiles=3");
    }));

  it("rejects absolute and escaping explicit changed paths with bounded diagnostics", () =>
    withTempRepo((repoRoot) => {
      writeCompleteRepo(repoRoot);

      expect(() =>
        checkRequiredContracts({
          repoRoot,
          changedFiles: [path.join(repoRoot, "src/hatchery/service/worker.ts")],
        }),
      ).toThrow("changed-file path must be repo-relative");
      expect(() =>
        checkRequiredContracts({
          repoRoot,
          changedFiles: ["../outside.ts"],
        }),
      ).toThrow("changed-file path escapes repository root");
    }));

  it("derives deterministic git changed paths including deletes and renames", () =>
    withTempRepo((repoRoot) => {
      writeCompleteRepo(repoRoot);
      writeFile(repoRoot, "src/hatchery/service/old.ts", "old\n");
      writeFile(repoRoot, "src/brood/removed.ts", "removed\n");
      git(repoRoot, ["init"]);
      git(repoRoot, ["config", "user.email", "march@example.test"]);
      git(repoRoot, ["config", "user.name", "March Test"]);
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-m", "base"]);
      const base = git(repoRoot, ["rev-parse", "HEAD"]).trim();

      git(repoRoot, [
        "mv",
        "src/hatchery/service/old.ts",
        "src/hatchery/service/new.ts",
      ]);
      fs.rmSync(path.join(repoRoot, "src/brood/removed.ts"));

      const verdict = checkRequiredContracts({ repoRoot, diffBase: base });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("freshness: fail checked=3 changedFiles=3");
      expect(output).toContain("sourcePath=src/hatchery/service/old.ts");
      expect(output).toContain("sourcePath=src/hatchery/service/new.ts");
      expect(output).toContain("sourcePath=src/brood/removed.ts");
    }));

  it("fails cleanly when a git diff base is unavailable", () =>
    withTempRepo((repoRoot) => {
      writeCompleteRepo(repoRoot);
      git(repoRoot, ["init"]);

      const stderr = [];
      const code = run(["--repo-root", repoRoot, "--diff-base", "missing-ref"], {
        stdout: { write: () => {} },
        stderr: { write: (line) => stderr.push(line) },
      });

      expect(code).toBe(2);
      expect(stderr.join("")).toContain(
        "unable to evaluate git diff base: missing-ref",
      );
    }));

  it("skips freshness drift when the config is invalid even with mapped changed input", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      const config = validFreshnessConfig();
      config.contracts = [
        ...config.contracts.filter((entry) => entry.name !== "herald"),
        freshnessEntry("brood", {
          publicSourcePaths: ["src/brood/worktree.ts"],
        }),
      ];
      writeFreshnessConfig(repoRoot, config);

      const verdict = checkRequiredContracts({
        repoRoot,
        changedFiles: ["src/hatchery/service/worker.ts"],
      });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=config");
      // Freshness is skipped because the config never validated: the mapped
      // source path must not surface a drift diagnostic, and checked=0 reflects
      // that nothing was evaluated while changedFiles still counts the input.
      expect(output).toContain("freshness: pass checked=0 changedFiles=1");
      expect(output).not.toContain("category=freshness");
    }));

  it("requires every subsystem named in the manifest", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, [...SUBSYSTEMS, "observatory"]);
      writeFreshnessConfig(repoRoot, {
        version: 1,
        contracts: [
          ...validFreshnessConfig().contracts,
          freshnessEntry("observatory"),
        ],
      });
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(
        verdict.checks.find((check) => check.category === "presence").checkedCount,
      ).toBe(SUBSYSTEMS.length + 1);
      expect(output).toContain("category=presence");
      expect(output).toContain("docs/subsystems/observatory/contract.md");
    }));

  it("fails presence with the missing repo-relative path", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      writeFreshnessConfig(repoRoot);
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
      writeFreshnessConfig(repoRoot);
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

  it("fails config validation for missing and duplicate required entries", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      const config = validFreshnessConfig();
      config.contracts = [
        ...config.contracts.filter((entry) => entry.name !== "herald"),
        freshnessEntry("brood", {
          publicSourcePaths: ["src/brood/worktree.ts"],
        }),
      ];
      writeFreshnessConfig(repoRoot, config);

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=config");
      expect(output).toContain("name=herald");
      expect(output).toContain("required freshness config entry is missing");
      expect(output).toContain("name=brood");
      expect(output).toContain("required freshness config entry is duplicated");
    }));

  it("fails config validation for duplicate contract paths", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      const config = validFreshnessConfig();
      config.contracts.find((entry) => entry.name === "castra").contractPath =
        contractPathForSubsystem("hatchery");
      writeFreshnessConfig(repoRoot, config);

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("docs/subsystems/hatchery/contract.md");
      expect(output).toContain(
        "duplicate freshness contractPath owned by hatchery,castra",
      );
    }));

  it("fails config validation for overlapping public source selectors", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      const config = validFreshnessConfig();
      config.contracts.find((entry) => entry.name === "brood").publicSourcePaths = [
        "src/hatchery/service/client.ts",
      ];
      writeFreshnessConfig(repoRoot, config);

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain(
        "sourcePath=src/hatchery/service/** <-> src/hatchery/service/client.ts",
      );
      expect(output).toContain("overlapping freshness selector owned by hatchery,brood");
    }));

  it("fails config validation for malformed selectors", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      const config = validFreshnessConfig();
      config.contracts.find((entry) => entry.name === "hatchery").publicSourcePaths = [
        "",
        "../outside.ts",
        "dist/cli.js",
        "node_modules/vitest/index.js",
      ];
      writeFreshnessConfig(repoRoot, config);

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("freshness config selector must be repo-relative");
      expect(output).toContain(
        "freshness config selector cannot target generated or dependency directories",
      );
    }));

  it("fails Steward config that requires a standalone source directory", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      const config = validFreshnessConfig();
      config.contracts.find((entry) => entry.name === "steward").publicSourcePaths = [
        "src/steward/**",
      ];
      writeFreshnessConfig(repoRoot, config);

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("sourcePath=src/steward/**");
      expect(output).toContain(
        "steward freshness selectors must use Castra/Hatchery role-consumer surfaces",
      );
    }));

  it("fails config validation for a falsy non-object config root", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      writeFile(repoRoot, FRESHNESS_CONFIG_PATH, "null\n");

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=config");
      expect(output).toContain("freshness config must be a JSON object");
    }));

  it("fails escaping and Windows-style selectors", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }
      const config = validFreshnessConfig();
      config.contracts.find((entry) => entry.name === "hatchery").publicSourcePaths = [
        "src/hatchery/..",
        "node_modules\\vitest\\index.js",
      ];
      writeFreshnessConfig(repoRoot, config);

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("sourcePath=src/hatchery/..");
      expect(output).toContain("sourcePath=node_modules\\vitest\\index.js");
      expect(output).toContain("freshness config selector must be repo-relative");
    }));

  it("fails config validation when the freshness config is missing", () =>
    withTempRepo((repoRoot) => {
      writeManifest(repoRoot, SUBSYSTEMS);
      for (const name of SUBSYSTEMS) {
        writeFile(repoRoot, contractPathForSubsystem(name), validContract);
      }

      const verdict = checkRequiredContracts({ repoRoot });
      const output = formatVerdict(verdict);

      expect(verdict.status).toBe("fail");
      expect(output).toContain("category=config");
      expect(output).toContain(FRESHNESS_CONFIG_PATH);
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
