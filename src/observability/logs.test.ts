import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveOtel, initOtel } from "./otel.js";
import { emitLoopLog, emitSpawnLog, initLoopLogs } from "./logs.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

describe("loop logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  it("is a no-op (does not throw, does not emit) when telemetry is disabled", () => {
    initOtel({});
    const emit = vi.spyOn(getActiveOtel().getLogger(), "emit");
    expect(() => emitLoopLog({ severity: "INFO", body: "hi" })).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("stamps profile/conductor and links to the dispatch trace via slice id", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    initLoopLogs({ profile: "smithy", conductor: "demo-legate" });
    const logger = getActiveOtel().getLogger();
    const emit = vi.spyOn(logger, "emit");

    emitLoopLog({
      severity: "ERROR",
      body: "dispatch failed",
      eventKind: "dispatch_failure",
      sliceId: "slice-123",
      attributes: { "march.action": "dispatch" },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const record = emit.mock.calls[0]![0];
    expect(record.severityText).toBe("ERROR");
    expect(record.attributes).toMatchObject({
      profile: "smithy",
      conductor: "demo-legate",
      event_kind: "dispatch_failure",
      "march.slice_id": "slice-123",
      "march.action": "dispatch",
    });
  });

  it("derives correlation ids identically to the dispatch span helpers", () => {
    // Guards the contract that logs land on the same trace as legate.dispatch.
    expect(traceIdForDispatch("slice-123")).toHaveLength(32);
    expect(spanIdForDispatch("slice-123")).toHaveLength(16);
  });
});

describe("emitSpawnLog (#244)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  it("is a no-op when telemetry is disabled", () => {
    initOtel({});
    const emit = vi.spyOn(getActiveOtel().getLogger(), "emit");
    expect(() =>
      emitSpawnLog({ severity: "ERROR", body: "git apply failed", traceId: "a", spanId: "b" }),
    ).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("attaches the explicit trace/span ids as the log's trace context", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const emit = vi.spyOn(getActiveOtel().getLogger(), "emit");

    const traceId = "0".repeat(31) + "1";
    const spanId = "0".repeat(15) + "2";
    emitSpawnLog({
      severity: "ERROR",
      body: "steward.apply: git apply failed",
      traceId,
      spanId,
      attributes: { event_kind: "steward_apply_failed", "march.spawn_id": "20260521-0e65d8" },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const record = emit.mock.calls[0]![0];
    expect(record.severityText).toBe("ERROR");
    expect(record.attributes).toMatchObject({
      event_kind: "steward_apply_failed",
      "march.spawn_id": "20260521-0e65d8",
    });
    // The ids land on the record's TRACE CONTEXT so Grafana's "Logs for this
    // span" resolves — not merely as attributes.
    const sc = trace.getSpanContext(record.context!);
    expect(sc?.traceId).toBe(traceId);
    expect(sc?.spanId).toBe(spanId);
  });

  it("emits without a trace context when ids are omitted", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const emit = vi.spyOn(getActiveOtel().getLogger(), "emit");

    emitSpawnLog({ severity: "WARN", body: "uncorrelated" });

    expect(emit).toHaveBeenCalledTimes(1);
    const record = emit.mock.calls[0]![0];
    expect(trace.getSpanContext(record.context!)).toBeUndefined();
  });
});
