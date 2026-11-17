/** @l0 @deterministic @ci */
import { describe, expect, it } from "vitest";
import { ACCESS_PROFILES, denyAuthorization, parseTokenRequest, ProviderRegistry } from "./models.js";
describe("Tessera issuance models", () => {
  it.each([
    null, [], {}, { identity: "app", access: "write" },
    { identity: "other", access: "read" }, { identity: "user", access: "admin" },
    { identity: "app", access: "read", repo: "owner/*" },
    { identity: "user", access: "read", refresh: "yes" },
    { identity: "user", access: "read", subject: 12 },
    { identity: "user", access: "read", permissions: {} },
  ])("rejects malformed requests %j", body => { expect(() => parseTokenRequest(body)).toThrow("Invalid token request"); });
  it("accepts both identities and typed optional fields", () => {
    expect(parseTokenRequest({ identity: "app", access: "write", repo: "acme/widgets", refresh: true, subject: "spawn" })).toEqual({ identity: "app", access: "write", repo: "acme/widgets", refresh: true, subject: "spawn" });
    expect(parseTokenRequest({ identity: "user", access: "read" }).identity).toBe("user");
  });
  it("denies by default and never substitutes missing providers", async () => {
    expect(() => denyAuthorization.authenticate("Bearer anything")).toThrow("Client authentication required");
    await expect(new ProviderRegistry().select("user").issue({ identity: "user", access: "read" })).rejects.toMatchObject({ code: "provider_unconfigured" });
  });
  it("freezes fixed minimal profiles", () => {
    expect(ACCESS_PROFILES.read).toEqual({ metadata: "read", contents: "read", pull_requests: "read", issues: "read", checks: "read", statuses: "read" });
    expect(ACCESS_PROFILES.write).toEqual({ ...ACCESS_PROFILES.read, contents: "write", pull_requests: "write", issues: "write" });
    expect(Object.isFrozen(ACCESS_PROFILES.write)).toBe(true);
  });
});
