/** @l1 @deterministic @ci */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTesseraAuthorization } from "./authorization.js";
import { GithubAppProvider } from "./github-app.js";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { initOtel, getActiveOtel } from "../observability/otel.js";
import { traceIdForDispatch, spanIdForDispatch } from "../observability/trace-ids.js";
import { PassThrough } from "node:stream";
import { buildTesseraServer } from "./server.js";
import { TesseraError, type CredentialProvider } from "./models.js";
/** Node 20 lacks Promise.withResolvers (CI runs l0 on Node 20). */
function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const allow = { authenticate: () => "test", authorize: () => {} };
const body = { identity: "app", repo: "acme/widgets", access: "write" };
function provider(code?: ConstructorParameters<typeof TesseraError>[0]): CredentialProvider {
  return { id: "github-app", identity: "app", start: async () => {},
    status: () => ({ provider: "github-app", state: "ok", login: "bot[bot]", credential_expires_at: null, expiry_warning: false, last_error: null }),
    issue: async () => { if (code) throw new TesseraError(code); return { token: "SECRET_TOKEN", expiresAt: "2026-11-16T23:00:00Z", identity: "bot[bot]", commitIdentity: {name:"bot[bot]",email:"123+bot[bot]@users.noreply.github.com"}, access: "write", repo:"acme/widgets", cache: "miss" }; },
  };
}
describe("Tessera HTTP contract", () => {
  it("defaults to deny even when a provider is configured, before validation", async () => {
    const app = buildTesseraServer({ providers: [provider()] });
    const res = await app.inject({method:"POST",url:"/v1/github/token",payload:{invalid:true}});
    expect(res.statusCode).toBe(401); expect(res.json().error.code).toBe("unauthorized"); await app.close();
  });
  it("returns the complete entitlement and never logs credentials or unchecked fields", async () => {
    let logs = ""; const stream = new PassThrough(); stream.on("data", chunk => {logs += chunk;});
    const app = buildTesseraServer({ providers:[provider()], authorize:allow, logger:pino({},stream) });
    const res = await app.inject({method:"POST",url:"/v1/github/token",headers:{authorization:"Bearer SECRET_BEARER"},payload:{...body,subject:"spawn-123"}});
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual({token:"SECRET_TOKEN",expires_at:"2026-11-16T23:00:00Z",identity:"bot[bot]",commit_identity:{name:"bot[bot]",email:"123+bot[bot]@users.noreply.github.com"},access:"write",repo:"acme/widgets"});
    expect(logs).toContain('"outcome":"issued"'); expect(logs).toContain('"subject":"spawn-123"'); expect(logs).not.toContain("SECRET"); await app.close();
  });
  for (const [code,status] of [["repo_not_installed",422],["provider_unconfigured",503],["credential_invalid",503],["provider_unavailable",503],["mint_failed",502],["policy_denied",403]] as const) {
    it(`maps ${code}`, async () => {
      const app = buildTesseraServer({providers:[provider(code)],authorize:allow});
      const res = await app.inject({method:"POST",url:"/v1/github/token",payload:body});
      expect(res.statusCode).toBe(status); expect(res.json().error.code).toBe(code);
      if(code === "provider_unavailable") expect(res.headers["retry-after"]).toBe("5"); await app.close();
    });
  }
  it("rejects malformed allowed requests and leaves both unconfigured providers visible",async () => {
    const app = buildTesseraServer({authorize:allow});
    for(const payload of [{...body,token:"SECRET"},{...body,refresh:"yes"},{...body,repo:"bad"},{...body,identity:"other"}]) {
      expect((await app.inject({method:"POST",url:"/v1/github/token",payload})).statusCode).toBe(400);
    }
    expect((await app.inject({method:"POST",url:"/v1/github/token",payload:body})).json().error.code).toBe("provider_unconfigured");
    expect((await app.inject({url:"/healthz"})).json()).toEqual({status:"ok"});
    expect((await app.inject({url:"/status"})).json().providers).toHaveLength(2); await app.close();
  });
});

