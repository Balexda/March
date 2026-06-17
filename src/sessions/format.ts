import type { Divergence, SessionState, SourceError, UnifiedSession } from "./types.js";

/** Filters applied to the joined rows before rendering. */
export interface SessionFilter {
  readonly profile?: string;
  readonly state?: string;
  /** Keep only divergent rows (anything but `ok`). */
  readonly orphans?: boolean;
}

/** Apply the `--profile` / `--state` / `--orphans` filters to the joined rows. */
export function filterSessions(
  rows: readonly UnifiedSession[],
  filter: SessionFilter,
): UnifiedSession[] {
  return rows.filter((row) => {
    if (filter.profile && row.profile !== filter.profile) return false;
    if (filter.state && row.state !== filter.state) return false;
    if (filter.orphans && row.divergence === "ok") return false;
    return true;
  });
}

/** Short, human flag for a divergent row (empty for a corroborated one). */
export function divergenceFlag(divergence: Divergence): string {
  switch (divergence) {
    case "castra-only":
      return "leak";
    case "brood-only":
      return "orphan";
    case "fold-only":
      return "stale";
    case "ok":
      return "";
  }
}

/** Render a duration in ms as a compact age (`45s`, `12m`, `3h`, `2d`). */
export function humanizeAge(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Trim an id/sha to a stable short form (Docker-style 12 chars). */
function short(value: string | undefined, width = 12): string {
  if (!value) return "—";
  return value.length > width ? value.slice(0, width) : value;
}

function dash(value: string | number | undefined): string {
  if (value === undefined || value === "") return "—";
  return String(value);
}

const HEADERS = [
  "SLICE",
  "PROFILE",
  "STATE",
  "PR",
  "BRANCH",
  "CONTAINER",
  "CASTRA",
  "BROOD",
  "AGE",
  "FLAG",
] as const;

/** Build the display cells for one row (the same order as {@link HEADERS}). */
function rowCells(row: UnifiedSession): string[] {
  return [
    dash(row.sliceId),
    dash(row.profile),
    row.state,
    row.pr !== undefined ? `#${row.pr}` : "—",
    dash(row.branch),
    short(row.containerId),
    short(row.castraSessionId),
    dash(row.broodStatus),
    humanizeAge(row.ageMs),
    divergenceFlag(row.divergence) || "—",
  ];
}

/**
 * Render the joined rows as an aligned text table, followed by any source-error
 * footnotes. An empty set prints a single informative line. The footnotes make a
 * PARTIAL view explicit — a down service never silently shrinks the table into a
 * misleading "all clear".
 */
export function formatTable(
  rows: readonly UnifiedSession[],
  errors: readonly SourceError[] = [],
): string {
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push("No in-flight sessions.");
  } else {
    const cellRows = rows.map(rowCells);
    const widths = HEADERS.map((h, i) =>
      Math.max(h.length, ...cellRows.map((cells) => cells[i].length)),
    );
    const fmt = (cells: readonly string[]): string =>
      cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    lines.push(fmt(HEADERS));
    for (const cells of cellRows) lines.push(fmt(cells));
  }

  for (const err of errors) {
    const scope = err.profile ? `${err.source} (${err.profile})` : err.source;
    lines.push(`! ${scope} unavailable: ${err.message}`);
  }

  return lines.join("\n");
}

/** The machine-consumable `--json` payload: rows plus any source errors. */
export interface SessionsJson {
  readonly sessions: readonly UnifiedSession[];
  readonly errors: readonly SourceError[];
}

export function formatJson(payload: SessionsJson): string {
  return JSON.stringify(payload, null, 2);
}

/** The closed set of valid `--state` filter values, for usage validation. */
export const SESSION_STATES: readonly SessionState[] = [
  "dispatched",
  "in-steward",
  "waiting-on-approval",
  "waiting-for-merge",
  "errored",
  "archived",
  "unknown",
];
