import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { emitTesseraSpan } from "../observability/tessera-trace.js";
import { ProviderRegistry, TesseraError, denyAuthorization, parseTokenRequest, type AuthorizationBoundary, type CredentialProvider, type ProviderIssueResult, type TokenRequest } from "./models.js";

export interface BuildTesseraServerOptions {
  providers?: CredentialProvider[];
  authorize?: AuthorizationBoundary;
  logger?: FastifyBaseLogger | false;
  startedAt?: number;
}

export function buildTesseraServer(options: BuildTesseraServerOptions = {}): FastifyInstance {
  const registry = new ProviderRegistry(options.providers ?? []);
  const authorization = options.authorize ?? denyAuthorization;
  const startedAt = options.startedAt ?? Date.now();
  // Silence Fastify's automatic error serializers: they may include request headers or bodies.
  const app = options.logger ? Fastify({ loggerInstance: options.logger, disableRequestLogging: true }) : Fastify({ logger: false });
  const requests = new WeakMap<object, { caller: string; parsed?: TokenRequest; start: number; code?: string; cache?: ProviderIssueResult["cache"] }>();
  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.url !== "/v1/github/token") return;
    const context = { caller: "unknown", start: Date.now() };
    requests.set(request, context);
    context.caller = await authorization.authenticate(request.headers.authorization);
  });
  app.addHook("onResponse", async (request, reply) => {
    const context = requests.get(request);
    if (!context) return;
    const req = context.parsed;
    const outcome = reply.statusCode === 200 ? "issued" : reply.statusCode < 500 ? "denied" : "failed";
    // Caller names come from the trusted authorization boundary; no raw user input is logged.
    const fields = { caller: context.caller, identity: req?.identity ?? "unknown", provider: req ? `github-${req.identity}` : "unknown", access: req?.access ?? "unknown", cache: context.cache ?? "n/a", outcome, reason: context.code ?? "none" };
    emitTesseraSpan("tessera.issue", { sliceId: typeof request.headers["x-march-slice-id"] === "string" ? request.headers["x-march-slice-id"] : undefined, error: reply.statusCode >= 400 || context.code === "provider_unavailable", attributes: fields, startTimeMs: context.start });
    app.log.info(fields, "tessera issuance handled");
  });
  app.setErrorHandler((error, request, reply) => {
    const safe = error instanceof TesseraError ? error : new TesseraError([400, 413, 415].includes((error as {statusCode?: number}).statusCode ?? 0) ? "invalid_request" : "mint_failed");
    const context = requests.get(request);
    if (context) context.code = safe.code;
    if (safe.code === "provider_unavailable") reply.header("Retry-After", "5");
    // Messages are fixed by code: even an injected dependency cannot echo secret material.
    void reply.code(safe.status).send({ error: { code: safe.code, message: new TesseraError(safe.code).message } });
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
    await authorization.authorize(context.caller, parsed);
    const result = await registry.select(parsed.identity).issue(parsed);
    context.cache = result.cache;
    context.code = result.degradedReason;
    return { token: result.token, expires_at: result.expiresAt, identity: result.identity,
      commit_identity: result.commitIdentity, access: parsed.access, repo: parsed.identity === "app" ? parsed.repo : null };
  });
  return app;
}
