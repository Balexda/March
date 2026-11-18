# PRD: Issue Triage into Smithy Entry Points

**Created**: 2026-11-17  |  **Status**: Draft

## Problem Statement
<!-- audience: stakeholder; mode: explanation; length: 2-3 paragraphs; diagram: optional; examples: discouraged -->

The March repository has 63 open issues and the smithycli repository has 33, and the maintainer has no reliable way to tell which of them have been looked at or what each one needs. The only labels in use today are `bug`, `enhancement`, and `area:*`. Many recent issues carry no label at all. Issues come from three places: the operator, March's own agents filing automated reports, and outside contributors. Their quality, scope, and readiness vary a lot. Some issues are one-line patches. Some are feature-sized ideas that need an RFC. Some are too vague to act on, and some should simply be closed. Nothing in the tracker records any of these distinctions. So every time the maintainer opens the backlog, they triage it again from scratch, across every profile March runs.

The second problem is what happens after an issue is picked up. March now runs Smithy planning artifacts (RFC → feature map → spec → tasks) through to merged PRs on its own. Agent stewards take each artifact and turn it into code. Issues are not an input to that pipeline. Nothing connects "an issue exists" to "a Smithy artifact at the right scale exists." So when an issue does get worked, the maintainer usually writes a prompt for it by hand. That skips the planning stages that March is built to automate. The maintainer's own analysis found that this direct-prompt path produces lower-quality code and needs rework more often than the same work done through Smithy. That finding is the reason for this PRD. It is an observation, not a measured baseline: no figures yet show how large the quality gap is or how much rework it causes, and that evidence is recorded as debt. The result is that the backlog grows, and the work that does get done takes the path that needs more rework.

We want every open issue to show its triage state at a glance. Each one should say whether it has been reviewed, what the outcome was, and where the work should start: routed to a Smithy entry point at the right scale, handled as a small direct patch, sent back to its author for better definition, flagged as contested, or closed. With that in place, issues flow into the same planning pipeline March already runs, and authors can see why their issue went where it did.

## Proposed Solution
<!-- audience: stakeholder; mode: explanation; length: 1-2 paragraphs; diagram: optional; examples: discouraged -->

Every open issue, in every repository March manages, gets a triage verdict that is recorded and visible on the issue. An LLM reads the issue and estimates how big the request is. It may also add repository context to flesh the issue out. It then recommends one outcome from a fixed vocabulary. The **build** outcomes say where the Smithy pipeline should start: `spark` for an idea that needs a one-page PRD, `ignite` for something RFC-sized, `render` for a feature map, `mark` for a single spec, and `strike` for a small patch done directly. The **non-build** outcomes are *needs definition*, *controversial*, and *close*:
- *Needs definition*: the issue is low quality, gets a grade and an explanation, and goes back to its author to improve and resubmit.
- *Controversial*: an operator has to decide.
- *Close*: the issue is a duplicate, obsolete, or won't be done.

`cut` and `forge` are never entry points, because they need an upstream artifact first.

Labels show the triage state next to the existing `bug`/`enhancement`/`area:*` labels: whether the issue is untriaged or triaged, the outcome, and the recommended entry point. Any added context goes beside the issue as a triage note and never rewrites the author's text. Once a buildable issue has a verdict, it becomes the starting artifact for March's existing continuous pipeline, and the maintainer stops writing hand prompts for it. An issue that is edited or resubmitted goes back into triage, so a verdict is never permanent.

## Target Users
<!-- audience: stakeholder; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- **The maintainer/operator.** The one person running March across several registered profiles (march, smithycli, and others). Today they re-triage an unlabeled backlog by hand and write prompts for the issues they pick up.
- **March's legate.** The downstream consumer. It needs a machine-readable verdict so it can pick routed issues up as pipeline inputs.
- **Issue authors.** The operator, March's own agents filing `automated` issues, and outside contributors. Each reads the verdict on their issue, for example "needs definition", and why it went where it did.

## Success Signals
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: optional -->

- **No untriaged backlog.** The number of open issues with no triage label falls to near zero across march and smithycli and stays there. New issues get a verdict within a bounded time of being opened.
- **Work moves into Smithy.** A growing share of merged work starts from a Smithy artifact instead of a hand-written prompt.
- **Less rework.** Work routed through triage needs fewer follow-up fix PRs and has fewer issues reopened than the direct-prompt baseline.
- **Trustworthy judgment.** The operator overrides the recommended entry point or outcome rarely, and less often over time.

