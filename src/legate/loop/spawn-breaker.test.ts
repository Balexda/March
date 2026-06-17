/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BREAKER_CONFIG,
  SpawnBreaker,
  isHardDownReason,
  parseAgentFailureReason,
} from "./spawn-breaker.js";

/** Drive one full tick: begin (get cap), then end (fold observation). */
function tick(b: SpawnBreaker, cap: number, obs: { agentDown: number; healthy: number }): number {
  const effective = b.beginTick(cap);
  b.endTick(obs);
  return effective;
}

describe("parseAgentFailureReason", () => {
  it("extracts the marker the hatchery stamps into the detail", () => {
    expect(parseAgentFailureReason("Spawn x exited 1; [agent_failure_reason=auth] Logs: /p")).toBe("auth");
    expect(parseAgentFailureReason("[agent_failure_reason=rate_limit]")).toBe("rate_limit");
  });
  it("returns null when no marker / unknown value", () => {
    expect(parseAgentFailureReason("patch does not apply")).toBeNull();
    expect(parseAgentFailureReason("[agent_failure_reason=bogus]")).toBeNull();
  });
});

describe("isHardDownReason", () => {
  it("treats auth as hard-down, others as soft", () => {
    expect(isHardDownReason("auth")).toBe(true);
    expect(isHardDownReason("rate_limit")).toBe(false);
    expect(isHardDownReason("other")).toBe(false);
  });
});

describe("SpawnBreaker", () => {
  const CAP = 10;

  it("stays closed and at full cap while healthy", () => {
    const b = new SpawnBreaker();
    expect(tick(b, CAP, { agentDown: 0, healthy: 3 })).toBe(CAP);
    expect(tick(b, CAP, { agentDown: 0, healthy: 1 })).toBe(CAP);
    expect(b.snapshot().state).toBe("closed");
  });

  it("does not trip on a single agent-down tick (needs openAfterTicks)", () => {
    const b = new SpawnBreaker();
    expect(DEFAULT_BREAKER_CONFIG.openAfterTicks).toBe(2);
    expect(tick(b, CAP, { agentDown: 4, healthy: 0 })).toBe(CAP); // still closed this tick
    expect(b.isOpen()).toBe(false);
  });

  it("trips OPEN after consecutive hard-down ticks and collapses the cap to 0", () => {
    const b = new SpawnBreaker();
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // downTicks=1
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // downTicks=2 -> trips at end
    expect(b.isOpen()).toBe(true);
    // Next tick the cap is collapsed.
    expect(b.beginTick(CAP)).toBe(0);
  });

  it("resets the down-streak on any healthy completion", () => {
    const b = new SpawnBreaker();
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // downTicks=1
    tick(b, CAP, { agentDown: 1, healthy: 2 }); // healthy -> reset
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // downTicks=1 again, not tripped
    expect(b.isOpen()).toBe(false);
  });

  it("arms a single probe every probeIntervalTicks while open", () => {
    const b = new SpawnBreaker();
    tick(b, CAP, { agentDown: 4, healthy: 0 });
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // OPEN now
    // probeIntervalTicks = 3: ticks 1,2 paused (cap 0), tick 3 probes (cap 1).
    expect(b.beginTick(CAP)).toBe(0);
    b.endTick({ agentDown: 1, healthy: 0 });
    expect(b.beginTick(CAP)).toBe(0);
    b.endTick({ agentDown: 1, healthy: 0 });
    const probeCap = b.beginTick(CAP);
    expect(probeCap).toBe(1);
    expect(b.snapshot().state).toBe("half_open");
    b.endTick({ agentDown: 1, healthy: 0 }); // probe still failing -> stay open
    expect(b.isOpen()).toBe(true);
  });

  it("closes when a healthy completion arrives while open (e.g. a recovery success)", () => {
    const b = new SpawnBreaker();
    tick(b, CAP, { agentDown: 4, healthy: 0 });
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // OPEN
    expect(b.isOpen()).toBe(true);
    // An uncapped #211 recovery succeeds — agent is back.
    b.beginTick(CAP);
    b.endTick({ agentDown: 0, healthy: 1 });
    expect(b.isOpen()).toBe(false);
    expect(b.beginTick(CAP)).toBe(CAP); // full cap restored
  });

  it("holds steady on idle ticks (no completions)", () => {
    const b = new SpawnBreaker();
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // downTicks=1
    tick(b, CAP, { agentDown: 0, healthy: 0 }); // idle -> no change
    expect(b.isOpen()).toBe(false);
    tick(b, CAP, { agentDown: 4, healthy: 0 }); // downTicks=2 -> trip
    expect(b.isOpen()).toBe(true);
  });

  it("snapshot reports effective cap and breakerOpen flag", () => {
    const b = new SpawnBreaker();
    b.beginTick(CAP);
    expect(b.snapshot()).toMatchObject({ state: "closed", effectiveCap: CAP, breakerOpen: 0 });
    tick(b, CAP, { agentDown: 4, healthy: 0 });
    tick(b, CAP, { agentDown: 4, healthy: 0 });
    b.beginTick(CAP);
    expect(b.snapshot()).toMatchObject({ breakerOpen: 1, effectiveCap: 0 });
  });
});
