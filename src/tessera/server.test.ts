/** @l1 @deterministic @ci */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { generateKeyPairSync } from "node:crypto";
import { GithubAppProvider } from "./github-app.js";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { initOtel, getActiveOtel } from "../observability/otel.js";
import { traceIdForDispatch, spanIdForDispatch } from "../observability/trace-ids.js";
import { PassThrough } from "node:stream";
import { buildTesseraServer } from "./server.js";
import { TesseraError, type CredentialProvider } from "./models.js";
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
    const res = await app.inject({method:"POST",url:"/v1/github/token",headers:{authorization:"Bearer SECRET_BEARER"},payload:{...body,subject:"SECRET_SUBJECT"}});
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual({token:"SECRET_TOKEN",expires_at:"2026-11-16T23:00:00Z",identity:"bot[bot]",commit_identity:{name:"bot[bot]",email:"123+bot[bot]@users.noreply.github.com"},access:"write",repo:"acme/widgets"});
    expect(logs).toContain('"outcome":"issued"'); expect(logs).not.toContain("SECRET"); await app.close();
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

it("emits safe errored HTTP spans for denial, malformed input, and provider failure", async () => {
  initOtel({MARCH_OTEL:"1"});
  const tracer=getActiveOtel().getTracer(); const real=tracer.startSpan.bind(tracer); const spans:Span[]=[];
  vi.spyOn(tracer,"startSpan").mockImplementation((...args:Parameters<typeof real>)=>{const span=real(...args) as Span;spans.push(span);return span;});
  try {
    for(const options of [{}, {authorize:allow}, {authorize:allow,providers:[provider("provider_unavailable")]}]) {
      const app=buildTesseraServer(options);
      await app.inject({method:"POST",url:"/v1/github/token",headers:{"x-march-slice-id":"slice-safe",authorization:"Bearer SECRET_BEARER"},payload:options.providers ? body : {...body,secret:"SECRET_BODY"}});
      await app.close();
    }
    expect(spans).toHaveLength(3);
    for(const span of spans) {
      expect(span.name).toBe("tessera.issue"); expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-safe"));
      expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-safe"));
      expect(JSON.stringify(span.attributes)).not.toContain("SECRET");
    }
  } finally {vi.restoreAllMocks(); initOtel({});}
});
it("treats oversized bodies as invalid requests",async()=>{
 const app=buildTesseraServer({authorize:allow});
 const res=await app.inject({method:"POST",url:"/v1/github/token",payload:{...body,subject:"a".repeat(1048577)}});
 expect(res.statusCode).toBe(400);expect(res.json().error.code).toBe("invalid_request");await app.close();
});

it("issues over HTTP through the App provider against fake GitHub", async () => {
 const now=Date.parse("2026-11-16T00:00:00Z");
 const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
 const transport=vi.fn<typeof fetch>(async (url, init)=>{
  const path=new URL(String(url)).pathname;
  if(path==="/app") return Response.json({slug:"march"});
  if(path.startsWith("/users/")) return Response.json({login:"march[bot]",id:123});
  if(path==="/repos/acme/widgets/installation") return Response.json({id:42});
  expect(path).toBe("/app/installations/42/access_tokens");
  expect(JSON.parse(String(init?.body))).toMatchObject({repositories:["widgets"],permissions:{contents:"write",metadata:"read"}});
  return Response.json({token:"SECRET_TOKEN",expires_at:"2026-11-16T01:00:00Z",repositories:[{full_name:"acme/widgets"}]});
 });
 const provider=new GithubAppProvider({appId:"1",privateKey:privateKey.export({format:"pem",type:"pkcs8"}).toString(),now:()=>now,fetchImpl:transport});
 await provider.start();
 const app=buildTesseraServer({authorize:allow,providers:[provider]});
 try {
  const res=await app.inject({method:"POST",url:"/v1/github/token",payload:body});
  expect(res.statusCode).toBe(200);expect(res.json()).toMatchObject({token:"SECRET_TOKEN",identity:"march[bot]",repo:"acme/widgets",commit_identity:{email:"123+march[bot]@users.noreply.github.com"}});
  expect(transport).toHaveBeenCalledTimes(4);
 } finally {await app.close();}
});
