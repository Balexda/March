/**
 * GitHub repository-name validation shared by the request validator
 * (`server.ts`) and the policy loader (`auth/policy.ts`), so both accept
 * exactly the same `owner` and `name` segments.
 *
 * A provider puts these values into GitHub API paths, so `.` and `..` (any
 * dot-only segment) must never get through.
 */

const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const DOTS_ONLY = /^\.+$/;

/** GitHub's maximum owner (user or organization) login length. */
export const MAX_OWNER_LENGTH = 39;
/** GitHub's maximum repository name length. */
export const MAX_REPO_NAME_LENGTH = 100;

function isValidSegment(segment: string, maxLength: number): boolean {
  return (
    segment.length <= maxLength && SEGMENT_PATTERN.test(segment) && !DOTS_ONLY.test(segment)
  );
}

/** A valid repository owner: letters, digits, `_`, `.`, `-`; not dot-only; at most 39 characters. */
export function isValidOwner(owner: string): boolean {
  return isValidSegment(owner, MAX_OWNER_LENGTH);
}

/** A valid repository name: letters, digits, `_`, `.`, `-`; not dot-only; at most 100 characters. */
export function isValidRepoName(name: string): boolean {
  return isValidSegment(name, MAX_REPO_NAME_LENGTH);
}

/** Exactly `owner/name`, with GitHub's length limits and no dot-only segment. */
export function isValidRepo(repo: string): boolean {
  const parts = repo.split("/");
  if (parts.length !== 2) return false;
  const [owner = "", name = ""] = parts;
  return isValidOwner(owner) && isValidRepoName(name);
}
