import { describe, expect, it } from "vitest";
import {
  blockedSmithyItems,
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

  it("recordGraphNodeId maps a next_action to the ROW it targets, not the parent (#289)", () => {
    // smithy.cut decomposes a spec user story → the spec's own row node, even for
    // an ORPHANED spec with no feature parent (the #289 drop case).
    expect(
      recordGraphNodeId({
        path: "specs/statio/statio.spec.md",
        next_action: { command: "smithy.cut", arguments: ["specs/statio", "3"] },
      }),
    ).toBe("specs/statio/statio.spec.md#US3");
    // smithy.mark targets a features-file feature row.
    expect(
      recordGraphNodeId({
        path: "rfc/01-spawn.features.md",
        next_action: { command: "smithy.mark", arguments: ["rfc/01-spawn.features.md", "2"] },
      }),
    ).toBe("rfc/01-spawn.features.md#F2");
    // smithy.forge implements a user story's slice → the parent US node.
    expect(
      recordGraphNodeId({
        path: "specs/x/01-foo.tasks.md",
        parent_path: "specs/x/x.spec.md",
        parent_row_id: "US4",
        next_action: { command: "smithy.forge", arguments: ["specs/x/01-foo.tasks.md", "1"] },
      }),
    ).toBe("specs/x/x.spec.md#US4");
  });

  it("recordGraphNodeId honors the record's dependency_order id_prefix", () => {
    expect(
      recordGraphNodeId({
        path: "specs/y/y.spec.md",
        dependency_order: { id_prefix: "US" },
        next_action: { command: "smithy.cut", arguments: ["specs/y", "US7"] },
      }),
    ).toBe("specs/y/y.spec.md#US7");
  });

  it("readySmithyItems includes a brand-new orphaned layer-0 spec (#289 regression)", () => {
    // The spec has NO feature parent; its only ready row (US3) is the cut target,
    // and that row sits in layer 0. The old parent-based node id fell through to
    // the bare spec path and never matched layer-0, so the spec was dropped.
    const status = {
      graph: {
        layers: [
          { layer: 0, node_ids: ["specs/statio/statio.spec.md#US3"] },
          { layer: 1, node_ids: ["specs/statio/statio.spec.md#US1"] },
        ],
      },
      records: [
        {
          path: "specs/statio/statio.spec.md",
          next_action: { command: "smithy.cut", arguments: ["specs/statio", "3"] },
        },
      ],
    };
    expect(readySmithyItems(status).map((r) => r.path)).toEqual(["specs/statio/statio.spec.md"]);
  });

  it("readySmithyItems excludes a cut whose target row is layer>0 even if its parent feature is layer-0 (no false positives)", () => {
    // Parent feature F4 is layer-0, but the cut targets spec row US3 which sits at
    // layer 1 — mapping to the parent (the old behavior) wrongly reported it ready.
    const status = {
      graph: {
        layers: [
          { layer: 0, node_ids: ["rfc/01-spawn.features.md#F4"] },
          { layer: 1, node_ids: ["specs/sandbox/sandbox.spec.md#US3"] },
        ],
      },
      records: [
        {
          path: "specs/sandbox/sandbox.spec.md",
          parent_path: "rfc/01-spawn.features.md",
          parent_row_id: "F4",
          next_action: { command: "smithy.cut", arguments: ["specs/sandbox", "3"] },
        },
      ],
    };
    expect(readySmithyItems(status)).toHaveLength(0);
  });

  it("blockedSmithyItems is the true layer>0 set, excluding layer-0/unmappable/done", () => {
    const status = {
      graph: {
        layers: [
          { layer: 0, node_ids: ["specs/ready/ready.spec.md#US1"] },
          { layer: 2, node_ids: ["specs/blocked/blocked.spec.md#US1"] },
        ],
      },
      records: [
        // layer 0 → ready, not blocked
        { path: "specs/ready/ready.spec.md", next_action: { command: "smithy.cut", arguments: ["specs/ready", "1"] } },
        // layer 2 → blocked
        { path: "specs/blocked/blocked.spec.md", next_action: { command: "smithy.cut", arguments: ["specs/blocked", "1"] } },
        // node not in the partition → unmappable, not provably blocked
        { path: "specs/orphan/orphan.spec.md", next_action: { command: "smithy.cut", arguments: ["specs/orphan", "1"] } },
        // done records carry no next_action → excluded
        { path: "specs/done/done.spec.md", next_action: null },
      ],
    };
    expect(blockedSmithyItems(status).map((r) => r.path)).toEqual(["specs/blocked/blocked.spec.md"]);
  });

  it("blockedSmithyItems is empty when there is no dependency graph", () => {
    const status = { records: [{ path: "a", next_action: { command: "smithy.forge" } }] };
    expect(blockedSmithyItems(status)).toEqual([]);
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
