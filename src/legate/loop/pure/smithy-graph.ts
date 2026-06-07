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

export function readySmithyItems(status: any): any[] {
  const readyNodes = readyLayerNodeIds(status);
  return dispatchRecords(status).filter(
    (record: any) => readyNodes.size === 0 || readyNodes.has(recordGraphNodeId(record)!),
  );
}

/**
 * The records smithy considers genuinely dependency-BLOCKED: a dispatchable next
 * action whose target node sits at a layer > 0 (it has at least one unmet
 * dependency in Smithy's graph). This is the true "blocked" set — NOT the residual
 * `total − ready`, which mislabeled done/in-flight/unmappable work as blocked
 * (#289). Done records carry no `next_action` (excluded); in-flight ready work
 * sits at layer 0 (excluded); a record whose node isn't in the layer partition is
 * unmappable, not provably blocked, so it is excluded too. With no layer graph
 * present nothing is provably blocked.
 */
export function blockedSmithyItems(status: any): any[] {
  const layers = nodeLayers(status);
  if (layers.size === 0) return [];
  return dispatchRecords(status).filter((record: any) => {
    const layer = layers.get(recordGraphNodeId(record)!);
    return layer !== undefined && layer > 0;
  });
}
