import { describe, expect, it, vi } from "vitest";
import { emitActionEventLog, emitActionEventSpan } from "./loop-telemetry.js";

describe("emitActionEventSpan", () => {
  it("ignores non-objects and events without a slice_id", () => {
    const emit = vi.fn();
    emitActionEventSpan(null, emit);
    emitActionEventSpan({ kind: "dispatch_action" }, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits a root legate.dispatch span for a dispatch action", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "dispatch_action", action: "dispatch", slice_id: "s" }, emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "legate.dispatch", traceKey: "s", root: true }));
  });

  it("marks a dispatch_failure as an errored root span", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "dispatch_failure", slice_id: "s", error: "boom" }, emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "legate.dispatch", root: true, error: true }));
  });

  it("emits non-root babysit / cleanup spans", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "babysit_action", slice_id: "s", action: "nudge" }, emit);
    emitActionEventSpan({ kind: "cleanup", slice_id: "s", pr_state: "MERGED" }, emit);
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "legate.babysit", root: false }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "legate.cleanup", root: false }));
  });
});

describe("emitActionEventLog", () => {
  it("ignores events without a kind", () => {
    const emit = vi.fn();
    emitActionEventLog({ slice_id: "s" }, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it("maps *_failure and sync_warning to ERROR, everything else to INFO", () => {
    const emit = vi.fn();
    emitActionEventLog({ kind: "dispatch_failure", error: "boom", slice_id: "s" }, emit);
    emitActionEventLog({ kind: "sync_warning", detail: "stale" }, emit);
    emitActionEventLog({ kind: "cleanup", slice_id: "s" }, emit);
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({ severity: "ERROR", eventKind: "dispatch_failure", sliceId: "s" }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({ severity: "ERROR", eventKind: "sync_warning" }));
    expect(emit).toHaveBeenNthCalledWith(3, expect.objectContaining({ severity: "INFO", eventKind: "cleanup" }));
  });

  it("builds the body from the first available detail field", () => {
    const emit = vi.fn();
    emitActionEventLog({ kind: "dispatch_action", detail: "queued" }, emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ body: "dispatch_action: queued" }));
  });
});
