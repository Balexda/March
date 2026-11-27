import { traceIdForDispatch } from "../observability/trace-ids.js";
import { sameDestination, signalReportMatches } from "./signals.js";
import type { Intent, ModuleStep, SignalSet, Step } from "./vocabulary.js";
import type { CloseOutReport, LandedReport, WorkDiagnostic, WorkItem } from "./work.js";

export const STEP_CLASSES = Object.freeze({
  implement: "non-destructive",
  remediate: "non-destructive",
  "request-review": "non-destructive",
  "update-labels": "non-destructive",
  "write-feedback": "non-destructive",
  "recover-github-pr-conflict": "bounded-recovery",
  "land-artifact": "policy-controlled-land",
  "close-out-origin": "policy-controlled-close-out",
  "delete-branch": "destructive",
  "delete-worktree": "destructive",
  teardown: "destructive",
} as const satisfies Record<Step, string>);

export interface BoundedActionContext {
  readonly item: WorkItem;
  /** Identity and capability resolved by core from the facet being called. */
  readonly requester: {
    readonly moduleId: string;
    readonly capability: "responder" | "destination" | "origin-owner" | "landing-participant";
  };
  readonly signals?: SignalSet;
  /** Policy resolved by core for the item's destination instance and kind. */
  readonly policy?: { readonly land: boolean; readonly closeOut: boolean };
  /** Core's first qualifying landing for this origin, and its close-out state. */
  readonly originLanding?: { readonly report: LandedReport; readonly closeOutAttempted: boolean };
  /** Core's current observation of the item's PR head. */
  readonly githubHead?: { readonly branch: string; readonly sha: string };
}

function record(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const allowed = [...required, ...optional];
  return required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}

function matches(value: unknown, expected: object | undefined): boolean {
  if (!expected) return false;
  const fields = Object.entries(expected);
  return record(value, fields.map(([key]) => key)) && fields.every(([key, field]) => value[key] === field);
}

function matchesLanding(value: unknown, report: LandedReport): boolean {
  return record(value, ["itemId", "destination", "artifact"]) && value.itemId === report.itemId
    && matches(value.destination, report.destination) && matches(value.artifact, report.artifact);
}

function isItemLanding(item: WorkItem, report: LandedReport): boolean {
  return item.id === report.itemId && sameDestination(item.destination, report.destination)
    && item.artifact?.id === report.artifact.id && item.artifact.kind === report.artifact.kind;
}

export function landedRecipients(item: WorkItem, confirmed: LandedReport): readonly string[] {
  return isItemLanding(item, confirmed)
    ? [...new Set([item.closeOutOwner, ...item.participatingProducers, item.producer])]
    : [];
}

function itemTarget(value: unknown, item: WorkItem): boolean {
  return (record(value, ["kind", "artifact"]) && value.kind === "artifact" && matches(value.artifact, item.artifact))
    || (record(value, ["kind", "origin"]) && value.kind === "origin" && matches(value.origin, item.origin));
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && Array.from(value).every(element => typeof element === "string");
}

function isResponder({ requester, item }: BoundedActionContext): boolean {
  return requester.capability === "responder" && requester.moduleId === item.producer;
}

function mayWriteFeedback(context: BoundedActionContext): boolean {
  const { item, requester } = context;
  return isResponder(context) || (requester.capability === "landing-participant"
    && (requester.moduleId === item.producer || item.participatingProducers.includes(requester.moduleId)));
}

