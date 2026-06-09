import { actionArguments, dispatchSliceId, slugifyDispatchPart } from "./dispatch-id.js";

/**
 * Pure reasoning over a `smithy status --format json` graph: dependency
 * resolution, layer-0 readiness, and dispatch ordering. No I/O — the status
 * object is read by the smithy client and passed in. `status`/`state` are the
 * sprawling upstream shapes, accepted as `any` at this edge.
 */

export function graphNodes(status: any): Record<string, any> {
  return status?.graph?.nodes && typeof status.graph.nodes === "object" ? status.graph.nodes : {};
}

export function graphNode(status: any, nodeId: string | null): any {
  const nodes = graphNodes(status);
  return nodeId ? nodes[nodeId] || null : null;
}

export function forgeRowId(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return /^[a-zA-Z]/.test(raw) ? raw : "S" + raw;
}

export function forgeNodeId(item: any): string | null {
  const args = actionArguments(item?.next_action || {});
  const tasksPath = args[0] || item?.path || "";
  const rowId = forgeRowId(args[1]);
  if (!tasksPath || !rowId) return null;
  return tasksPath + "#" + rowId;
}

export function recordRowForForgeItem(status: any, item: any): any {
  const args = actionArguments(item?.next_action || {});
  const tasksPath = args[0] || item?.path || "";
  const rowId = forgeRowId(args[1]);
  if (!tasksPath || !rowId) return null;
  const records = Array.isArray(status?.records) ? status.records : [];
  const record = records.find((candidate: any) => candidate?.path === tasksPath);
  const rows = Array.isArray(record?.dependency_order?.rows) ? record.dependency_order.rows : [];
  return rows.find((row: any) => String(row?.id || "") === rowId) || null;
}

export function dependencyIds(status: any, item: any): string[] {
  const nodeId = forgeNodeId(item);
  const node = graphNode(status, nodeId);
  const row = node?.row || recordRowForForgeItem(status, item) || {};
  const raw = Array.isArray(row?.depends_on) ? row.depends_on : [];
  const recordPath = String(node?.record_path || actionArguments(item?.next_action || {})[0] || item?.path || "");
  return raw
    .map((dep: unknown) => String(dep || "").trim())
    .filter(Boolean)
    .map((dep: string) => (dep.includes("#") ? dep : recordPath + "#" + dep));
}

export function dependencyMerged(state: any, depId: string): boolean {
  const archived =
    state?.archived_slices && typeof state.archived_slices === "object" ? state.archived_slices : {};
  const live = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const archivedSlice = archived[depId] || archived[slugifyDispatchPart(depId)];
  if (archivedSlice && typeof archivedSlice === "object") {
    if (archivedSlice.terminal_state === "MERGED" || archivedSlice.merged_at) return true;
  }
  const liveSlice = live[depId] || live[slugifyDispatchPart(depId)];
  if (liveSlice && typeof liveSlice === "object") {
    if (liveSlice.stage === "merged" || liveSlice.pr?.state === "MERGED") return true;
  }
  return false;
}

export function itemFromGraphNode(status: any, node: any): any {
  const recordPath = String(node?.record_path || "");
  const row = node?.row && typeof node.row === "object" ? node.row : {};
  const rowId = String(row.id || "").trim();
  const rowNumber = rowId.replace(/^[a-zA-Z]+/, "") || rowId;
  // Look up the matching record so parent_path/parent_row_id are populated —
  // otherwise dispatchSliceId(depItem) falls into the hash fallback and can't
  // match the semantic id used when the dep was dispatched.
  const records = Array.isArray(status?.records) ? status.records : [];
  const record = records.find((candidate: any) => candidate?.path === recordPath) || {};
  return {
    path: recordPath,
    title: row.title || recordPath,
    parent_path: record.parent_path || null,
    parent_row_id: record.parent_row_id || null,
    next_action: { command: "smithy.forge", arguments: [recordPath, rowNumber] },
  };
}

export function dependencySatisfied(state: any, status: any, depId: string): boolean {
  const node = graphNode(status, depId);
  const nodeStatus = String(node?.status || "").toLowerCase();
  if (nodeStatus === "done") return true;
  const depItem = node ? itemFromGraphNode(status, node) : null;
  const candidates = [depId, depItem ? dispatchSliceId(depItem) : null, slugifyDispatchPart(depId)].filter(
    Boolean,
  ) as string[];
  return candidates.some((candidate) => dependencyMerged(state, candidate));
}

export function dependenciesClear(state: any, status: any, item: any): boolean {
  return dependencyIds(status, item).every((depId) => dependencySatisfied(state, status, depId));
}

