export type WorkKind = `${string}/${string}`;
export type WorkStage = "discover" | "implement" | "steward" | "land" | "close-out";

const smithyAliases = {
  cut: "smithy/cut",
  forge: "smithy/forge",
  spark: "smithy/spark",
  ignite: "smithy/ignite",
  render: "smithy/render",
  mark: "smithy/mark",
  fix: "smithy/fix",
  strike: "smithy/strike",
} as const satisfies Record<string, WorkKind>;

export type SmithyAlias = keyof typeof smithyAliases;

export function resolveWorkKind(kind: WorkKind | SmithyAlias): WorkKind {
  return Object.hasOwn(smithyAliases, kind) ? smithyAliases[kind as SmithyAlias] : kind as WorkKind;
}

export interface OriginRef {
  readonly source: string;
  readonly objectId: string;
}

export interface DestinationBinding {
  readonly moduleId: string;
  readonly instanceId: string;
}

export interface ArtifactRef {
  readonly kind: string;
  readonly id: string;
}

export interface StewardRef {
  readonly sessionId: string;
}

export interface WorkCandidate {
  readonly kind: WorkKind;
  readonly origin: OriginRef;
  readonly destination: DestinationBinding;
  readonly entryStage: WorkStage;
  readonly closeOutOwner: string;
  readonly artifact?: ArtifactRef;
}

export interface WorkItem extends WorkCandidate {
  readonly id: string;
  readonly producer: string;
  readonly participatingProducers: readonly string[];
  readonly steward?: StewardRef;
  readonly predecessorId?: string;
}

export interface ProducerHandoff {
  readonly predecessorId: string;
  readonly receivingProducer: string;
  readonly kind: WorkKind;
  readonly destination: DestinationBinding;
  readonly entryStage: WorkStage;
  readonly artifact?: ArtifactRef;
}

export function createHandoffSuccessor(
  id: string,
  predecessor: WorkItem,
  proposal: ProducerHandoff,
  receivingProducer: { readonly id: string; readonly kinds: readonly WorkKind[] },
): WorkItem {
  if (proposal.predecessorId !== predecessor.id) {
    throw new Error("Handoff must reference the predecessor item");
  }
  if (proposal.receivingProducer !== receivingProducer.id || !receivingProducer.kinds.includes(proposal.kind)) {
    throw new Error("Handoff kind must be declared by the receiving producer");
  }

  return {
    id,
    predecessorId: predecessor.id,
    producer: receivingProducer.id,
    kind: proposal.kind,
    origin: predecessor.origin,
    destination: proposal.destination,
    entryStage: proposal.entryStage,
    closeOutOwner: predecessor.closeOutOwner,
    artifact: proposal.artifact,
    participatingProducers: [...new Set([
      ...predecessor.participatingProducers,
      predecessor.producer,
      receivingProducer.id,
    ])],
  };
}

export interface LandedReport {
  readonly itemId: string;
  readonly destination: DestinationBinding;
  readonly artifact: ArtifactRef;
}

export interface WorkDiagnostic {
  readonly code: string;
  readonly message: string;
}

export type CloseOutReport = {
  readonly itemId: string;
  readonly origin: OriginRef;
  readonly owner: string;
} & (
  | { readonly outcome: "closed" | "already-completed"; readonly diagnostic?: never }
  | { readonly outcome: "failed"; readonly diagnostic: WorkDiagnostic }
);
