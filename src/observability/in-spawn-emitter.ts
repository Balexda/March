import { resolveOtelEndpoint } from "./otel.js";

/**
 * In-container OpenTelemetry emission for the ephemeral spawn sandbox.
 *
 * The headless agent (claude/codex) runs inside a hardened, no-egress-by-default
 * container, so it can't use the OTEL SDK against a host collector directly.
 * Instead the orchestrator (a) injects an OTLP endpoint + W3C traceparent into
 * the container, (b) copies the tiny CommonJS emitter below to
 * {@link IN_SPAWN_EMITTER_PATH}, and (c) wraps the backend entrypoint so that
 * after the agent exits, the emitter POSTs one `spawn.exec` span — the headless
 * agent run — as a child of the dispatch trace. Everything here is gated by the
 * caller passing a {@link SpawnOtelContext}; without it the entrypoint and env
 * are untouched and the sandbox keeps its no-egress posture.
 */

/** In-container path the emitter script is copied to. */
export const IN_SPAWN_EMITTER_PATH = "/march/otel-emit.js";

/** Telemetry context injected into a spawn so it can emit to the collector. */
export interface SpawnOtelContext {
  /** Collector endpoint reachable from inside the container. */
  readonly endpoint: string;
  /** W3C traceparent of the parent (dispatch) span. */
  readonly traceparent: string;
  /** OTLP resource attributes, encoded as `k=v,k=v`. */
  readonly resourceAttributes: string;
}

/**
 * Rewrite a host collector endpoint so it's reachable from a bridge-network
 * container. `localhost`/`127.0.0.1` become `host.docker.internal` (paired with
 * `--add-host host.docker.internal:host-gateway` at launch). Any other host
 * (e.g. a compose service name) is assumed already reachable and left as-is.
 */
export function containerOtelEndpoint(hostEndpoint: string): string {
  return hostEndpoint
    .replace("//localhost:", "//host.docker.internal:")
    .replace("//127.0.0.1:", "//host.docker.internal:");
}

/** Encode resource attributes as the OTEL `k=v,k=v` env format (drops blanks). */
export function encodeResourceAttributes(
  attributes: Record<string, string>,
): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

/**
 * Build the telemetry context to inject into a spawn, or undefined when
 * telemetry is off (no traceparent → orchestrator OTEL disabled).
 */
export function buildSpawnOtelContext(input: {
  readonly traceparent: string | undefined;
  readonly attributes: Record<string, string>;
  readonly hostEndpoint?: string;
}): SpawnOtelContext | undefined {
  if (!input.traceparent) return undefined;
  const host = input.hostEndpoint ?? resolveOtelEndpoint();
  return {
    endpoint: containerOtelEndpoint(host),
    traceparent: input.traceparent,
    resourceAttributes: encodeResourceAttributes(input.attributes),
  };
}

/**
 * Wrap a backend `["sh","-c", cmd]` entrypoint so it times the agent run and
 * emits a span afterwards. Non-`sh -c` shapes are returned unchanged. The
 * emitter is best-effort (`2>/dev/null || true`) and the original exit code is
 * always preserved.
 */
export function wrapEntrypointWithEmitter(
  argv: readonly string[],
): readonly string[] {
  if (argv.length !== 3 || argv[0] !== "sh" || argv[1] !== "-c") return argv;
  const cmd = argv[2];
  const wrapped =
    `__ms=$(date +%s%N 2>/dev/null || echo 0); ` +
    `( ${cmd} ); __rc=$?; ` +
    `node ${IN_SPAWN_EMITTER_PATH} "$__ms" "$__rc" 2>/dev/null || true; ` +
    `exit $__rc`;
  return ["sh", "-c", wrapped];
}

/**
 * The CommonJS emitter copied into the container. Reads the injected env +
 * `argv[2]` (start epoch nanos) and `argv[3]` (agent exit code), then POSTs a
 * single OTLP/HTTP JSON span. Pure stdlib (no deps in the image); all errors
 * are swallowed so it can never affect the spawn.
 */
export function inSpawnEmitterScript(): string {
  return `"use strict";
const crypto = require("crypto");
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const traceparent = process.env.TRACEPARENT || "";
const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(traceparent);
if (!endpoint || !m) process.exit(0);
const traceId = m[1];
const parentSpanId = m[2];
const spanId = crypto.randomBytes(8).toString("hex");
const spanName = process.env.MARCH_SPAN_NAME || "spawn.exec";
const exitCode = parseInt(process.argv[3] || "0", 10) || 0;
const nowNanos = BigInt(Date.now()) * 1000000n;
let startNanos = nowNanos;
try {
  const parsed = BigInt(process.argv[2] || "0");
  if (parsed > 0n && parsed <= nowNanos) startNanos = parsed;
} catch (e) {}
const attrs = [];
for (const pair of (process.env.OTEL_RESOURCE_ATTRIBUTES || "").split(",")) {
  const i = pair.indexOf("=");
  if (i <= 0) continue;
  attrs.push({ key: pair.slice(0, i).trim(), value: { stringValue: pair.slice(i + 1).trim() } });
}
const payload = {
  resourceSpans: [{
    resource: { attributes: attrs },
    scopeSpans: [{
      scope: { name: "march-spawn" },
      spans: [{
        traceId: traceId,
        spanId: spanId,
        parentSpanId: parentSpanId,
        name: spanName,
        kind: 1,
        startTimeUnixNano: startNanos.toString(),
        endTimeUnixNano: nowNanos.toString(),
        attributes: [{ key: "exit_code", value: { intValue: String(exitCode) } }],
        status: { code: exitCode === 0 ? 1 : 2 },
      }],
    }],
  }],
};
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3000);
fetch(endpoint + "/v1/traces", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: controller.signal,
}).catch(() => {}).finally(() => clearTimeout(timer));
`;
}
