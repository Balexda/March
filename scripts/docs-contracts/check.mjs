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
export const FRESHNESS_CONFIG_PATH =
  "docs/subsystems/contract-freshness.config.json";

const MAX_DIAGNOSTICS = 50;
const GENERATED_OR_DEPENDENCY_ROOTS = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const STEWARD_ROLE_CONSUMER_PREFIXES = ["src/castra/", "src/hatchery/"];

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

function readFreshnessConfig(repoRoot) {
  const absolutePath = path.join(repoRoot, FRESHNESS_CONFIG_PATH);

  let raw;
  try {
    raw = fs.readFileSync(absolutePath, "utf8");
  } catch {
    return {
      config: undefined,
      diagnostics: [
        toDiagnostic({
          category: "config",
          contractPath: FRESHNESS_CONFIG_PATH,
          message: "freshness config is missing",
        }),
      ],
    };
  }

  try {
    return { config: JSON.parse(raw), diagnostics: [] };
  } catch (error) {
    return {
      config: undefined,
      diagnostics: [
        toDiagnostic({
          category: "config",
          contractPath: FRESHNESS_CONFIG_PATH,
          message: `freshness config is not valid JSON: ${error.message}`,
        }),
      ],
    };
  }
}

function isRepoRelativeSelector(selector) {
  return (
    selector !== "" &&
    !path.isAbsolute(selector) &&
    selector !== "." &&
    selector !== ".." &&
    !selector.startsWith("../") &&
    !selector.includes("/../")
  );
}

function generatedOrDependencyRoot(selector) {
  const root = selector.split("/")[0];
  return GENERATED_OR_DEPENDENCY_ROOTS.has(root);
}

function selectorOwnershipBase(selector) {
  if (selector.endsWith("/**")) {
    return { kind: "directory", base: selector.slice(0, -3) };
  }

  if (selector.endsWith("/*")) {
    return { kind: "directory", base: selector.slice(0, -2) };
  }

  if (selector.endsWith("/")) {
    return { kind: "directory", base: selector.slice(0, -1) };
  }

  return { kind: "file", base: selector };
}

function selectorsOverlap(left, right) {
  if (left.selector === right.selector) {
    return true;
  }

  if (
    left.kind === "directory" &&
    (right.base === left.base || right.base.startsWith(`${left.base}/`))
  ) {
    return true;
  }

  if (
    right.kind === "directory" &&
    (left.base === right.base || left.base.startsWith(`${right.base}/`))
  ) {
    return true;
  }

  return false;
}

