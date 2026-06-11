import type { LoopMeta } from "../meta.js";
import { readSmithyStatus } from "../../../observe/smithy-status.js";
import type { FoldDeps } from "./sense.js";

/**
 * Build the dependency surface the legate's Stage 1 ({@link senseFromHerald})
 * needs. This is the legate's replacement for `sense-io.ts`'s `createSenseIo`:
 * the legate reads the world from the **folded Herald inbox**, never from `gh`,
 * so all it needs here is the local smithy-graph read. Keeping this on its own —
 * and gh-free — is what isolates the gh sensing to Herald; one glance at this
 * module shows the legate's fold sense has no GitHub I/O.
 *
 * (Herald, by contrast, builds the full {@link SenseDeps} via `sense-io.ts`
 * because its {@link senseObserved} is the path that actually polls `gh`.)
 */
export function createFoldDeps(opts: { meta: LoopMeta; now: () => string }): FoldDeps {
  return {
    meta: opts.meta,
    now: opts.now,
    readSmithyStatus: (repoPath: string) => readSmithyStatus(repoPath),
  };
}
