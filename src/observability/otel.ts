import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { logs, type Logger } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { CLI_VERSION } from "../shared/version.js";

const INSTRUMENTATION_SCOPE = "march";
const DEFAULT_ENDPOINT = "http://localhost:4318";
const METRIC_EXPORT_INTERVAL_MS = 15000;
const FLUSH_TIMEOUT_MS = 4000;

/**
 * Handle returned by {@link initOtel}. When telemetry is disabled this is a
 * no-op: `getTracer`/`getMeter` return the API's default no-op implementations
 * and `shutdown` resolves immediately, so the rest of the codebase can call
 * into observability unconditionally with zero behavioural impact.
 */
export interface OtelHandle {
  readonly enabled: boolean;
  getTracer(): Tracer;
  getMeter(): Meter;
  getLogger(): Logger;
  shutdown(): Promise<void>;
}

/** Resolve the OTLP/HTTP base endpoint (no trailing slash); falls back to DEFAULT_ENDPOINT. */
export function resolveOtelEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit =
    env.MARCH_OTEL_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return (explicit && explicit.length > 0 ? explicit : DEFAULT_ENDPOINT).replace(
    /\/+$/,
    "",
  );
}

/** Telemetry is opt-in: only active when MARCH_OTEL=1. */
export function otelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARCH_OTEL === "1";
}

const NOOP_HANDLE: OtelHandle = {
  enabled: false,
  getTracer: () => trace.getTracer(INSTRUMENTATION_SCOPE),
  getMeter: () => metrics.getMeter(INSTRUMENTATION_SCOPE),
  getLogger: () => logs.getLogger(INSTRUMENTATION_SCOPE),
  shutdown: async () => {},
};

let active: OtelHandle = NOOP_HANDLE;

/** The handle established by the most recent {@link initOtel} call. */
export function getActiveOtel(): OtelHandle {
  return active;
}

/**
 * Initialise OpenTelemetry for a short-lived CLI process. Uses manual providers
 * (not the auto SDK) so `shutdown` can deterministically force-flush before the
 * process exits — the CLI exits as soon as the event loop drains, so batched
 * spans/metrics would otherwise be dropped. Exporter/flush failures are
 * swallowed: a missing collector must never change a command's outcome.
 */
export function initOtel(env: NodeJS.ProcessEnv = process.env): OtelHandle {
  if (!otelEnabled(env)) {
    active = NOOP_HANDLE;
    return active;
  }

  const base = resolveOtelEndpoint(env);
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]:
      env.MARCH_OTEL_SERVICE_NAME?.trim() || "march",
    [ATTR_SERVICE_VERSION]: CLI_VERSION,
  });

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces` })),
    ],
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
  });

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${base}/v1/logs` }),
      ),
    ],
  });
  // Register globally so emitters that resolve a logger via the API (rather
  // than the handle) land on this provider too.
  logs.setGlobalLoggerProvider(loggerProvider);

  active = {
    enabled: true,
    getTracer: () => tracerProvider.getTracer(INSTRUMENTATION_SCOPE),
    getMeter: () => meterProvider.getMeter(INSTRUMENTATION_SCOPE),
    getLogger: () => loggerProvider.getLogger(INSTRUMENTATION_SCOPE),
    shutdown: async () => {
      await withTimeout(safe(() => tracerProvider.forceFlush()));
      await withTimeout(safe(() => meterProvider.forceFlush()));
      await withTimeout(safe(() => loggerProvider.forceFlush()));
      await safe(() => tracerProvider.shutdown());
      await safe(() => meterProvider.shutdown());
      await safe(() => loggerProvider.shutdown());
    },
  };
  return active;
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Telemetry must never fail or alter the CLI command.
  }
}

function withTimeout(promise: Promise<void>): Promise<void> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref()),
  ]);
}
