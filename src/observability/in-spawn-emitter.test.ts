/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSpawnOtelContext,
  containerOtelEndpoint,
  encodeResourceAttributes,
  IN_SPAWN_EMITTER_PATH,
  inSpawnEmitterScript,
  wrapEntrypointWithEmitter,
} from "./in-spawn-emitter.js";

describe("in-spawn-emitter helpers", () => {
  it("rewrites localhost/127.0.0.1 to host.docker.internal, leaves others", () => {
    expect(containerOtelEndpoint("http://localhost:4318")).toBe(
      "http://host.docker.internal:4318",
    );
    expect(containerOtelEndpoint("http://127.0.0.1:4318")).toBe(
      "http://host.docker.internal:4318",
    );
    expect(containerOtelEndpoint("http://otel-lgtm:4318")).toBe(
      "http://otel-lgtm:4318",
    );
  });

  it("encodes resource attributes and drops blanks", () => {
    expect(
      encodeResourceAttributes({
        "service.name": "march-spawn",
        "march.task.type": "forge",
        "march.slice_id": "",
      }),
    ).toBe("service.name=march-spawn,march.task.type=forge");
  });

  it("returns no context when telemetry is off (no traceparent)", () => {
    expect(
      buildSpawnOtelContext({ traceparent: undefined, attributes: {} }),
    ).toBeUndefined();
  });

  it("builds a container context from a traceparent + host endpoint", () => {
    const ctx = buildSpawnOtelContext({
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      attributes: { "service.name": "march-spawn", "march.backend": "codex" },
      hostEndpoint: "http://localhost:4318",
    });
    expect(ctx).toEqual({
      endpoint: "http://host.docker.internal:4318",
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      resourceAttributes: "service.name=march-spawn,march.backend=codex",
    });
  });

  it("wraps an sh -c entrypoint, preserving the command and exit code", () => {
    const wrapped = wrapEntrypointWithEmitter([
      "sh",
      "-c",
      "claude -p hi",
    ]);
    expect(wrapped[0]).toBe("sh");
    expect(wrapped[1]).toBe("-c");
    expect(wrapped[2]).toContain("( claude -p hi )");
    expect(wrapped[2]).toContain(`node ${IN_SPAWN_EMITTER_PATH}`);
    expect(wrapped[2]).toContain("exit $__rc");
  });

  it("leaves a non sh -c entrypoint unchanged", () => {
    const argv = ["codex", "exec"];
    expect(wrapEntrypointWithEmitter(argv)).toBe(argv);
  });
});

describe("in-spawn-emitter script", () => {
  let server: http.Server | undefined;
  const tmpFiles: string[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
  });

  it("POSTs a valid OTLP span derived from the traceparent + exit code", async () => {
    const received = new Promise<{ url: string; body: string }>((resolve) => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          resolve({ url: req.url ?? "", body });
        });
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server!.address() as { port: number }).port;

    const scriptPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "otel-emit-test-")),
      "otel-emit.js",
    );
    tmpFiles.push(scriptPath);
    fs.writeFileSync(scriptPath, inSpawnEmitterScript(), "utf-8");

    const traceId = "a".repeat(32);
    const parentSpanId = "b".repeat(16);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, "0", "1"], {
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          TRACEPARENT: `00-${traceId}-${parentSpanId}-01`,
          OTEL_RESOURCE_ATTRIBUTES:
            "service.name=march-spawn,march.task.type=forge",
        },
        stdio: "ignore",
      });
      child.on("exit", () => resolve());
      child.on("error", reject);
    });

    const { url, body } = await received;
    expect(url).toBe("/v1/traces");
    const payload = JSON.parse(body);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe(traceId);
    expect(span.parentSpanId).toBe(parentSpanId);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.spanId).not.toBe(parentSpanId);
    expect(span.name).toBe("spawn.exec");
    expect(span.status.code).toBe(2); // exit 1 -> ERROR
    expect(span.attributes).toContainEqual({
      key: "exit_code",
      value: { intValue: "1" },
    });
    const resourceAttrs = payload.resourceSpans[0].resource.attributes;
    expect(resourceAttrs).toContainEqual({
      key: "service.name",
      value: { stringValue: "march-spawn" },
    });
  });
});