export function dispatchPriority(item: any): number {
  const command = String(item?.next_action?.command || "");
  if (command === "smithy.cut") return 0;
  if (command === "smithy.forge") return 1;
  if (command === "smithy.render") return 2;
  if (command === "smithy.mark") return 3;
  return 9;
}

export function readyLayerNodeIds(status: any): Set<string> {
  const layers = Array.isArray(status?.graph?.layers) ? status.graph.layers : [];
  const layer = layers.find((candidate: any) => Number(candidate?.layer) === 0);
  const ids = Array.isArray(layer?.node_ids) ? layer.node_ids : [];
  return new Set(ids.map((id: unknown) => String(id)));
}

/** Map every graph node id → the layer number it sits in (across all layers). */
export function nodeLayers(status: any): Map<string, number> {
  const layers = Array.isArray(status?.graph?.layers) ? status.graph.layers : [];
  const out = new Map<string, number>();
  for (const layer of layers) {
    const n = Number(layer?.layer);
    if (!Number.isFinite(n)) continue;
    for (const id of Array.isArray(layer?.node_ids) ? layer.node_ids : []) out.set(String(id), n);
  }
  return out;
}

/** The set of smithy verbs the legate can dispatch (membership checks only;
 *  dispatch ordering is decided by {@link dispatchPriority}, not this order). */
export const DISPATCH_COMMANDS = ["smithy.render", "smithy.mark", "smithy.cut", "smithy.forge"] as const;

/** Strip all non-digit characters, leaving just the digits (e.g. "US3"/"3" → "3"). */
function rowNumber(value: unknown): string {
  return String(value || "").replace(/[^0-9]/g, "");
}

/**
 * The graph node a record's NEXT ACTION operates on — the row that must be
 * layer-0 for the dispatch to be ready. Smithy's dependency graph is keyed at the
 * ROW level (`<artifact-file>#<rowId>`), so a faithful readiness check maps each
 * record to the specific row its `next_action` targets, NOT the record's parent:
 *
 *   - smithy.forge → the parent user story being implemented
 *     (`parent_path#parent_row_id`); the tasks-file path is not itself a node.
 *   - smithy.cut   → the spec user-story row being decomposed (`<spec>.md#US<n>`),
 *     where <n> is the cut's row argument.
 *   - smithy.mark  → the features-file feature row being marked (`<features>.md#F<n>`).
 *   - smithy.render→ the RFC milestone row being rendered (`<rfc>.md#M<n>`).
 *
 * Using the parent (the prior behavior) BOTH dropped orphaned specs — a spec with
 * no feature parent fell through to the bare `record.path`, which is not a node
 * id, so a brand-new layer-0 spec never matched layer-0 (#289) — AND produced
 * false positives: a cut whose parent feature is layer-0 but whose target row sits
 * at layer 1+ was wrongly reported ready. Targeting the action's actual row fixes
 * both directions. The row prefix comes from the record's own
 * `dependency_order.id_prefix` (the authoritative source), falling back to the
 * per-command default. When the action can't be mapped to a row the parent/bare
 * path is used so the record is still gated, never silently mis-keyed.
 */
const ROW_PREFIX_BY_COMMAND: Record<string, string> = {
  "smithy.cut": "US",
  "smithy.mark": "F",
  "smithy.render": "M",
};

/**
 * The graph node a forge record's task slice maps to: `<tasks-file>#<rowId>` (e.g.
 * `…/01-foo.tasks.md#S1`). The row id is derived with {@link forgeRowId} — the
 * EXACT scheme {@link forgeNodeId}, {@link recordRowForForgeItem}, {@link
 * dependencyIds}, and the in-flight dedup keys already use (a numeric arg becomes
 * `S<n>`; an already-prefixed arg is preserved) — so the readiness candidate, the
 * dependency ids, and the dedup key are guaranteed to byte-match the same graph
 * node. (Verified against smithy 0.5.13: every forge slice node in `graph.nodes`
 * is keyed `<tasks-file>#S<n>`.) A parallel `id_prefix`-based derivation would risk
 * a non-`S` id that fails `readyNodes.has(id)` even when the slice is layer-0 — the
 * exact silent dispatch stall this helper exists to prevent.
 *
 * Smithy ≤0.4.10 gated forge readiness on the PARENT story node ({@link
 * recordGraphNodeId}) and buried this slice node deep under it. Since smithy 0.5.13
 * a CUT (decomposed) story LEAVES the layer graph (`decomposed: true`) and its
 * slice rows are promoted onto the layer-0 frontier, so the slice node is now the
 * readiness signal. Callers accept BOTH the parent-story node and this slice node
 * (see {@link readySmithyItems}/{@link recordsByTargetNode}) so either graph shape
 * dispatches. Returns null when the row id can't be derived (non-forge record or
 * missing argument).
 */
