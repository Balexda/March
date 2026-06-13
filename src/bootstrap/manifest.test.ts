/**
 * @l0 @deterministic @ci
 */
import { describe, it, expect } from "vitest";
import { createManifest, isValidManifest, type MarchManifest } from "./manifest.js";

describe("MarchManifest", () => {
  it("createManifest returns a manifest with correct default structure", () => {
    const manifest: MarchManifest = createManifest("0.1.0");

    expect(manifest.version).toBe(1);
    expect(manifest.marchVersion).toBe("0.1.0");
    expect(manifest.deployLocation).toBe("user");
    expect(manifest.agents).toEqual(["claude"]);
    expect(manifest.files).toEqual({ claude: [] });
  });

  it("createManifest uses the provided cliVersion for marchVersion", () => {
    const manifest = createManifest("1.2.3");

    expect(manifest.marchVersion).toBe("1.2.3");
  });

  it("createManifest returns the correct TypeScript shape", () => {
    const manifest = createManifest("0.1.0");

    // Verify all required fields are present
    expect(manifest).toHaveProperty("version");
    expect(manifest).toHaveProperty("marchVersion");
    expect(manifest).toHaveProperty("deployLocation");
    expect(manifest).toHaveProperty("agents");
    expect(manifest).toHaveProperty("files");

    // Verify types
    expect(typeof manifest.version).toBe("number");
    expect(typeof manifest.marchVersion).toBe("string");
    expect(typeof manifest.deployLocation).toBe("string");
    expect(Array.isArray(manifest.agents)).toBe(true);
    expect(typeof manifest.files).toBe("object");
    expect(Array.isArray(manifest.files.claude)).toBe(true);
  });
});

describe("isValidManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(isValidManifest(createManifest("0.1.0"))).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidManifest(null)).toBe(false);
  });

  it("rejects a string", () => {
    expect(isValidManifest("hello")).toBe(false);
  });

  it("rejects an object missing required fields", () => {
    expect(isValidManifest({ hello: "world" })).toBe(false);
  });

  it("rejects an object with wrong field types", () => {
    expect(
      isValidManifest({
        version: "1",
        marchVersion: "0.1.0",
        deployLocation: "user",
        agents: ["claude"],
        files: { claude: [] },
      }),
    ).toBe(false);
  });

  it("rejects agents with non-string elements", () => {
    expect(
      isValidManifest({
        version: 1,
        marchVersion: "0.1.0",
        deployLocation: "user",
        agents: [123],
        files: { claude: [] },
      }),
    ).toBe(false);
  });
});
