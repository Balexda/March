import { describe, expect, it } from "vitest";
import {
  actionArguments,
  actionCommandLine,
  dispatchArtifactSlug,
  dispatchBranch,
  dispatchIdentity,
  dispatchItemKey,
  dispatchSliceId,
  dispatchTitle,
  sliceActionKey,
  slugifyDispatchPart,
  smithyVerb,
} from "./dispatch-id.js";

describe("dispatch-id pure helpers", () => {
  it("slugifies, defaulting and truncating", () => {
    expect(slugifyDispatchPart("Hello, World!")).toBe("hello-world");
    expect(slugifyDispatchPart("")).toBe("item");
    expect(slugifyDispatchPart("", "fallback")).toBe("fallback");
    expect(slugifyDispatchPart("a".repeat(80)).length).toBe(56);
  });

  it("strips the smithy. command prefix", () => {
    expect(smithyVerb("smithy.forge")).toBe("forge");
    expect(smithyVerb("render")).toBe("render");
    expect(smithyVerb(undefined)).toBe("");
  });

  it("normalizes action arguments and command line", () => {
    expect(actionArguments({ arguments: ["a", 2] })).toEqual(["a", "2"]);
    expect(actionArguments({})).toEqual([]);
    expect(actionCommandLine({ command: "smithy.forge", arguments: ["x", "1"] })).toBe(
      "/smithy.forge x 1",
    );
  });

  it("recognizes artifact slugs only for known suffixes", () => {
    expect(dispatchArtifactSlug("docs/foo/bar.spec.md")).toBe("bar");
    expect(dispatchArtifactSlug("a/b/layered.rfc.md")).toBe("layered");
    expect(dispatchArtifactSlug("readme.md")).toBeNull();
    expect(dispatchArtifactSlug(undefined)).toBeNull();
  });

  it("derives a semantic identity for forge (slug + row + slice)", () => {
    const item = {
      parent_path: "docs/specs/spawn-dispatch.spec.md",
      parent_row_id: "US7",
      next_action: { command: "smithy.forge", arguments: ["docs/...", "1"] },
    };
    const id = dispatchIdentity(item);
    expect(id).toMatchObject({ verb: "forge", semantic: true, hash: null });
    expect(id.stem).toBe("spawn-dispatch-us7-s1");
    // semantic ids carry no hash suffix; branch mirrors the stem
    expect(dispatchSliceId(item)).toBe("spawn-dispatch-us7-s1-forge");
    expect(dispatchBranch(item)).toBe("smithy/forge/spawn-dispatch-us7-s1");
  });

  it("derives a semantic identity for render (rfc slug + milestone)", () => {
    const item = {
      next_action: { command: "smithy.render", arguments: ["docs/rfcs/layered.rfc.md", "2"] },
    };
    expect(dispatchIdentity(item)).toMatchObject({ stem: "layered-m2", semantic: true });
    expect(dispatchSliceId(item)).toBe("layered-m2-render");
  });

  it("falls back to the legacy hash scheme without parent structure", () => {
    const item = { path: "docs/x.tasks.md", next_action: { command: "smithy.mark", arguments: ["1"] } };
    const id = dispatchIdentity(item);
    expect(id.semantic).toBe(false);
    expect(id.hash).toMatch(/^[0-9a-f]{8}$/);
    // legacy slice id / branch carry the hash suffix
    expect(dispatchSliceId(item)).toBe(`${id.stem}-mark-${id.hash}`);
    expect(dispatchBranch(item)).toBe(`smithy/mark/${id.stem}-${id.hash}`);
  });

  it("produces a stable, structured title", () => {
    expect(dispatchTitle({ title: "Spawn dispatch US7", next_action: { command: "smithy.forge" } })).toBe(
      "forge: Spawn dispatch US7",
    );
  });

  it("dispatchItemKey / sliceActionKey are stable JSON keys", () => {
    const item = { path: "p", next_action: { command: "smithy.cut", arguments: ["a"] } };
    expect(JSON.parse(dispatchItemKey(item))).toEqual({ command: "smithy.cut", arguments: ["a"], path: "p" });
    const slice = { command: "smithy.cut", arguments: ["a"], artifact_path: "p" };
    expect(dispatchItemKey(item)).toBe(sliceActionKey(slice));
  });
});