function eligible(step: ModuleStep, inputs: unknown, context: BoundedActionContext): boolean {
  const { item, requester, policy, signals, originLanding, githubHead } = context;
  const isDestination = requester.capability === "destination" && requester.moduleId === item.destination.moduleId;
  switch (step) {
    case "implement":
    case "remediate":
      return isResponder(context) && record(inputs, ["instructions"], ["steward"])
        && typeof inputs.instructions === "string"
        && (!Object.hasOwn(inputs, "steward") || inputs.steward === undefined || matches(inputs.steward, item.steward));
    case "request-review":
      return (isResponder(context) || isDestination) && record(inputs, ["artifact", "mode"])
        && matches(inputs.artifact, item.artifact) && (inputs.mode === "initial" || inputs.mode === "fresh");
    case "update-labels":
      return mayWriteFeedback(context) && record(inputs, ["target", "add", "remove"])
        && itemTarget(inputs.target, item) && strings(inputs.add) && strings(inputs.remove);
    case "write-feedback":
      return mayWriteFeedback(context) && record(inputs, ["target", "body"], ["stickyKey"])
        && itemTarget(inputs.target, item) && typeof inputs.body === "string"
        && (inputs.stickyKey === undefined || typeof inputs.stickyKey === "string");
    case "land-artifact":
      return isDestination && policy?.land === true && record(inputs, ["destination", "artifact"])
        && matches(inputs.destination, item.destination) && matches(inputs.artifact, item.artifact)
        && !!signals && signalReportMatches(item, signals)
        && signals.checks.notPossible.status === "passed" && signals.checks.notPermitted.status === "passed"
        && signals.checks.user.every(check => check.status === "passed") && signals.comments.length === 0;
    case "close-out-origin":
      return requester.capability === "origin-owner" && requester.moduleId === item.closeOutOwner
        && policy?.closeOut === true && !!originLanding && !originLanding.closeOutAttempted
        && isItemLanding(item, originLanding.report) && record(inputs, ["origin", "landed"])
        && matches(inputs.origin, item.origin) && matchesLanding(inputs.landed, originLanding.report);
    case "recover-github-pr-conflict": {
      const check = signals?.checks?.notPossible;
      return isResponder(context) && item.destination.moduleId === "github-repo" && item.artifact?.kind === "github-pr"
        && !!signals && signalReportMatches(item, signals) && check?.status === "failed"
        && (check.reason === "conflict" || check.reason === "moved-base") && !!githubHead
        && record(inputs, ["pr", "headBranch", "expectedHead"]) && matches(inputs.pr, item.artifact)
        && !!githubHead.branch && inputs.headBranch === githubHead.branch
        && /^[a-f0-9]{40}$/i.test(githubHead.sha) && inputs.expectedHead === githubHead.sha;
    }
  }
}

export type ActionFailure = {
  readonly status: "needs-human";
  readonly itemId: string;
  readonly traceId: string;
  readonly diagnostic: WorkDiagnostic;
};

function actionFailure(itemId: string, diagnostic: WorkDiagnostic): ActionFailure {
  return { status: "needs-human", itemId, traceId: traceIdForDispatch(itemId), diagnostic };
}

export type IntentEligibility =
  | { readonly status: "eligible"; readonly intent: Intent<ModuleStep>; readonly stepClass: typeof STEP_CLASSES[ModuleStep];
      readonly traceId: string }
  | ActionFailure;

/** Pure eligibility check. Execution and atomic reservation of lifecycle state belong to core. */
export function evaluateModuleIntent(value: unknown, context: BoundedActionContext): IntentEligibility {
  const reject = () => actionFailure(context.item.id, {
    code: "ineligible-intent",
    message: "Module intent is outside its capability, item scope, or action policy",
  });
  if (!record(value, ["itemId", "step", "inputs"]) || value.itemId !== context.item.id
      || typeof value.step !== "string" || !Object.hasOwn(STEP_CLASSES, value.step)) return reject();

  const stepClass = STEP_CLASSES[value.step as Step];
  if (stepClass === "destructive" || !eligible(value.step as ModuleStep, value.inputs, context)) return reject();
  return { status: "eligible", intent: value as Intent<ModuleStep>, stepClass, traceId: traceIdForDispatch(context.item.id) };
}

export function recoveryFailure(item: WorkItem, diagnostic: WorkDiagnostic): ActionFailure {
  return actionFailure(item.id, diagnostic);
}

export function closeOutFailure(report: CloseOutReport): ActionFailure | undefined {
  return report.outcome === "failed" ? actionFailure(report.itemId, report.diagnostic) : undefined;
}
