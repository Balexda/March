/**
 * @l0 @deterministic @ci
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  LOG_SERVICES,
  buildDockerLogsArgs,
  resolveLogServices,
  runLogs,
  type LogsChild,
  type LogsSpawner,
} from "./logs.js";

/** A fake `docker logs` child: feed lines, then end with an exit code. */
class FakeChild extends EventEmitter implements LogsChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): void {
    this.killed = signal;
    this.emit("exit", null);
  }

  /** Push stdout lines then exit; mirrors a one-shot `docker logs` run. */
  feed(lines: string[], code = 0, stream: "stdout" | "stderr" = "stdout"): void {
    for (const line of lines) this[stream].write(`${line}\n`);
    this[stream].end();
    // Let the readline 'line' events flush before the exit resolves the leg.
    setImmediate(() => this.emit("exit", code));
  }
}

/** A spawner that hands back one prepared FakeChild per container, in order. */
function fakeSpawner(children: Map<string, FakeChild>): {
  spawn: LogsSpawner;
  calls: { file: string; args: string[] }[];
} {
  const calls: { file: string; args: string[] }[] = [];
  const spawn: LogsSpawner = (file, args) => {
    calls.push({ file, args });
    const container = args[args.length - 1];
    const child = children.get(container) ?? new FakeChild();
    children.set(container, child);
    return child;
  };
  return { spawn, calls };
}

describe("resolveLogServices", () => {
  it("returns all six services in bring-up order when unscoped", () => {
    expect(resolveLogServices().map((s) => s.name)).toEqual([
      "otel-lgtm",
      "castra",
      "hatchery",
      "brood",
      "herald",
      "legate",
    ]);
  });

  it("scopes to a single named service", () => {
    expect(resolveLogServices("herald")).toEqual([
      { name: "herald", container: "march-herald" },
    ]);
  });

  it("throws a helpful error for an unknown service", () => {
    expect(() => resolveLogServices("nope")).toThrow(/Unknown service "nope"/);
    expect(() => resolveLogServices("nope")).toThrow(/herald/);
  });
});

describe("buildDockerLogsArgs", () => {
  it("defaults to a bounded tail and no follow", () => {
    expect(buildDockerLogsArgs("march-herald", {})).toEqual([
      "logs",
      "--tail",
      "100",
      "march-herald",
    ]);
  });

  it("threads through follow, since, and an explicit tail", () => {
    expect(
      buildDockerLogsArgs("march-legate", {
        follow: true,
        since: "10m",
        tail: "50",
      }),
    ).toEqual([
      "logs",
      "--follow",
      "--since",
      "10m",
      "--tail",
      "50",
      "march-legate",
    ]);
  });

  it("never references a compose file (container name only)", () => {
    const args = buildDockerLogsArgs("march-castra", {});
    expect(args.some((a) => a.includes("compose"))).toBe(false);
    expect(args.some((a) => a.includes(".yml"))).toBe(false);
    expect(args).toContain("march-castra");
  });
});

describe("runLogs — single service", () => {
  it("tags every line with the service name and resolves with the exit code", async () => {
    const children = new Map<string, FakeChild>();
    const child = new FakeChild();
    children.set("march-herald", child);
    const { spawn, calls } = fakeSpawner(children);
    const out: string[] = [];

    const promise = runLogs({
      service: "herald",
      spawn,
      write: (c) => out.push(c),
      color: false,
    });
    child.feed(["hello", "world"], 0);
    const result = await promise;

    expect(calls).toHaveLength(1);
    expect(out.join("")).toBe("herald | hello\nherald | world\n");
    expect(result.services).toEqual([{ name: "herald", exitCode: 0 }]);
  });

  it("tags stderr lines too (app logs land on stderr)", async () => {
    const children = new Map<string, FakeChild>();
    const child = new FakeChild();
    children.set("march-legate", child);
    const { spawn } = fakeSpawner(children);
    const out: string[] = [];

    const promise = runLogs({
      service: "legate",
      spawn,
      write: (c) => out.push(c),
      color: false,
    });
    child.feed(["on stderr"], 0, "stderr");
    await promise;

    expect(out.join("")).toBe("legate | on stderr\n");
  });
});

describe("runLogs — all services", () => {
  it("spawns one docker logs per service and tags each", async () => {
    const children = new Map<string, FakeChild>();
    for (const svc of LOG_SERVICES) children.set(svc.container, new FakeChild());
    const { spawn, calls } = fakeSpawner(children);
    const out: string[] = [];

    const promise = runLogs({ spawn, write: (c) => out.push(c), color: false });
    for (const svc of LOG_SERVICES) {
      children.get(svc.container)!.feed([`${svc.name}-line`], 0);
    }
    const result = await promise;

    expect(calls).toHaveLength(LOG_SERVICES.length);
    // Every service's line is present, tagged with its (padded) name.
    for (const svc of LOG_SERVICES) {
      expect(out.join("")).toContain(`${svc.name.padEnd(9)} | ${svc.name}-line`);
    }
    expect(result.services.map((s) => s.name)).toEqual(
      LOG_SERVICES.map((s) => s.name),
    );
  });
});

describe("runLogs — --errors filter", () => {
  it("keeps only error-level lines", async () => {
    const children = new Map<string, FakeChild>();
    const child = new FakeChild();
    children.set("march-brood", child);
    const { spawn } = fakeSpawner(children);
    const out: string[] = [];

    const promise = runLogs({
      service: "brood",
      errors: true,
      spawn,
      write: (c) => out.push(c),
      color: false,
    });
    child.feed(
      [
        "info: all good",
        "ERROR: boom",
        'something with "level":"error" embedded',
        "a warning only",
      ],
      0,
    );
    await promise;

    expect(out.join("")).toBe(
      "brood | ERROR: boom\n" +
        'brood | something with "level":"error" embedded\n',
    );
  });
});

describe("runLogs — follow + SIGINT", () => {
  it("kills children on Ctrl-C and resolves", async () => {
    const children = new Map<string, FakeChild>();
    const child = new FakeChild();
    children.set("march-legate", child);
    const { spawn } = fakeSpawner(children);

    const promise = runLogs({
      service: "legate",
      follow: true,
      spawn,
      write: () => {},
      color: false,
    });
    // Simulate Ctrl-C; the runner's SIGINT handler kills the child.
    process.emit("SIGINT");
    const result = await promise;

    expect(child.killed).toBe("SIGINT");
    expect(result.services).toEqual([{ name: "legate", exitCode: null }]);
  });
});
