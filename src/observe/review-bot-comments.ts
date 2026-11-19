/**
 * Review-bot conversation comments that are NOT feedback for the steward.
 *
 * Sensing (`sense-io.ts`) classifies each full comment body with
 * `classifyReviewerComment` before building previews. Anything other than
 * `feedback` is dropped from `conversation_comments`, so babysit never dispatches
 * a `/smithy.fix` turn for it and it never counts as an `owes_comments` merge
 * blocker. Notices from a verified reviewer bot identity are surfaced as
 * `reviewer_notices`; marker text alone never creates one.
 *
 * Marker and command matches are prefix matches: a reviewer who quotes a marker
 * or a bot handle further down a comment is leaving genuine feedback. Inline
 * review threads are sensed separately and are unaffected.
 */
import { MARCH_BOT_MARKER } from "./march-bot.js";
import { isCodexReviewSummary } from "./codex-review.js";

/** The HTML comment every CodeRabbit-authored conversation comment opens with. */
export const CODERABBIT_COMMENT_MARKER = "<!-- coderabbit-ai-generated:v1 -->";

/** Handles of review bots whose commands are not addressed to the steward. */
export const REVIEW_BOT_HANDLES = ["coderabbitai", "codex"] as const;

/** True when the body opens with CodeRabbit's generated-comment marker. */
export function isCodeRabbitComment(body: unknown): boolean {
  return typeof body === "string" && body.trimStart().startsWith(CODERABBIT_COMMENT_MARKER);
}

// `@handle` at the very start, ended by whitespace or end of body, so a different
// handle that merely starts the same way (`@codexbot`) is not mistaken for one.
const REVIEW_BOT_COMMAND_RE = new RegExp(`^@(?:${REVIEW_BOT_HANDLES.join("|")})(?:\\s|$)`, "i");

/** True when the body opens with a command to a review bot, e.g. `@coderabbitai review`. */
export function isReviewBotCommand(body: unknown): boolean {
  return typeof body === "string" && REVIEW_BOT_COMMAND_RE.test(body.trimStart());
}

type NoticeKind = "status" | "in_progress" | "rate_limited" | "paused";

export interface ReviewerNotice {
  reviewer: string;
  kind: NoticeKind;
  created_at: string;
  reset_at?: string;
}

interface ReviewerComment {
  author?: string;
  authorType?: string;
  body: string;
  createdAt?: string;
}

interface ReviewerAdapter {
  id: string;
  logins: readonly string[];
  classifyComment(comment: ReviewerComment): { kind: NoticeKind; resetAt?: string };
}

function parseResetAt({ body, createdAt }: ReviewerComment): string | undefined {
  const absolute = body.match(/\b(?:reset(?:s|_at)?(?: at)?|try again (?:at|after)|resumes? at)[: \x60]+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i)?.[1];
  const absoluteTime = Date.parse(absolute ?? "");
  if (Number.isFinite(absoluteTime)) return new Date(absoluteTime).toISOString();

  const wait = body.match(/\b(?:please wait|try again in) \*{0,2}(?:(\d+) minutes?(?: and )?)?(?:(\d+) seconds?)?/i);
  if (!wait || (!wait[1] && !wait[2])) return undefined;
  // Anchor the duration to the notice so repeated sensing reports the same reset.
  const seconds = Number(wait[1] ?? 0) * 60 + Number(wait[2] ?? 0);
  const reset = new Date(Date.parse(createdAt ?? "") + seconds * 1000);
  return Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined;
}

const CODERABBIT_LEGACY_MARKER = /^<!-- This is an auto-generated comment: (?:summarize|rate limited|review paused) by coderabbit\.ai -->/i;
const REVIEWERS: readonly ReviewerAdapter[] = [
  {
    id: "coderabbit",
    logins: ["coderabbitai"],
    classifyComment(comment) {
      const { body } = comment;
      if (/<!-- This is an auto-generated comment: rate limited by coderabbit\.ai -->|^(?:>\s*)?(?:#{1,6}\s*)?(?:rate limit exceeded|rate limited)\b/im.test(body)) {
        return { kind: "rate_limited", resetAt: parseResetAt(comment) };
      }
      if (/<!-- This is an auto-generated comment: review paused by coderabbit\.ai -->|^(?:>\s*)?(?:#{1,6}\s*)?reviews? paused\b/im.test(body)) {
        return { kind: "paused", resetAt: parseResetAt(comment) };
      }
      if (/^(?:>\s*)?(?:#{1,6}\s*)?(?:currently processing new changes in this PR|review in progress)\b/im.test(body)) {
        return { kind: "in_progress" };
      }
      return { kind: "status" };
    },
  },
  {
    id: "copilot",
    logins: ["copilot-pull-request-reviewer"],
    classifyComment: () => ({ kind: "status" }),
  },
];

type Classification =
  | { kind: "feedback" | "trigger" }
  | { kind: NoticeKind; reviewer?: string; resetAt?: string };

/** Classify full conversation bodies before projecting bounded previews. */
export function classifyReviewerComment(comment: ReviewerComment): Classification {
  const body = comment.body.trimStart();
  if (
    isReviewBotCommand(body) ||
    (body.startsWith(MARCH_BOT_MARKER) && isReviewBotCommand(body.slice(MARCH_BOT_MARKER.length))) ||
    body.startsWith("<!-- march-bot:review-trigger -->")
  ) return { kind: "trigger" };

  const login = (comment.author ?? "").toLowerCase();
  const isBot = comment.authorType === "Bot" || login.endsWith("[bot]");
  const normalizedLogin = login.replace(/\[bot\]$/, "");
  // Codex also posts actionable conversation feedback. Classify its summaries
  // by their opening marker and leave its unmarked comments eligible.
  if (isCodexReviewSummary(body)) {
    return { kind: "status", reviewer: isBot && normalizedLogin === "chatgpt-codex-connector" ? "codex" : undefined };
  }

  const reviewer = isBot && REVIEWERS.find(({ logins }) => logins.includes(normalizedLogin));
  if (reviewer) return { reviewer: reviewer.id, ...reviewer.classifyComment(comment) };
  if (isCodeRabbitComment(body) || CODERABBIT_LEGACY_MARKER.test(body)) return { kind: "status" };
  return { kind: "feedback" };
}
