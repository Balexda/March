import type { Counter, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

const SERVICES = new Set(["herald", "brood", "hatchery", "legate", "statio", "steward"]);
export function tesseraConsumerService(env: NodeJS.ProcessEnv): string {
  const name = env.MARCH_OTEL_SERVICE_NAME?.replace(/^march-/, "");
  return name && SERVICES.has(name) ? name : "unknown";
}
let meter: Meter | undefined;
let counter: Counter | undefined;
export function recordTesseraFallback(service: string): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const current = otel.getMeter();
  if (meter !== current) {
    meter = current;
    counter = current.createCounter("march.tessera.client.fallbacks", {
      description: "Ambient GitHub credential migration fallbacks", unit: "1",
    });
  }
  counter!.add(1, { service: SERVICES.has(service) ? service : "unknown" });
}