it("records one safe audit and span per request across completion paths", async () => {
  initOtel({MARCH_OTEL:"1"});
  const tracer=getActiveOtel().getTracer(); const real=tracer.startSpan.bind(tracer); const spans:Span[]=[];
  vi.spyOn(tracer,"startSpan").mockImplementation((...args:Parameters<typeof real>)=>{const span=real(...args) as Span;spans.push(span);return span;});
  try {
    const upstream = provider();
    vi.spyOn(upstream, "issue").mockRejectedValue(new Error("SECRET_UPSTREAM"));
    const cases = [
      { options: {}, outcome: "denied", reason: "unauthorized", payload: body },
      { options: { authorize: allow }, outcome: "denied", reason: "invalid_request", payload: "{SECRET_BODY" },
      { options: { authorize: { ...allow, authorize() { throw new TesseraError("policy_denied"); } } }, outcome: "denied", reason: "policy_denied", payload: { ...body, repo: "acme/SECRET_BEARER" } },
      { options: { authorize: allow, providers: [upstream] }, outcome: "failed", reason: "mint_failed", payload: body },
      { options: { authorize: allow, providers: [provider()] }, outcome: "issued", reason: null, payload: { ...body, subject: "spawn-SECRET_BEARER" } },
    ];
    for (const [index, scenario] of cases.entries()) {
      let logs = "";
      const stream = new PassThrough();
      stream.on("data", chunk => { logs += chunk; });
      const app = buildTesseraServer({ ...scenario.options, logger: pino({}, stream) });
      try {
        const response = await app.inject({
          method: "POST", url: "/v1/github/token", payload: scenario.payload,
          headers: { "content-type": "application/json", "x-march-slice-id": "slice-safe", authorization: "Bearer SECRET_BEARER" },
        });
        if (scenario.reason) {
          expect(response.json().error.code).toBe(scenario.reason);
          expect(response.body).not.toContain("SECRET");
        }
      } finally {
        await app.close();
      }
      const issued = scenario.outcome === "issued";
      const parsed = index >= 2;
      const { outcome, reason } = scenario;
      expect(logs).not.toContain("SECRET");
      expect(logs.trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "tessera.audit"))
        .toEqual([expect.objectContaining({
          caller: index === 0 ? "unknown" : "test",
          identity: parsed ? "app" : null, provider: parsed ? "github-app" : null,
          access: parsed ? "write" : null, repo: index >= 3 ? body.repo : null,
          outcome, reason, cache: issued ? "miss" : "n/a",
          expires_at: issued ? "2026-11-16T23:00:00.000Z" : null,
          subject: issued ? "[REDACTED]" : null,
        })]);
      expect(spans).toHaveLength(index + 1);
      const span = spans[index];
      expect(span.name).toBe("tessera.issue");
      expect(span.status.code).toBe(issued ? SpanStatusCode.UNSET : SpanStatusCode.ERROR);
      expect(span.attributes).toMatchObject({ outcome, reason: reason ?? "none" });
      expect(span.attributes).not.toHaveProperty("repo");
      expect(span.attributes).not.toHaveProperty("subject");
      expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-safe"));
      expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-safe"));
      expect(JSON.stringify(span.attributes)).not.toContain("SECRET");
    }
  // Repo convention: reset to the no-op handle without awaiting shutdown(); its OTLP flush blocks past the test timeout when no collector runs (CI).
  } finally {vi.restoreAllMocks(); initOtel({});}
});
it("treats oversized bodies as invalid requests",async()=>{
 const app=buildTesseraServer({authorize:allow});
 const res=await app.inject({method:"POST",url:"/v1/github/token",payload:{...body,subject:"a".repeat(1048577)}});
 expect(res.statusCode).toBe(400);expect(res.json().error.code).toBe("invalid_request");await app.close();
});

