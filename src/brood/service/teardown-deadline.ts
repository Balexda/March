/** Leave headroom under the default 30s client timeout, including queue time. */
export const TEARDOWN_REQUEST_MS = 25_000;
export const TEARDOWN_FINALIZATION_MS = 3_000;
/**
 * Share of the pre-finalization window kept for each Git step. Steps before
 * Git stop at `finalization + 2 × reserve` before the request deadline, and
 * worktree removal stops one reserve earlier than branch deletion. A stalled
 * retry prefix therefore cannot starve branch deletion.
 */
export const TEARDOWN_GIT_STEP_RESERVE_MS = 2_000;

export class TeardownDeadlineError extends Error {}

/**
 * A timed-out mutation can still have I/O in flight. Keep its archive fenced
 * until the provider settles, without holding the HTTP response or event loop.
 */
const draining = new Set<string>();

export function teardownCall<T>(
  label: string,
  deadline: number,
  operation: (signal: AbortSignal) => T | Promise<T>,
  archiveKey?: string,
): Promise<T> {
  if (archiveKey && draining.has(archiveKey)) {
    return Promise.reject(new TeardownDeadlineError(
      `${label} deferred: a timed-out teardown operation is still settling; retry teardown`,
    ));
  }
  const remaining = Math.floor(deadline - performance.now());
  const error = new TeardownDeadlineError(`${label} deadline exceeded; retry teardown`);
  if (remaining <= 0) return Promise.reject(error);

  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (archiveKey) draining.add(archiveKey);
      controller.abort(error);
      reject(error);
    }, remaining);
    const settled = () => {
      clearTimeout(timer);
      if (controller.signal.aborted && archiveKey) draining.delete(archiveKey);
    };
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => { settled(); resolve(value); },
      (failure: unknown) => { settled(); reject(failure); },
    );
  });
}

/**
 * Group primaries whose shared workspace is being reclaimed. Brood rejects
 * steward registration into such a group from the membership check through
 * the Git mutation, so a new steward cannot lose its checkout mid-removal.
 */
const reclaiming = new Map<string, number>();

export function workspaceReclaimActive(primaryId: string | undefined): boolean {
  return primaryId !== undefined && reclaiming.has(primaryId);
}

/** Hold the reclaim lease until `operation` settles, even after a deadline. */
export async function withWorkspaceReclaim<T>(primaryId: string, operation: () => Promise<T>): Promise<T> {
  reclaiming.set(primaryId, (reclaiming.get(primaryId) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const count = (reclaiming.get(primaryId) ?? 1) - 1;
    if (count > 0) reclaiming.set(primaryId, count);
    else reclaiming.delete(primaryId);
  }
}
