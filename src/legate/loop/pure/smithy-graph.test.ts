import { describe, expect, it } from "vitest";
import {
  dependenciesClear,
  dependencyIds,
  dependencyMerged,
  dispatchPriority,
  readyLayerNodeIds,
  readySmithyItems,
  recordGraphNodeId,
} from "./smithy-graph.js";

describe("smithy-graph pure helpers", () => {
  it("orders ready items cut < forge < render < mark, then by index", () => {
    const status = {
      records: [
        { path: "a", next_action: { command: "smithy.mark", arguments: [] } },
        { path: "b", next_action: { command: "smithy.cut", arguments: [] } },
        { path: "c", next_action: { command: "smithy.forge", arguments: [] } },
      ],
    };
    expect(readySmithyItems(status).map((r) => r.path)).toEqual(["b", "c", "a"]);
  });

  it("excludes virtual records and non-dispatch commands", () => {
    const status = {
      records: [
        { path: "v", virtual: true, next_action: { command: "smithy.cut" } },
        { path: "x", next_action: { command: "smithy.audit" } },
        { path: "ok", next_action: { command: "smithy.forge" } },
      ],
    };
    expect(readySmithyItems(status).map((r) => r.path)).toEqual(["ok"]);
  });

  it("restricts to layer-0 node ids when a layer 0 is present", () => {
    const status = {
      graph: {
        layers: [{ layer: 0, node_ids: ["docs/x.tasks.md#US1"] }],
      },
      records: [
        { path: "docs/x.tasks.md", parent_path: "docs/x.tasks.md", parent_row_id: "US1", next_action: { command: "smithy.forge" } },
        { path: "docs/y.tasks.md", parent_path: "docs/y.tasks.md", parent_row_id: "US2", next_action: { command: "smithy.forge" } },
      ],
    };
    expect(readySmithyItems(status).map((r) => r.path)).toEqual(["docs/x.tasks.md"]);
  });

  it("dispatchPriority ranks the smithy verbs", () => {
    expect(dispatchPriority({ next_action: { command: "smithy.cut" } })).toBe(0);
    expect(dispatchPriority({ next_action: { command: "smithy.mark" } })).toBe(3);
    expect(dispatchPriority({ next_action: { command: "other" } })).toBe(9);
  });

  it("recordGraphNodeId prefers parent path#row, then render milestone, then path", () => {
    expect(recordGraphNodeId({ parent_path: "p", parent_row_id: "US1" })).toBe("p#US1");
    expect(
      recordGraphNodeId({ path: "x", next_action: { command: "smithy.render", arguments: ["rfc.md", "2"] } }),
    ).toBe("rfc.md#M2");
    expect(recordGraphNodeId({ path: "z", next_action: { command: "smithy.cut" } })).toBe("z");
  });

  it("readyLayerNodeIds reads layer 0 ids", () => {
    const ids = readyLayerNodeIds({ graph: { layers: [{ layer: 0, node_ids: ["a", "b"] }] } });
    expect([...ids]).toEqual(["a", "b"]);
  });

  it("dependencyMerged sees MERGED archives and merged live slices", () => {
    const state = {
      archived_slices: { "p#S1": { terminal_state: "MERGED" } },
      slices: { "p#S2": { stage: "merged" } },
    };
    expect(dependencyMerged(state, "p#S1")).toBe(true);
    expect(dependencyMerged(state, "p#S2")).toBe(true);
    expect(dependencyMerged(state, "p#S3")).toBe(false);
  });

  it("dependencyIds qualifies bare row refs with the record path", () => {
    const status = {
      graph: { nodes: { "t.md#S1": { record_path: "t.md", row: { depends_on: ["S0", "other.md#S9"] } } } },
      records: [],
    };
    const item = { next_action: { command: "smithy.forge", arguments: ["t.md", "1"] } };
    expect(dependencyIds(status, item)).toEqual(["t.md#S0", "other.md#S9"]);
  });

  it("dependenciesClear is true when every dep is satisfied", () => {
    const status = {
      graph: { nodes: { "t.md#S1": { record_path: "t.md", row: { depends_on: ["S0"] } }, "t.md#S0": { status: "done" } } },
      records: [],
    };
    const item = { next_action: { command: "smithy.forge", arguments: ["t.md", "1"] } };
    expect(dependenciesClear({}, status, item)).toBe(true);
  });
});
