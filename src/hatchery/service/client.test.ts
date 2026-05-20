import { describe, expect, it, vi } from "vitest";
import {
  getJob,
  HatcheryClientError,
  pollUntilTerminal,
  postSpawn,
  resolveHatcheryUrl,
  runSpawnViaService,
} from "./client.js";
import type { SpawnRequest } from "./types.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const request: SpawnRequest = { prompt: "x", backend: "codex", repoPath: "/r" };

describe("resolveHatcheryUrl", () => {
  it("defaults to localhost:8080 and strips trailing slashes", () => {
    expect(resolveHatcheryUrl({})).toBe("http://localhost:8080");
    expect(resolveHatcheryUrl({ MARCH_HATCHERY_URL: "http://h:9090/" })).toBe(
      "http://h:9090",
    );
  });
});

describe("postSpawn", () => {
  it("returns the created job on 202", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(202, { id: "job-1", status: "pending" }),
    );
    const created = await postSpawn("http://h", request, fetchImpl as never);
    expect(created).toEqual({ id: "job-1", status: "pending" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://h/spawns",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws the server error message on non-202", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "bad backend" }));
    await expect(postSpawn("http://h", request, fetchImpl as never)).rejects.toThrow(
      "bad backend",
    );
  });

  it("wraps connection failures in HatcheryClientError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      postSpawn("http://h", request, fetchImpl as never),
    ).rejects.toBeInstanceOf(HatcheryClientError);
  });
});

describe("getJob", () => {
  it("returns the record on 200 and throws on 404", async () => {
    const ok = vi.fn(async () => jsonResponse(200, { id: "j", status: "running" }));
    expect((await getJob("http://h", "j", ok as never)).status).toBe("running");

    const missing = vi.fn(async () => jsonResponse(404, { error: "nope" }));
    await expect(getJob("http://h", "j", missing as never)).rejects.toThrow("nope");
  });
});

describe("pollUntilTerminal", () => {
  it("polls until the job reaches a terminal state", async () => {
    const statuses = ["running", "running", "succeeded"];
    let i = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: "j", status: statuses[i++] }),
    );
    const sleep = vi.fn(async () => {});
    const job = await pollUntilTerminal("http://h", "j", {
      fetchImpl: fetchImpl as never,
      sleep,
      intervalMs: 1,
    });
    expect(job.status).toBe("succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws on timeout", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "j", status: "running" }));
    let t = 0;
    await expect(
      pollUntilTerminal("http://h", "j", {
        fetchImpl: fetchImpl as never,
        sleep: async () => {},
        now: () => (t += 1000),
        timeoutMs: 1500,
      }),
    ).rejects.toThrow(/Timed out/);
  });
});

describe("runSpawnViaService", () => {
  it("posts then polls to a terminal job", async () => {
    const responses = [
      jsonResponse(202, { id: "job-9", status: "pending" }),
      jsonResponse(200, { id: "job-9", status: "succeeded", result: { spawnId: "s" } }),
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => responses[i++]);
    const job = await runSpawnViaService(request, {
      baseUrl: "http://h",
      fetchImpl: fetchImpl as never,
      sleep: async () => {},
    });
    expect(job.status).toBe("succeeded");
  });
});
