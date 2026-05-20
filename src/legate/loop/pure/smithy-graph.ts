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

export function recordGraphNodeId(record: any): string | null {
  if (!record || typeof record !== "object") return null;
  if (record.parent_path && record.parent_row_id) {
    return String(record.parent_path) + "#" + String(record.parent_row_id);
  }
  const action = record.next_action || {};
  if (String(action.command || "") === "smithy.render") {
    const args = actionArguments(action);
    const milestone = args[1] ? "M" + String(args[1]).replace(/^[a-zA-Z]+/, "") : "";
    return milestone ? String(args[0] || record.path || "") + "#" + milestone : null;
  }
  return record.path ? String(record.path) : null;
}

export function readySmithyItems(status: any): any[] {
  const records = Array.isArray(status?.records) ? status.records : [];
  const readyNodes = readyLayerNodeIds(status);
  return records
    .filter((record: any) => record?.next_action && !record.virtual)
    .filter((record: any) =>
      ["smithy.render", "smithy.mark", "smithy.cut", "smithy.forge"].includes(
        String(record.next_action.command || ""),
      ),
    )
    .filter((record: any) => readyNodes.size === 0 || readyNodes.has(recordGraphNodeId(record)!))
    .map((record: any, index: number) => ({ ...record, __index: index }))
    .sort((a: any, b: any) => dispatchPriority(a) - dispatchPriority(b) || a.__index - b.__index);
}
