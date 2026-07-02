/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  BEGIN_AUTOGEN_MARKER,
  END_AUTOGEN_MARKER,
  renderGeneratedContractBlock,
  replaceContractAutogenRegions,
  validateAutogenMarkerRegion,
} from "./contract-region.js";
import type { PublicExportSummary } from "./public-surface.js";

const summaries: PublicExportSummary[] = [
  {
    sourcePath: "src/hatchery/service/routes.ts",
    kind: "function",
    name: "registerHatcheryRoutes",
    signature: "export function registerHatcheryRoutes(server: FastifyInstance): void;",
    typeOnly: false,
  },
  {
    sourcePath: "src/hatchery/service/types.ts",
    kind: "interface",
    name: "HatcherySpawnRequest",
    signature: "export interface HatcherySpawnRequest { readonly prompt: string; }",
    typeOnly: true,
  },
];

function contractWithAutogen(body: string): string {
  return [
    "# Hatchery Contract",
    "",
    "## Purpose",
    "",
    "Human-authored purpose stays fixed.",
    "",
    "## Public Interface",
    "",
    "Human-authored intro stays fixed.",
    "",
    BEGIN_AUTOGEN_MARKER,
    body,
    END_AUTOGEN_MARKER,
    "",
    "Human-authored outro stays fixed.",
    "",
    "## Error Modes",
    "",
    "Human-authored errors stay fixed.",
    "",
  ].join("\n");
}

describe("renderGeneratedContractBlock", () => {
  it("renders deterministic owner, contract, export, signature, and type-only details", () => {
    const first = renderGeneratedContractBlock({
      ownerName: "hatchery",
      contractPath: "docs/subsystems/hatchery/contract.md",
      exports: [...summaries].reverse(),
    });
    const second = renderGeneratedContractBlock({
      ownerName: "hatchery",
      contractPath: "docs/subsystems/hatchery/contract.md",
      exports: summaries,
    });

    expect(first).toEqual(second);
    expect(first.content).toContain("Owner: `hatchery`");
    expect(first.content).toContain("Contract: `docs/subsystems/hatchery/contract.md`");
    expect(first.content).toContain(
      "| src/hatchery/service/routes.ts | function | registerHatcheryRoutes | no | export function registerHatcheryRoutes(server: FastifyInstance): void; |",
    );
    expect(first.content).toContain(
      "| src/hatchery/service/types.ts | interface | HatcherySpawnRequest | yes | export interface HatcherySpawnRequest { readonly prompt: string; } |",
    );
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("renders an explicitly allowed empty surface deterministically", () => {
    const block = renderGeneratedContractBlock({
      ownerName: "steward",
      contractPath: "docs/subsystems/steward/contract.md",
      exports: [],
      allowEmptySurface: true,
    });

    expect(block.exportCount).toBe(0);
    expect(block.content).toBe(
      [
        "### Generated TypeScript Public Surface",
        "",
        "Owner: `steward`",
        "Contract: `docs/subsystems/steward/contract.md`",
        "Exports: 0",
        "",
        "No public exports are currently declared for this allowed empty surface.",
        "",
      ].join("\n"),
    );
  });
});

describe("validateAutogenMarkerRegion", () => {
  it("returns the one-based marker lines for one balanced pair inside Public Interface", () => {
    const result = validateAutogenMarkerRegion({
      contractPath: "docs/subsystems/hatchery/contract.md",
      content: contractWithAutogen("old generated content"),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.region).toEqual({
      beginMarkerLine: 11,
      endMarkerLine: 13,
    });
  });

  it.each([
    {
      name: "missing markers",
      content: ["# Contract", "", "## Public Interface", "", "No markers.", ""].join("\n"),
      message: "AUTOGEN marker pair is missing.",
    },
    {
      name: "duplicate markers",
      content: [
        "# Contract",
        "",
        "## Public Interface",
        "",
        BEGIN_AUTOGEN_MARKER,
        END_AUTOGEN_MARKER,
        BEGIN_AUTOGEN_MARKER,
        END_AUTOGEN_MARKER,
        "",
      ].join("\n"),
      message: "contract must contain exactly one AUTOGEN marker pair.",
    },
    {
      name: "unbalanced markers",
      content: ["# Contract", "", "## Public Interface", "", BEGIN_AUTOGEN_MARKER, ""].join("\n"),
      message: "contract must contain exactly one AUTOGEN marker pair.",
    },
    {
      name: "reversed markers",
      content: [
        "# Contract",
        "",
        "## Public Interface",
        "",
        END_AUTOGEN_MARKER,
        BEGIN_AUTOGEN_MARKER,
        "",
      ].join("\n"),
      message: "AUTOGEN end marker appears before begin marker.",
    },
    {
      name: "outside Public Interface",
      content: [
        "# Contract",
        "",
        BEGIN_AUTOGEN_MARKER,
        END_AUTOGEN_MARKER,
        "",
        "## Public Interface",
        "",
      ].join("\n"),
      message: "AUTOGEN markers must be inside the ## Public Interface section.",
    },
  ])("reports bounded marker diagnostics for $name", ({ content, message }) => {
    const result = validateAutogenMarkerRegion({
      contractPath: "docs/subsystems/hatchery/contract.md",
      content,
    });

    expect(result.region).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        category: "marker",
        severity: "error",
        contractPath: "docs/subsystems/hatchery/contract.md",
        message,
      },
    ]);
    expect(result.diagnostics[0].message.length).toBeLessThanOrEqual(300);
  });

  it("ignores marker text in fenced code blocks and non-standalone lines", () => {
    const result = validateAutogenMarkerRegion({
      contractPath: "docs/subsystems/hatchery/contract.md",
      content: [
        "# Contract",
        "",
        "## Public Interface",
        "",
        "```md",
        BEGIN_AUTOGEN_MARKER,
        END_AUTOGEN_MARKER,
        "```",
        `prefix ${BEGIN_AUTOGEN_MARKER}`,
        `${END_AUTOGEN_MARKER} suffix`,
        "",
      ].join("\n"),
    });

    expect(result.region).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        category: "marker",
        severity: "error",
        contractPath: "docs/subsystems/hatchery/contract.md",
        message: "AUTOGEN marker pair is missing.",
      },
    ]);
  });
});

