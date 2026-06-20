/**
 * `march doctor` — read-only deep stack-consistency diagnostics.
 *
 * Public entry points for the CLI command: {@link wireDoctorContext} resolves
 * the service clients + in-scope profiles, {@link runDoctor} runs the battery,
 * and {@link formatReport} renders the human view (`--json` prints the report).
 */
export { runDoctor, type RunDoctorOptions } from "./run.js";
export { wireDoctorContext, type WireOptions } from "./wire.js";
export { formatReport } from "./format.js";
export type {
  CheckId,
  CheckResult,
  DoctorReport,
  Finding,
  Severity,
  SeverityCounts,
} from "./types.js";
export type { DoctorContext } from "./context.js";