export function forgeSliceNodeId(record: any): string | null {
  const action = record?.next_action || {};
  if (String(action.command || "") !== "smithy.forge") return null;
  const args = actionArguments(action);
  const rowId = forgeRowId(args[1]);
  if (!rowId) return null;
  const filePath = args[0] || record.path;
  return filePath ? String(filePath) + "#" + rowId : null;
}

export function recordGraphNodeId(record: any): string | null {
  if (!record || typeof record !== "object") return null;
  const action = record.next_action || {};
  const command = String(action.command || "");
  // forge implements a user story's slice — readiness is the parent US node; the
  // tasks-file path is not itself a graph node.
  if (command === "smithy.forge") {
    if (record.parent_path && record.parent_row_id) {
      return String(record.parent_path) + "#" + String(record.parent_row_id);
    }
    return record.path ? String(record.path) : null;
  }
  // cut/mark/render decompose a row WITHIN this record — map to that row's node.
  if (ROW_PREFIX_BY_COMMAND[command]) {
    const args = actionArguments(action);
    const prefix =
      (typeof record.dependency_order?.id_prefix === "string" && record.dependency_order.id_prefix) ||
      ROW_PREFIX_BY_COMMAND[command];
    const num = rowNumber(args[1]);
    // render's target file is its first argument; cut/mark target this record's file.
    const filePath = command === "smithy.render" ? args[0] || record.path : record.path;
    if (prefix && num && filePath) return String(filePath) + "#" + prefix + num;
  }
  if (record.parent_path && record.parent_row_id) {
    return String(record.parent_path) + "#" + String(record.parent_row_id);
  }
  return record.path ? String(record.path) : null;
}

/** The dispatch-command, non-virtual records, in dispatch-priority order. */
function dispatchRecords(status: any): any[] {
  const records = Array.isArray(status?.records) ? status.records : [];
  return records
    .filter((record: any) => record?.next_action && !record.virtual)
    .filter((record: any) => DISPATCH_COMMANDS.includes(String(record.next_action.command || "") as any))
    .map((record: any, index: number) => ({ ...record, __index: index }))
    .sort((a: any, b: any) => dispatchPriority(a) - dispatchPriority(b) || a.__index - b.__index);
}

/**
 * The graph nodes whose layer-0 membership marks a record ready. Usually the single
 * {@link recordGraphNodeId}; a forge record ALSO accepts its {@link forgeSliceNodeId}
 * so smithy 0.5.13's promoted slice node matches directly while a pre-0.5.13 graph —
 * where the slice sits deep under a still-layer-0 parent story — keeps dispatching
 * through the parent node. (forgeSliceNodeId is null for non-forge records.)
 */
export function readyNodeCandidates(record: any): string[] {
  return [recordGraphNodeId(record), forgeSliceNodeId(record)].filter(Boolean) as string[];
}

export function readySmithyItems(status: any): any[] {
  const readyNodes = readyLayerNodeIds(status);
  return dispatchRecords(status).filter(
    (record: any) => readyNodes.size === 0 || readyNodeCandidates(record).some((id) => readyNodes.has(id)),
  );
}

/**
 * The legate measures its work queue at the smithy graph's NODE (row) level, not
 * the record level. Smithy surfaces only ONE `next_action` per record, but the
 * dependency graph keys every row (`<artifact-file>#<rowId>`) as its own node — so
 * a spec with three independent layer-0 user stories is three dispatchable units
 * even though its record emits a single next action. Counting records collapses
 * that frontier (#289); counting nodes restores it.
 */

/** A pending (not-`done`) graph node together with the layer it sits in. */
export interface PendingNode {
  readonly id: string;
  readonly layer: number;
  readonly node: any;
}

/** Every graph node whose status is not `done`, tagged with its layer. The legate
 *  reads `smithy status … --pending`, so done nodes are already filtered out; the
 *  status guard is a belt-and-suspenders for a full (non-pending) payload. */
export function pendingGraphNodes(status: any): PendingNode[] {
  const nodes = graphNodes(status);
  const layers = nodeLayers(status);
  const out: PendingNode[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (String((node as any)?.status) === "done") continue;
    const layer = layers.get(id);
    if (layer === undefined) continue;
    out.push({ id, layer, node });
  }
  return out;
}

/** Classify a node by its row id prefix: user story / task slice / feature /
 *  milestone. "US" must be tested before "S" (both start with letters that
 *  overlap). */
function nodeRowKind(node: any): "US" | "S" | "F" | "M" | "other" {
  const rid = String(node?.row?.id || "").toUpperCase();
  if (rid.startsWith("US")) return "US";
  if (rid.startsWith("S")) return "S";
  if (rid.startsWith("F")) return "F";
  if (rid.startsWith("M")) return "M";
  return "other";
}

