import { hashText } from "./hash.js";

/**
 * Pure derivation of a dispatch's identity — slice id, branch, title — from a
 * smithy status record. Extracted verbatim from the loop runtime so it can be
 * unit-tested in isolation; no I/O, no `meta`, fully deterministic.
 *
 * `item` is a smithy status record (sprawling/loosely-typed upstream), so it's
 * accepted as `any` at this edge; everything derived from it is typed.
 */

export interface DispatchIdentity {
  readonly stem: string;
  readonly verb: string;
  readonly hash: string | null;
  /** True when a semantic stem was derived (no hash suffix); false ⇒ legacy hash scheme. */
  readonly semantic: boolean;
}

export function slugifyDispatchPart(value: unknown, fallback = "item"): string {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return slug || fallback;
}

export function smithyVerb(command: unknown): string {
  return String(command || "").replace(/^smithy\./, "");
}

export function actionArguments(action: any): string[] {
  return Array.isArray(action?.arguments) ? action.arguments.map((arg: unknown) => String(arg)) : [];
}

export function actionCommandLine(action: any): string {
  const command = String(action?.command || "");
  const args = actionArguments(action);
  return ["/" + command, ...args].join(" ").trim();
}

export function dispatchItemKey(item: any): string {
  const action = item?.next_action || {};
  return JSON.stringify({
    command: action.command || "",
    arguments: actionArguments(action),
    path: item?.path || "",
  });
}

export function sliceActionKey(slice: any): string {
  if (!slice || typeof slice !== "object") return "";
  return JSON.stringify({
    command: slice.command || "",
    arguments: Array.isArray(slice.arguments) ? slice.arguments.map((arg: unknown) => String(arg)) : [],
    path: slice.artifact_path || "",
  });
}

/**
 * Strip a known artifact suffix from a basename so the leftover is a short,
 * readable spec / RFC / features-file slug. Returns null if the suffix isn't
 * recognized so callers fall back to the hash-based name rather than misderive.
 */
export function dispatchArtifactSlug(filename: unknown): string | null {
  if (typeof filename !== "string" || filename.length === 0) return null;
  const base = filename.split("/").pop() || "";
  const m = base.match(/^(.+?)\.(?:spec|rfc|features|tasks)\.md$/);
  return m ? m[1]! : null;
}

/**
 * Derive a structured identity (spec/RFC slug + US/M row + slice/feature/
 * milestone index) for a smithy status record. Produces a short, semantic stem;
 * falls back to the legacy hash-based stem only when the record lacks the
 * structure to derive a meaningful name. Branch/slice-id collisions are
 * intentional: the same spec+US+slice yields the same name every dispatch, so a
 * collision means "re-attempt of the same logical work".
 */
export function dispatchIdentity(item: any): DispatchIdentity {
  const action = item?.next_action || {};
  const verb = smithyVerb(action.command);
  const args = actionArguments(action);
  const parentSlug = dispatchArtifactSlug(item?.parent_path);
  const row = String(item?.parent_row_id || "").trim().toLowerCase();
  const numericTail = (s: unknown) => String(s || "").replace(/[^0-9]/g, "");
  let stem: string | null = null;
  if (verb === "forge" && parentSlug && row) {
    const slice = numericTail(args[1]);
    stem = parentSlug + "-" + row + (slice ? "-s" + slice : "");
  } else if (verb === "cut" && parentSlug && row) {
    const slice = numericTail(args[1]);
    stem = parentSlug + "-" + row + (slice ? "-s" + slice : "");
  } else if (verb === "mark" && parentSlug && row) {
    const feature = numericTail(args[1]);
    stem = parentSlug + "-" + row + (feature ? "-f" + feature : "");
  } else if (verb === "render") {
    const rfcSlug = dispatchArtifactSlug(args[0]) || parentSlug;
    const milestone = numericTail(args[1]);
    if (rfcSlug && milestone) stem = rfcSlug + "-m" + milestone;
  }
  if (stem) {
    return { stem: slugifyDispatchPart(stem, "smithy"), verb, hash: null, semantic: true };
  }
  // Fallback: legacy hash-based scheme. Order preserved exactly so existing
  // state.json / archive entries keyed by the legacy id continue to match.
  const basis = [item?.path || item?.title || "smithy", ...args].join(" ");
  const truncStem = slugifyDispatchPart(basis, "smithy").slice(0, 44);
  const hash = hashText(dispatchItemKey(item)).slice(0, 8);
  return { stem: truncStem, verb, hash, semantic: false };
}

export function dispatchSliceId(item: any): string {
  const { stem, verb, hash, semantic } = dispatchIdentity(item);
  const verbSlug = slugifyDispatchPart(verb, "step");
  return semantic ? stem + "-" + verbSlug : stem + "-" + verbSlug + "-" + hash;
}

export function dispatchTitle(item: any): string {
  const action = item?.next_action || {};
  const verb = smithyVerb(action.command);
  const title = item?.title || item?.path || actionArguments(action).join(" ");
  return verb + ": " + String(title || "smithy work").slice(0, 80);
}

export function dispatchBranch(item: any): string {
  const { stem, verb, hash, semantic } = dispatchIdentity(item);
  const verbSlug = slugifyDispatchPart(verb, "step");
  return semantic ? "smithy/" + verbSlug + "/" + stem : "smithy/" + verbSlug + "/" + stem + "-" + hash;
}
