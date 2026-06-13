/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { JobStore } from "./jobs.js";
import type { FastifyInstance } from "fastify";

const silentLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  level: "silent",
  child() {
    return this;
  },
} as never;

describe("server lifecycle", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("listens on an ephemeral port and serves /healthz over real HTTP", async () => {
    const store = new JobStore({ executor: async () => {
      throw new Error("not used");
    } });
    const built = await buildServer({ store, logger: silentLogger });
    app = built.app;
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`${address}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