## Alternatives / Build-vs-Buy
<!-- audience: reviewer; mode: explanation; length: 3-6 paragraphs; diagram: optional; examples: recommended -->

### Alternatives Considered

| Name | URL | Category | Fit | Why not |
|------|-----|----------|-----|---------|
| GitHub Agentic Workflows: Issue Triage sample (`githubnext/agentics/issue-triage`) | <https://github.github.com/gh-aw/gallery/ai-issue-triage/> | OSS CLI tool + Actions workflow (technical preview) | Partial | It runs Claude Code as one of several engines and writes labels and comments safely. But its built-in outcomes are a fixed bug/feature/question/needs-info/priority/duplicate/spam set, with no grading rubric and no routing to a PRD/RFC/feature-map/spec entry point. gh-aw is also still in technical preview and its docs say it "may change significantly". |
| anthropics/claude-code-action | <https://github.com/anthropics/claude-code-action> | OSS GitHub Action (MIT) | Partial | Good substrate: Claude, runs on the repo's own runner, `gh issue edit` labeling, structured JSON outputs. It has no dedicated triage mode, though. Triage is "automatic categorization" set up through a prompt, so the rubric, the routing taxonomy and the label contract would all still have to be written. |
| AI Assessment Comment Labeler (GitHub) | <https://github.com/marketplace/actions/ai-assessment-comment-labeler> | Actions workflow (GitHub Models) | Partial | Clean label-in, label-out contract (`ai:<prompt>:<assessment>` plus an `ai_assessments` JSON output). But it is one prompt pass per trigger label with no repo or codebase context, and it defaults to GitHub Models rather than Claude. Pointing it at Claude would need a compatible endpoint. |
| Linear Triage Intelligence | <https://linear.app/docs/triage-intelligence> | SaaS | Poor | Only works on Linear issues, not GitHub issues. Only available on Business and Enterprise plans. Its suggestions are limited to team, label, assignee, project and duplicate fields, not custom outcomes like "close / needs-definition / controversial / patch / plan at tier X". |
| Dosu | <https://github.com/apps/dosubot> | SaaS GitHub App | Poor | Hosted maintainer agent offering auto-labeling, dedup and Q&A, aimed at large OSS communities answering users. You can't change its routing taxonomy or connect it to the orchestrator, and its current product direction is unclear. |

### Build-vs-Buy Rationale

