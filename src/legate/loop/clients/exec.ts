import { execFileSync } from "node:child_process";

/** Run a command, returning stdout as text. Throws on non-zero exit. */
export function execText(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): string {
  const out = execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof out === "string" ? out : "";
}
