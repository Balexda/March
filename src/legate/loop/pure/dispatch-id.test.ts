/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  actionArguments,
  actionCommandLine,
  dispatchActionKeyFields,
  dispatchArtifactSlug,
  dispatchBranch,
  dispatchIdentity,
  dispatchItemKey,
  dispatchSliceId,
  dispatchTitle,
  legacyCutBranch,
  legacyCutSliceId,
  MAX_SEMANTIC_STEM,
  sliceActionKey,
  slugifyDispatchPart,
  smithyVerb,
} from "./dispatch-id.js";

describe("dispatchActionKeyFields (#653)", () => {
  it("returns the item's action key in the event shape", () => {
    expect(dispatchActionKeyFields({
      path: "docs/a.tasks.md", next_action: { command: "smithy.forge", arguments: ["docs/a.tasks.md", 1] },
    })).toEqual({ command: "smithy.forge", arguments: ["docs/a.tasks.md", "1"], artifactPath: "docs/a.tasks.md" });
  });

  it("omits an empty or whitespace-only command or path, which Herald's validator would reject", () => {
    for (const blank of ["", "   "]) {
      expect(dispatchActionKeyFields({ path: blank, next_action: { command: blank } })).toEqual({ arguments: [] });
    }
    expect(dispatchActionKeyFields(undefined)).toEqual({ arguments: [] });
  });
});

describe("dispatch-id pure helpers", () => {
  it("slugifies, defaulting and truncating", () => {
    expect(slugifyDispatchPart("Hello, World!")).toBe("hello-world");
    expect(slugifyDispatchPart("")).toBe("item");
    expect(slugifyDispatchPart("", "fallback")).toBe("fallback");
    expect(slugifyDispatchPart("a".repeat(80)).length).toBe(56);
    expect(slugifyDispatchPart("a".repeat(80), "item", Infinity).length).toBe(80);
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

  // #599: the semantic stem used to be cut to 56 characters, dropping the row
  // suffix at its end, so different rows of a long-named plan file shared one id.
  describe("long artifact slugs keep the row suffix (#599)", () => {
    const SLUG50 = "automatic-retry-handling-for-review-feedback-loops";
    const SLUG56 = "structured-review-feedback-with-automatic-retry-handling";
    const forgeItem = (slug: string, row: string, slice: string) => ({
      parent_path: `docs/specs/${slug}.tasks.md`,
      parent_row_id: row,
      next_action: { command: "smithy.forge", arguments: [`docs/specs/${slug}.tasks.md`, slice] },
    });

    it("fixtures are the issue's 50- and 56-character slugs", () => {
      expect(SLUG50).toHaveLength(50);
      expect(SLUG56).toHaveLength(56);
    });

    it.each([SLUG50, SLUG56])("forge rows of %s get distinct, full ids", (slug) => {
      const rows: [string, string][] = [["US1", "1"], ["US1", "2"], ["US2", "1"], ["US3", "4"]];
      const ids = rows.map(([row, slice]) => dispatchSliceId(forgeItem(slug, row, slice)));
      expect(ids).toEqual([
        `${slug}-us1-s1-forge`,
        `${slug}-us1-s2-forge`,
        `${slug}-us2-s1-forge`,
        `${slug}-us3-s4-forge`,
      ]);
      expect(new Set(ids).size).toBe(rows.length);
      expect(dispatchBranch(forgeItem(slug, "US3", "4"))).toBe(`smithy/forge/${slug}-us3-s4`);
    });

    it("cut / mark / render keep their suffixes too", () => {
      const cut = (row: string, slice: string) => ({
        parent_path: `docs/specs/${SLUG56}.spec.md`,
        parent_row_id: row,
        next_action: { command: "smithy.cut", arguments: [`docs/specs/${SLUG56}.spec.md`, slice] },
      });
      expect(dispatchSliceId(cut("US1", "1"))).toBe(`${SLUG56}-us1-s1-cut`);
      expect(dispatchSliceId(cut("US2", "1"))).toBe(`${SLUG56}-us2-s1-cut`);

      const mark = (row: string, feature: string) => ({
        parent_path: `docs/rfcs/${SLUG56}.features.md`,
        parent_row_id: row,
        next_action: { command: "smithy.mark", arguments: [`docs/rfcs/${SLUG56}.features.md`, feature] },
      });
      expect(dispatchSliceId(mark("M1", "1"))).toBe(`${SLUG56}-m1-f1-mark`);
      expect(dispatchSliceId(mark("M1", "2"))).toBe(`${SLUG56}-m1-f2-mark`);

      const render = (milestone: string) => ({
        next_action: { command: "smithy.render", arguments: [`docs/rfcs/${SLUG56}.rfc.md`, milestone] },
      });
      expect(dispatchSliceId(render("1"))).toBe(`${SLUG56}-m1-render`);
      expect(dispatchSliceId(render("2"))).toBe(`${SLUG56}-m2-render`);
    });

    it("legacyCutSliceId / legacyCutBranch give the old 56-character id, shared by siblings", () => {
      expect(legacyCutSliceId(forgeItem(SLUG56, "US1", "1"))).toBe(`${SLUG56}-forge`);
      expect(legacyCutSliceId(forgeItem(SLUG56, "US3", "4"))).toBe(`${SLUG56}-forge`);
      expect(legacyCutBranch(forgeItem(SLUG56, "US2", "1"))).toBe(`smithy/forge/${SLUG56}`);
      expect(legacyCutSliceId(forgeItem(SLUG50, "US1", "2"))).toBe(`${SLUG50}-us1-s-forge`);
    });

    it("legacy helpers are null when the id never changed", () => {
      const short = forgeItem("short-name", "US1", "1");
      expect(legacyCutSliceId(short)).toBeNull();
      expect(legacyCutBranch(short)).toBeNull();
      expect(legacyCutSliceId({ path: "x", next_action: { command: "smithy.mark", arguments: ["1"] } })).toBeNull();
    });

    it(`caps stems over ${MAX_SEMANTIC_STEM} characters, keeping the row suffix and a slug hash`, () => {
      const huge = "a".repeat(200);
      const hugeB = "a".repeat(199) + "b"; // same long prefix, different slug
      const id1 = dispatchIdentity(forgeItem(huge, "US1", "1")).stem;
      const id2 = dispatchIdentity(forgeItem(huge, "US2", "1")).stem;
      const idB = dispatchIdentity(forgeItem(hugeB, "US1", "1")).stem;
      expect(id1).toHaveLength(MAX_SEMANTIC_STEM);
      expect(id1).toMatch(/-[0-9a-f]{6}-us1-s1$/);
      expect(id2).toMatch(/-us2-s1$/);
      expect(id1).not.toBe(idB);
      expect(dispatchSliceId(forgeItem(huge, "US1", "1"))).toBe(dispatchSliceId(forgeItem(huge, "US1", "1")));
    });

    it("is deterministic", () => {
      expect(dispatchSliceId(forgeItem(SLUG56, "US2", "1"))).toBe(dispatchSliceId(forgeItem(SLUG56, "US2", "1")));
    });
  });
});
