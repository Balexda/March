/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadExtractionOwnershipConfig,
  resolveExtractionSourceSurfaces,
} from "./extraction-ownership.js";

const createdRepos: string[] = [];
const REQUIRED_OWNER_NAMES = [
  "hatchery",
  "brood",
  "herald",
  "castra",
  "spawn",
  "legate",
  "steward",
];

function fixtureRepo(files: Record<string, string>): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "march-extraction-ownership-"));
  createdRepos.push(repoRoot);
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(repoRoot, relativePath, contents);
  }
  return repoRoot;
}

function writeFile(repoRoot: string, relativePath: string, contents: string): void {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function owner(name: string, publicSourcePaths = [`src/${name}/**`], overrides = {}) {
  return {
    name,
    contractPath: `docs/subsystems/${name}/contract.md`,
    publicSourcePaths,
    ...overrides,
  };
}

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    contracts: [
      owner("hatchery", ["src/hatchery/a.ts", "src/hatchery/nested/**"]),
      owner("brood"),
      owner("herald"),
      owner("castra", ["src/castra/index.ts"]),
      owner("spawn"),
      owner("legate"),
      owner("steward", ["src/castra/client.ts", "src/hatchery/spawn-handoff.ts"], {
        notes: "Role-consumer ownership uses Castra and Hatchery surfaces.",
      }),
    ],
    ...overrides,
  };
}

function writeConfig(repoRoot: string, config: unknown = validConfig()): void {
  writeFile(repoRoot, "config/extraction.json", `${JSON.stringify(config, null, 2)}\n`);
}

