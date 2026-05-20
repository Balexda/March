import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHatcheryLogger,
  emitOtelLogLine,
  pinoLevelToSeverity,
  resolveHatcheryLogFilePath,
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
      env: {}, // MARCH_OTEL unset -> file sink only
      sync: true,
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
