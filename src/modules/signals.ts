import type { ResponderRegistration } from "./v0.js";
import type { ActionableSignal, SignalSet } from "./vocabulary.js";
import type { DestinationBinding, WorkItem } from "./work.js";

export function sameDestination(left: DestinationBinding, right: DestinationBinding): boolean {
  return left.moduleId === right.moduleId && left.instanceId === right.instanceId;
}

function checkStatus(status: unknown): boolean {
  return status === "pending" || status === "passed" || status === "failed";
}

export function signalReportMatches(item: WorkItem, report: SignalSet): boolean {
  return report.itemId === item.id && !!report.destination && sameDestination(report.destination, item.destination)
    && report.checks?.notPossible?.category === "not-possible" && report.checks.notPossible.kind === "platform"
    && checkStatus(report.checks.notPossible.status)
    && report.checks.notPermitted?.category === "not-permitted" && report.checks.notPermitted.kind === "platform"
    && checkStatus(report.checks.notPermitted.status)
    && Array.isArray(report.checks.user) && report.checks.user.every(
      check => check?.category === "user-check" && check.kind === "user" && checkStatus(check.status),
    )
    && Array.isArray(report.comments) && report.comments.every(comment =>
      (comment?.category === "review-thread" || comment?.category === "conversation-comment")
      && typeof comment.reference === "string" && typeof comment.body === "string",
    )
    && Array.isArray(report.approvals) && report.approvals.every(approval =>
      approval?.state === "pending" || approval?.state === "approved" || approval?.state === "changes-requested",
    );
}

/** Report only unresolved review threads and actionable conversation comments. */
export function rankSignals(report: SignalSet): readonly ActionableSignal[] {
  const { notPossible, notPermitted, user } = report.checks;
  return [
    ...(notPossible.status === "failed" ? [notPossible] : []),
    ...report.comments.filter(comment => comment.category === "review-thread"),
    ...user.filter(check => check.status === "failed"),
    ...report.comments.filter(comment => comment.category === "conversation-comment"),
    ...(notPermitted.status === "failed" ? [notPermitted] : []),
  ];
}

export type SignalDecision =
  | { readonly status: "idle" | "deferred" }
  | { readonly status: "needs-human"; readonly signal: ActionableSignal }
  | { readonly status: "respond"; readonly signal: ActionableSignal; readonly responder: ResponderRegistration };

/** Share one set of steward session ids across all items in a tick. */
export function arbitrateSignals(
  item: WorkItem,
  report: SignalSet,
  responders: readonly ResponderRegistration[],
  actedStewards: Set<string>,
): SignalDecision {
  if (!signalReportMatches(item, report)) throw new Error("Invalid destination signal report");
  const [signal] = rankSignals(report);
  if (!signal) return { status: "idle" };

  const stewardId = item.steward?.sessionId;
  if (stewardId && actedStewards.has(stewardId)) return { status: "deferred" };

  const responder = responders.find(entry => entry.kind === item.kind && entry.category === signal.category);
  if (!responder) return { status: "needs-human", signal };

  if (stewardId) actedStewards.add(stewardId);
  return { status: "respond", signal, responder };
}
