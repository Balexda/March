import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_SECTIONS = [
  "Public Interface",
  "Invariants",
  "Error Modes",
];

// Single source of truth for the required subsystem set. Adding a subsystem
// (e.g. `statio`) means adding one line here rather than editing this script,
// so the verdict tracks the repo instead of drifting from it.
export const SUBSYSTEM_MANIFEST_PATH = "docs/subsystems/subsystems.json";

const MAX_DIAGNOSTICS = 50;

export function contractPathForSubsystem(name) {
  return `docs/subsystems/${name}/contract.md`;
}

export function readSubsystems(repoRoot) {
  const manifestPath = path.join(repoRoot, SUBSYSTEM_MANIFEST_PATH);

  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(
      `subsystem manifest not found at ${SUBSYSTEM_MANIFEST_PATH}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `subsystem manifest ${SUBSYSTEM_MANIFEST_PATH} is not valid JSON: ${error.message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `subsystem manifest ${SUBSYSTEM_MANIFEST_PATH} must be a JSON array of subsystem names`,
    );
  }

  const seen = new Set();
  const contracts = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        `subsystem manifest ${SUBSYSTEM_MANIFEST_PATH} entries must be non-empty strings`,
      );
    }
    const name = entry.trim();
    if (seen.has(name)) {
      throw new Error(
        `subsystem manifest ${SUBSYSTEM_MANIFEST_PATH} has a duplicate subsystem: ${name}`,
      );
    }
    seen.add(name);
    contracts.push({ name, contractPath: contractPathForSubsystem(name) });
  }

  return contracts;
}

function parseArgs(argv) {
  let repoRoot = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--repo-root requires a path");
      }
      repoRoot = next;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return { repoRoot };
}

function toDiagnostic(fields) {
  return fields;
}

function readContractFiles(repoRoot, requiredContracts) {
  const presenceDiagnostics = [];
  const presentContracts = [];

  for (const contract of requiredContracts) {
    const absolutePath = path.join(repoRoot, contract.contractPath);
    if (!fs.existsSync(absolutePath)) {
      presenceDiagnostics.push(
        toDiagnostic({
          category: "presence",
          name: contract.name,
          contractPath: contract.contractPath,
          message: "required contract is missing",
        }),
      );
      continue;
    }

    presentContracts.push({
      ...contract,
      content: fs.readFileSync(absolutePath, "utf8"),
    });
  }

  return { presenceDiagnostics, presentContracts };
}

export function findH2Headings(markdown) {
  const headings = [];
  let inFence = false;
  let fenceMarker = "";
  let fenceLength = 0;

  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[2];
      const marker = fence[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        fenceLength = fence.length;
      } else if (marker === fenceMarker && fence.length >= fenceLength) {
        // CommonMark: a closing fence must use the same character and be at
        // least as long as the opening fence.
        inFence = false;
        fenceMarker = "";
        fenceLength = 0;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    const headingMatch = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (headingMatch) {
      headings.push(headingMatch[1].trim());
    }
  }

  return headings;
}

function validateSections(presentContracts) {
  const diagnostics = [];

  for (const contract of presentContracts) {
    const headings = findH2Headings(contract.content);
    for (const section of REQUIRED_SECTIONS) {
      const count = headings.filter((heading) => heading === section).length;
      if (count === 0) {
        diagnostics.push(
          toDiagnostic({
            category: "section-schema",
            name: contract.name,
            contractPath: contract.contractPath,
            message: `missing required H2 heading: ## ${section}`,
          }),
        );
      } else if (count > 1) {
        diagnostics.push(
          toDiagnostic({
            category: "section-schema",
            name: contract.name,
            contractPath: contract.contractPath,
            message: `duplicate required H2 heading: ## ${section}`,
          }),
        );
      }
    }
  }

  return diagnostics;
}

function summarizeCheck(category, checkedCount, diagnostics) {
  return {
    category,
    status: diagnostics.length === 0 ? "pass" : "fail",
    checkedCount,
    diagnostics,
  };
}

export function checkRequiredContracts(input = {}) {
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const requiredContracts = readSubsystems(repoRoot);
  const { presenceDiagnostics, presentContracts } = readContractFiles(
    repoRoot,
    requiredContracts,
  );
  const sectionDiagnostics = validateSections(presentContracts);
  const checks = [
    summarizeCheck("presence", requiredContracts.length, presenceDiagnostics),
    summarizeCheck("section-schema", presentContracts.length, sectionDiagnostics),
  ];
  const diagnostics = checks
    .flatMap((check) => check.diagnostics)
    .slice(0, MAX_DIAGNOSTICS);
  const status = checks.some((check) => check.status === "fail") ? "fail" : "pass";

  return {
    status,
    checks,
    diagnostics,
    summary: {
      contracts: requiredContracts.map((contract) => contract.name),
      diagnostics: diagnostics.length,
    },
  };
}

function formatDiagnostic(diagnostic) {
  const parts = [
    `category=${diagnostic.category}`,
    `name=${diagnostic.name}`,
    `contractPath=${diagnostic.contractPath}`,
    `message=${diagnostic.message}`,
  ];
  return `diagnostic: ${parts.join(" ")}`;
}

export function formatVerdict(verdict) {
  const lines = [
    `contract verdict: ${verdict.status}`,
    `presence: ${verdict.checks[0].status} checked=${verdict.checks[0].checkedCount} contracts=${verdict.summary.contracts.join(",")}`,
    `section-schema: ${verdict.checks[1].status} checked=${verdict.checks[1].checkedCount} contracts=${verdict.summary.contracts.join(",")}`,
    `diagnostics: ${verdict.summary.diagnostics}`,
  ];

  for (const diagnostic of verdict.diagnostics) {
    lines.push(formatDiagnostic(diagnostic));
  }

  return `${lines.join("\n")}\n`;
}

export function run(argv = process.argv.slice(2), io = process) {
  try {
    const { repoRoot } = parseArgs(argv);
    const verdict = checkRequiredContracts({ repoRoot });
    io.stdout.write(formatVerdict(verdict));
    return verdict.status === "pass" ? 0 : 1;
  } catch (error) {
    io.stderr.write(`docs:contracts:check: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
