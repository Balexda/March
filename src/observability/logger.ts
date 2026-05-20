import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import pino from "pino";
import { getActiveOtel, otelEnabled } from "./otel.js";

type PinoLogger = pino.Logger;
type LevelWithSilent = pino.LevelWithSilent;

/**
 * Resolve the JSONL log file the hatchery service writes to. Always under a
 * real directory so the file survives even when OTel is off:
 *   $MARCH_HATCHERY_LOG_DIR/hatchery.jsonl  (default ~/.march/logs).
 */
export function resolveHatcheryLogFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir =
    env.MARCH_HATCHERY_LOG_DIR?.trim() ||
    path.join(env.HOME?.trim() || os.homedir(), ".march", "logs");
  return path.join(dir, "hatchery.jsonl");
}

/**
 * Map a pino numeric level to its OpenTelemetry severity. pino levels:
 * trace=10 debug=20 info=30 warn=40 error=50 fatal=60. Exported for testing.
 */
export function pinoLevelToSeverity(level: number): {
  severityNumber: SeverityNumber;
  severityText: string;
} {
  if (level >= 60) return { severityNumber: SeverityNumber.FATAL, severityText: "FATAL" };
  if (level >= 50) return { severityNumber: SeverityNumber.ERROR, severityText: "ERROR" };
  if (level >= 40) return { severityNumber: SeverityNumber.WARN, severityText: "WARN" };
  if (level >= 30) return { severityNumber: SeverityNumber.INFO, severityText: "INFO" };
  if (level >= 20) return { severityNumber: SeverityNumber.DEBUG, severityText: "DEBUG" };
  return { severityNumber: SeverityNumber.TRACE, severityText: "TRACE" };
}

/**
 * Emit one serialized pino JSON line as an OTel log record. Best-effort: a
 * malformed line or a disabled collector must never break the app. Trace
 * context is read from the line itself (injected by {@link traceMixin} at log
 * time) because the bridge runs decoupled from the original call's context.
 */
export function emitOtelLogLine(line: string): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const trimmed = line.trim();
  if (!trimmed) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  const level = typeof record.level === "number" ? record.level : 30;
  const { severityNumber, severityText } = pinoLevelToSeverity(level);
  const timestamp = typeof record.time === "number" ? record.time : Date.now();
  const body = typeof record.msg === "string" ? record.msg : "";

  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "level" || key === "time" || key === "msg") continue;
    if (value === undefined) continue;
    attributes[key] = value;
  }

  otel.getLogger().emit({
    severityNumber,
    severityText,
    body,
    timestamp,
    // api-logs accepts maps/arrays as AnyValue; pino serializers can nest.
    attributes: attributes as Record<string, never>,
  });
}

/** Capture the active span so file lines and OTel records carry trace ids. */
function traceMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

function createOtelBridgeStream(): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      try {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        for (const line of text.split("\n")) {
          if (line.trim()) emitOtelLogLine(line);
        }
      } catch {
        // Logging must never throw into the app.
      }
      callback();
    },
  });
}

export interface HatcheryLoggerOptions {
  readonly logFilePath?: string;
  readonly name?: string;
  readonly level?: LevelWithSilent;
  readonly env?: NodeJS.ProcessEnv;
  /** Synchronous file writes. Default false (buffered); set true in tests/CI. */
  readonly sync?: boolean;
}

/**
 * Build the hatchery service logger: a pino instance that always writes JSONL
 * to a file (durable artifact, mandated independently of telemetry) and, when
 * `MARCH_OTEL=1`, mirrors each record to the OTel logs pipeline so it ships to
 * the lgtm collector. The same instance is wired into Fastify so request logs
 * flow through one pipeline.
 */
export function createHatcheryLogger(
  options: HatcheryLoggerOptions = {},
): PinoLogger {
  const env = options.env ?? process.env;
  const logFilePath = options.logFilePath ?? resolveHatcheryLogFilePath(env);
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });

  const streams: pino.StreamEntry[] = [
    { stream: pino.destination({ dest: logFilePath, sync: options.sync ?? false }) },
  ];
  if (otelEnabled(env)) {
    streams.push({ stream: createOtelBridgeStream() });
  }

  return pino(
    {
      name: options.name ?? "march-hatchery",
      level: options.level ?? "info",
      mixin: traceMixin,
    },
    pino.multistream(streams),
  );
}
