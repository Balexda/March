export function reviewConfigInteger(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
  key: string,
  fallback: number,
  minimum: number,
  scale = 1,
): number {
  const value = env[key];
  if (value === undefined || (value === "" && fallback === Infinity)) return fallback;
  const number = Number(value);
  if (/^\d+$/.test(value) && Number.isSafeInteger(number * scale) && number >= minimum) return number;
  warn(`Invalid ${key}; using ${fallback === Infinity ? "unlimited" : fallback}.`);
  return fallback;
}

export function reviewWaitMs(env: NodeJS.ProcessEnv, warn: (message: string) => void): number {
  return reviewConfigInteger(env, warn, "MARCH_REVIEW_WAIT_MINUTES", 30, 1, 60_000) * 60_000;
}
