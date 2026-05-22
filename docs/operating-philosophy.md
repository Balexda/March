# March Operating Philosophy

**Status**: Living document. Expected to evolve as the system grows and as we learn what does and does not work in practice.

**Audience**: Anyone designing a new March component, writing or reviewing a March spec, or trying to understand why a particular feature is shaped the way it is.

**Companion**: [`docs/vision.md`](vision.md) holds the long-lived "what and why" of March. This document holds the implementation-level "how" — how each component contributes to the vision, and the rules of thumb that fall out of trying to live up to it. Read the vision first; this document presumes it.

**Last revised**: 2026-05-16.

---

## Per-component intervention-avoidance

The vision says March eliminates operator intervention at points where intervention does not add value. This table is the concrete decomposition: which component eliminates which intervention.

| Component | The intervention it eliminates | What that feels like |
|-----------|-------------------------------|----------------------|
| **Spawn** | Intervention in *execution of individual steps*. | The operator does not babysit a session, approve commands, or watch progress. The spawn runs to completion (or to a clean failure) and emits a structured result. |
| **Hatchery** | Intervention in *setting up to run the steps*. | The operator does not assemble container args, juggle credentials, or hand-tune security posture per session. Profiles declare the configuration once and every spawn / steward / legate / future role consumes the same declarative source. |
| **Brood** | Intervention in *cleanup and lifecycle*. | The operator does not manually remove containers, prune worktrees, archive logs, or reconcile orphaned branches. Brood owns the full cradle-to-grave path for every containerized session. |
| **Herald** | Intervention in *checking whether anything is ready yet*. | The operator does not refresh `gh pr view`, poll `smithy status`, or context-switch to ask "is it done? is it done? what do I need to do next?" Herald watches deterministic state and fires events on transitions so the next consumer reacts without the operator looking. |
| **Legate** | Intervention in *managing parts of the system*. | The operator does not pick what to run next, monitor for stalls across many parallel work items, or decide when to retry vs. escalate. Legate runs the orchestration loop and only surfaces decisions that genuinely require operator judgment. |
| **Steward** | Intervention in *assembling and submitting the work*. | The operator does not take the patch the spawn produced, apply it, run tests, commit, push, and open the PR. The Steward session does that and only escalates if something is genuinely ambiguous (merge conflict, failing test that needs judgment). |

The **March CLI** is the operator's *deliberate* intervention surface. When the operator does want to step in — to dispatch an ad-hoc spawn, inspect a stuck session, or override a decision — there are clear verbs to do so. The default path is autonomous; the intervention path is one command away.

When a new component is added (or an existing one renamed — Steward was unnamed until 2026-05-16), update this table. The vision doc's [§ Ideas in, quality out](vision.md#ideas-in-quality-out) narrative should keep working as new components land; if it stops working, that is a signal the new component is solving the wrong problem or being shoehorned into an old shape.

## Three rules of thumb

These are the rules any new March component should be designed against, and the rules to check existing specs against during review.

### 1. No interactive surfaces inside an autonomous component

No permission prompts reaching a spawn. No approval requests waiting on the operator inside a brood teardown. No questions the herald asks before routing an event. No "are you sure?" between any two automated steps.

If a component genuinely needs operator judgment, it raises an escalation (via Herald event, via SpawnRecord state, via a steward session asking the operator) — it does not block waiting for input it cannot receive.

Corollary: auto-mode and auto-review (Claude Code's `--dangerously-skip-permissions`, Codex's `--dangerously-bypass-approvals-and-sandbox`, etc.) are the *minimum bar* for an autonomous backend, not a security degradation we tolerate. A backend that cannot run headless cannot participate in the system.

### 2. Minimum required access, not zero access

Sandboxes start tight (F2's `bridge` network, F2's snapshot-only filesystem) and peel back deliberately as real backends require it (F4's per-backend egress allowlist, the accelerated `BackendCredentialMountSpec` for Codex). Each peel-back is declared on the component's interface — not operator-authored — so the structural enforcement holds even as the access surface grows.

"No-access" is a useful starting point, never the end state. Cloud LLMs need network. Subscription-based CLIs need credential material. Pretending otherwise produces a sandbox so tight that nothing actually runs in it. The honest stance is: every access the system grants is declared on a typed interface, audited, and minimally scoped — and the access exists because the autonomous path requires it.

### 3. Failures are clean exits, not hangs

Auto-mode is imperfect — sessions occasionally stall, alignment validation costs tokens, an API hits a rate limit at the wrong moment. The sandbox cannot prevent stalls but it must prevent stalls from becoming hangs.

- Timeouts kill the container.
- Pre-flights fail fast before any artifact is created.
- Herald events fire on transitions to terminal states (failed, timed-out, abandoned) so consumers do not wait forever.
- SpawnRecord captures the failure shape so the operator can triage without re-running.

The operator should walk away and come back to *something* — either a green PR ready to merge or a SpawnRecord marked failed with a diagnostic. Never a hung session waiting for input it cannot receive. Never a half-cleaned-up artifact someone has to chase down by hand.

## How to apply this in a spec

When you write or review a March spec, cite this document instead of restating the philosophy:

- Reference [`docs/vision.md`](vision.md) for the high-level "ideas in, quality out" framing.
- Reference this document for the per-component table and the three rules of thumb.
- Append your spec to the [Citations from specs](#citations-from-specs) list below so future readers can trace where the philosophy has been applied concretely.

When a spec needs to make a trade-off that the rules of thumb don't cleanly resolve (e.g., a new escalation surface that's *almost* interactive, a backend that needs a third auth shape, a Brood teardown that wants confirmation for destructive operations), that's a signal to either:

1. Solve the trade-off in the spec and update this document with the new rule it implies; or
2. Decide the rules of thumb need to evolve, revise this document first, then write the spec against the revised rules.

Either path is healthy. The unhealthy path is silently breaking a rule in a single spec without making the trade-off visible — that's how the system drifts away from the vision one feature at a time.

## How this evolves

This document is more revisable than [`docs/vision.md`](vision.md). The vision rarely shifts; the operating philosophy should change as we learn:

- When a rule of thumb proves too tight or too loose in practice, revise it here first, then trace the implications through individual specs.
- When a new component is added, add it to the per-component table. When a component is renamed, update the table and search for stale references in spec files.
- When several specs end up citing the same exception, that's evidence the rule needs softening (or the system needs a different abstraction). Treat the citation pattern as feedback.

If this document and the vision doc ever drift on the same point, the vision wins — this document's job is to translate the vision into actionable guidance, not to override it.

## Citations from specs

Specs and feature maps that explicitly invoke this philosophy:

- `specs/2026-05-12-004-spawn-sandbox-security/spawn-sandbox-security.spec.md` — "Design philosophy (2026-05-16)" section. Applied to F4's typed-exception bind-mount validator and credential-mount pre-flight (rule 2: minimum required access, not zero access).
- `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` — "Operating Philosophy" section. Summarizes this document and the vision; specs that cite the RFC indirectly cite both.
- `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.spec.md` — Statio (the forge gateway). Like Castra, an infrastructure seam with no row in the per-component table; invokes all three rules of thumb in its Clarifications section (no interactive surfaces — `gh` auth provisioned at deploy, not negotiated per request; minimum required access — Statio is the only forge-credentialed image; clean exits — timeout-bounded `gh`, `forge_error` envelope never a hang).
- `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.spec.md` — "Assumptions" section. Applies the low-touch execution framing by making service-boundary promises explicit test targets.

When you cite this document from a new spec, add the spec to this list with one line on which rule(s) it invokes and where.