describe("Tessera App token lifecycle over HTTP", () => {
  const hour = 3_600_000;
  const tenMinutes = 600_000;

  async function fakeGithub() {
    let now = Date.parse("2026-11-16T00:00:00Z");
    let unavailable = false;
    const mint = vi.fn(async () => {
      if (unavailable) return new Response(null, { status: 503 });
      return Response.json({
        token: `SECRET_TOKEN_${mint.mock.calls.length}`,
        expires_at: new Date(now + hour).toISOString(),
        repositories: [{ full_name: body.repo }],
      });
    });
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app") return Response.json({ slug: "march" });
      if (path === "/users/march%5Bbot%5D") return Response.json({ login: "march[bot]", id: 123 });
      if (path === "/repos/acme/widgets/installation") return Response.json({ id: 42 });
      expect(path).toBe("/app/installations/42/access_tokens");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        repositories: ["widgets"],
        permissions: { contents: "write", metadata: "read" },
      });
      return mint();
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const provider = new GithubAppProvider({
      appId: "1",
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      now: () => now,
      fetchImpl: transport,
    });
    await provider.start();
    const app = buildTesseraServer({ authorize: allow, providers: [provider] });
    return {
      app,
      mint,
      transport,
      advance: (ms: number) => { now += ms; },
      outage: () => { unavailable = true; },
      issue: (refresh = false) => app.inject({
        method: "POST", url: "/v1/github/token", payload: refresh ? { ...body, refresh } : body,
      }),
      status: async () => (await app.inject({ url: "/status" })).json(),
    };
  }

  it("reuses a scoped token at the ten-minute boundary and refreshes just below it", async () => {
    const github = await fakeGithub();
    try {
      const first = await github.issue();
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        token: "SECRET_TOKEN_1",
        expires_at: "2026-11-16T01:00:00.000Z",
        identity: "march[bot]",
        repo: body.repo,
        commit_identity: { email: "123+march[bot]@users.noreply.github.com" },
      });
      expect(github.transport).toHaveBeenCalledTimes(4);

      github.advance(hour - tenMinutes - 1);
      expect((await github.issue()).json()).toEqual(first.json());
      github.advance(1);
      expect((await github.issue()).json()).toEqual(first.json());
      expect(github.transport).toHaveBeenCalledTimes(4);

      github.advance(1);
      const refreshed = await github.issue();
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({
        token: "SECRET_TOKEN_2",
        expires_at: "2026-11-16T01:50:00.001Z",
      });
      expect(github.mint).toHaveBeenCalledTimes(2);
      expect((await github.status()).cache).toEqual({ entries: 1 });
    } finally {
      await github.app.close();
    }
  });

  it("shares one mint across concurrent requests for the same scope", async () => {
    const github = await fakeGithub();
    const bothRequests = withResolvers<void>();
    let requests = 0;
    github.app.addHook("preHandler", async (request) => {
      if (request.routeOptions.url === "/v1/github/token" && ++requests === 2) bothRequests.resolve();
    });
    const mint = github.mint.getMockImplementation()!;
    github.mint.mockImplementation(async () => {
      await bothRequests.promise;
      return mint();
    });
    try {
      const [first, second] = await Promise.all([github.issue(), github.issue()]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json().token).toBe("SECRET_TOKEN_1");
      expect(second.json()).toEqual(first.json());
      expect(github.mint).toHaveBeenCalledTimes(1);
    } finally {
      await github.app.close();
    }
  });

  it.each([false, true])("records bounded service metrics with telemetry enabled=%s", async (enabled) => {
    const otel = initOtel({ MARCH_OTEL: enabled ? "1" : "0" });
    const meter = otel.getMeter();
    const getMeter = vi.spyOn(otel, "getMeter").mockReturnValue(meter);
    const counters = new Map<string, ReturnType<typeof vi.fn>>();
    vi.spyOn(meter, "createCounter").mockImplementation(name => {
      const add = vi.fn();
      counters.set(name, add);
      return { add };
    });
    const latency = vi.fn();
    const remaining = vi.fn();
    const histogram = vi.spyOn(meter, "createHistogram").mockReturnValue({ record: latency });
    const gauge = vi.spyOn(meter, "createGauge").mockReturnValue({ record: remaining });
    const github = await fakeGithub();
    const mint = github.mint.getMockImplementation()!;
    const bothRequests = withResolvers<void>();
    let requests = 0;
    github.app.addHook("preHandler", async () => { if (++requests === 2) bothRequests.resolve(); });
    github.mint.mockImplementationOnce(async () => {
      await bothRequests.promise;
      const response = await mint();
      response.headers.set("x-ratelimit-remaining", "40");
      return response;
    });
    try {
      const results = await Promise.all([github.issue(), github.issue()]);
      expect(results.map(result => result.statusCode)).toEqual([200, 200]);
      expect((await github.issue()).statusCode).toBe(200);
      github.mint.mockResolvedValueOnce(Response.json({ message: "You exceeded a secondary rate limit SECRET_UPSTREAM" }, {
        status: 429, headers: { "x-ratelimit-remaining": "39" },
      }));
      const denied = await github.issue(true);
      expect(denied.statusCode).toBe(503);
      expect(denied.body).not.toContain("SECRET");
      github.mint.mockResolvedValueOnce(new Response("SECRET_UPSTREAM", { status: 429, headers: { "x-ratelimit-remaining": "0" } }));
      expect((await github.issue(true)).statusCode).toBe(503);
      github.mint.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "10", "x-ratelimit-remaining": "SECRET_HEADER" } }));
      expect((await github.issue(true)).statusCode).toBe(503);
      expect(github.mint).toHaveBeenCalledTimes(4);

      if (!enabled) {
        expect(getMeter).not.toHaveBeenCalled();
        expect(counters.size).toBe(0);
        expect(latency).not.toHaveBeenCalled();
        expect(remaining).not.toHaveBeenCalled();
        return;
      }
      const provider = "github-app";
      expect(histogram).toHaveBeenCalledWith("march.tessera.mint.duration", { unit: "ms" });
      expect(gauge).toHaveBeenCalledWith("march.tessera.github.rate_limit_remaining", { unit: "1" });
      expect(latency.mock.calls).toEqual(["issued", "failed", "failed", "failed"].map(outcome => [
        expect.any(Number), { provider, outcome },
      ]));
      expect(remaining.mock.calls).toEqual([[40, { provider }], [39, { provider }], [0, { provider }]]);
      expect(counters.get("march.tessera.github.secondary_limits")?.mock.calls).toEqual([[1, { provider }]]);
      expect(counters.get("march.tessera.issuances")?.mock.calls).toEqual(["miss", "miss", "hit"].map(cache => [
        1, { provider, identity: "app", access: "write", cache },
      ]));
      expect(counters.get("march.tessera.denials")?.mock.calls).toEqual(Array.from({ length: 3 }, () => [
        1, { identity: "app", reason: "provider_unavailable" },
      ]));
    } finally {
      vi.restoreAllMocks();
      initOtel({});
      await github.app.close();
    }
  });

  it("returns an unexpired token on a GitHub outage, recording the failed refresh", async () => {
    const github = await fakeGithub();
    initOtel({ MARCH_OTEL: "1" });
    const tracer = getActiveOtel().getTracer();
    const startSpan = tracer.startSpan.bind(tracer);
    const spans: Span[] = [];
    const spy = vi.spyOn(tracer, "startSpan").mockImplementation((...args) => {
      const span = startSpan(...args) as Span;
      spans.push(span);
      return span;
    });
    try {
      const first = await github.issue();
      expect(first.statusCode).toBe(200);

      github.advance(hour - 1);
      github.outage();
      const fallback = await github.issue();
      expect(fallback.statusCode).toBe(200);
      expect(fallback.json()).toEqual(first.json());
      expect(github.mint).toHaveBeenCalledTimes(2);
      expect(spans.at(-1)).toMatchObject({
        name: "tessera.issue",
        status: { code: SpanStatusCode.ERROR },
        attributes: { cache: "hit", reason: "provider_unavailable" },
      });
      expect(await github.status()).toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: "github-app", state: "degraded", last_error: "provider_unavailable" }),
        ]),
        cache: { entries: 1 },
      });

      github.advance(1);
      expect((await github.status()).cache).toEqual({ entries: 0 });
      const expired = await github.issue();
      expect(expired.statusCode).toBe(503);
      expect(expired.headers["retry-after"]).toBe("5");
      expect(expired.json().error.code).toBe("provider_unavailable");
      expect(github.mint).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
      initOtel({});
      await github.app.close();
    }
  });

  it("evicts the cached token even when explicit refresh fails", async () => {
    const github = await fakeGithub();
    try {
      expect((await github.issue()).statusCode).toBe(200);
      expect((await github.status()).cache).toEqual({ entries: 1 });

      github.outage();
      const failed = await github.issue(true);
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error.code).toBe("provider_unavailable");
      expect((await github.status()).cache).toEqual({ entries: 0 });

      const next = await github.issue();
      expect(next.statusCode).toBe(503);
      expect(next.json().error.code).toBe("provider_unavailable");
      expect(github.mint).toHaveBeenCalledTimes(3);
    } finally {
      await github.app.close();
    }
  });
});

