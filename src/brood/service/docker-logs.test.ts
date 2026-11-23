/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readContainerLogsAsync } from "./docker-logs.js";

const dirs: string[] = [];

/** Write a fake `docker` executable running `body` and return its path. */
function fakeDocker(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-docker-logs-"));
  dirs.push(dir);
  const bin = path.join(dir, "docker");
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readContainerLogsAsync", () => {
  it("passes the container id to `docker logs` and returns stdout", async () => {
    const bin = fakeDocker('printf "%s %s\\n" "$1" "$2"');
    await expect(readContainerLogsAsync("c1", { bin })).resolves.toBe("logs c1\n");
  });

  it("keeps stderr-only container output instead of returning empty logs", async () => {
    const bin = fakeDocker('printf "boom\\n" >&2');
    await expect(readContainerLogsAsync("c1", { bin })).resolves.toBe("boom\n");
  });

  it("combines stdout and stderr", async () => {
    const bin = fakeDocker('printf "out\\n"; sleep 0.05; printf "err\\n" >&2');
    await expect(readContainerLogsAsync("c1", { bin })).resolves.toBe("out\nerr\n");
  });

  it("rejects with docker's stderr on a non-zero exit", async () => {
    const bin = fakeDocker('printf "No such container: c1\\n" >&2; exit 1');
    await expect(readContainerLogsAsync("c1", { bin })).rejects.toThrow(
      /No such container: c1/,
    );
  });

  it("rejects when the read exceeds the timeout", async () => {
    const bin = fakeDocker("exec sleep 5");
    await expect(
      readContainerLogsAsync("c1", { bin, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it("rejects when output exceeds the byte cap", async () => {
    const bin = fakeDocker('printf "0123456789"');
    await expect(
      readContainerLogsAsync("c1", { bin, maxBytes: 4 }),
    ).rejects.toThrow(/exceeded 4 bytes/);
  });

  it("rejects when docker cannot be spawned", async () => {
    await expect(
      readContainerLogsAsync("c1", { bin: "/nonexistent/docker" }),
    ).rejects.toThrow(/docker logs failed/);
  });
});
