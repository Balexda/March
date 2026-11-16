/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCastraLogger,
  createHatcheryLogger,
  createServiceLogger,
  emitOtelLogLine,
  pinoLevelToSeverity,
  resolveCastraLogFilePath,
  resolveHatcheryLogFilePath,
  createTesseraClientLogger,
  createTesseraLogger,
  createStatioLogger,
  REDACT_CENSOR,
  TESSERA_REDACT_CENSOR,
  TESSERA_REDACT_PATHS,
  resolveTesseraClientLogFilePath,
  resolveTesseraLogFilePath,
} from "./logger.js";
import { SeverityNumber } from "@opentelemetry/api-logs";

describe("resolveHatcheryLogFilePath", () => {
  it("prefers MARCH_HATCHERY_LOG_DIR", () => {
    expect(
      resolveHatcheryLogFilePath({ MARCH_HATCHERY_LOG_DIR: "/march/logs" }),
    ).toBe(path.join("/march/logs", "hatchery.jsonl"));
  });

  it("falls back to HOME/.march/logs", () => {
    expect(resolveHatcheryLogFilePath({ HOME: "/home/u" })).toBe(
      path.join("/home/u", ".march", "logs", "hatchery.jsonl"),
    );
  });
});

describe("resolveCastraLogFilePath", () => {
  it("prefers MARCH_CASTRA_LOG_DIR", () => {
    expect(
      resolveCastraLogFilePath({ MARCH_CASTRA_LOG_DIR: "/march/logs" }),
    ).toBe(path.join("/march/logs", "castra.jsonl"));
  });

  it("falls back to HOME/.march/logs", () => {
    expect(resolveCastraLogFilePath({ HOME: "/home/u" })).toBe(
      path.join("/home/u", ".march", "logs", "castra.jsonl"),
    );
  });
});

describe("resolveTesseraLogFilePath", () => {
  it("prefers MARCH_TESSERA_LOG_DIR", () => {
    expect(
      resolveTesseraLogFilePath({ MARCH_TESSERA_LOG_DIR: "/march/logs" }),
    ).toBe(path.join("/march/logs", "tessera.jsonl"));
  });

  it("falls back to HOME/.march/logs", () => {
    expect(resolveTesseraLogFilePath({ HOME: "/home/u" })).toBe(
      path.join("/home/u", ".march", "logs", "tessera.jsonl"),
    );
  });
});

describe("createTesseraLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-tessera-log-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes JSONL tagged march-tessera under MARCH_TESSERA_LOG_DIR", () => {
    const logger = createTesseraLogger({
      env: { MARCH_TESSERA_LOG_DIR: dir },
      sync: true,
      stdout: new PassThrough(),
    });
    logger.info("tessera started");

    const lines = fs
      .readFileSync(path.join(dir, "tessera.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("march-tessera");
    expect(lines[0].msg).toBe("tessera started");
  });
});

describe("createTesseraClientLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-tessera-client-log-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves tessera-client.jsonl under MARCH_TESSERA_LOG_DIR, else HOME/.march/logs", () => {
    expect(resolveTesseraClientLogFilePath({ MARCH_TESSERA_LOG_DIR: "/march/logs" })).toBe(
      path.join("/march/logs", "tessera-client.jsonl"),
    );
    expect(resolveTesseraClientLogFilePath({ HOME: "/home/u" })).toBe(
      path.join("/home/u", ".march", "logs", "tessera-client.jsonl"),
    );
  });

  it("writes JSONL to the file only, never to stdout", () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write");
    const logger = createTesseraClientLogger({ env: { MARCH_TESSERA_LOG_DIR: dir } });
    logger.warn({ reason: "unreachable" }, "fell back");

    const lines = fs
      .readFileSync(path.join(dir, "tessera-client.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("march-tessera-client");
    expect(lines[0].reason).toBe("unreachable");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});

describe("pinoLevelToSeverity", () => {
  it("maps pino numeric levels to OTel severities", () => {
    expect(pinoLevelToSeverity(10).severityNumber).toBe(SeverityNumber.TRACE);
    expect(pinoLevelToSeverity(20).severityNumber).toBe(SeverityNumber.DEBUG);
    expect(pinoLevelToSeverity(30).severityNumber).toBe(SeverityNumber.INFO);
    expect(pinoLevelToSeverity(40).severityNumber).toBe(SeverityNumber.WARN);
    expect(pinoLevelToSeverity(50).severityNumber).toBe(SeverityNumber.ERROR);
    expect(pinoLevelToSeverity(60).severityNumber).toBe(SeverityNumber.FATAL);
    expect(pinoLevelToSeverity(30).severityText).toBe("INFO");
  });
});

describe("emitOtelLogLine", () => {
  it("is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      emitOtelLogLine(JSON.stringify({ level: 30, time: 1, msg: "hi" })),
    ).not.toThrow();
  });

  it("ignores malformed lines without throwing", () => {
    expect(() => emitOtelLogLine("not json")).not.toThrow();
    expect(() => emitOtelLogLine("")).not.toThrow();
  });

  it("accepts lines carrying trace_id/span_id without throwing", () => {
    expect(() =>
      emitOtelLogLine(
        JSON.stringify({
          level: 30,
          time: 1,
          msg: "castra send accepted",
          trace_id: "0af7651916cd43dd8448eb211c80319c",
          span_id: "b7ad6b7169203331",
        }),
      ),
    ).not.toThrow();
  });
});

