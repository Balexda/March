import type { CheckId, DoctorReport, Severity } from "./types.js";

/**
 * Human-readable rendering of a {@link DoctorReport}: a glyph-prefixed line per
 * finding, grouped by check, with the remedy indented beneath any non-pass, and
 * a one-line verdict footer.
 */

const GLYPH: Record<Severity, string> = {
  pass: "✓",
  warn: "⚠",
  fail: "✗",
};

const CHECK_TITLE: Record<CheckId, string> = {
  "token-wiring": "Token wiring",
  "session-consistency": "Session consistency",
  "dispatch-health": "Dispatch health",
  "worktree-hygiene": "Worktree/branch hygiene",
  "sync-health": "Sync health",
};

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  const scope = report.profile ? ` (profile: ${report.profile})` : "";
  lines.push(`march doctor — stack consistency${scope}`);
  lines.push("");

  for (const check of report.checks) {
    lines.push(CHECK_TITLE[check.check] ?? check.check);
    for (const f of check.findings) {
      lines.push(`  ${GLYPH[f.severity]} ${f.title}: ${f.detail}`);
      if (f.remedy && f.severity !== "pass") {
        lines.push(`      → remedy: ${f.remedy}`);
      }
    }
    lines.push("");
  }

  const { pass, warn, fail } = report.counts;
  const verdict = report.ok
    ? fail === 0 && warn === 0
      ? "HEALTHY"
      : "OK (warnings present)"
    : "UNHEALTHY";
  lines.push(`Result: ${verdict} — ${pass} pass, ${warn} warn, ${fail} fail`);
  return lines.join("\n");
}
