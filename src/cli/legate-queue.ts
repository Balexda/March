/**
 * Plain-text rendering of the legate's `GET /queue` body for
 * `march legate queue` (#592): one line per ready plan row, saying why it did or
 * did not dispatch on the last tick and which slice holds it back. Pure, so it
 * is unit-testable without a running legate.
 */

interface QueueRow {
  path?: string | null;
  rowId?: string | null;
  command?: string | null;
  sliceId?: string;
  decision?: string;
  heldBy?: { sliceId?: string; matchedOn?: string; prNumber?: number | null; stage?: string | null } | null;
  retryAt?: string;
}

interface CheckoutStatus {
  ok?: boolean;
  defaultBranch?: string | null;
  head?: string | null;
  behind?: number | null;
  error?: string | null;
  at?: string | null;
}

interface ProfileQueue {
  last_tick_at?: string | null;
  smithy_ok?: boolean | null;
  queue?: { dispatchable?: number; blocked?: number; total?: number };
  items?: QueueRow[];
  checkout?: CheckoutStatus | null;
}

/** The decisions an operator can act on with `march legate requeue`. */
const RELEASABLE = new Set(["archived_closed", "archived_merged"]);

function rowLabel(row: QueueRow): string {
  const file = (row.path ?? "").split("/").pop() || "(unknown)";
  const verb = (row.command ?? "").replace(/^smithy\./, "") || "?";
  return `${file}${row.rowId ? `#${row.rowId}` : ""} ${verb}`;
}

function heldByLabel(row: QueueRow): string {
  const h = row.heldBy;
  if (!h?.sliceId) return "";
  const pr = typeof h.prNumber === "number" ? ` PR #${h.prNumber}` : "";
  const stage = h.stage ? ` (${h.stage})` : "";
  const via = h.matchedOn && h.matchedOn !== "id" ? ` via ${h.matchedOn}` : "";
  return `held by ${h.sliceId}${pr}${stage}${via}`;
}

function checkoutLine(c: CheckoutStatus | null | undefined): string {
  if (!c) return "checkout: unknown (no sync recorded yet)";
  const head = c.head ? c.head.slice(0, 12) : "?";
  const behind = typeof c.behind === "number" ? `${c.behind} behind` : "behind ?";
  const state = c.ok === false ? `sync FAILED${c.error ? `: ${c.error}` : ""}` : "synced";
  return `checkout: ${c.defaultBranch ?? "?"} @ ${head}, ${behind}, ${state}${c.at ? ` (${c.at})` : ""}`;
}

/** Render one profile's queue as text lines. */
export function formatProfileQueue(profile: string, q: ProfileQueue): string[] {
  const lines: string[] = [];
  const queue = q.queue ?? {};
  lines.push(
    `${profile}: dispatchable=${queue.dispatchable ?? 0} blocked=${queue.blocked ?? 0} total=${queue.total ?? 0}` +
      (q.last_tick_at ? ` (last tick ${q.last_tick_at})` : " (no tick yet)"),
  );
  lines.push(`  ${checkoutLine(q.checkout)}`);
  if (q.smithy_ok === false) {
    lines.push("  smithy status could not be read on the last tick — no per-item decisions.");
    return lines;
  }
  const items = q.items ?? [];
  if (items.length === 0) {
    lines.push("  no dependency-free plan rows.");
    return lines;
  }
  const width = Math.max(...items.map((r) => (r.decision ?? "").length));
  for (const row of items) {
    const parts = [(row.decision ?? "?").padEnd(width), rowLabel(row), row.sliceId ?? ""];
    const held = heldByLabel(row);
    if (held) parts.push(held);
    if (row.retryAt) parts.push(`retry at ${row.retryAt}`);
    lines.push(`  ${parts.join("  ")}`);
  }
  if (items.some((r) => RELEASABLE.has(r.decision ?? ""))) {
    lines.push(
      `  release an archived hold: march legate requeue <held-by slice> --profile ${profile}` +
        " (add --release-merged for an archived_merged hold)",
    );
  }
  return lines;
}

/** Render a `/queue` body (one profile, or every profile under `by_profile`). */
export function formatQueue(body: any): string {
  if (body && typeof body.profile === "string") return formatProfileQueue(body.profile, body).join("\n");
  const byProfile = body?.by_profile && typeof body.by_profile === "object" ? body.by_profile : {};
  const profiles = Object.keys(byProfile);
  if (profiles.length === 0) return "No profiles have ticked yet.";
  return profiles.map((p) => formatProfileQueue(p, byProfile[p]).join("\n")).join("\n\n");
}
