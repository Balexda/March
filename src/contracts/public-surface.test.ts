import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractPublicTypeScriptSurface } from "./public-surface.js";

const createdRepos: string[] = [];

function fixtureRepo(files: Record<string, string>): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "march-public-surface-"));
  createdRepos.push(repoRoot);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return repoRoot;
}

afterEach(() => {
  while (createdRepos.length > 0) {
    const repoRoot = createdRepos.pop();
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("extractPublicTypeScriptSurface", () => {
  it("extracts public declarations and omits private local declarations and bodies", () => {
    const repoRoot = fixtureRepo({
      "src/fixture.ts": `
        function privateHelper() {
          return "hidden";
        }

        export function run<T>(input: T): T {
          privateHelper();
          return input;
        }

        export class Runner {
          private secret(): string {
            return "hidden";
          }

          execute(value: string): string {
            return value.toUpperCase();
          }
        }

        export interface Options {
          readonly enabled: boolean;
        }

        export type Result<T> = { value: T };
        export const VERSION = "1.0.0";
        export enum Mode {
          Fast = "fast",
          Slow = "slow",
        }
      `,
    });

    const result = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/fixture.ts"],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.summaries.map((summary) => [summary.kind, summary.name])).toEqual([
      ["class", "Runner"],
      ["const", "VERSION"],
      ["enum", "Mode"],
      ["function", "run"],
      ["interface", "Options"],
      ["type", "Result"],
    ]);
    expect(result.summaries.every((summary) => summary.sourcePath === "src/fixture.ts")).toBe(true);
    expect(result.summaries.find((summary) => summary.name === "Options")?.typeOnly).toBe(true);
    expect(result.summaries.find((summary) => summary.name === "Result")?.typeOnly).toBe(true);
    expect(result.summaries.find((summary) => summary.name === "run")?.signature).toContain(
      "export function run<T>(input: T): T;",
    );

    const serialized = JSON.stringify(result.summaries);
    expect(serialized).not.toContain("privateHelper");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("toUpperCase");
    expect(serialized).not.toContain("secret");
  });

  it("represents default exports, re-exports, namespace exports, and type-only exports", () => {
    const repoRoot = fixtureRepo({
      "src/barrel.ts": `
        export { original as renamed } from "./library.js";
        export { localValue };
        export type { PublicType } from "./types.js";
        export * as utilities from "./utilities.js";
        export * from "./everything.js";
        export { something as default } from "./default.js";

        const localValue = 1;
        export default class VisibleDefault {
          run(): void {}
        }
      `,
    });

    const result = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/barrel.ts"],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.summaries.map((summary) => [summary.kind, summary.name, summary.typeOnly])).toEqual([
      ["default", "default", false],
      ["default", "default", false],
      ["namespace", "*", false],
      ["namespace", "utilities", false],
      ["re-export", "PublicType", true],
      ["re-export", "localValue", false],
      ["re-export", "renamed", false],
    ]);
    expect(result.summaries.find((summary) => summary.name === "renamed")?.signature).toBe(
      'export { original as renamed } from "./library.js";',
    );
    expect(result.summaries.find((summary) => summary.name === "PublicType")?.signature).toBe(
      'export type { PublicType } from "./types.js";',
    );
    expect(result.summaries.find((summary) => summary.name === "utilities")?.signature).toBe(
      'export * as utilities from "./utilities.js";',
    );
  });

  it("sorts by source path, export kind, and export name for byte-stable output", () => {
    const repoRoot = fixtureRepo({
      "src/b.ts": `
        export const zed = 1;
        export function alpha(): void {}
      `,
      "src/a.ts": `
        export type Zed = string;
        export const beta: number = 2;
      `,
    });

    const first = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/b.ts", "src/a.ts"],
    });
    const second = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/a.ts", "src/b.ts"],
    });

    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(first.summaries.map((summary) => `${summary.sourcePath}:${summary.kind}:${summary.name}`)).toEqual([
      "src/a.ts:const:beta",
      "src/a.ts:type:Zed",
      "src/b.ts:const:zed",
      "src/b.ts:function:alpha",
    ]);
    expect(JSON.stringify(first.summaries)).toBe(JSON.stringify(second.summaries));
  });

  it("returns bounded parse diagnostics instead of partial summaries", () => {
    const repoRoot = fixtureRepo({
      "src/broken.ts": `
        export const ok = 1;
        export function broken(
      `,
    });

    const result = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/broken.ts"],
    });

    expect(result.summaries).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      category: "parse",
      severity: "error",
      sourcePath: "src/broken.ts",
    });
    expect(result.diagnostics[0].message.length).toBeLessThanOrEqual(300);
  });

  it("reports unsupported export syntax with bounded extraction diagnostics", () => {
    const repoRoot = fixtureRepo({
      "src/legacy.ts": `
        const legacy = {};
        export = legacy;
      `,
    });

    const result = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/legacy.ts"],
    });

    expect(result.summaries).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        category: "extraction",
        severity: "error",
        sourcePath: "src/legacy.ts",
        message: "Unsupported export syntax: export assignment with equals.",
      },
    ]);
  });

  it("includes the type keyword in type-only namespace and star re-export signatures", () => {
    const repoRoot = fixtureRepo({
      "src/types-barrel.ts": `
        export type * from "./types.js";
        export type * as typeNs from "./more-types.js";
      `,
    });

    const result = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/types-barrel.ts"],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.summaries.find((summary) => summary.name === "*")).toMatchObject({
      typeOnly: true,
      signature: 'export type * from "./types.js";',
    });
    expect(result.summaries.find((summary) => summary.name === "typeNs")).toMatchObject({
      typeOnly: true,
      signature: 'export type * as typeNs from "./more-types.js";',
    });
  });

  it("rejects non-const exported variables with an extraction diagnostic", () => {
    const repoRoot = fixtureRepo({
      "src/mutable.ts": `
        export let counter = 0;
      `,
    });

    const result = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: ["src/mutable.ts"],
    });

    expect(result.summaries).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        category: "extraction",
        severity: "error",
        sourcePath: "src/mutable.ts",
        message: "Unsupported exported variable declaration: only 'const' exports are supported, found 'let'.",
      },
    ]);
  });

  it("returns an empty result for empty source lists", () => {
    const repoRoot = fixtureRepo({});

    expect(
      extractPublicTypeScriptSurface({
        repoRoot,
        sourcePaths: [],
      }),
    ).toEqual({
      summaries: [],
      diagnostics: [],
    });
  });
});