function validateFreshnessConfig(repoRoot, requiredContracts) {
  const { config, diagnostics } = readFreshnessConfig(repoRoot);
  if (!config) {
    return { checkedCount: 0, diagnostics };
  }

  if (config.version !== 1) {
    diagnostics.push(
      toDiagnostic({
        category: "config",
        contractPath: FRESHNESS_CONFIG_PATH,
        message: "freshness config version must be 1",
      }),
    );
  }

  if (!Array.isArray(config.contracts)) {
    diagnostics.push(
      toDiagnostic({
        category: "config",
        contractPath: FRESHNESS_CONFIG_PATH,
        message: "freshness config contracts must be an array",
      }),
    );
    return { checkedCount: 0, diagnostics };
  }

  const requiredByName = new Map(
    requiredContracts.map((contract) => [contract.name, contract]),
  );
  const entriesByName = new Map();
  const entriesByContractPath = new Map();
  const ownedSelectors = [];

  for (const [index, entry] of config.contracts.entries()) {
    const entryLabel =
      entry && typeof entry.name === "string" && entry.name.trim() !== ""
        ? entry.name.trim()
        : `contracts[${index}]`;

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push(
        toDiagnostic({
          category: "config",
          name: entryLabel,
          contractPath: FRESHNESS_CONFIG_PATH,
          message: "freshness config entry must be an object",
        }),
      );
      continue;
    }

    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      diagnostics.push(
        toDiagnostic({
          category: "config",
          name: entryLabel,
          contractPath: FRESHNESS_CONFIG_PATH,
          message: "freshness config entry name must be a non-empty string",
        }),
      );
    } else {
      const names = entriesByName.get(entry.name) ?? [];
      names.push(entry);
      entriesByName.set(entry.name, names);
      if (!requiredByName.has(entry.name)) {
        diagnostics.push(
          toDiagnostic({
            category: "config",
            name: entry.name,
            contractPath: entry.contractPath ?? FRESHNESS_CONFIG_PATH,
            message: "freshness config entry is not in the required contract set",
          }),
        );
      }
    }

    if (
      typeof entry.contractPath !== "string" ||
      entry.contractPath.trim() === ""
    ) {
      diagnostics.push(
        toDiagnostic({
          category: "config",
          name: entryLabel,
          contractPath: FRESHNESS_CONFIG_PATH,
          message: "freshness config contractPath must be a non-empty string",
        }),
      );
    } else {
      const contractPathOwners =
        entriesByContractPath.get(entry.contractPath) ?? [];
      contractPathOwners.push(entryLabel);
      entriesByContractPath.set(entry.contractPath, contractPathOwners);

      const required = requiredByName.get(entry.name);
      if (required && entry.contractPath !== required.contractPath) {
        diagnostics.push(
          toDiagnostic({
            category: "config",
            name: entryLabel,
            contractPath: entry.contractPath,
            message: `freshness config contractPath must be ${required.contractPath}`,
          }),
        );
      }
    }

    if (
      !Array.isArray(entry.publicSourcePaths) ||
      entry.publicSourcePaths.length === 0
    ) {
      diagnostics.push(
        toDiagnostic({
          category: "config",
          name: entryLabel,
          contractPath: entry.contractPath ?? FRESHNESS_CONFIG_PATH,
          message: "freshness config publicSourcePaths must be a non-empty array",
        }),
      );
      continue;
    }

    for (const selector of entry.publicSourcePaths) {
      if (typeof selector !== "string") {
        diagnostics.push(
          toDiagnostic({
            category: "config",
            name: entryLabel,
            contractPath: entry.contractPath ?? FRESHNESS_CONFIG_PATH,
            message: "freshness config selector must be a string",
          }),
        );
        continue;
      }

      const normalizedSelector = selector.trim();
      if (!isRepoRelativeSelector(normalizedSelector)) {
        diagnostics.push(
          toDiagnostic({
            category: "config",
            name: entryLabel,
            sourcePath: selector,
            contractPath: entry.contractPath ?? FRESHNESS_CONFIG_PATH,
            message: "freshness config selector must be repo-relative",
          }),
        );
        continue;
      }

      if (generatedOrDependencyRoot(normalizedSelector)) {
        diagnostics.push(
          toDiagnostic({
            category: "config",
            name: entryLabel,
            sourcePath: normalizedSelector,
            contractPath: entry.contractPath ?? FRESHNESS_CONFIG_PATH,
            message:
              "freshness config selector cannot target generated or dependency directories",
          }),
        );
        continue;
      }

      if (
        entry.name === "steward" &&
        (normalizedSelector === "src/steward" ||
          normalizedSelector.startsWith("src/steward/") ||
          !STEWARD_ROLE_CONSUMER_PREFIXES.some((prefix) =>
            normalizedSelector.startsWith(prefix),
          ))
      ) {
        diagnostics.push(
          toDiagnostic({
            category: "config",
            name: entryLabel,
            sourcePath: normalizedSelector,
            contractPath: entry.contractPath ?? FRESHNESS_CONFIG_PATH,
            message:
              "steward freshness selectors must use Castra/Hatchery role-consumer surfaces",
          }),
        );
        continue;
      }

      const ownershipBase = selectorOwnershipBase(normalizedSelector);
      ownedSelectors.push({
        selector: normalizedSelector,
        owner: entryLabel,
        contractPath: entry.contractPath ?? FRESHNESS_CONFIG_PATH,
        ...ownershipBase,
      });
    }
  }

  for (const required of requiredContracts) {
    const entries = entriesByName.get(required.name) ?? [];
    if (entries.length === 0) {
      diagnostics.push(
        toDiagnostic({
          category: "config",
          name: required.name,
          contractPath: required.contractPath,
          message: "required freshness config entry is missing",
        }),
      );
    } else if (entries.length > 1) {
      diagnostics.push(
        toDiagnostic({
          category: "config",
          name: required.name,
          contractPath: required.contractPath,
          message: "required freshness config entry is duplicated",
        }),
      );
    }
  }

  for (const [contractPath, owners] of entriesByContractPath.entries()) {
    const uniqueOwners = [...new Set(owners)];
    if (uniqueOwners.length > 1 || owners.length > 1) {
      diagnostics.push(
        toDiagnostic({
          category: "config",
          name: uniqueOwners.join(","),
          contractPath,
          message: `duplicate freshness contractPath owned by ${uniqueOwners.join(",")}`,
        }),
      );
    }
  }

  for (let leftIndex = 0; leftIndex < ownedSelectors.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < ownedSelectors.length;
      rightIndex += 1
    ) {
      const left = ownedSelectors[leftIndex];
      const right = ownedSelectors[rightIndex];
      if (selectorsOverlap(left, right)) {
        diagnostics.push(
          toDiagnostic({
            category: "config",
            name: `${left.owner},${right.owner}`,
            sourcePath:
              left.selector === right.selector
                ? left.selector
                : `${left.selector} <-> ${right.selector}`,
            contractPath: `${left.contractPath},${right.contractPath}`,
            message: `overlapping freshness selector owned by ${left.owner},${right.owner}`,
          }),
        );
      }
    }
  }

  return { checkedCount: config.contracts.length, diagnostics };
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
  const { checkedCount: configCheckedCount, diagnostics: configDiagnostics } =
    validateFreshnessConfig(repoRoot, requiredContracts);
  const checks = [
    summarizeCheck("presence", requiredContracts.length, presenceDiagnostics),
    summarizeCheck("section-schema", presentContracts.length, sectionDiagnostics),
    summarizeCheck("config", configCheckedCount, configDiagnostics),
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
      configEntries: configCheckedCount,
      diagnostics: diagnostics.length,
    },
  };
}

function formatDiagnostic(diagnostic) {
  const parts = [`category=${diagnostic.category}`];
  if (diagnostic.name !== undefined) {
    parts.push(`name=${diagnostic.name}`);
  }
  if (diagnostic.sourcePath !== undefined) {
    parts.push(`sourcePath=${diagnostic.sourcePath}`);
  }
  if (diagnostic.contractPath !== undefined) {
    parts.push(`contractPath=${diagnostic.contractPath}`);
  }
  parts.push(`message=${diagnostic.message}`);
  return `diagnostic: ${parts.join(" ")}`;
}

export function formatVerdict(verdict) {
  const presence = verdict.checks.find((check) => check.category === "presence");
  const sectionSchema = verdict.checks.find(
    (check) => check.category === "section-schema",
  );
  const config = verdict.checks.find((check) => check.category === "config");
  const lines = [
    `contract verdict: ${verdict.status}`,
    `presence: ${presence.status} checked=${presence.checkedCount} contracts=${verdict.summary.contracts.join(",")}`,
    `section-schema: ${sectionSchema.status} checked=${sectionSchema.checkedCount} contracts=${verdict.summary.contracts.join(",")}`,
    `config: ${config.status} checked=${config.checkedCount} entries=${verdict.summary.configEntries}`,
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
