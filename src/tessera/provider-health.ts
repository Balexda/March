import type { FastifyInstance } from "fastify";
import { observeTesseraExpiry, type TesseraProviderId } from "../observability/tessera-service-metrics.js";
import { isTesseraErrorCode, type ProviderRegistry } from "./models.js";
import type { TesseraStatus } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WARNING_MS = 14 * DAY_MS;
const CHECK_INTERVAL_MS = 60_000;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function monitorProviderHealth(app: FastifyInstance, registry: ProviderRegistry, startedAt: number): () => TesseraStatus {
  // Last observed credential per provider (updated on every successful check) and
  // the time a warning was last emitted for it. A change in the observation
  // re-arms the warning; an unchanged credential keeps daily suppression.
  const observed = new Map<TesseraProviderId, { expiry: number; revision?: object }>();
  const lastWarnedAt = new Map<TesseraProviderId, number>();

  function check(): TesseraStatus {
    const now = Date.now();
    let soonest = Infinity;
    let entries = 0;
    const providers = (["app", "user"] as const).map((identity): TesseraStatus["providers"][number] => {
      const provider = `github-${identity}` as const;
      const source = registry.select(identity);
      try {
        const status = source.status();
        const count = source.cacheSize?.() ?? 0;
        if (Number.isSafeInteger(count) && count >= 0) entries += count;

        const rawExpiry = status.credential_expires_at;
        const expiry = identity === "user" && rawExpiry && RFC3339.test(rawExpiry) ? Date.parse(rawExpiry) : NaN;
        const known = Number.isFinite(expiry);
        const expiry_warning = known && expiry - now <= WARNING_MS;
        const credential_expires_at = known ? new Date(expiry).toISOString() : null;
        if (known) soonest = Math.min(soonest, expiry);

        const previous = observed.get(provider);
        const replaced = previous !== undefined && (previous.revision !== status.credentialRevision ||
          (status.credentialRevision === undefined && !Object.is(previous.expiry, expiry)));
        observed.set(provider, { expiry, revision: status.credentialRevision });
        if (replaced) lastWarnedAt.delete(provider);
        const warnedAt = lastWarnedAt.get(provider);
        if (expiry_warning && (warnedAt === undefined || now - warnedAt >= DAY_MS)) {
          lastWarnedAt.set(provider, now);
          app.log.warn({ event: "tessera.expiry_warning", provider, credential_expires_at }, "Tessera credential is expiring or expired");
        }

        const { state, login, last_error } = status;
        return {
          provider,
          state: state === "ok" || state === "unconfigured" || state === "invalid" ? state : "degraded",
          login: typeof login === "string" && LOGIN.test(login) ? login : null,
          credential_expires_at,
          expiry_warning,
          last_error: isTesseraErrorCode(last_error) ? last_error : null,
        };
      } catch {
        return { provider, state: "degraded", login: null, credential_expires_at: null, expiry_warning: false, last_error: "provider_unavailable" };
      }
    });
    return {
      service: "march-tessera",
      uptime_s: Math.floor((now - startedAt) / 1000),
      providers,
      soonest_expiry: Number.isFinite(soonest) ? new Date(soonest).toISOString() : null,
      cache: { entries },
    };
  }

  let latest: TesseraStatus;
  const refresh = () => (latest = check());
  let interval: NodeJS.Timeout | undefined;
  let stopObserving: (() => void) | undefined;
  app.addHook("onReady", async () => {
    refresh();
    interval = setInterval(refresh, CHECK_INTERVAL_MS).unref();
    stopObserving = observeTesseraExpiry(function* () {
      const now = Date.now();
      for (const status of latest.providers) {
        if (!status.credential_expires_at) continue;
        const remaining = Date.parse(status.credential_expires_at) - now;
        yield { provider: status.provider, secondsRemaining: Math.max(0, Math.floor(remaining / 1000)), warning: remaining <= WARNING_MS };
      }
    });
  });
  app.addHook("onClose", async () => {
    clearInterval(interval);
    stopObserving?.();
  });
  return refresh;
}