/** Index `status.records` by their `path`. */
function recordsByPath(status: any): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of Array.isArray(status?.records) ? status.records : []) {
    if (r?.path) m.set(String(r.path), r);
  }
  return m;
}

/** Map each graph node id → the record whose `next_action` currently targets it
 *  (the first such record wins). A node present here is one smithy would act on
 *  right now; a node absent here is either a sibling row the record's single next
 *  action didn't surface, or a container whose work has flowed to its children. */
function recordsByTargetNode(status: any): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of dispatchRecords(status)) {
    // A forge record targets its slice node (0.5.13's layer-0 frontier) AND its
    // parent-story node (the pre-0.5.13 frontier) — index both so the actionable
    // layer-0 scan resolves whichever the graph surfaces back to this record.
    for (const id of readyNodeCandidates(r)) {
      if (id && !m.has(id)) m.set(id, r);
    }
  }
  return m;
}

/**
 * The dispatch item for an actionable layer-0 node: the record whose `next_action`
 * targets it when one exists (so the derived slice id / branch match a real
 * dispatch EXACTLY — letting the in-flight dedup recognize it), else a synthesized
 * action for a sibling row the record's single surfaced next_action didn't emit — a
 * `smithy.cut` for a spec user story, or (since 0.5.13 promotes a cut story's slice
 * rows to the frontier) a `smithy.forge` for a task slice. Returns null when no
 * runnable item can be built.
 */
function dispatchItemForNode(
  byPath: Map<string, any>,
  byTarget: Map<string, any>,
  n: PendingNode,
): any | null {
  const direct = byTarget.get(n.id);
  if (direct) return direct;
  const recordPath = String(n.node?.record_path || "");
  const kind = nodeRowKind(n.node);
  if (kind === "US") {
    if (!recordPath) return null;
    const rec = byPath.get(recordPath) || {};
    const num = rowNumber(n.node?.row?.id);
    if (!num) return null;
    const specDir = recordPath.replace(/\/[^/]+$/, "");
    return {
      path: recordPath,
      parent_path: rec.parent_path ?? null,
      parent_row_id: rec.parent_row_id ?? null,
      title: n.node?.row?.title,
      next_action: { command: "smithy.cut", arguments: [specDir, num] },
    };
  }
  if (kind === "S") {
    if (!recordPath) return null;
    const rec = byPath.get(recordPath) || {};
    const num = rowNumber(n.node?.row?.id);
    if (!num) return null;
    return {
      path: recordPath,
      parent_path: rec.parent_path ?? null,
      parent_row_id: rec.parent_row_id ?? null,
      title: n.node?.row?.title,
      next_action: { command: "smithy.forge", arguments: [recordPath, num] },
    };
  }
  return null;
}

/**
 * The dispatch items for every ACTIONABLE layer-0 node — the work a steward can be
 * launched on right now. A layer-0 node is actionable when it is a spec user-story
 * (US) or task-slice (S) row (the cut/forge units), OR when some record's
 * `next_action` targets it directly (covers a runnable render/mark). Pure feature/
 * milestone CONTAINER nodes — whose child artifact already exists, so their real
 * work lives at deeper layers — are excluded. Subtract in-flight/archived work with
 * {@link dispatchableReady} to get the "dispatchable now" count.
 */
export function actionableLayer0Items(status: any): any[] {
  const pending = pendingGraphNodes(status);
  // No dependency graph (older smithy, or a graph-less payload) → fall back to the
  // record-level ready set so the frontier is never silently zeroed; with a graph
  // present, expand to the node-level actionable set.
  if (pending.length === 0) return readySmithyItems(status);
  const byPath = recordsByPath(status);
  const byTarget = recordsByTargetNode(status);
  const out: any[] = [];
  for (const n of pending) {
    if (n.layer !== 0) continue;
    const kind = nodeRowKind(n.node);
    if (!(kind === "US" || kind === "S" || byTarget.has(n.id))) continue;
    const item = dispatchItemForNode(byPath, byTarget, n);
    if (item) out.push(item);
  }
  return out;
}

/** Pending-node queue depth by dependency layer: `blocked` is the next wave (layer
 *  1, one dependency away), `total` is the deep backlog (layer ≥ 2). Layer-0 is the
 *  dispatchable frontier, counted separately via {@link actionableLayer0Items}. */
export function queueDepth(status: any): { blocked: number; total: number } {
  let blocked = 0;
  let total = 0;
  for (const n of pendingGraphNodes(status)) {
    if (n.layer === 1) blocked++;
    else if (n.layer >= 2) total++;
  }
  return { blocked, total };
}
