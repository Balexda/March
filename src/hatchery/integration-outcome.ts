import { BroodClient } from "../brood/service/client.js";
import type { PrIntegrationResult } from "../brood/service/types.js";
import type { AgentFailureReason } from "../observability/agent-output.js";
import type { PublicationFailure } from "./integration-publisher.js";
import type { LaunchFailure } from "./launch-failure.js";
import type { PatchApplicationResult } from "./spawn-handoff.js";
import { buildTraceparent, spanIdForDispatch, traceIdForDispatch } from "../observability/trace-ids.js";
import type { DispatchTrace } from "../observability/spawn-trace.js";
import { stewardDeadlineExpired, stewardTimeRemaining } from "./integration-deadline.js";

type FailedOutcome = Extract<PrIntegrationResult, { status: "failed" }>;
type FailureReason = FailedOutcome["failureReason"];
type Artifacts = Pick<FailedOutcome, "application" | "commit" | "pullRequest" |
  "stewardSessionId" | "worktreePath" | "artifactsDir">;

const diagnostics: Record<FailureReason, string> = {
  extraction_rejected: "Spawn output did not yield an eligible patch.",
  missing_lifecycle: "Brood has no lifecycle record for this spawn.",
  patch_conflict: "The validated patch could not be applied to the Steward checkout.",
  commit_failed: "The integration commit could not be created or verified.",
  push_failed: "The integration commit could not be pushed.",
  pr_failed: "The reviewed pull request could not be published.",
  timeout: "The Steward integration timed out.",
  persistence: "Brood could not confirm the integration attempt or its outcome.",
};

/** Structured failure details that the job API reports beside the outcome. */
export interface IntegrationErrorDetails {
  readonly application?: PatchApplicationResult;
  readonly publication?: PublicationFailure;
}

export class IntegrationOutcomeError extends Error {
  details: IntegrationErrorDetails = {};
  /**
   * The launch-failure class behind this outcome, when Hatchery knew one (e.g. a
   * diverged-branch collision or an agent that declined). The Brood outcome's
   * `failureReason` stays the integration vocabulary; the job record reports
   * this class so the legate's retry follows it.
   */
  launchFailure?: LaunchFailure;

  constructor(readonly outcome: FailedOutcome, readonly agentFailureReason?: Exclude<AgentFailureReason, "none">) {
    super(outcome.diagnostic);
    this.name = "IntegrationOutcomeError";
  }

  withDetails(details: IntegrationErrorDetails): this {
    this.details = { ...this.details, ...details };
    return this;
  }
}

function failedOutcome(spawnId: string | null, failureReason: FailureReason, artifacts: Artifacts): FailedOutcome {
  return {
    ...artifacts,
    // Use fixed diagnostics for the terminal API. Subprocess messages and
    // remote responses may contain credentials or raw backend output.
    application: artifacts.application && {
      ...artifacts.application,
      ...(artifacts.application.diagnostic && { diagnostic: diagnostics[failureReason] }),
    },
    spawnId,
    status: "failed",
    failureReason,
    diagnostic: diagnostics[failureReason],
    completedAt: new Date().toISOString(),
  };
}

export function workerIntegrationError(deadline: string): IntegrationOutcomeError {
  return new IntegrationOutcomeError(failedOutcome(null, Date.now() >= Date.parse(deadline) ? "timeout" : "persistence", {}));
}

const BROOD_TIMEOUT_MS = 2_000;

export class IntegrationAttempt {
  private spawnId: string;
  private bound = false;
  private priorOutcome?: PrIntegrationResult;
  artifacts: Artifacts = {};
  timedOut = false;

  constructor(
    readonly attemptId: string,
    private readonly stewardDeadline: string,
    spawnId: string,
    private readonly dispatch: DispatchTrace,
    traceKey: string,
    readonly client = new BroodClient({
      timeoutMs: BROOD_TIMEOUT_MS,
      traceparent: dispatch.traceparent() ?? buildTraceparent(traceIdForDispatch(traceKey), spanIdForDispatch(traceKey)),
    }),
  ) {
    this.spawnId = spawnId;
  }

  isBound(): boolean {
    return this.bound;
  }

