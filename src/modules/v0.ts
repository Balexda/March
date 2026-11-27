import type {
  CloseOutReport, DestinationBinding, LandedReport, WorkCandidate, WorkDiagnostic,
  ProducerHandoff, StewardRef, WorkItem, WorkKind,
} from "./work.js";
import type { ActionableSignal, Intent, ModuleStep, SignalSet } from "./vocabulary.js";

export * from "./work.js";
export type * from "./vocabulary.js";
export { arbitrateSignals, rankSignals, signalReportMatches, type SignalDecision } from "./signals.js";
export * from "./eligibility.js";

export const WORK_MODULE_CONTRACT_VERSION = "0.1.0";

type Result<T> = T | Promise<T>;

export interface DiscoveryContext<SourceObservation = unknown> {
  readonly profile: { readonly id: string };
  readonly observations: readonly SourceObservation[];
}

export interface PreparationContext<PlanningInput = unknown> {
  readonly item: WorkItem;
  readonly planning: PlanningInput;
}

export type Preparation =
  | { readonly kind: "instructions"; readonly instructions: string }
  | { readonly kind: "handoff"; readonly proposal: ProducerHandoff };

export interface ResponseContext<Signal extends ActionableSignal = ActionableSignal> {
  readonly item: WorkItem;
  readonly signal: Signal;
  readonly steward?: StewardRef;
}

type FollowUpStep = "update-labels" | "write-feedback";
type ResponseStep = Exclude<ModuleStep, "land-artifact" | "close-out-origin">;

export type ResponderRegistration = {
  [Category in ActionableSignal["category"]]: {
    readonly kind: WorkKind;
    readonly category: Category;
    readonly respond: (
      context: ResponseContext<ActionableSignal & { readonly category: Category }>,
    ) => Result<Intent<ResponseStep> | undefined>;
  };
}[ActionableSignal["category"]];

export interface ProducerObserve<SourceObservation = unknown> {
  discover(context: DiscoveryContext<SourceObservation>): Result<readonly WorkCandidate[]>;
}

export interface OriginAct {
  proposeCloseOut?(context: { readonly item: WorkItem; readonly landed: LandedReport }): Result<
    Intent<"close-out-origin"> | undefined
  >;
  onCloseOut?(report: CloseOutReport): Result<void>;
}

export interface ProducerAct<PlanningInput = unknown> extends OriginAct {
  prepare?(context: PreparationContext<PlanningInput>): Result<Preparation>;
  readonly responders?: readonly ResponderRegistration[];
  onLanded?(report: LandedReport): Result<Intent<FollowUpStep> | undefined>;
}

interface ModuleIdentity {
  readonly id: string;
  readonly contractVersion: string;
}

export interface ProducerModule<SourceObservation = unknown, PlanningInput = unknown> extends ModuleIdentity {
  readonly role: "producer";
  readonly kinds: readonly WorkKind[];
  readonly aliases?: Readonly<Partial<Record<string, WorkKind>>>;
  readonly observe: ProducerObserve<SourceObservation>;
  readonly act: ProducerAct<PlanningInput>;
}

export interface DestinationContext {
  readonly item: WorkItem;
  readonly destination: DestinationBinding;
}

export interface DestinationDecisionContext<Policy = unknown> extends DestinationContext {
  readonly signals: SignalSet;
  readonly policy: Policy;
}

export type DestinationDecision =
  | { readonly status: "proposed"; readonly intents: readonly Intent<"land-artifact" | "request-review">[] }
  | { readonly status: "blocked"; readonly diagnostic: WorkDiagnostic };

export interface DestinationObserve {
  observe(context: DestinationContext): Result<SignalSet>;
}

export interface DestinationAct<Policy = unknown> extends OriginAct {
  evaluate(context: DestinationDecisionContext<Policy>): Result<DestinationDecision>;
}

export interface DestinationModule<Policy = unknown> extends ModuleIdentity {
  readonly role: "destination";
  readonly observe: DestinationObserve;
  readonly act: DestinationAct<Policy>;
}
