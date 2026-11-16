/**
 * @l1 @deterministic @ci
 *
 * Entrypoint test for `runTesseraServer`: it starts with no GitHub App
 * configured, answers `/healthz`, reports the app setting names (never their
 * values), and shuts down cleanly on a termination signal.
 */
import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { TesseraValidationError } from "./types.js";
import { runTesseraServer } from "./serve.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function captureLogger(): { logger: pino.Logger; lines: () => string[] } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
  return {
    logger: pino({ level: "info" }, stream),
    lines: () => chunks.join("").split("\n").filter(Boolean),
  };
}

async function waitForHealthz(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`server never answered ${url}`);
}

describe("runTesseraServer", () => {
  it("serves unconfigured, logs setting names only, and stops on SIGTERM", async () => {
    const port = await freePort();
    const signals = new EventEmitter();
    const { logger, lines } = captureLogger();

    const running = runTesseraServer({
      port,
      host: "127.0.0.1",
      env: { TESSERA_GITHUB_APP_ID: "12345", TESSERA_GITHUB_APP_KEY_FILE: "/no/such/key.pem" },
      logger,
      signals,
    });

    const res = await waitForHealthz(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });

    signals.emit("SIGTERM");
    await expect(running).resolves.toBeUndefined();

    const output = lines().join("\n");
    expect(output).toContain("TESSERA_GITHUB_APP_KEY_FILE");
    expect(output).not.toContain("12345");
    expect(output).not.toContain("/no/such/key.pem");
    expect(output).toContain("received SIGTERM");

    // The port is released after shutdown.
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("rejects an invalid port before the server starts", async () => {
    await expect(
      runTesseraServer({ port: "9689x", env: {} }),
    ).rejects.toBeInstanceOf(TesseraValidationError);
  });
});