describe("createHatcheryLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-hatchery-log-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes JSONL to the file even when telemetry is off", () => {
    const logFilePath = path.join(dir, "nested", "hatchery.jsonl");
    const logger = createHatcheryLogger({
      logFilePath,
      env: {}, // MARCH_OTEL unset -> file + stdout sinks
      sync: true,
      stdout: new PassThrough(), // swallow stdout; this test asserts the file sink
    });
    logger.info({ job_id: "abc" }, "spawn started");

    const lines = fs
      .readFileSync(logFilePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe("spawn started");
    expect(lines[0].job_id).toBe("abc");
    expect(lines[0].level).toBe(30);
  });
});

describe("createServiceLogger — stdout capture", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-svc-log-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("streams every record to stdout so `docker logs` (and `march logs`) sees it", () => {
    const logFilePath = path.join(dir, "svc.jsonl");
    const stdout = new PassThrough();
    const captured: string[] = [];
    stdout.on("data", (c: Buffer) => captured.push(c.toString("utf-8")));

    const logger = createServiceLogger({
      serviceName: "march-test",
      logFilePath,
      env: {}, // MARCH_OTEL unset
      sync: true,
      stdout,
    });
    logger.info({ slice: "x" }, "observed");

    const lines = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("march-test");
    expect(lines[0].msg).toBe("observed");
    expect(lines[0].slice).toBe("x");
    // The durable file sink still receives the same record.
    expect(fs.readFileSync(logFilePath, "utf-8")).toContain("observed");
  });
});

describe("createCastraLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-castra-log-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes JSONL tagged march-castra even when telemetry is off", () => {
    const logFilePath = path.join(dir, "nested", "castra.jsonl");
    const logger = createCastraLogger({
      logFilePath,
      env: {}, // MARCH_OTEL unset -> file + stdout sinks
      sync: true,
      stdout: new PassThrough(), // swallow stdout; this test asserts the file sink
    });
    logger.info({ profile: "march" }, "session launched");

    const lines = fs
      .readFileSync(logFilePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("march-castra");
    expect(lines[0].msg).toBe("session launched");
    expect(lines[0].profile).toBe("march");
  });
});

/** Credential-bearing fields, at the top level and one level down. */
const CREDENTIAL_RECORD = {
  token: "tok-top",
  authorization: "Bearer auth-top",
  clientKey: "ck-top",
  key_sha256: "sha-top",
  password: "pw-top",
  headers: { authorization: "Bearer auth-headers" },
  req: { headers: { authorization: "Bearer auth-req" } },
  entitlement: { token: "tok-nested", clientKey: "ck-nested", key_sha256: "sha-nested" },
  login: { password: "pw-nested", authorization: "Bearer auth-nested" },
  kept: "visible",
};
const CREDENTIAL_VALUES = [
  "tok-top",
  "auth-top",
  "ck-top",
  "sha-top",
  "pw-top",
  "auth-headers",
  "auth-req",
  "tok-nested",
  "ck-nested",
  "sha-nested",
  "pw-nested",
  "auth-nested",
];

describe("Tessera logger redaction", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-tessera-redact-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readLines(file: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("covers the credential-bearing paths with a fixed censor", () => {
    expect(REDACT_CENSOR).toBe("[redacted]");
    // The Tessera name is an alias of the service-neutral censor.
    expect(TESSERA_REDACT_CENSOR).toBe(REDACT_CENSOR);
    for (const p of [
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "headers.authorization",
      "req.headers.authorization",
      "clientKey",
      "*.clientKey",
      "key_sha256",
      "*.key_sha256",
      "password",
      "*.password",
    ]) {
      expect(TESSERA_REDACT_PATHS).toContain(p);
    }
  });

  it("redacts credential fields from the service logger, on stdout and in the file", () => {
    const stdout = new PassThrough();
    const captured: string[] = [];
    stdout.on("data", (c: Buffer) => captured.push(c.toString("utf-8")));
    const logger = createTesseraLogger({
      env: { MARCH_TESSERA_LOG_DIR: dir },
      level: "trace",
      sync: true,
      stdout,
    });
    logger.info(CREDENTIAL_RECORD, "credentials");

    const file = fs.readFileSync(path.join(dir, "tessera.jsonl"), "utf-8");
    for (const text of [file, captured.join("")]) {
      for (const value of CREDENTIAL_VALUES) expect(text).not.toContain(value);
      expect(text).toContain("visible");
    }
    const [line] = readLines(path.join(dir, "tessera.jsonl"));
    expect(line!.token).toBe("[redacted]");
    expect((line!.entitlement as Record<string, unknown>).token).toBe("[redacted]");
    expect(((line!.req as Record<string, unknown>).headers as Record<string, unknown>).authorization).toBe(
      "[redacted]",
    );
  });

  it("redacts credential fields from the client logger", () => {
    const logger = createTesseraClientLogger({ env: { MARCH_TESSERA_LOG_DIR: dir }, level: "trace" });
    logger.warn(CREDENTIAL_RECORD, "credentials");
    const text = fs.readFileSync(path.join(dir, "tessera-client.jsonl"), "utf-8");
    for (const value of CREDENTIAL_VALUES) expect(text).not.toContain(value);
    expect(text).toContain("visible");
  });

  it("leaves other services' loggers unaffected", () => {
    const logFilePath = path.join(dir, "statio.jsonl");
    const logger = createStatioLogger({
      logFilePath,
      env: {},
      sync: true,
      stdout: new PassThrough(),
    });
    logger.info({ token: "statio-visible-token" }, "unredacted");
    const [line] = readLines(logFilePath);
    expect(line!.token).toBe("statio-visible-token");
  });
});
