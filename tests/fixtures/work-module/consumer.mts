import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
  WORK_MODULE_CONTRACT_VERSION,
  STEP_CLASSES,
  arbitrateSignals,
  closeOutFailure,
  evaluateModuleIntent,
  landedRecipients,
  rankSignals,
  recoveryFailure,
  signalReportMatches,
  type BoundedActionContext,
  type Intent,
  type ResponseContext,
  type SignalSet,
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

const item = {
  ...successor,
  entryStage: "land",
  artifact,
  destination: { ...destination, moduleId: "github-repo" },
} satisfies WorkItem;
const clear: SignalSet = { ...signals, itemId: item.id, destination: item.destination };
const gateBlocked: SignalSet = {
  ...clear,
  checks: { ...clear.checks, notPermitted: { ...clear.checks.notPermitted, status: "failed" } },
};
equal(signalReportMatches(item, clear), true);
equal(signalReportMatches(item, { ...clear, itemId: "other" }), false);
equal(signalReportMatches(item, { ...clear, destination }), false);
// @ts-expect-error A destination report requires both platform checks.
equal(signalReportMatches(item, { ...clear, checks: { notPossible: clear.checks.notPossible, user: [] } }), false);
deepStrictEqual(rankSignals(clear), []);
deepStrictEqual(rankSignals(gateBlocked).map(signal => signal.category), ["not-permitted"]);

const simultaneous: SignalSet = {
  ...gateBlocked,
  checks: {
    ...gateBlocked.checks,
    notPossible: { ...clear.checks.notPossible, status: "failed", reason: "moved-base" },
    user: [{ kind: "user", category: "user-check", status: "failed", reference: "opaque" }],
  },
  comments: [
    { category: "conversation-comment", reference: "2", body: "Follow up" },
    { category: "review-thread", reference: "1", body: "Changes needed" },
  ],
  approvals: [{ state: "pending", reference: "opaque" }],
};
deepStrictEqual(rankSignals(simultaneous).map(signal => signal.category), [
  "not-possible", "review-thread", "user-check", "conversation-comment", "not-permitted",
]);

const head = { branch: "dependency-update", sha: "a".repeat(40) };
const recovery = {
  itemId: item.id,
  step: "recover-github-pr-conflict",
  inputs: { pr: artifact, headBranch: head.branch, expectedHead: head.sha },
} satisfies Intent;
const recoveryResponder = {
  kind: item.kind,
  category: "not-possible",
  respond: () => recovery,
} satisfies ResponderRegistration;
const acted = new Set<string>();
const withSteward = { ...item, steward: { sessionId: "session-1" } };
equal(arbitrateSignals(withSteward, simultaneous, [responder], acted).status, "needs-human");
equal(arbitrateSignals(withSteward, simultaneous, [recoveryResponder], acted).status, "respond");
equal(arbitrateSignals(withSteward, simultaneous, [recoveryResponder], acted).status, "deferred");
const landEntryDecision = arbitrateSignals(item, simultaneous, [recoveryResponder], acted);
ok(landEntryDecision.status === "respond" && landEntryDecision.responder.category === "not-possible"
  && landEntryDecision.signal.category === "not-possible");
deepStrictEqual(await landEntryDecision.responder.respond({ item, signal: landEntryDecision.signal }), recovery);

const moduleContext: ResponseContext = { item, signal: simultaneous.checks.notPossible };
// @ts-expect-error Module contexts carry no GitHub write client.
equal(moduleContext.github, undefined);
// @ts-expect-error Module contexts carry no Git credentials.
equal(moduleContext.gitCredentials, undefined);

const destinationRequest: BoundedActionContext = {
  item,
  signals: clear,
  requester: { capability: "destination", moduleId: item.destination.moduleId },
  policy: { land: true, closeOut: true },
};
const landIntent = {
  itemId: item.id,
  step: "land-artifact",
  inputs: { destination: item.destination, artifact },
} satisfies Intent;
equal(evaluateModuleIntent(landIntent, destinationRequest).status, "eligible");
equal(evaluateModuleIntent(landIntent, { ...destinationRequest, signals: gateBlocked }).status, "needs-human");
equal(evaluateModuleIntent(landIntent, { ...destinationRequest, policy: undefined }).status, "needs-human");