describe("replaceContractAutogenRegions", () => {
  it("replaces only content between markers and preserves surrounding prose byte-for-byte", () => {
    const original = contractWithAutogen("old generated content\nwith two lines");
    const intro = original.slice(0, original.indexOf(BEGIN_AUTOGEN_MARKER));
    const outro = original.slice(original.indexOf("Human-authored outro stays fixed."));
    const block = renderGeneratedContractBlock({
      ownerName: "hatchery",
      contractPath: "docs/subsystems/hatchery/contract.md",
      exports: summaries,
    });

    const result = replaceContractAutogenRegions({
      contracts: [
        {
          contractPath: "docs/subsystems/hatchery/contract.md",
          content: original,
          generatedContent: block.content,
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.replacements).toHaveLength(1);
    const updated = result.replacements[0].content;
    expect(updated).toContain(`${BEGIN_AUTOGEN_MARKER}\n${block.content}${END_AUTOGEN_MARKER}`);
    expect(updated.slice(0, intro.length)).toBe(intro);
    expect(updated.slice(updated.indexOf("Human-authored outro stays fixed."))).toBe(outro);
  });

  it("leaves invalid contracts unchanged and prevents partial batch replacement", () => {
    const valid = contractWithAutogen("stale generated content");
    const invalid = ["# Contract", "", "## Public Interface", "", "No markers.", ""].join("\n");
    const block = renderGeneratedContractBlock({
      ownerName: "hatchery",
      contractPath: "docs/subsystems/hatchery/contract.md",
      exports: summaries,
    });

    const result = replaceContractAutogenRegions({
      contracts: [
        {
          contractPath: "docs/subsystems/hatchery/contract.md",
          content: valid,
          generatedContent: block.content,
        },
        {
          contractPath: "docs/subsystems/brood/contract.md",
          content: invalid,
          generatedContent: block.content,
        },
      ],
    });

    expect(result.replacements).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        category: "marker",
        severity: "error",
        contractPath: "docs/subsystems/brood/contract.md",
        message: "AUTOGEN marker pair is missing.",
      },
    ]);
    expect(valid).toContain("stale generated content");
    expect(invalid).toContain("No markers.");
  });
});
