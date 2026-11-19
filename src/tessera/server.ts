import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { recordTesseraDenial, recordTesseraIssuance } from "../observability/tessera-service-metrics.js";
import { emitTesseraSpan } from "../observability/tessera-trace.js";
import { ProviderRegistry, TesseraError, denyAuthorization, isTesseraErrorCode, parseTokenRequest, type AuthorizationBoundary, type CredentialProvider, type ProviderIssueResult, type TesseraErrorCode, type TokenRequest } from "./models.js";

export interface BuildTesseraServerOptions {
  providers?: CredentialProvider[];
  authorize?: AuthorizationBoundary;
  logger?: FastifyBaseLogger | false;
  startedAt?: number;
}

interface IssuanceContext {
  caller: string;
  parsed?: TokenRequest;
  start: number;
  code?: TesseraErrorCode;
  cache?: ProviderIssueResult["cache"];
  expiresAt?: string;
  repo?: string | null;
  subject?: string;
}

export function buildTesseraServer(options: BuildTesseraServerOptions = {}): FastifyInstance {
  const registry = new ProviderRegistry(options.providers ?? []);
  const authorization = options.authorize ?? denyAuthorization;
  const startedAt = options.startedAt ?? Date.now();
  // Silence Fastify's automatic error serializers: they may include request headers or bodies.
  const app = options.logger ? Fastify({ loggerInstance: options.logger, disableRequestLogging: true }) : Fastify({ logger: false });
  const requests = new WeakMap<object, IssuanceContext>();
  app.addHook("onRequest", async (request) => {
    const target = request.url.replace(/^https?:\/\/[^/]+/i, "");
    if (!request.routeOptions.url?.startsWith("/v1/") && !target.startsWith("/v1/")) return;
    const context: IssuanceContext = { caller: "unknown", start: Date.now() };
    requests.set(request, context);
    context.caller = await authorization.authenticate(request.headers.authorization);
  });
  app.addHook("onResponse", async (request, reply) => {
    const context = requests.get(request);
    if (!context || (!context.code && !context.parsed)) return;
    const req = context.parsed;
    const outcome = reply.statusCode === 200 ? "issued" : reply.statusCode < 500 ? "denied" : "failed";
    const provider = req ? (`github-${req.identity}` as const) : null;
    const cache = context.cache ?? "n/a";
    const reason = outcome === "issued" ? null : context.code ?? "mint_failed";
    const fields = { caller: context.caller, identity: req?.identity ?? null, provider, access: req?.access ?? null, cache, outcome, reason };
    app.log.info({
      event: "tessera.audit", ...fields,
      repo: context.repo ?? null,
      expires_at: context.expiresAt ?? null,
      subject: context.subject ?? null,
    }, "Tessera token request completed");
    emitTesseraSpan("tessera.issue", {
      sliceId: typeof request.headers["x-march-slice-id"] === "string" ? request.headers["x-march-slice-id"] : undefined,
      error: outcome !== "issued" || context.code === "provider_unavailable",
      attributes: {
        ...fields, identity: fields.identity ?? "unknown", provider: provider ?? "unknown",
        access: fields.access ?? "unknown", reason: context.code ?? reason ?? "none",
      },
      startTimeMs: context.start,
    });
    if (reason) recordTesseraDenial(req?.identity, reason);
    else if (req && provider) recordTesseraIssuance(req.identity, provider, req.access, cache);
  });
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof TesseraError && isTesseraErrorCode(error.code)
      ? error.code
      : [400, 413, 415].includes((error as { statusCode?: number }).statusCode ?? 0) ? "invalid_request" : "mint_failed";
    const safe = new TesseraError(code);
    const context = requests.get(request);
    if (context) context.code = safe.code;
    if (safe.code === "provider_unavailable") reply.header("Retry-After", "5");
    // Messages are fixed by code: even an injected dependency cannot echo secret material.
    void reply.code(safe.status).send({ error: { code: safe.code, message: safe.message } });
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/status", async () => ({
    service: "march-tessera", uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    providers: (["app", "user"] as const).map(identity => {
      try { return registry.select(identity).status(); }
      catch { return { provider: `github-${identity}`, state: "unconfigured", login: null, credential_expires_at: null, expiry_warning: false, last_error: null }; }
    }), soonest_expiry: null, cache: { entries: registry.all().reduce((total, provider) => total + (provider.cacheSize?.() ?? 0), 0) },
  }));
  app.post("/v1/github/token", async request => {
    const parsed = parseTokenRequest(request.body);
    const context = requests.get(request)!;
    context.parsed = parsed;
    // A repository component can contain a bearer key even after syntax validation.
    const bearer = request.headers.authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
    context.repo = parsed.repo && (!bearer || !parsed.repo.includes(bearer)) ? parsed.repo : null;
    // The reserved subject is echoed for correlation unless it carries credential material.
    if (parsed.subject !== undefined) context.subject = bearer && parsed.subject.includes(bearer) ? "[REDACTED]" : parsed.subject;
    await authorization.authorize(context.caller, parsed);
    const { subject: _auditSubject, ...scope } = parsed;
    const result = await registry.select(parsed.identity).issue(scope);
    context.cache = result.cache === "hit" || result.cache === "miss" ? result.cache : "n/a";
    context.code = result.degradedReason === "provider_unavailable" ? result.degradedReason : undefined;
    const expiryMs = typeof result.expiresAt === "string" ? Date.parse(result.expiresAt) : NaN;
    if (Number.isFinite(expiryMs)) context.expiresAt = new Date(expiryMs).toISOString();
    if (result.token && context.repo?.includes(result.token)) context.repo = null;
    if (result.token && context.subject?.includes(result.token)) context.subject = "[REDACTED]";
    return { token: result.token, expires_at: result.expiresAt, identity: result.identity,
      commit_identity: result.commitIdentity, access: parsed.access, repo: parsed.identity === "app" ? parsed.repo : null };
  });
  return app;
}
