import fs from "node:fs";
import path from "node:path";

/**
 * Per-profile worker toolchain selection (issue #287, Phase 1).
 *
 * Spawn worker images are node-only by default (`node:22-bookworm-slim` + git):
 * a non-node repo (e.g. StorySpider's Kotlin/Gradle) can be edited and committed
 * by the commit-based pipeline (#278) but cannot be *built or self-verified* in
 * the container — verification silently falls to CI. This module picks the right
 * toolchain layer image so the worker can run the repo's build.
 *
 * Selection is **auto-detect + per-profile override** (the issue's principle):
 *   - `auto` (default): infer the stack from the repo's own marker files.
 *   - explicit (`jvm`, `node`): force it, overriding detection.
 *
 * The resolved image is `f(agent, toolchain)` — it extends the backend's
 * `baseImage` seam by inserting the toolchain as an image-name segment, so a
 * cached toolchain layer is reused across spawns rather than baked into every
 * snapshot (see {@link resolveToolchainImage}).
 */

/** A concrete toolchain a worker image can provide. `node` is the base image. */
export type ResolvedToolchain = "node" | "jvm";

/**
 * What a profile (or caller) may request. `auto` defers to {@link detectToolchain};
 * the concrete values force a specific image regardless of repo markers.
 */
export type ToolchainSelection = "auto" | ResolvedToolchain;

/** Every accepted selection value — the validation allow-list for the registry. */
export const TOOLCHAIN_SELECTIONS: readonly ToolchainSelection[] = [
  "auto",
  "node",
  "jvm",
];

/** Default selection when a profile omits the field. */
export const DEFAULT_TOOLCHAIN_SELECTION: ToolchainSelection = "auto";

/** True if `value` is one of the accepted {@link ToolchainSelection} strings. */
export function isToolchainSelection(
  value: string,
): value is ToolchainSelection {
  return (TOOLCHAIN_SELECTIONS as readonly string[]).includes(value);
}

/**
 * Repo marker files that imply a JVM (Java/Kotlin/Scala + Gradle/Maven) project.
 * Presence of any one at the repo root selects the `jvm` toolchain under `auto`.
 */
const JVM_MARKERS: readonly string[] = [
  "gradlew",
  "gradlew.bat",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pom.xml",
];

/**
 * Infer the toolchain from a repo's marker files. Today this distinguishes JVM
 * projects (which need a JDK the node base image lacks) from everything else,
 * which falls back to the node base. Designed to grow new stacks (Rust, Python)
 * without changing callers.
 *
 * @param repoRoot - Absolute path to the worktree/snapshot root to inspect.
 */
export function detectToolchain(repoRoot: string): ResolvedToolchain {
  for (const marker of JVM_MARKERS) {
    if (fileExists(path.join(repoRoot, marker))) return "jvm";
  }
  return "node";
}

/** How {@link resolveToolchain} arrived at its result — surfaced in telemetry. */
export type ToolchainResolutionSource = "override" | "detected" | "default";

export interface ResolvedToolchainSelection {
  readonly toolchain: ResolvedToolchain;
  readonly source: ToolchainResolutionSource;
}

/**
 * Resolve the effective toolchain for a spawn: an explicit profile override
 * wins; otherwise the repo markers are auto-detected. An unrecognized or empty
 * override is treated as `auto` (the registry validates the field on write, so
 * this is just defense-in-depth for hand-edited / legacy records).
 *
 * @param override - The profile's `toolchain` field, or undefined.
 * @param repoRoot - Absolute path to the worktree/snapshot root.
 */
export function resolveToolchain(
  override: string | undefined,
  repoRoot: string,
): ResolvedToolchainSelection {
  const normalized = override?.trim();
  // Guard first so TS narrows `normalized` to ToolchainSelection, then exclude
  // `auto` so the remaining type is a concrete ResolvedToolchain.
  if (normalized && isToolchainSelection(normalized) && normalized !== "auto") {
    return { toolchain: normalized, source: "override" };
  }
  const detected = detectToolchain(repoRoot);
  return {
    toolchain: detected,
    source: detected === "node" ? "default" : "detected",
  };
}

/**
 * Resolve the worker image tag for an `(agent, toolchain)` pair by extending the
 * backend's `baseImage`. `node` is the base image itself (no toolchain layer),
 * so it returns `baseImage` unchanged — preserving today's behavior for node
 * repos. Any other toolchain inserts a `-<toolchain>` segment before the tag:
 *
 *   `march-spawn-claude:latest` + `jvm` -> `march-spawn-claude-jvm:latest`
 *
 * The derived image is the cached toolchain layer (agent base + JDK/etc.) that
 * `docker/spawn-<agent>-<toolchain>.Dockerfile` builds; the per-spawn snapshot
 * then `FROM`s it.
 *
 * @param baseImage - The backend's base image tag (`SpawnBackend.baseImage`).
 * @param toolchain - The resolved concrete toolchain.
 */
export function resolveToolchainImage(
  baseImage: string,
  toolchain: ResolvedToolchain,
): string {
  if (toolchain === "node") return baseImage;
  const lastColon = baseImage.lastIndexOf(":");
  // Treat a colon as a tag separator only when it follows a `/` (or there is no
  // `/`), so a registry-port reference like `host:5000/img` isn't mis-split.
  const lastSlash = baseImage.lastIndexOf("/");
  if (lastColon > lastSlash) {
    const name = baseImage.slice(0, lastColon);
    const tag = baseImage.slice(lastColon + 1);
    return `${name}-${toolchain}:${tag}`;
  }
  return `${baseImage}-${toolchain}`;
}

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
