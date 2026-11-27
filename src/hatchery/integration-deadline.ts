import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_TIMEOUT_MS = 3_900_000;
const MAX_TIMER_MS = 2_147_483_647;
const currentDeadline = new AsyncLocalStorage<number>();

export function stewardDeadlineFromNow(env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const configured = Number(env.MARCH_STEWARD_TIMEOUT_MS);
  const timeout = Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_TIMER_MS
    ? configured : DEFAULT_TIMEOUT_MS;
  return new Date(now + timeout).toISOString();
}

export function withStewardDeadline<T>(deadline: string | undefined, work: () => T): T {
  return deadline === undefined ? work() : currentDeadline.run(Date.parse(deadline), work);
}

export function stewardDeadlineExpired(): boolean {
  const deadline = currentDeadline.getStore();
  return deadline !== undefined && Date.now() >= deadline;
}

export function stewardTimeRemaining(limitMs: number): number {
  const deadline = currentDeadline.getStore();
  if (deadline === undefined) return limitMs;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw Object.assign(new Error("The Steward deadline expired."), { code: "ETIMEDOUT" });
  }
  return Math.min(remaining, limitMs);
}

export function stewardOperationSignal(limitMs: number): AbortSignal {
  return AbortSignal.timeout(stewardTimeRemaining(limitMs));
}


export function attemptDeadlineSignal(): AbortSignal | undefined {
  return currentDeadline.getStore() === undefined ? undefined : stewardOperationSignal(MAX_TIMER_MS);
}

export const fetchDuringStewardAttempt: typeof fetch = (input, init) => {
  const deadline = attemptDeadlineSignal();
  if (!deadline) return fetch(input, init);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
  });
};
