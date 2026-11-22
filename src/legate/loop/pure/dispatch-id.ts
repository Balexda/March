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

/**
 * Lower-case, dash-separated slug of `value`, cut to `max` characters (56 by
 * default — kept for the legacy hash ids and legacy-key lookups). Semantic
 * dispatch stems pass `Infinity`: cutting them dropped the row suffix that tells
 * plan rows apart (#599).
 */
export function slugifyDispatchPart(value: unknown, fallback = "item", max = 56): string {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
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

/**
 * The action-key fields (#653) for the `slice.dispatched` /
 * `slice.recovery.dispatched` transition events, so the Herald fold keeps what
 * {@link dispatchItemKey} keys on and a cold-start rebuild can restore
 * `command`/`arguments`/`artifact_path`. An empty or whitespace-only command or
 * path is omitted (Herald's validator rejects those).
 */
export function dispatchActionKeyFields(item: any): { command?: string; arguments: string[]; artifactPath?: string } {
  const action = item?.next_action || {};
  // Same test as Herald's validator (non-empty after trimming): a value it would
  // reject must be omitted, or the whole dispatch event — job id included — is lost.
  const present = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  const command = present(action.command) ? action.command : undefined;
  const artifactPath = present(item?.path) ? item.path : undefined;
  return {
    ...(command !== undefined ? { command } : {}),
    arguments: actionArguments(action),
    ...(artifactPath !== undefined ? { artifactPath } : {}),
  };
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

/** Longest semantic stem kept verbatim. Real plan slugs sit far below this; it
 *  only keeps ids under downstream limits (Castra metadata values, path params). */
export const MAX_SEMANTIC_STEM = 120;

/** The pre-#599 cut: semantic stems were sliced to 56 characters. */
const LEGACY_SEMANTIC_STEM = 56;

interface SemanticParts {
  readonly verb: string;
  /** Artifact slug (spec / RFC / features file), unslugified. */
  readonly slug: string;
  /** Row / slice / feature / milestone suffix, starting with "-". */
  readonly suffix: string;
}

function semanticParts(item: any): SemanticParts | null {
  const action = item?.next_action || {};
  const verb = smithyVerb(action.command);
  const args = actionArguments(action);
  const parentSlug = dispatchArtifactSlug(item?.parent_path);
  const row = String(item?.parent_row_id || "").trim().toLowerCase();
  const numericTail = (s: unknown) => String(s || "").replace(/[^0-9]/g, "");
  if ((verb === "forge" || verb === "cut") && parentSlug && row) {
    const slice = numericTail(args[1]);
    return { verb, slug: parentSlug, suffix: "-" + row + (slice ? "-s" + slice : "") };
  }
  if (verb === "mark" && parentSlug && row) {
    const feature = numericTail(args[1]);
    return { verb, slug: parentSlug, suffix: "-" + row + (feature ? "-f" + feature : "") };
  }
  if (verb === "render") {
    const rfcSlug = dispatchArtifactSlug(args[0]) || parentSlug;
    const milestone = numericTail(args[1]);
    if (rfcSlug && milestone) return { verb, slug: rfcSlug, suffix: "-m" + milestone };
  }
  return null;
}

/**
 * The semantic stem: the full slug + suffix when it fits in
 * {@link MAX_SEMANTIC_STEM}; otherwise the artifact slug is shortened and a hash
 * of the full slug added, so the row suffix (which tells rows apart) is kept and
 * two artifacts with a common long prefix stay distinct.
 */
function semanticStem(parts: SemanticParts): string {
  const full = slugifyDispatchPart(parts.slug + parts.suffix, "smithy", Infinity);
  if (full.length <= MAX_SEMANTIC_STEM) return full;
  const slug = slugifyDispatchPart(parts.slug, "smithy", Infinity);
  const suffix = slugifyDispatchPart(parts.suffix, "", Infinity);
  const hash = hashText(slug).slice(0, 6);
  const room = Math.max(0, MAX_SEMANTIC_STEM - suffix.length - hash.length - 2);
  const head = slug.slice(0, room).replace(/-+$/, "");
  return [head, hash, suffix].filter(Boolean).join("-").slice(0, MAX_SEMANTIC_STEM);
}

/**
 * Derive a structured identity (spec/RFC slug + US/M row + slice/feature/
 * milestone index) for a smithy status record. Produces a short, semantic stem;
 * falls back to the legacy hash-based stem only when the record lacks the
 * structure to derive a meaningful name. Branch/slice-id collisions are
 * intentional: the same spec+US+slice yields the same name every dispatch, so a
 * collision means "re-attempt of the same logical work".
 *
 * The row/slice suffix sits at the end of the stem, so it is never cut: before
 * #599 the stem was sliced to 56 characters, and different rows of a long-named
 * plan file shared one id. {@link legacyCutSliceId} gives that old id so state
 * keyed by it can still be matched (see `pure/slice.ts`).
 */
export function dispatchIdentity(item: any): DispatchIdentity {
  const parts = semanticParts(item);
  if (parts) {
    return { stem: semanticStem(parts), verb: parts.verb, hash: null, semantic: true };
  }
  const action = item?.next_action || {};
  const verb = smithyVerb(action.command);
  const args = actionArguments(action);
  // Fallback: legacy hash-based scheme. Order preserved exactly so existing
  // state.json / archive entries keyed by the legacy id continue to match.
  const basis = [item?.path || item?.title || "smithy", ...args].join(" ");
  const truncStem = slugifyDispatchPart(basis, "smithy").slice(0, 44);
  const hash = hashText(dispatchItemKey(item)).slice(0, 8);
  return { stem: truncStem, verb, hash, semantic: false };
}

/** The pre-#599 56-character stem, or null when it equals today's stem (the id
 *  never changed). Several rows can share one legacy stem. */
function legacyCutStem(item: any): { stem: string; verbSlug: string } | null {
  const parts = semanticParts(item);
  if (!parts) return null;
  const legacy = slugifyDispatchPart(parts.slug + parts.suffix, "smithy", LEGACY_SEMANTIC_STEM);
  if (legacy === semanticStem(parts)) return null;
  return { stem: legacy, verbSlug: slugifyDispatchPart(parts.verb, "step") };
}

/**
 * The slice id this item had before #599, when it differs from
 * {@link dispatchSliceId}; null otherwise. It is ambiguous: sibling rows of a
 * long-named plan file all map to the same legacy id.
 */
export function legacyCutSliceId(item: any): string | null {
  const legacy = legacyCutStem(item);
  return legacy ? legacy.stem + "-" + legacy.verbSlug : null;
}

/** The branch this item had before #599, when it differs from {@link dispatchBranch}. */
export function legacyCutBranch(item: any): string | null {
  const legacy = legacyCutStem(item);
  return legacy ? "smithy/" + legacy.verbSlug + "/" + legacy.stem : null;
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
