/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { HeraldClient } from "../../herald/service/client.js";
import { publishStewardAttachedToHerald } from "./herald-registration.js";

const input = {
  sliceId: "layered-testing-framework-m2-f1-mark",
  sessionId: "ad-session-1",
  spawnId: "20260521-abc123",
  branch: "feature/smithy/m2-f1-mark",
  worktreePath: "/wt/20260521-abc123",
};

/** A HeraldClient backed by a fetch stub that captures the POST /events body. */
function capturingClient(bodies: Record<string, unknown>[]): HeraldClient {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    return new Response(JSON.stringify({ seq: 1, id: "e1", ts: "t", source: "legate", ...body }), {
      status: 201,
    });
  }) as unknown as typeof fetch;
  return new HeraldClient({ baseUrl: "http://herald", fetchImpl });
}

describe("publishStewardAttachedToHerald", () => {
  it("posts a slice.steward.attached event carrying the full correlation (#213)", async () => {
    const bodies: Record<string, unknown>[] = [];
    await publishStewardAttachedToHerald(input, { client: capturingClient(bodies) });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      source: "legate",
      type: "slice.steward.attached",
      sliceId: input.sliceId,
      sessionId: input.sessionId,
      spawnId: input.spawnId,
      branch: input.branch,
      worktreePath: input.worktreePath,
    });
  });

  it("is a no-op when there is no sliceId (ad-hoc spawn)", async () => {
    const bodies: Record<string, unknown>[] = [];
    await publishStewardAttachedToHerald(
      { ...input, sliceId: "" },
      { client: capturingClient(bodies) },
    );
    expect(bodies).toHaveLength(0);
  });

  it("is a no-op when herald is unconfigured (no client, no MARCH_HERALD_URL)", async () => {
    await expect(
      publishStewardAttachedToHerald(input, { env: {} }),
    ).resolves.toBeUndefined();
  });

  it("swallows a herald failure with a warning (never throws)", async () => {
    const warn = vi.fn();
    const failingClient = new HeraldClient({
      baseUrl: "http://herald",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(
      publishStewardAttachedToHerald(input, { client: failingClient, warn }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
