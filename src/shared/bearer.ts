import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of an `Authorization: Bearer <token>` header against the
 * expected token. Shared by every March service that gates routes on a static
 * shared secret (Castra, Statio, the Legate operator API).
 */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
