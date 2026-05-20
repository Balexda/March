import crypto from "node:crypto";

/** Short, stable hex digest used for dedup keys and dispatch ids. Pure. */
export function hashText(text: unknown): string {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}