it("enforces configured grants before issuance and audits correlated denials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tessera-policy-"));
  const keys = join(dir, "keys.json");
  const policy = join(dir, "policy.json");
  const fixtureKey = (client: string) => `SECRET_KEY_${client}`;
  const registrations = ["herald", "brood", "legate"].map(client => ({
    client, key_sha256: createHash("sha256").update(fixtureKey(client)).digest("hex"),
  }));
  const stream = new PassThrough();
  let logs = "";
  stream.on("data", chunk => { logs += chunk; });
  initOtel({ MARCH_OTEL: "1" });
  const tracer = getActiveOtel().getTracer();
  const startSpan = tracer.startSpan.bind(tracer);
  const spans: Span[] = [];
  const spy = vi.spyOn(tracer, "startSpan").mockImplementation((...args) => {
    const span = startSpan(...args) as Span;
    spans.push(span);
    return span;
  });
  let app: ReturnType<typeof buildTesseraServer> | undefined;
  try {
    await writeFile(keys, JSON.stringify(registrations));
    await writeFile(policy, JSON.stringify([
      { client: "herald", identities: ["app"], repos: ["acme/widgets", "march/*"], max_access: "read" },
      { client: "herald", identities: ["app"], repos: ["acme/tools"], max_access: "write" },
      { client: "legate", identities: ["user"], max_access: "read" },
    ]));
    const authorize = await loadTesseraAuthorization({ TESSERA_CLIENT_KEYS_FILE: keys, TESSERA_POLICY_FILE: policy });
    const appProvider = provider();
    const issue = vi.spyOn(appProvider, "issue");
    const userProvider = { ...provider(), id: "github-user", identity: "user" as const };
    const issueUser = vi.spyOn(userProvider, "issue");
    const server = buildTesseraServer({ authorize, providers: [appProvider, userProvider], logger: pino({}, stream) });
    app = server;
    const send = (client: string | undefined, payload: Record<string, unknown> | string, url = "/v1/github/token") =>
      server.inject({
        method: "POST", url, payload,
        headers: {
          "content-type": "application/json",
          "x-march-slice-id": "slice-policy",
          ...(client === undefined ? {} : { authorization: `Bearer ${fixtureKey(client)}` }),
        },
      });

    for (const [client, url] of [[undefined, undefined], ["unknown", undefined], [undefined, "/v1/future"]] as const) {
      const response = await send(client, "{", url);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "unauthorized", message: "Client authentication required" } });
    }
    const invalid = await send("herald", { ...body, subject: { token: "SECRET_BODY" } });
    expect(invalid.statusCode).toBe(400);
    for (const [client, denied] of [
      ["herald", body],
      ["herald", { ...body, repo: "another/widgets", access: "read" }],
      ["herald", { ...body, identity: "user" }],
      ["brood", { ...body, access: "read" }],
      ["legate", { ...body, access: "read" }],
    ] as const) {
      const response = await send(client, { ...denied, refresh: true, subject: "denied-spawn" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: "policy_denied", message: "Request denied by policy" } });
    }
    expect(issue).not.toHaveBeenCalled();
    expect(issueUser).not.toHaveBeenCalled();
    expect(spans.map(span => span.attributes.reason)).toEqual([
      "unauthorized", "unauthorized", "unauthorized", "invalid_request",
      ...Array(5).fill("policy_denied"),
    ]);
    for (const span of spans) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-policy"));
      expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-policy"));
    }

    const scope = { ...body, repo: "MARCH/widgets", access: "read" };
    expect((await send("herald", { ...scope, subject: "spawn-a" })).statusCode).toBe(200);
    expect((await send("herald", { ...scope, subject: "spawn-b" })).statusCode).toBe(200);
    expect(issue.mock.calls).toEqual([[scope], [scope]]);
    expect((await send("herald", { ...body, repo: "acme/tools" })).statusCode).toBe(200);
    expect((await send("legate", { identity: "user", access: "write" })).statusCode).toBe(200);
    expect((await server.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect((await server.inject({ url: "/status" })).statusCode).toBe(200);

    const audit = logs.trim().split("\n").map(line => JSON.parse(line));
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: "unknown", outcome: "denied", reason: "unauthorized", subject: null }),
      expect.objectContaining({ caller: "herald", outcome: "denied", reason: "invalid_request", subject: null }),
      expect.objectContaining({ caller: "herald", outcome: "denied", reason: "policy_denied", subject: "denied-spawn" }),
      expect.objectContaining({ caller: "herald", outcome: "issued", subject: "spawn-a" }),
    ]));
    const attributes = JSON.stringify(spans.map(span => span.attributes));
    for (const secret of ["SECRET", "Bearer ", ...registrations.map(row => row.key_sha256)]) {
      expect(logs).not.toContain(secret);
      expect(attributes).not.toContain(secret);
    }
    expect(attributes).not.toContain("spawn-a");
    expect(attributes).not.toContain("denied-spawn");
  } finally {
    spy.mockRestore();
    initOtel({});
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
