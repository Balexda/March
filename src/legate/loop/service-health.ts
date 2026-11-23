/**
 * Stack service READINESS as the legate sees it (2026-11-22 spawn-credential
 * outage: every spawn failed for 5h while every liveness signal stayed green).
 *
 * Once per tick the legate probes each service it depends on — Hatchery and
 * Brood `/readyz`, Castra and Herald `/healthz`, Tessera `/status` — with a short
 * timeout, folds each answer into one {@link ServiceHealth} (state + human
 * reasons + a one-line operator remedy), and caches the map. `GET /status`
 * serves the cached map under `services`; it never probes inline. The same map
 * drives the `march_stack_service_state{service,state}` gauge. A probe that
 * throws or times out yields a `down` entry; it never breaks the tick.
 */

export const STACK_SERVICES = ["castra", "hatchery", "brood", "herald", "tessera"] as const;
export type StackServiceName = (typeof STACK_SERVICES)[number];

export const SERVICE_STATES = ["ok", "degraded", "down", "absent"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export interface ServiceHealth {
  readonly state: ServiceState;
  readonly checked_at: string;
  readonly reasons: string[];
  readonly remedy: string | null;
  readonly detail: Record<string, unknown> | null;
}

export type ServicesHealth = Partial<Record<StackServiceName, ServiceHealth>>;

/** Per-probe timeout. Short: all probes run concurrently inside the tick. */
export const SERVICE_PROBE_TIMEOUT_MS = 2_000;

const DEFAULT_URLS: Record<StackServiceName, string> = {
  castra: "http://castra:9264",
  hatchery: "http://hatchery:8080",
  brood: "http://brood:9748",
  herald: "http://herald:8818",
  tessera: "http://tessera:9477",
};

const URL_ENV: Record<StackServiceName, string> = {
  castra: "CASTRA_URL",
  hatchery: "MARCH_HATCHERY_URL",
  brood: "MARCH_BROOD_URL",
  herald: "MARCH_HERALD_URL",
  tessera: "MARCH_TESSERA_URL",
};

const PROBE_PATH: Record<StackServiceName, string> = {
  castra: "/healthz",
  hatchery: "/readyz",
  brood: "/readyz",
  herald: "/healthz",
  tessera: "/status",
};

/** The base URL the legate uses for a service (env override, else the compose default). */
export function serviceUrl(name: StackServiceName, env: NodeJS.ProcessEnv): string {
  const explicit = env[URL_ENV[name]]?.trim();
  return (explicit || DEFAULT_URLS[name]).replace(/\/+$/, "");
}

/** Raw outcome of one HTTP probe. */
export type ProbeResult =
  | { readonly answered: true; readonly status: number; readonly body: unknown }
  | { readonly answered: false; readonly error: string };

export type ProbeFn = (url: string, timeoutMs: number) => Promise<ProbeResult>;

/** Bounded transport-error code: the Node error code (ECONNREFUSED, ENOTFOUND, …), "timeout", or "error". */
function transportError(err: unknown): string {
  const e = err as { name?: string; code?: unknown; cause?: { code?: unknown } } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timeout";
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && /^[A-Z_]{2,32}$/.test(code) ? code : "error";
}

/** Default probe: GET with a hard timeout; JSON body when it parses. Never throws. */
export async function fetchProbe(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal, redirect: "error" });
    let body: unknown = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    return { answered: true, status: res.status, body };
  } catch (err) {
    return { answered: false, error: controller.signal.aborted ? "timeout" : transportError(err) };
  } finally {
    clearTimeout(timer);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function startRemedy(name: StackServiceName): string {
  return `Start it: march up (or docker compose -f docker/${name}.docker-compose.yml up -d).`;
}

export const HATCHERY_CREDENTIAL_REMEDY =
  "Hatchery has no GitHub credential: recreate it with MARCH_TESSERA_GH_TOKEN_FALLBACK=1 GH_TOKEN=$(gh auth token) (march up), or configure Tessera.";

function notAnswering(name: StackServiceName, error: string, checkedAt: string): ServiceHealth {
  return { state: "down", checked_at: checkedAt, reasons: [`not answering: ${error}`], remedy: startRemedy(name), detail: null };
}

/** Remedy for a non-ok Hatchery readiness body. */
function hatcheryRemedy(body: Record<string, unknown>): string | null {
  const github = isObject(body.github) ? body.github : undefined;
  if (github && github.ok === false) return HATCHERY_CREDENTIAL_REMEDY;
  const spawns = isObject(body.spawns) ? body.spawns : undefined;
  if (spawns && typeof spawns.consecutive_failures === "number" && spawns.consecutive_failures >= 2) {
    const last = typeof spawns.last_error === "string" ? spawns.last_error : "unknown";
    return `Every recent spawn failed (${last}); see \`march logs hatchery\`.`;
  }
  if (body.castra === false) return "Hatchery cannot reach Castra: " + startRemedy("castra");
  if (body.docker === false) return "Hatchery has no docker: check its /var/run/docker.sock mount, then recreate it (march up).";
  return "See `march logs hatchery`.";
}

/** Fold a `/readyz` answer (Hatchery's rich body, or Brood's booleans) into a ServiceHealth. */
export function readinessHealth(name: "hatchery" | "brood", result: ProbeResult, checkedAt: string): ServiceHealth {
  if (!result.answered) return notAnswering(name, result.error, checkedAt);
  const body = isObject(result.body) ? result.body : undefined;
  let state: ServiceState;
  if (body && (body.state === "ok" || body.state === "degraded" || body.state === "down")) state = body.state;
  else if (body && typeof body.ready === "boolean") state = body.ready ? "ok" : "down";
  else state = result.status >= 200 && result.status < 300 ? "ok" : "down";
  let reasons = body ? stringList(body.reasons) : [];
  if (state !== "ok" && reasons.length === 0) {
    // Older/simpler readyz bodies (Brood): name the false boolean checks.
    const failed = body ? Object.entries(body).filter(([k, v]) => k !== "ready" && v === false).map(([k]) => `${k} check failed`) : [];
    reasons = failed.length > 0 ? failed : [`readyz answered HTTP ${result.status}`];
  }
  const remedy = state === "ok" ? null : name === "hatchery" && body ? hatcheryRemedy(body) : `See \`march logs ${name}\`.`;
  return { state, checked_at: checkedAt, reasons, remedy, detail: body ?? null };
}

/** Fold a `/healthz` liveness answer (Castra, Herald) into a ServiceHealth. */
export function livenessHealth(name: "castra" | "herald", result: ProbeResult, checkedAt: string): ServiceHealth {
  if (!result.answered) return notAnswering(name, result.error, checkedAt);
  const ok = result.status >= 200 && result.status < 300;
  return {
    state: ok ? "ok" : "down",
    checked_at: checkedAt,
    reasons: ok ? [] : [`healthz answered HTTP ${result.status}`],
    remedy: ok ? null : `See \`march logs ${name}\`.`,
    detail: isObject(result.body) ? result.body : null,
  };
}

/**
 * Fold Tessera's `/status` into a ServiceHealth. `absent` (not deployed — the
 * normal state today) when it does not answer AND either no URL is configured
 * or the host does not resolve; `down` when a configured, resolvable Tessera is
 * not answering. Reachable: `ok` when the github-app provider is ok, else
 * `degraded` (unconfigured/degraded/invalid provider).
 */
export function tesseraHealth(result: ProbeResult, urlConfigured: boolean, checkedAt: string): ServiceHealth {
  if (!result.answered) {
    const dns = result.error === "ENOTFOUND" || result.error === "EAI_AGAIN";
    if (!urlConfigured || dns) {
      return { state: "absent", checked_at: checkedAt, reasons: ["not deployed"], remedy: null, detail: null };
    }
    return notAnswering("tessera", result.error, checkedAt);
  }
  const body = isObject(result.body) ? result.body : undefined;
  const providers = body && Array.isArray(body.providers) ? body.providers.filter(isObject) : [];
  const app = providers.find((p) => p.provider === "github-app");
  if (result.status < 200 || result.status >= 300 || !app) {
    return {
      state: "down",
      checked_at: checkedAt,
      reasons: [app ? `status answered HTTP ${result.status}` : "status body has no github-app provider"],
      remedy: "See `march logs tessera`.",
      detail: body ?? null,
    };
  }
  if (app.state === "ok") return { state: "ok", checked_at: checkedAt, reasons: [], remedy: null, detail: body ?? null };
  const lastError = typeof app.last_error === "string" && app.last_error ? `: ${app.last_error}` : "";
  return {
    state: "degraded",
    checked_at: checkedAt,
    reasons: [`github-app provider is ${String(app.state)}${lastError}`],
    remedy: "Configure Tessera's GitHub App (TESSERA_GITHUB_APP_ID, TESSERA_GITHUB_INSTALLATION_ID, TESSERA_GITHUB_APP_KEY_FILE) and recreate it.",
    detail: body ?? null,
  };
}

export interface ProbeServicesOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly probe?: ProbeFn;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/** Probe every stack service concurrently. Never rejects. */
export async function probeServices(opts: ProbeServicesOptions = {}): Promise<ServicesHealth> {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? ((url, timeoutMs) => fetchProbe(url, timeoutMs));
  const timeoutMs = opts.timeoutMs ?? SERVICE_PROBE_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  const entries = await Promise.all(
    STACK_SERVICES.map(async (name): Promise<[StackServiceName, ServiceHealth]> => {
      let result: ProbeResult;
      try {
        result = await probe(serviceUrl(name, env) + PROBE_PATH[name], timeoutMs);
      } catch (err) {
        result = { answered: false, error: transportError(err) };
      }
      const checkedAt = now().toISOString();
      try {
        switch (name) {
          case "hatchery":
          case "brood":
            return [name, readinessHealth(name, result, checkedAt)];
          case "castra":
          case "herald":
            return [name, livenessHealth(name, result, checkedAt)];
          case "tessera":
            return [name, tesseraHealth(result, !!env.MARCH_TESSERA_URL?.trim(), checkedAt)];
        }
      } catch {
        return [name, notAnswering(name, "error", checkedAt)];
      }
    }),
  );
  return Object.fromEntries(entries) as ServicesHealth;
}