afterEach(() => {
  while (createdRepos.length > 0) {
    const repoRoot = createdRepos.pop();
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("loadExtractionOwnershipConfig", () => {
  it("loads required owners from repo-local config without changing public extraction", () => {
    const repoRoot = fixtureRepo({});
    writeConfig(repoRoot);

    const result = loadExtractionOwnershipConfig({
      repoRoot,
      configPath: "config/extraction.json",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config).toMatchObject({
      version: 1,
      source: "config/extraction.json",
    });
    expect(result.config?.owners.map((entry) => entry.name)).toEqual([
      "brood",
      "castra",
      "hatchery",
      "herald",
      "legate",
      "spawn",
      "steward",
    ]);
    expect(result.config?.owners.find((entry) => entry.name === "steward")).toMatchObject({
      contractPath: "docs/subsystems/steward/contract.md",
      publicSourcePaths: ["src/castra/client.ts", "src/hatchery/spawn-handoff.ts"],
    });
  });

  it("rejects duplicate contract paths with bounded ownership diagnostics", () => {
    const repoRoot = fixtureRepo({});
    const config = validConfig();
    config.contracts.find((entry) => entry.name === "castra")!.contractPath =
      "docs/subsystems/hatchery/contract.md";
    writeConfig(repoRoot, config);

    const result = loadExtractionOwnershipConfig({
      repoRoot,
      configPath: "config/extraction.json",
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toContainEqual({
      category: "ownership",
      severity: "error",
      ownerName: "castra,hatchery",
      contractPath: "docs/subsystems/hatchery/contract.md",
      message: "duplicate extraction contractPath owned by castra,hatchery.",
    });
  });

  it("rejects unsupported config shape and version with the config path", () => {
    const repoRoot = fixtureRepo({});
    writeConfig(repoRoot, { version: 99, owners: [] });

    const result = loadExtractionOwnershipConfig({
      repoRoot,
      configPath: "config/extraction.json",
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        category: "config",
        severity: "error",
        contractPath: "config/extraction.json",
        message: "ownership config version must be 1.",
      },
      {
        category: "config",
        severity: "error",
        contractPath: "config/extraction.json",
        message: "ownership config contracts must be an array.",
      },
    ]);
  });

  it("rejects overlapping selector claims before surfaces are resolved", () => {
    const repoRoot = fixtureRepo({});
    const config = validConfig();
    config.contracts.find((entry) => entry.name === "brood")!.publicSourcePaths = [
      "src/hatchery/nested/client.ts",
    ];
    writeConfig(repoRoot, config);

    const result = loadExtractionOwnershipConfig({
      repoRoot,
      configPath: "config/extraction.json",
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toContainEqual({
      category: "ownership",
      severity: "error",
      ownerName: "brood,hatchery",
      contractPath: "docs/subsystems/brood/contract.md,docs/subsystems/hatchery/contract.md",
      sourcePath: "src/hatchery/nested/** <-> src/hatchery/nested/client.ts",
      message: "overlapping extraction selector owned by brood,hatchery.",
    });
  });

  it("rejects Steward selectors that require a standalone source module", () => {
    const repoRoot = fixtureRepo({});
    const config = validConfig();
    config.contracts.find((entry) => entry.name === "steward")!.publicSourcePaths = [
      "src/steward/**",
    ];
    writeConfig(repoRoot, config);

    const result = loadExtractionOwnershipConfig({
      repoRoot,
      configPath: "config/extraction.json",
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toContainEqual({
      category: "config",
      severity: "error",
      ownerName: "steward",
      contractPath: "docs/subsystems/steward/contract.md",
      sourcePath: "src/steward/**",
      message: "steward extraction selectors must use Castra/Hatchery role-consumer surfaces.",
    });
  });
});

describe("resolveExtractionSourceSurfaces", () => {
  it("resolves deterministic repo-relative TypeScript surfaces and excludes generated output", () => {
    const repoRoot = fixtureRepo({
      "src/hatchery/a.ts": "export const a = 1;",
      "src/hatchery/nested/b.mts": "export const b = 1;",
      "src/hatchery/readme.md": "ignore",
      "src/hatchery/types.d.ts": "export interface Ignored {}",
      "src/hatchery/dist/generated.ts": "export const generated = 1;",
      "node_modules/pkg/index.ts": "export const dependency = 1;",
      "src/brood/index.ts": "export const brood = 1;",
      "src/herald/index.ts": "export const herald = 1;",
      "src/castra/client.ts": "export const client = 1;",
      "src/castra/index.ts": "export const castra = 1;",
      "src/spawn/index.ts": "export const spawn = 1;",
      "src/legate/index.ts": "export const legate = 1;",
      "src/hatchery/spawn-handoff.ts": "export const handoff = 1;",
    });
    writeConfig(repoRoot, validConfig());
    const load = loadExtractionOwnershipConfig({
      repoRoot,
      configPath: "config/extraction.json",
    });

    const result = resolveExtractionSourceSurfaces({
      repoRoot,
      config: load.config!,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.surfaces).toHaveLength(REQUIRED_OWNER_NAMES.length);
    expect(result.surfaces.find((surface) => surface.ownerName === "hatchery")).toMatchObject({
      sourcePaths: [
        "src/hatchery/a.ts",
        "src/hatchery/nested/b.mts",
      ],
      empty: false,
    });
    expect(result.surfaces.find((surface) => surface.ownerName === "steward")).toMatchObject({
      sourcePaths: ["src/castra/client.ts", "src/hatchery/spawn-handoff.ts"],
      empty: false,
    });
  });

  it("represents empty surfaces only when explicitly allowed", () => {
    const repoRoot = fixtureRepo({});
    writeConfig(repoRoot, {
      version: 1,
      contracts: [
        owner("hatchery", ["src/future/**"], { allowEmptySurface: true }),
        owner("brood", ["src/also-future/**"]),
      ],
    });
    const load = loadExtractionOwnershipConfig({
      repoRoot,
      configPath: "config/extraction.json",
      requiredOwnerNames: ["hatchery", "brood"],
    });

    const result = resolveExtractionSourceSurfaces({
      repoRoot,
      config: load.config!,
    });

    expect(result.surfaces).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        category: "ownership",
        severity: "error",
        ownerName: "brood",
        contractPath: "docs/subsystems/brood/contract.md",
        message: "extraction owner resolved no TypeScript source files.",
      },
    ]);

    const allowedOnly = resolveExtractionSourceSurfaces({
      repoRoot,
      config: {
        ...load.config!,
        owners: [load.config!.owners.find((entry) => entry.name === "hatchery")!],
      },
    });
    expect(allowedOnly).toEqual({
      surfaces: [
        {
          ownerName: "hatchery",
          contractPath: "docs/subsystems/hatchery/contract.md",
          sourcePaths: [],
          empty: true,
        },
      ],
      diagnostics: [],
    });
  });

  it("rejects overlapping resolved source paths", () => {
    const repoRoot = fixtureRepo({
      "src/shared.ts": "export const shared = 1;",
    });

    const result = resolveExtractionSourceSurfaces({
      repoRoot,
      config: {
        version: 1,
        source: "config/extraction.json",
        owners: [
          {
            name: "hatchery",
            contractPath: "docs/subsystems/hatchery/contract.md",
            publicSourcePaths: ["src/shared.ts"],
            allowEmptySurface: false,
          },
          {
            name: "brood",
            contractPath: "docs/subsystems/brood/contract.md",
            publicSourcePaths: ["src/shared.ts"],
            allowEmptySurface: false,
          },
        ],
      },
    });

    expect(result.surfaces).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        category: "ownership",
        severity: "error",
        ownerName: "brood,hatchery",
        contractPath: "docs/subsystems/brood/contract.md,docs/subsystems/hatchery/contract.md",
        sourcePath: "src/shared.ts",
        message: "overlapping extraction source owned by brood,hatchery.",
      },
    ]);
  });
});
