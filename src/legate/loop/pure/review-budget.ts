import type { ReviewRequestRecord } from "../../../herald/events.js";

export interface ReviewRequestLimits {
  waitMs: number;
  dailyCap: number;
}

export function reviewRequestLimits(env: NodeJS.ProcessEnv, warn: (message: string) => void) {
  function integer(key: string, fallback: number, minimum: number, scale = 1): number {
    const value = env[key];
    if (value === undefined || (value === "" && fallback === Infinity)) return fallback;
    const number = Number(value);
    if (/^\d+$/.test(value) && Number.isSafeInteger(number * scale) && number >= minimum) return number;
    warn(`Invalid ${key}; using ${fallback === Infinity ? "unlimited" : fallback}.`);
    return fallback;
  }
  return {
    copilotDailyCap: integer("MARCH_COPILOT_REVIEWS_PER_DAY", 0, 0),
    copilotMonthlyCap: integer("MARCH_COPILOT_REVIEWS_PER_MONTH", 0, 0),
    dailyCap: integer("MARCH_CODERABBIT_REVIEWS_PER_DAY", Infinity, 0),
    waitMs: integer("MARCH_REVIEW_WAIT_MINUTES", 30, 1, 60_000) * 60_000,
  };
}

type Reviewer = ReviewRequestRecord["reviewer"];
type Window = "day" | "month";
type RequestHistory = Readonly<Record<string, readonly ReviewRequestRecord[]>>;

export function remainingReviewCap(
  history: RequestHistory, reviewer: Reviewer, window: Window, limit: number, at: string,
): number | null {
  if (limit === Infinity) return null;
  // Herald validates request timestamps as UTC ISO strings.
  const bucket = at.slice(0, window === "day" ? 10 : 7);
  let used = 0;
  for (const requests of Object.values(history)) {
    for (const request of requests) {
      if (request.reviewer === reviewer && request.at.startsWith(bucket)) used++;
    }
  }
  return Math.max(0, limit - used);
}

export function reviewCapSamples(history: RequestHistory, limits: ReturnType<typeof reviewRequestLimits>, at: string) {
  const windows: { reviewer: Reviewer; window: Window; limit: number }[] = [
    { reviewer: "coderabbit", window: "day", limit: limits.dailyCap },
    { reviewer: "copilot", window: "day", limit: limits.copilotDailyCap },
    { reviewer: "copilot", window: "month", limit: limits.copilotMonthlyCap },
  ];
  return windows.flatMap(({ reviewer, window, limit }) => {
    const remaining = remainingReviewCap(history, reviewer, window, limit, at);
    return remaining === null ? [] : [{ reviewer, window, remaining }];
  });
}
