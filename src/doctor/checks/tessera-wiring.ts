import { MARCH_SERVICES } from "../../stack/services.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding, Severity } from "../types.js";
import type { KeyVerdict } from "../tessera-probes.js";

const CHECK = "tessera-wiring";
const CONSUMERS = ["hatchery", "brood", "herald", "legate", "statio"];
const SERVICES = [...MARCH_SERVICES.map(service => service.name), "statio"];
const SEVERITY: Record<KeyVerdict, Severity> = {
  accepted: "pass",
  rejected: "fail",
  missing: "fail",
  unverifiable: "warn",
};

export async function checkTesseraWiring(ctx: DoctorContext): Promise<CheckResult> {
  const [reachable, keys, ambient] = await Promise.all([
    ctx.tessera.reachable(),
    Promise.all(CONSUMERS.map(async (title): Promise<Finding> => {
      const verdict = await ctx.tessera.key(title);
      return { check: CHECK, title, severity: SEVERITY[verdict], detail: `Tessera client key ${verdict}` };
    })),
    Promise.all(SERVICES.map(async (title): Promise<Finding[]> => {
      const names = await ctx.tessera.ambient(title);
      if (!names?.length) return [];
      return [{ check: CHECK, title, severity: "warn", detail: `ambient GitHub credential present (${names.join(", ")})` }];
    })),
  ]);

  return {
    check: CHECK,
    findings: [
      {
        check: CHECK,
        title: "Tessera",
        severity: reachable ? "pass" : "warn",
        detail: reachable ? "Tessera is reachable" : "Tessera liveness could not be verified",
      },
      ...keys,
      ...ambient.flat(),
    ],
  };
}
