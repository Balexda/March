/** Leave headroom under the default 30s client timeout, including queue time. */
export const TEARDOWN_REQUEST_MS = 25_000;
export const TEARDOWN_FINALIZATION_MS = 3_000;

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
