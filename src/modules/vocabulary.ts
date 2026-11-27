import type { ArtifactRef, DestinationBinding, LandedReport, OriginRef, StewardRef } from "./work.js";

export type CheckStatus = "pending" | "passed" | "failed";

export interface CheckSignal<Category extends "not-possible" | "not-permitted" | "user-check"> {
  readonly category: Category;
  readonly kind: Category extends "user-check" ? "user" : "platform";
  readonly status: CheckStatus;
  readonly reference?: string;
}

export interface CommentSignal {
  readonly category: "review-thread" | "conversation-comment";
  readonly reference: string;
  readonly body: string;
}

export interface ApprovalSignal {
  readonly state: "pending" | "approved" | "changes-requested";
  readonly reference?: string;
}

export type ActionableSignal = CheckSignal<"not-possible"> | CheckSignal<"not-permitted">
  | CheckSignal<"user-check"> | CommentSignal;

export interface SignalSet {
  readonly itemId: string;
  readonly destination: DestinationBinding;
  readonly checks: {
    readonly notPossible: CheckSignal<"not-possible">;
    readonly notPermitted: CheckSignal<"not-permitted">;
    readonly user: readonly CheckSignal<"user-check">[];
  };
  readonly comments: readonly CommentSignal[];
  readonly approvals: readonly ApprovalSignal[];
}

type FeedbackTarget =
  | { readonly kind: "artifact"; readonly artifact: ArtifactRef }
  | { readonly kind: "origin"; readonly origin: OriginRef };

export interface StepInputs {
  implement: { readonly instructions: string; readonly steward?: StewardRef };
  remediate: { readonly instructions: string; readonly steward?: StewardRef };
  "request-review": { readonly artifact: ArtifactRef; readonly mode: "initial" | "fresh" };
  "update-labels": { readonly target: FeedbackTarget; readonly add: readonly string[]; readonly remove: readonly string[] };
  "write-feedback": { readonly target: FeedbackTarget; readonly body: string; readonly stickyKey?: string };
  "recover-github-pr-conflict": { readonly pr: ArtifactRef; readonly headBranch: string; readonly expectedHead: string };
  "land-artifact": { readonly destination: DestinationBinding; readonly artifact: ArtifactRef };
  "close-out-origin": { readonly origin: OriginRef; readonly landed: LandedReport };
  "delete-branch": { readonly branch: string };
  "delete-worktree": { readonly path: string };
  teardown: Record<string, never>;
}

export type Step = keyof StepInputs;
export type ModuleStep = Exclude<Step, "delete-branch" | "delete-worktree" | "teardown">;

export type Intent<Allowed extends Step = Step> = {
  [Kind in Allowed]: {
    readonly itemId: string;
    readonly step: Kind;
    readonly inputs: StepInputs[Kind];
  };
}[Allowed];