The closest candidates (claude-code-action and the gh-aw issue-triage sample) are runners, not triage products. They solve the plumbing: getting Claude onto an issue event, holding write permissions safely, and putting labels on the issue. They don't make the judgment this problem needs. The core value is a grading rubric plus a routing decision that maps each issue to the right entry point in Smithy's expand-then-segment chain (PRD → RFC → feature map → spec → tasks, per `docs/vision.md`), or to close / needs-definition / controversial / direct-patch. That taxonomy belongs to March, and none of the surveyed tools ship it. The off-the-shelf outcome sets (bug/feature/needs-info/priority, or Linear's team/label/assignee) don't come close to it. The routing labels also have to be a contract the Legate actually consumes: the orchestrator turns routed issues into planning work and then into dispatchable slices. No external tool knows about that downstream consumer. `docs/operating-philosophy.md` adds a constraint: an autonomous component must not block on the operator and must escalate through events instead (Rule 1). So "controversial" and "needs definition" need to be escalation states the system can see, not one-off bot comments.

Buy the substrate, build the judgment. Don't build a new triage service from scratch. Write the triage rubric and routing taxonomy as a March-owned prompt or skill. Run it either on claude-code-action / gh-aw in GitHub Actions, or as a Legate-dispatched spawn using the existing Claude backend. Record the outcomes in a small, versioned label namespace that Herald/Legate read. That keeps the effort on the part only March can define and reuses maintained infrastructure for the rest. `docs/vision.md` puts "agentic judgment" in the private value layer behind the open/closed line. Settle which side of `docs/open-core-boundary.md` the triage judgment belongs on before picking a runner. A public GitHub Action workflow would put the rubric in the open repo.

## Assumptions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- [Critical Assumption] **Two problems.** The issue backlog has no triage state at all. And issues that do get worked usually skip Smithy and go straight to a hand-written prompt. The quality finding is the motivating observation, not a measured baseline.
- [Critical Assumption] **Who it's for.** The main user is the single maintainer/operator running March across multiple profiles. Issue authors read the verdicts: the operator, `automated` agent filers, and outside contributors.
- [Critical Assumption] **What triage does.** Every open issue gets a recorded, visible verdict. The verdict names either a Smithy entry point or a non-build outcome, and an LLM recommends it based on the estimated size of the request.
- [Critical Assumption] **The outcome vocabulary** is:
  - build outcomes: `spark`, `ignite`, `render`, `mark`, `strike`
  - non-build outcomes: *needs definition*, *controversial*, *close*

  `cut` and `forge` are never entry points.
- [Critical Assumption] **Where state lives.** Issue labels are the durable, visible record of triage state, outcome and recommended entry point. They sit beside the existing `bug`/`enhancement`/`area:*` labels and don't replace them.
- [Critical Assumption] **Repository scope.** Triage covers every registered profile's repository (at least march and smithycli) with one shared outcome vocabulary.
- [Critical Assumption] **Success signals.** Success means the untriaged count falls to near zero, the time to a verdict stays bounded, more work enters through Smithy, rework falls, and the operator overrides verdicts rarely.
- [Critical Assumption] **Out of scope:**
  - changing the Smithy stages or forge
  - triaging PRs
  - priority or scheduling beyond what March already dispatches
  - trackers other than GitHub
  - rewriting or deleting the author's issue text
- [Critical Assumption] **Enrichment.** When an issue can be fleshed out, the added context goes beside it as a triage note. That context travels into whatever artifact the issue is routed to.
- **Verdicts can change.** An improved or resubmitted issue goes back into triage. *Controversial* verdicts escalate to the operator and nothing acts on them automatically.
- **Existing options fall short.** Manual labels, GitHub Projects fields, issue forms, label and stale bots, and built-in AI triage helpers exist, but none of them make the "which Smithy entry point" judgment.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-001 | auto-act-vs-approve-triage-verdicts | Solution Intent | Critical | Medium | local |
| SD-002 | triage-judgment-open-vs-private | Scope Edges | High | Low | local |
| SD-003 | quality-gap-evidence-missing | Problem Definition | Medium | Medium | local |
| SD-004 | unverified-alternatives | Off-the-Shelf Alternatives | Low | Medium | local |

### SD-001 — auto-act-vs-approve-triage-verdicts

How far should a triage verdict act without the operator? This is an unresolved choice between three options:
- Recommend only, with the operator approving every routing and every closure.
- Dispatch build verdicts automatically, but require approval to close or downgrade an issue.
- Act on every verdict automatically and escalate only controversial ones.

The operating philosophy leans toward autonomy. A wrong closure or a wrong entry point still has a real cost.

### SD-002 — triage-judgment-open-vs-private

`docs/open-core-boundary.md` puts agentic judgment in the private layer and keeps a baseline legate-agent open. Two options are unresolved. In the first, the label vocabulary and a baseline triage recommender ship in the open engine. In the second, only the label and state contract is open and the LLM triage judgment is private. The choice also decides whether a public Actions-hosted runner is acceptable.

### SD-003 — quality-gap-evidence-missing

The claim that direct prompting produces lower-quality code and more rework than the Smithy path has no figures behind it. There is no rework rate, no review-thread count, and no comparison of the two paths. Without that baseline, the "Less rework" success signal can't be measured. It is undecided whether to capture the baseline before triage ships or to accept the signal as qualitative.

### SD-004 — unverified-alternatives

The survey didn't verify several likely "why not X" candidates: Copilot coding agent issue assignment, Sweep, CodeRabbit issue features, Devin/Factory issue intake, probot triage bots, and `github/issue-labeler`. Dosu's current product direction is also unclear. Two of these look like poor fits from their descriptions: `github/issue-labeler` labels by regex with no LLM judgment, and the Copilot coding agent implements issues rather than triaging them. Neither has been confirmed.

## Open Questions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- **How much autonomy triage gets first (SD-001)** is the operator's decision. Settle it before `smithy.ignite`, because it determines whether the RFC needs an approval step.
- **Open engine or private layer (SD-002)** is a product-strategy call under the open-core ADR. It must be settled before choosing where the triage judgment runs.
