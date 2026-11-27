import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  WORK_MODULE_CONTRACT_VERSION,
  createHandoffSuccessor,
  resolveWorkKind,
  type CloseOutReport,
  type DestinationModule,
  type LandedReport,
  type ProducerHandoff,
  type ProducerModule,
  type ResponderRegistration,
  type WorkItem,
} from "@balexda/march/modules/v0";

const contractVersion = WORK_MODULE_CONTRACT_VERSION;
const destination = { moduleId: "github", instanceId: "example/repo" };
const artifact = { kind: "github-pr", id: "example/repo#42" };
const triageItem: WorkItem = {
  id: "triage-1",
  producer: "triage",
  kind: "triage/issue",
  origin: { source: "github-issue", objectId: "example/repo#1" },
  destination,
  entryStage: "discover",
  closeOutOwner: "triage",
  participatingProducers: ["intake", "triage"],
};

for (const alias of ["cut", "forge", "spark", "ignite", "render", "mark", "fix", "strike"] as const) {
  equal(resolveWorkKind(alias), `smithy/${alias}`);
}
equal(resolveWorkKind("dependabot/update"), "dependabot/update");

const responder: ResponderRegistration = {
  kind: "smithy/forge",
  category: "review-thread",
  respond: ({ item, signal, steward }) => ({
    itemId: item.id,
    step: "remediate",
    inputs: { instructions: signal.body, steward },
  }),
};
const smithy: ProducerModule = {
  id: "smithy",
  role: "producer",
  contractVersion,
  kinds: [resolveWorkKind("forge")],
  observe: { discover: () => [] },
  act: {
    responders: [responder],
    prepare: () => ({ kind: "instructions", instructions: "Implement the slice." }),
    onLanded: (report) => ({
      itemId: report.itemId,
      step: "write-feedback",
      inputs: { target: { kind: "artifact", artifact: report.artifact }, body: "Landed." },
    }),
  },
};
const proposal: ProducerHandoff = {
  predecessorId: triageItem.id,
  receivingProducer: smithy.id,
  kind: "smithy/forge",
  destination,
  entryStage: "implement",
};
const successor = createHandoffSuccessor("smithy-1", triageItem, proposal, smithy);
equal(successor.predecessorId, triageItem.id);
equal(successor.producer, smithy.id);
equal(successor.kind, "smithy/forge");
deepStrictEqual(successor.origin, triageItem.origin);
equal(successor.closeOutOwner, triageItem.closeOutOwner);
deepStrictEqual(successor.participatingProducers, ["intake", "triage", "smithy"]);
throws(() => createHandoffSuccessor("smithy-1", triageItem, { ...proposal, kind: "smithy/cut" }, smithy));
throws(() => createHandoffSuccessor("smithy-1", triageItem, { ...proposal, predecessorId: "other" }, smithy));

const dependabot: WorkItem = {
  id: "dependency-1",
  producer: "dependabot",
  kind: "dependabot/update",
  origin: { source: "github-pr", objectId: artifact.id },
  destination,
  entryStage: "land",
  artifact,
  closeOutOwner: "dependabot",
  participatingProducers: ["dependabot"],
};
equal(dependabot.steward, undefined);

const github: DestinationModule<{ readonly autoLand: boolean }> = {
  id: "github",
  role: "destination",
  contractVersion,
  observe: {
    observe: ({ item, destination }) => ({
      itemId: item.id,
      destination,
      checks: {
        notPossible: { category: "not-possible", kind: "platform", status: "passed" },
        notPermitted: { category: "not-permitted", kind: "platform", status: "passed" },
        user: [],
      },
      approvals: [],
      comments: [],
    }),
  },
  act: {
    evaluate: ({ item, policy, destination }) => policy.autoLand && item.artifact
      ? {
        status: "proposed",
        intents: [{ itemId: item.id, step: "land-artifact", inputs: { destination, artifact: item.artifact } }],
      }
      : { status: "blocked", diagnostic: { code: "blocked", message: "Landing is unavailable." } },
  },
};
const binding = { item: dependabot, destination };
const signals = await github.observe.observe(binding);
const decision = await github.act.evaluate({ ...binding, signals, policy: { autoLand: true } });
equal(decision.status, "proposed");

const landed: LandedReport = { itemId: successor.id, destination, artifact };
const triage: ProducerModule = {
  id: "triage",
  role: "producer",
  contractVersion,
  kinds: ["triage/issue"],
  observe: { discover: () => [triageItem] },
  act: {
    proposeCloseOut: ({ item, landed }) => ({
      itemId: item.id,
      step: "close-out-origin",
      inputs: { origin: item.origin, landed },
    }),
  },
};
equal((await triage.act.proposeCloseOut?.({ item: successor, landed }))?.itemId, landed.itemId);
equal((await smithy.act.onLanded?.(landed))?.itemId, successor.id);

const outcome = { itemId: successor.id, origin: successor.origin, owner: successor.closeOutOwner };
const failure: CloseOutReport = {
  ...outcome,
  outcome: "failed",
  diagnostic: { code: "close-failed", message: "The issue could not be closed." },
};
const replay: CloseOutReport = { ...outcome, outcome: "already-completed" };
equal(failure.itemId, replay.itemId);

// @ts-expect-error A close-out failure requires a diagnostic.
const invalidFailure: CloseOutReport = { ...outcome, outcome: "failed" };
void invalidFailure;

console.log(contractVersion);
