import { describe, expect, it } from "vitest";
import {
  actionableLayer0Items,
  dependenciesClear,
  dependencyIds,
  dependencyMerged,
  dispatchPriority,
  forgeNodeId,
  forgeSliceNodeId,
  pendingGraphNodes,
  queueDepth,
  readyLayerNodeIds,
  readySmithyItems,
  recordGraphNodeId,
} from "./smithy-graph.js";
import { dispatchableReady } from "./slice.js";
import { dispatchSliceId, dispatchBranch, actionArguments } from "./dispatch-id.js";

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

  // A statio-shaped fixture: one orphaned spec with three independent layer-0 user
  // stories (US3/US5/US6, depends_on []), one layer-1 story (US1, depends on US3),
  // and a deeper layer-2 node. The spec record surfaces a single cut next_action
  // (US3); US5/US6 are sibling rows it never surfaces. A node carries record_path,
  // row, and status; the layers partition assigns each node its depth.
  const statioStatus = () => ({
    graph: {
      nodes: {
        "specs/statio/statio.spec.md#US3": { record_path: "specs/statio/statio.spec.md", row: { id: "US3", title: "Repo identity", depends_on: [] }, status: "not-started" },
        "specs/statio/statio.spec.md#US5": { record_path: "specs/statio/statio.spec.md", row: { id: "US5", title: "HTTP gateway", depends_on: [] }, status: "not-started" },
        "specs/statio/statio.spec.md#US6": { record_path: "specs/statio/statio.spec.md", row: { id: "US6", title: "Observable", depends_on: [] }, status: "not-started" },
        "specs/statio/statio.spec.md#US1": { record_path: "specs/statio/statio.spec.md", row: { id: "US1", title: "Read PR", depends_on: ["US3"] }, status: "not-started" },
        "rfc/01.features.md#F9": { record_path: "rfc/01.features.md", row: { id: "F9", title: "Deep feature", depends_on: ["F1"] }, status: "not-started" },
      },
      layers: [
        { layer: 0, node_ids: ["specs/statio/statio.spec.md#US3", "specs/statio/statio.spec.md#US5", "specs/statio/statio.spec.md#US6"] },
        { layer: 1, node_ids: ["specs/statio/statio.spec.md#US1"] },
        { layer: 2, node_ids: ["rfc/01.features.md#F9"] },
      ],
    },
    records: [
      { path: "specs/statio/statio.spec.md", dependency_order: { id_prefix: "US" }, next_action: { command: "smithy.cut", arguments: ["specs/statio", "3"] } },
    ],
  });

  it("actionableLayer0Items expands a spec's layer-0 user stories into one dispatch item each (#289)", () => {
    // The record surfaces only cut US3, but US5/US6 are independent layer-0 work —
    // node-level expansion synthesizes a cut for each sibling. US1 (layer 1) and the
    // layer-2 feature are excluded.
    const items = actionableLayer0Items(statioStatus());
    const actions = items.map((i) => i.next_action.command + " " + i.next_action.arguments.join(" ")).sort();
    expect(actions).toEqual([
      "smithy.cut specs/statio 3",
      "smithy.cut specs/statio 5",
      "smithy.cut specs/statio 6",
    ]);
  });

  it("dispatchableReady subtracts an already-dispatched layer-0 item from the frontier", () => {
    const items = actionableLayer0Items(statioStatus());
    expect(dispatchableReady({ slices: {}, archived_slices: {} }, items)).toHaveLength(3);
    // Mark US5 in-flight exactly as launchDispatch records a slice; it drops out.
    const us5 = items.find((i) => i.next_action.arguments[1] === "5")!;
    const sid = dispatchSliceId(us5);
    const state = {
      slices: { [sid]: { stage: "implementing", branch: dispatchBranch(us5), command: us5.next_action.command, arguments: actionArguments(us5.next_action), artifact_path: us5.path } },
      archived_slices: {},
    };
    expect(dispatchableReady(state, items)).toHaveLength(2);
  });

  it("queueDepth counts the next wave (layer 1) as blocked and layer ≥ 2 as the deep backlog", () => {
    expect(queueDepth(statioStatus())).toEqual({ blocked: 1, total: 1 });
  });

  it("pendingGraphNodes excludes done nodes", () => {
    const status = {
      graph: {
        nodes: {
          "a#US1": { record_path: "a", row: { id: "US1" }, status: "done" },
          "a#US2": { record_path: "a", row: { id: "US2" }, status: "not-started" },
        },
        layers: [{ layer: 0, node_ids: ["a#US1", "a#US2"] }],
      },
    };
    expect(pendingGraphNodes(status).map((n) => n.id)).toEqual(["a#US2"]);
  });

  it("actionableLayer0Items excludes container feature nodes whose work has flowed to children", () => {
    // A feature node sits at layer 0 but no record's next_action targets it (its spec
    // exists and the work is its deeper user stories) — it is a container, not
    // actionable. Only the user-story node counts.
    const status = {
      graph: {
        nodes: {
          "rfc/01.features.md#F4": { record_path: "rfc/01.features.md", row: { id: "F4" }, status: "in-progress" },
          "specs/x/x.spec.md#US1": { record_path: "specs/x/x.spec.md", row: { id: "US1", depends_on: [] }, status: "not-started" },
        },
        layers: [{ layer: 0, node_ids: ["rfc/01.features.md#F4", "specs/x/x.spec.md#US1"] }],
      },
      records: [
        { path: "specs/x/x.spec.md", dependency_order: { id_prefix: "US" }, next_action: { command: "smithy.cut", arguments: ["specs/x", "1"] } },
      ],
    };
    const items = actionableLayer0Items(status);
    expect(items.map((i) => i.next_action.arguments.join(" "))).toEqual(["specs/x 1"]);
  });

  it("queueDepth is empty when there is no dependency graph", () => {
    expect(queueDepth({ records: [{ path: "a", next_action: { command: "smithy.forge" } }] })).toEqual({ blocked: 0, total: 0 });
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

  // Smithy 0.5.13 changed which nodes sit on the layer-0 frontier: once a story is
  // CUT, smithy marks its US node `decomposed` and REMOVES it from the layer graph,
  // promoting the story's task-slice rows to layer 0. The forge readiness gate must
  // therefore accept the SLICE node, not only the (now de-layered) parent story —
  // otherwise no forge work is ever ready and dispatch stalls (the 0.4.10 → 0.5.13
  // bump regression). The parent-story path stays as a fallback for older graphs.
  describe("0.5.13 forge frontier", () => {
    it("forgeSliceNodeId derives <tasks-file>#<rowId> the SAME way forgeNodeId does (forgeRowId), null for non-forge", () => {
      const rec = { path: "t.md", next_action: { command: "smithy.forge", arguments: ["t.md", "3"] } };
      // Numeric row arg → canonical "S<n>" — the prefix smithy 0.5.13 actually keys
      // these promoted slice nodes with, and byte-identical to forgeNodeId so the
      // readiness candidate / dependency ids / dedup key all agree.
      expect(forgeSliceNodeId(rec)).toBe("t.md#S3");
      expect(forgeSliceNodeId(rec)).toBe(forgeNodeId(rec));
      // An already-prefixed row arg is preserved (forgeRowId leaves alpha-leading ids as-is).
      expect(
        forgeSliceNodeId({ path: "t.md", next_action: { command: "smithy.forge", arguments: ["t.md", "S5"] } }),
      ).toBe("t.md#S5");
      // dependency_order.id_prefix does NOT fork the derivation — forgeRowId is the
      // single source of truth, so no divergent (e.g. "TS") node id can be produced.
      expect(
        forgeSliceNodeId({
          path: "t.md",
          dependency_order: { id_prefix: "TS" },
          next_action: { command: "smithy.forge", arguments: ["t.md", "3"] },
        }),
      ).toBe("t.md#S3");
      expect(forgeSliceNodeId({ next_action: { command: "smithy.cut", arguments: ["x", "1"] } })).toBeNull();
      expect(forgeSliceNodeId({ next_action: { command: "smithy.forge", arguments: ["t.md"] } })).toBeNull();
    });

    it("readySmithyItems dispatches a forge via its slice node when the cut parent left the layer graph", () => {
      // 0.5.13 shape: parent US4 is `decomposed` and present in `nodes` but ABSENT
      // from every layer; the slice node S1 is the layer-0 frontier.
      const status = {
        graph: {
          nodes: {
            "specs/x/x.spec.md#US4": { record_path: "specs/x/x.spec.md", row: { id: "US4" }, status: "in-progress", decomposed: true },
            "specs/x/01-foo.tasks.md#S1": { record_path: "specs/x/01-foo.tasks.md", row: { id: "S1", depends_on: [] }, status: "not-started" },
          },
          layers: [{ layer: 0, node_ids: ["specs/x/01-foo.tasks.md#S1"] }],
        },
        records: [
          {
            path: "specs/x/01-foo.tasks.md",
            parent_path: "specs/x/x.spec.md",
            parent_row_id: "US4",
            next_action: { command: "smithy.forge", arguments: ["specs/x/01-foo.tasks.md", "1"] },
          },
        ],
      };
      expect(readySmithyItems(status).map((r) => r.path)).toEqual(["specs/x/01-foo.tasks.md"]);
    });

    it("readySmithyItems still dispatches a forge via the layer-0 parent story (pre-0.5.13 graph)", () => {
      // ≤0.4.10 shape: parent US4 is the layer-0 gate; the slice node sits at layer 1.
      const status = {
        graph: {
          layers: [
            { layer: 0, node_ids: ["specs/x/x.spec.md#US4"] },
            { layer: 1, node_ids: ["specs/x/01-foo.tasks.md#S1"] },
          ],
        },
        records: [
          {
            path: "specs/x/01-foo.tasks.md",
            parent_path: "specs/x/x.spec.md",
            parent_row_id: "US4",
            next_action: { command: "smithy.forge", arguments: ["specs/x/01-foo.tasks.md", "1"] },
          },
        ],
      };
      expect(readySmithyItems(status).map((r) => r.path)).toEqual(["specs/x/01-foo.tasks.md"]);
    });

    it("actionableLayer0Items resolves a layer-0 slice to its record and synthesizes a forge for an unsurfaced sibling slice", () => {
      // S1 is the record's surfaced forge target; S2 is a sibling slice the record's
      // single next_action never emitted — both are dispatchable layer-0 units.
      const status = {
        graph: {
          nodes: {
            "specs/x/x.spec.md#US4": { record_path: "specs/x/x.spec.md", row: { id: "US4" }, status: "in-progress", decomposed: true },
            "specs/x/01-foo.tasks.md#S1": { record_path: "specs/x/01-foo.tasks.md", row: { id: "S1", title: "Slice one", depends_on: [] }, status: "not-started" },
            "specs/x/01-foo.tasks.md#S2": { record_path: "specs/x/01-foo.tasks.md", row: { id: "S2", title: "Slice two", depends_on: [] }, status: "not-started" },
          },
          layers: [{ layer: 0, node_ids: ["specs/x/01-foo.tasks.md#S1", "specs/x/01-foo.tasks.md#S2"] }],
        },
        records: [
          {
            path: "specs/x/01-foo.tasks.md",
            parent_path: "specs/x/x.spec.md",
            parent_row_id: "US4",
            next_action: { command: "smithy.forge", arguments: ["specs/x/01-foo.tasks.md", "1"] },
          },
        ],
      };
      const items = actionableLayer0Items(status);
      expect(items.every((i) => i.next_action.command === "smithy.forge")).toBe(true);
      expect(items.map((i) => i.next_action.arguments.join(" ")).sort()).toEqual([
        "specs/x/01-foo.tasks.md 1",
        "specs/x/01-foo.tasks.md 2",
      ]);
    });
  });
});
