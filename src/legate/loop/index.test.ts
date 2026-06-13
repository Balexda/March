/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { reconcileOtelEnv } from "./index.js";

describe("reconcileOtelEnv", () => {
  it("defaults the service name to march-legate (dashboard contract), env wins", () => {
    const fresh: NodeJS.ProcessEnv = {};
    reconcileOtelEnv(fresh);
    expect(fresh.MARCH_OTEL_SERVICE_NAME).toBe("march-legate");

    const explicit: NodeJS.ProcessEnv = { MARCH_OTEL_SERVICE_NAME: "custom" };
    reconcileOtelEnv(explicit);
    expect(explicit.MARCH_OTEL_SERVICE_NAME).toBe("custom");
  });

  // Brood/Herald/OTel endpoints are no longer reconciled from a single meta —
  // the profile-agnostic service reads them from the container env (compose) and
  // the per-profile config from Herald's registry. See runtime.ts / profile-paths.ts.
});