  async bind(spawnId: string): Promise<void> {
    this.spawnId = spawnId;
    try {
      await this.dispatch.spanAsync("steward.integration.bind", async () => {
        const expected = { attemptId: this.attemptId, spawnId, stewardDeadline: this.stewardDeadline };
        let state;
        try {
          state = await this.client.registerIntegrationAttempt(expected);
        } catch {
          // A lost response may hide a committed registration.
          state = await this.client.readIntegrationAttempt(this.attemptId);
          if (!state.spawnId && !state.fenced && !stewardDeadlineExpired()) {
            state = await this.client.registerIntegrationAttempt(expected);
          }
        }
        if (state.fenced || state.spawnId !== spawnId || state.stewardDeadline !== this.stewardDeadline) {
          throw new Error(diagnostics.persistence);
        }
        this.bound = true;
        this.priorOutcome = state.outcome ?? undefined;
      });
    } catch {
      throw new IntegrationOutcomeError(failedOutcome(spawnId, "persistence", this.artifacts));
    }
  }

  async requireLifecycle(backend: string): Promise<void> {
    stewardTimeRemaining(BROOD_TIMEOUT_MS);
    if (this.priorOutcome) {
      if (this.priorOutcome.status === "failed") throw new IntegrationOutcomeError(this.priorOutcome);
      // An already published attempt is terminal and must not run again.
      throw new IntegrationOutcomeError(failedOutcome(this.spawnId, "persistence", this.priorOutcome));
    }
    let present;
    try {
      present = await this.dispatch.spanAsync("steward.integration.lifecycle", () =>
        this.client.get(this.spawnId));
    } catch {
      throw new IntegrationOutcomeError(failedOutcome(this.spawnId, "persistence", this.artifacts));
    }
    if (present?.kind !== "spawn" || present.status === "tearing-down" || present.status === "torndown") {
      await this.fail("missing_lifecycle");
    }
    if (present?.backend !== backend) await this.fail("extraction_rejected");
    stewardTimeRemaining(BROOD_TIMEOUT_MS);
  }

  async fail(reason: FailureReason): Promise<never> {
    this.timedOut = reason === "timeout";
    const outcome = failedOutcome(this.spawnId, reason, this.artifacts);
    if (!this.bound) throw new IntegrationOutcomeError(outcome);
    const recorded = await this.persist(outcome);
    if (recorded.status === "failed") throw new IntegrationOutcomeError(recorded);
    throw new IntegrationOutcomeError(failedOutcome(this.spawnId, "persistence", recorded));
  }

  async succeed(application: Extract<PrIntegrationResult, { status: "succeeded" }>["application"],
    commit: Extract<PrIntegrationResult, { status: "succeeded" }>["commit"],
    pullRequest: Extract<PrIntegrationResult, { status: "succeeded" }>["pullRequest"],
  ): Promise<Extract<PrIntegrationResult, { status: "succeeded" }>> {
    this.artifacts = { ...this.artifacts, application, commit, pullRequest };
    if (stewardDeadlineExpired()) await this.fail("timeout");
    const recorded = await this.persist({
      ...this.artifacts,
      spawnId: this.spawnId, status: "succeeded", application, commit, pullRequest,
      completedAt: new Date().toISOString(),
    });
    if (recorded.status === "failed") throw new IntegrationOutcomeError(recorded);
    return recorded;
  }

  private async persist(outcome: PrIntegrationResult): Promise<PrIntegrationResult> {
    try {
      return await this.dispatch.spanAsync("steward.integration.persist", async (span) => {
        span.setAttributes({ "march.spawn_id": this.spawnId });
        if (outcome.status === "failed") {
          span.setAttributes({ "march.failure_reason": outcome.failureReason });
          span.setError(outcome.diagnostic);
        }
        try {
          return await this.client.writeIntegrationOutcome(this.attemptId, outcome);
        } catch {
          const state = await this.client.readIntegrationAttempt(this.attemptId);
          if (state.outcome) return state.outcome;
          if (state.fenced || state.spawnId !== this.spawnId) throw new Error(diagnostics.persistence);
          // Retry with an identical body, including its original completedAt.
          const retry = stewardDeadlineExpired() && !(outcome.status === "failed" && outcome.failureReason === "timeout")
            ? failedOutcome(this.spawnId, "timeout", this.artifacts)
            : outcome;
          return this.client.writeIntegrationOutcome(this.attemptId, retry);
        }
      });
    } catch {
      throw new IntegrationOutcomeError(failedOutcome(this.spawnId, "persistence", this.artifacts));
    }
  }
}
