import type { Counter, Meter } from "@opentelemetry/api";
import type {
  AccessLevel,
  Identity,
  ProviderId,
  TesseraErrorCode,
} from "../tessera/types.js";
import { getActiveOtel } from "./otel.js";
import { TESSERA_UNRESOLVED } from "./tessera-trace.js";

/**
 * Tessera metrics (contracts "Events / Hooks"): the consumer-side fallback
 * counter, emitted by the Node client inside whichever service calls it, and
 * the server-side issuance and denial counters, emitted by the Tessera
 * service. Instruments are created lazily on the active meter; every function
 * is a complete no-op when telemetry is off and never throws into the caller.
 */

export interface RecordTesseraClientFallbackInput {
  /** The calling service (low-cardinality); the only label. */
  readonly service: string;
}

let cachedMeter: Meter | undefined;
let fallbacksCounter: Counter | undefined;

function fallbacks(meter: Meter): Counter {
  if (meter !== cachedMeter || fallbacksCounter === undefined) {
    fallbacksCounter = meter.createCounter("march.tessera.client.fallbacks", {
      description:
        "Count of GitHub tokens served from GH_TOKEN/GITHUB_TOKEN because Tessera could not issue (migration fallback)",
      unit: "1",
    });
    cachedMeter = meter;
  }
  return fallbacksCounter;
}

/** Count one `env-fallback` result, labelled only by `service`. */
export function recordTesseraClientFallback(input: RecordTesseraClientFallbackInput): void {
  try {
    const otel = getActiveOtel();
    if (!otel.enabled) return;
    fallbacks(otel.getMeter()).add(1, { service: input.service });
  } catch {
    // Telemetry must never break the token call.
  }
}

/*
 * Server-side Tessera counters, emitted by `march tessera serve` once per
 * `POST /v1/github/token` request (contracts "Events / Hooks"). Every label
 * value is drawn from a closed set: anything outside it is recorded as the
 * single placeholder {@link TESSERA_UNRESOLVED}, so no caller-supplied string
 * can ever become a label. No label carries a repository, client name, client
 * key or token.
 */

const IDENTITIES = ["app", "user"] as const satisfies readonly Identity[];
const PROVIDERS = ["github-app", "github-user"] as const satisfies readonly ProviderId[];
const ACCESS_LEVELS = ["read", "write"] as const satisfies readonly AccessLevel[];
const CACHE_RESULTS = ["hit", "miss"] as const;
const DENIAL_REASONS = [
  "unauthorized",
  "policy_denied",
  "invalid_request",
  "repo_not_installed",
  "provider_unconfigured",
  "credential_invalid",
  "provider_unavailable",
  "mint_failed",
  "internal",
] as const satisfies readonly TesseraErrorCode[];
// Compile-time guard: a new error code must be added to DENIAL_REASONS.
const _everyReasonListed: (typeof DENIAL_REASONS)[number] = "internal" as TesseraErrorCode;
void _everyReasonListed;

/** `value` if it is one of `allowed`, else the fixed placeholder. */
function closed(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : TESSERA_UNRESOLVED;
}

export interface RecordTesseraIssuanceInput {
  /** `app` or `user`; anything else is recorded as the placeholder. */
  readonly identity: string | null;
  /** `github-app` or `github-user`; anything else is recorded as the placeholder. */
  readonly provider: string | null;
  /** `read` or `write`; anything else is recorded as the placeholder. */
  readonly access: string | null;
  /** `hit` or `miss`; anything else is recorded as the placeholder. */
  readonly cache: string | null;
}

export interface RecordTesseraDenialInput {
  /** `app` or `user`; unresolved (401, 400) or anything else is the placeholder. */
  readonly identity: string | null;
  /** A Tessera error code; anything else is recorded as the placeholder. */
  readonly reason: string | null;
}

let serverMeter: Meter | undefined;
let issuancesCounter: Counter | undefined;
let denialsCounter: Counter | undefined;

function serverCounters(meter: Meter): { issuances: Counter; denials: Counter } {
  if (meter !== serverMeter || issuancesCounter === undefined || denialsCounter === undefined) {
    issuancesCounter = meter.createCounter("march.tessera.issuances", {
      description: "Count of GitHub tokens issued by Tessera",
      unit: "1",
    });
    denialsCounter = meter.createCounter("march.tessera.denials", {
      description: "Count of Tessera token requests denied or failed, by error code",
      unit: "1",
    });
    serverMeter = meter;
  }
  return { issuances: issuancesCounter, denials: denialsCounter };
}

/** Count one issued token, labelled by identity, provider, access and cache result. */
export function recordTesseraIssuance(input: RecordTesseraIssuanceInput): void {
  try {
    const otel = getActiveOtel();
    if (!otel.enabled) return;
    serverCounters(otel.getMeter()).issuances.add(1, {
      identity: closed(input.identity, IDENTITIES),
      provider: closed(input.provider, PROVIDERS),
      access: closed(input.access, ACCESS_LEVELS),
      cache: closed(input.cache, CACHE_RESULTS),
    });
  } catch {
    // Telemetry must never fail or alter a token request.
  }
}

/** Count one denied or failed token request, labelled by identity and error code. */
export function recordTesseraDenial(input: RecordTesseraDenialInput): void {
  try {
    const otel = getActiveOtel();
    if (!otel.enabled) return;
    serverCounters(otel.getMeter()).denials.add(1, {
      identity: closed(input.identity, IDENTITIES),
      reason: closed(input.reason, DENIAL_REASONS),
    });
  } catch {
    // Telemetry must never fail or alter a token request.
  }
}
