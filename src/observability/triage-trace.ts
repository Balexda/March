import { SpanStatusCode } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

export function emitTriageValidationFailure(code: string): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const span = otel.getTracer().startSpan("triage.verdict.validate", {
    attributes: { "triage.validation.code": code },
  });
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}
