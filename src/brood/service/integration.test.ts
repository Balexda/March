/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { parseIntegrationAttempt } from "./integration.js";

describe("parseIntegrationAttempt", () => {
  const binding = (stewardDeadline: string) => ({ attemptId: "a", spawnId: "s", stewardDeadline });

  it.each(["2026-11-27T12:00:00.000Z", "2026-11-27T12:00:00Z", "2026-11-27T12:00:00+02:00", "2026-11-27T12:00:00-0500"])(
    "accepts the timezone-qualified deadline %s",
    (deadline) => expect(parseIntegrationAttempt(binding(deadline))).toEqual(binding(deadline)),
  );

  it.each(["2026-11-27T12:00:00", "2026-11-27T12:00:00.000", "2026-11-27"])(
    "rejects the deadline %s without a timezone",
    (deadline) => expect(parseIntegrationAttempt(binding(deadline))).toBeUndefined(),
  );
});