const confirmed = { itemId: item.id, destination: item.destination, artifact };
deepStrictEqual(landedRecipients(item, confirmed), ["triage", "intake", "smithy"]);
deepStrictEqual(landedRecipients(item, { ...confirmed, itemId: "other" }), []);
const closeContext: BoundedActionContext = {
  ...destinationRequest,
  requester: { capability: "origin-owner", moduleId: item.closeOutOwner },
  originLanding: { report: confirmed, closeOutAttempted: false },
};
const close = {
  itemId: item.id,
  step: "close-out-origin",
  inputs: { origin: item.origin, landed: confirmed },
} satisfies Intent;
equal(evaluateModuleIntent(close, closeContext).status, "eligible");
equal(evaluateModuleIntent(close, {
  ...closeContext, requester: { capability: "origin-owner", moduleId: "smithy" },
}).status, "needs-human");
equal(evaluateModuleIntent(close, {
  ...closeContext, originLanding: { report: confirmed, closeOutAttempted: true },
}).status, "needs-human");

const later = { ...item, id: "later", artifact: { ...artifact, id: "example/repo#43" } };
equal(evaluateModuleIntent({
  ...close, itemId: later.id, inputs: { ...close.inputs, landed: { ...confirmed, itemId: later.id, artifact: later.artifact } },
}, { ...closeContext, item: later }).status, "needs-human");
for (const evidence of [{ verdict: "accepted" }, { approvals: [{ state: "approved" }] }]) {
  equal(evaluateModuleIntent({
    ...close, inputs: { origin: item.origin, landed: evidence },
  }, { ...closeContext, originLanding: undefined }).status, "needs-human");
}

const recoveryContext: BoundedActionContext = {
  item,
  signals: simultaneous,
  requester: { capability: "responder", moduleId: item.producer },
  githubHead: head,
};
const recoveryDecision = evaluateModuleIntent(recovery, recoveryContext);
ok(recoveryDecision.status === "eligible");
equal(recoveryDecision.stepClass, "bounded-recovery");
equal(evaluateModuleIntent(recovery, {
  ...recoveryContext, signals: { ...simultaneous, checks: {
    ...simultaneous.checks, notPossible: { ...simultaneous.checks.notPossible, reason: "conflict" },
  } },
}).status, "eligible");
for (const input of [
  { ...recovery.inputs, pr: { ...artifact, id: "example/repo#99" } },
  { ...recovery.inputs, headBranch: "main" },
  { pr: artifact, headBranch: head.branch },
  { ...recovery.inputs, expectedHead: "b".repeat(40) },
]) {
  equal(evaluateModuleIntent({ ...recovery, inputs: input }, recoveryContext).status, "needs-human");
}
equal(evaluateModuleIntent(recovery, { ...recoveryContext, signals: gateBlocked }).status, "needs-human");
equal(evaluateModuleIntent(recovery, {
  ...recoveryContext, signals: { ...simultaneous, checks: {
    ...simultaneous.checks, notPossible: { ...simultaneous.checks.notPossible, reason: undefined },
  } },
}).status, "needs-human");
equal(evaluateModuleIntent(recovery, {
  ...recoveryContext, item: { ...item, destination }, signals: { ...simultaneous, destination },
}).status, "needs-human");

const remediation = { itemId: item.id, step: "remediate", inputs: { instructions: "Fix CI" } } satisfies Intent;
equal(evaluateModuleIntent(remediation, recoveryContext).status, "eligible");
equal(evaluateModuleIntent(remediation, destinationRequest).status, "needs-human");
equal(evaluateModuleIntent({ ...remediation, itemId: "other" }, recoveryContext).status, "needs-human");
for (const [step, inputs] of [
  ["delete-branch", { branch: head.branch }],
  ["delete-worktree", { path: "/tmp/worktree" }],
  ["teardown", {}],
  ["command", { command: "git branch -D branch" }],
  ["callback", { callback: () => undefined }],
  ["remediate", { ...remediation.inputs, callback: () => undefined }],
] as const) {
  equal(evaluateModuleIntent({ itemId: item.id, step, inputs }, recoveryContext).status, "needs-human");
}
equal(STEP_CLASSES["delete-branch"], "destructive");
equal(STEP_CLASSES["delete-worktree"], "destructive");
equal(STEP_CLASSES.teardown, "destructive");

const failedRecovery = recoveryFailure(item, { code: "lease-rejected", message: "Head moved" });
const rejectedRecovery = evaluateModuleIntent({ ...recovery, inputs: {} }, recoveryContext);
const failedCloseOut = closeOutFailure({ ...failure, itemId: item.id });
equal(failedRecovery.status, "needs-human");
ok(rejectedRecovery.status === "needs-human");
equal(rejectedRecovery.diagnostic.code, "ineligible-intent");
equal(failedCloseOut?.status, "needs-human");
equal(failedCloseOut?.diagnostic.code, failure.diagnostic.code);
equal(failedRecovery.traceId, recoveryDecision.traceId);
equal(rejectedRecovery.traceId, recoveryDecision.traceId);
equal(failedCloseOut?.traceId, recoveryDecision.traceId);

console.log(contractVersion);
