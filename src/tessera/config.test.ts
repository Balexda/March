/** @l0 @deterministic @ci */
import { describe, expect, it } from "vitest";
import { loadTesseraAppConfig, resolveTesseraPort } from "./config.js";

describe("Tessera runtime configuration", () => {
  it("resolves explicit, environment and default ports", () => {
    expect(resolveTesseraPort(undefined, {})).toBe(9477);
    expect(resolveTesseraPort(undefined, { MARCH_TESSERA_PORT: "1234" })).toBe(1234);
    expect(resolveTesseraPort("4321", { MARCH_TESSERA_PORT: "1234" })).toBe(4321);
  });
  it.each(["-1", "0", "65536", "1e3", "abc", "12.5", 1.5, NaN])("rejects invalid port %s", (value) => {
    expect(() => resolveTesseraPort(value, {})).toThrow("Invalid Tessera port");
  });
  it("permits unconfigured startup and rejects invalid installation override", async () => {
    expect(await loadTesseraAppConfig({})).toEqual({});
    await expect(loadTesseraAppConfig({ TESSERA_GITHUB_INSTALLATION_ID: "0" })).rejects.toThrow("installation id");
  });
});
