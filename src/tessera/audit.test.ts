/**
 * @l0 @deterministic @ci
 *
 * The pure Issuance Audit Record builder (data model entity 10).
 */
import { describe, expect, it } from "vitest";
import {
  AUDIT_SUBJECT_MAX_LENGTH,
  buildAuditRecord,
  createAuditContext,
  type AuditContext,
} from "./audit.js";

const RECORD_FIELDS = [
  "access",
  "cache",
  "caller",
  "expires_at",
  "identity",
  "outcome",
  "provider",
  "reason",
  "repo",
  "subject",
].sort();

function issuedContext(): AuditContext {
  const context = createAuditContext();
  context.caller = "herald";
  context.identity = "app";
  context.repo = "acme/widgets";
  context.access = "read";
  context.subject = "spawn-a";
  context.provider = "github-app";
  context.cache = "miss";
  context.expiresAt = "2026-11-15T19:04:11Z";
  return context;
}

describe("buildAuditRecord", () => {
  it("records an issued request with its cache result and expiry", () => {
    expect(buildAuditRecord(issuedContext(), 200)).toEqual({
      caller: "herald",
      identity: "app",
      provider: "github-app",
      repo: "acme/widgets",
      access: "read",
      outcome: "issued",
      reason: null,
      cache: "miss",
      expires_at: "2026-11-15T19:04:11Z",
      subject: "spawn-a",
    });
    const hit = issuedContext();
    hit.cache = "hit";
    expect(buildAuditRecord(hit, 200).cache).toBe("hit");
  });

  it("records an unauthenticated request as caller unknown with every other field null", () => {
    const context = createAuditContext();
    context.errorCode = "unauthorized";
    expect(buildAuditRecord(context, 401)).toEqual({
      caller: "unknown",
      identity: null,
      provider: null,
      repo: null,
      access: null,
      outcome: "denied",
      reason: "unauthorized",
      cache: "n/a",
      expires_at: null,
      subject: null,
    });
  });

  it("marks a 4xx rejection denied and a 5xx failed, with the error code as the reason", () => {
    const denied = createAuditContext();
    denied.caller = "herald";
    denied.identity = "app";
    denied.access = "write";
    denied.repo = "acme/widgets";
    denied.errorCode = "policy_denied";
    expect(buildAuditRecord(denied, 403)).toMatchObject({
      outcome: "denied",
      reason: "policy_denied",
      provider: null,
      cache: "n/a",
    });

    const failed = issuedContext();
    failed.cache = null;
    failed.expiresAt = null;
    failed.errorCode = "mint_failed";
    expect(buildAuditRecord(failed, 502)).toMatchObject({
      outcome: "failed",
      reason: "mint_failed",
      provider: "github-app",
      cache: "n/a",
      expires_at: null,
    });
  });

  it("reports cache n/a and no expiry unless a token was issued", () => {
    const context = issuedContext();
    context.errorCode = "repo_not_installed";
    expect(buildAuditRecord(context, 422)).toMatchObject({
      outcome: "denied",
      reason: "repo_not_installed",
      cache: "n/a",
      expires_at: null,
    });
  });

  it("falls back to internal when a failure carries no recorded code", () => {
    const context = createAuditContext();
    context.caller = "herald";
    expect(buildAuditRecord(context, 500)).toMatchObject({ outcome: "failed", reason: "internal" });
  });

  it("never reports issued for a success status with no issuance recorded", () => {
    const context = createAuditContext();
    context.caller = "herald";
    expect(buildAuditRecord(context, 200)).toMatchObject({ outcome: "failed", reason: "internal" });
  });

  it("caps an over-long subject", () => {
    const context = issuedContext();
    context.subject = "s".repeat(AUDIT_SUBJECT_MAX_LENGTH * 4);
    expect(buildAuditRecord(context, 200).subject).toBe("s".repeat(AUDIT_SUBJECT_MAX_LENGTH));
  });

  it("copies only the allow-listed fields, whatever else the context carries", () => {
    const context = Object.assign(issuedContext(), {
      token: "ghs_SENTINEL",
      key: "client-key-sentinel",
      key_sha256: "abc123",
      authorization: "Bearer client-key-sentinel",
      body: { token: "ghs_SENTINEL" },
      extra: "unlisted",
    });
    const record = buildAuditRecord(context, 200);
    expect(Object.keys(record).sort()).toEqual(RECORD_FIELDS);
    const serialized = JSON.stringify(record);
    for (const leaked of ["ghs_SENTINEL", "client-key-sentinel", "abc123", "Bearer", "unlisted"]) {
      expect(serialized).not.toContain(leaked);
    }
  });
});
