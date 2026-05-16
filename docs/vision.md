# March Vision

**Status**: Long-lived vision document. Intended to outlive any individual RFC, milestone, or refactor. Revise sparingly — when the broad direction of the project actually shifts, not when implementation details change.

**Companion**: [`docs/operating-philosophy.md`](operating-philosophy.md) translates this vision into the rules and per-component framing that should guide day-to-day spec and code decisions. If the vision answers *what* and *why*, the operating philosophy answers *how we're getting there*.

**Last revised**: 2026-05-16.

---

## The thesis in one sentence

**Smithy makes the ideas high-quality. March makes the execution low-touch. Together they let a solo operator ship serious work without becoming the bottleneck.**

## Why this matters

Modern AI-assisted development is full of touch points:

- *Planning* touch points — what are we building, what's the contract, what are the edges, where's the debt?
- *Execution* touch points — what runs next, what sandbox, what credentials, what cleanup?
- *Coordination* touch points — is it done yet, what's the next step, who needs to know, what state am I in?
- *Integration* touch points — did the patch apply, do the tests pass, is the PR ready, did it merge?

Each touch point is an opportunity for quality (catch a bug, surface a missing assumption, make a deliberate trade-off) **and** an opportunity for cost (operator context switch, lost flow, slow turnaround). The honest reading of the AI-development landscape today is: planning needs more touch points than people give it, and execution needs many fewer. People burn out approving the same shell command for the hundredth time while shipping under-specified features that quietly break in production.

Smithy and March make that trade-off explicit and arrange the system around it.

## Smithy decomposes; March executes

Smithy turns a vague idea into a mergeable change set through a cyclical expand-then-segment process. The conversation goes:

```
small idea
   │
   ├─ expand → PRD (bigger; surfaces real stakes, real personas, real OKRs)
   │     │
   │     └─ group / segment → RFC sections, alternatives, decisions
   │
   ├─ expand → RFC (bigger; deep architecture, threat model, dependencies)
   │     │
   │     └─ group / segment → feature maps with scope boundaries
   │
   ├─ expand → feature maps (bigger; per-feature user-facing value, cross-milestone deps)
   │     │
   │     └─ group / segment → individual feature specs
   │
   ├─ expand → specs (bigger; user stories, FRs, edge cases, success criteria)
   │     │
   │     └─ group / segment → task slices (PR-sized)
   │
   └─ expand → tasks (bigger; TDD failing tests, then implementation)
         │
         └─ group / segment → atomic commits, reviewable PRs
```

Each cycle expands the prior artifact (more detail, more concrete questions answered), then groups and segments the result into the next layer's discrete units. **Lots of touch points by design**: every cycle is a chance to catch ambiguity, surface debt, and produce something a reader can act on without re-deriving the prior cycle. The output is high-quality, but the artifact lineage itself is high-touch — each artifact needs review, each segmentation is a decision.

That is correct. Planning should be high-touch. The cost of a bad plan compounds across every subsequent execution.

March takes Smithy's output — a fully decomposed plan, down to actionable task slices — and runs it across a coordinated system **without making the operator the constant point of intervention**. Smithy is high-touch by design; March is low-touch by design. The combination is what makes the pipeline economically viable for a solo operator.

## Ideas in, quality out

When the system holds up its end of the bargain, the operator's day-to-day looks like this:

- Sit with a problem. Talk it through with Smithy. Get an RFC.
- Iterate on the RFC. Get a feature map. Pick which feature to cut first.
- Let Smithy decompose it to specs and task slices. Review the slices.
- Hand the slice list to Legate. Walk away.
- Come back to a queue of green PRs — each one with a Steward-written description, tests passing, ready for the operator's final read-through.
- The operator's review is the high-judgment touch point: does this *actually* solve the problem? Are the edge cases real? Do the tests prove what they claim?
- Merge. Loop.

The operator's attention is concentrated where it adds the most value: shaping the idea, reviewing the output. Everything in the middle — execution, coordination, cleanup, mechanics — happens without the operator being the point of intervention.

## The promise

To the operator: **you bring the ideas and the judgment; we'll take care of the chaos.**

To the system: every component we build, every spec we write, every default we pick should reduce the number of times a person has to step in *between* the idea and the merged code — not increase it. When a feature would make the operator's job easier in the moment but harder over time (more knobs, more babysitting, more "are you sure?" prompts), that feature is wrong for March even if it's locally appealing.

To future contributors: the vision is the test. If a change makes "ideas in, quality out" more true, ship it. If it makes "ideas in, quality out" less true — even if it's clever, even if it's faster, even if it's what some other tool does — push back.

## How this evolves

This is a vision document, but not a static one. The thesis is stable; the framing around it should change as we learn:

- When the daily-life narrative in [§ Ideas in, quality out](#ideas-in-quality-out) no longer matches the operator's actual day, that is feedback that the system isn't living up to the vision — the next round of work should close the gap.
- When a new pattern emerges (a new role like the Steward in 2026-05, a new touch point we hadn't recognized), reflect it here and in the [operating philosophy](operating-philosophy.md).
- When we've genuinely learned that a piece of the vision was wrong — not just hard to implement, actually wrong — change it. Document why, so future readers understand the shift.

Revise sparingly. If you find yourself revising the vision because of a single feature, you are probably actually revising the operating philosophy or an individual spec. The vision is the slowest-moving artifact in the repo.
