# March Open-Core Boundary

**Status**: Architecture decision record. Long-lived. Records *why* March is split
into an open engine and a private value layer, *where* the line falls, and the
rules that keep it from rotting. Revise when the boundary itself moves — not when
a component lands on the side the boundary already assigns it.

**Audience**: Anyone deciding where a new component lives, what an open API may
expose, or whether a private piece is allowed to reach into the engine. Also the
contract future agents must respect when editing either side.

**Companion**: [`docs/vision.md`](vision.md) holds the long-lived *what and why*;
[`docs/operating-philosophy.md`](operating-philosophy.md) holds the per-component
*how*. This document holds the *open vs. closed* line that cuts across both.

**Last revised**: 2026-06-23.

---

## The decision in one sentence

**The deterministic engine is open; the agentic judgment, the management surface,
the enterprise connectors, and the cloud control plane are private — and they all
hang off the open engine through one stable contract, never reaching past it.**

## Why a boundary at all

March is drifting from "a CLI a person runs" toward "a distributed system someone
deploys." That shift opens a commercial path, and the honest reading of where the
value concentrates is:

- The **plumbing** — the deterministic loop, spawn/teardown, the event log, the
  CLI — is good engineering but commodity. Anyone could rebuild a dependency-graph
  executor. Keeping it open costs nothing defensible and buys adoption,
  credibility, and an auditable engine people can trust on sensitive code.
- The **moat** is *trust to run unattended*: the agentic judgment that automates
  escalations, the management surface that makes the system observable and
  steerable, the enterprise connectors that give it reach, and the operational
  layer that runs it at scale. That is what someone would pay for.

So the line is not "core vs. extras." It is **commodity engine (open)** vs.
**the layer that makes the engine trustworthy, reachable, and operable at scale
(private)**.

## The layering

| Layer | Open / Closed | Holds |
|---|---|---|
| **Engine** | Open | core loop, deterministic dispatch / teardown, substrate *interfaces*, CLI, docker/compose for local run, connector *framework*, baseline connectors (GitHub), **baseline legate-agent**, Grafana dashboards |
| **Connectors** | **Split** | framework + common connectors (GitHub) open; **enterprise connectors (Jira, ServiceNow, …) private** |
| **Observability** | **Split** | read-only Grafana dashboards stay open; the *action / management* console is private |
| **Control UI** | Closed | observe **+ act + configure** — the sellable operator surface |
| **Cloud** | **Split** | deploy tooling (k8s/terraform — slots into the substrate interfaces) ‖ multi-tenant control plane (net-new; the real SaaS lift) |
| **Legate-agent(s)** | **Split** | escalation-automation (coupled to the core; near-term) ‖ daily-coding assistant (a separate product surface) |
| **The boundary contract** | Open | the stable, versioned surface the private layer consumes — the load-bearing wall |

Two entries are *split*-by-design and easy to get wrong:

- **Connectors are not all open.** The framework and the connectors that drive
  adoption (GitHub) are open and are table stakes. The enterprise connectors are
  the paid catalog and stay private. "We integrate with your Jira" is a sales
  unlock, not an open-source feature.
- **The dashboards are not the UI.** The existing Grafana dashboards are
  read-only observability and stay open so the engine is inspectable standalone.
  The private UI is the polished surface that also *acts* (recover, merge,
  configure) — observe-and-act, not just observe.

## Repository topology

**One open repo + one private monorepo. Not three private repos.**

```
                 ┌─────────────────────────────────────┐
                 │  OPEN  ·  github.com/Balexda/March   │  (public)
                 │  engine · CLI · docker · dashboards  │
                 │  connector framework · baseline agent│
                 │  ── publishes ──▶ npm package,       │
                 │     container images, API contract,  │
                 │     agent + substrate + connector    │
                 │     interfaces                       │
                 └──────────────────┬──────────────────┘
                                    │ consumes ONLY the published surface
                                    │ (never engine internals)
                 ┌──────────────────┴──────────────────┐
                 │  PRIVATE  ·  march-private (monorepo)│
                 │   packages/connectors/{jira,…}       │
                 │   packages/legate-agent              │
                 │   packages/coding-assistant          │
                 │   packages/contract-client           │
                 │   apps/ui  (console + BFF)            │
                 │   deploy/cloud  (control plane)       │
                 └─────────────────────────────────────┘
```

**Why the open repo must be a separate repo:** it is public. Everything in its
history is public, permanently. Private code therefore cannot live in it — that
forces at least one separate private repo. This is a constraint, not a choice.

**Why one private monorepo, not one-per-component:** none of the private pieces
is a shippable standalone product yet, and they all consume the *same* contract.
Three private repos would make every boundary-contract change a four-repo
coordination (open + three private), triple the CI, and add version-pinning
between pieces that have no independent consumers. A single private monorepo keeps
cross-cutting refactors atomic on the private side and is mechanical to shard
later (see *Graduation* below). Pay polyrepo cost when scale justifies it — not
before.

### Private monorepo internal structure

```
march-private/
  packages/
    connectors/        jira/  servicenow/ …   plug into the open connector framework
    legate-agent/      escalation-automation; the smart drop-in over the baseline
    coding-assistant/  daily-driver beyond March tasks (its own product surface)
    contract-client/   typed client for the open engine's published API
  apps/
    ui/                management console (frontend + its BFF)
  deploy/
    cloud/             k8s / terraform / helm + the multi-tenant control plane
```

## The boundary contract

The arrow in the diagram is the whole architecture. It is one **stable, versioned**
surface, owned and documented by the open repo:

1. The service HTTP APIs — Herald (`/state`, `/events`, profiles), Brood
   (sessions, teardown), Legate (`/status`, recover), Castra (sessions).
2. The CLI's npm-install boundary — operator verbs over service APIs, never
   runtime reads of repo internals.
3. The published artifacts — the `@balexda/march` npm package and the `march-*`
   container images.
4. The **pluggable interfaces** the engine already defines: the substrate
   adapters (`TeardownSubstrate`, `SessionRepository`/`MARCH_BROOD_STORE`,
   the Castra substrate), the connector framework, and the **legate-agent
   interface**.

### Rule 1 — consume the published surface only

Private packages depend on the open engine **only** through its published package,
images, and API. Never a source checkout of engine internals, never a git
submodule. This makes the wall self-enforcing: a private package physically cannot
reach an engine internal that is not in its dependency surface. During early
contract churn, a local `file:`/`npm link` dependency against a sibling checkout is
fine for iteration — flip to a pinned published version once the contract
stabilizes. Do not reach for a submodule.

### Rule 2 — the engine stays independently runnable

The open repo must run, dispatch, and merge **without** anything private. That is
what keeps it a real project rather than a gutted shell, and what lets it serve as
the trust-building, auditable, self-hostable engine. Concretely:

- The open engine ships a **baseline legate-agent** that implements the
  agent interface (deterministic loop + simple model calls — enough to dispatch
  and merge). The private `legate-agent` is a smarter drop-in implementing the
  **same interface** — an enhancement, never a dependency.
- The same pattern holds for connectors (open framework + GitHub; private
  enterprise connectors) and observability (open dashboards; private action
  console).

If removing the private repo breaks the open engine, the boundary has been
violated — the private layer has become load-bearing, and that is the bug.

### Rule 3 — cross-cutting concerns ride the contract

Two concerns must travel on the boundary, or the private layers cannot act safely:

- **Auth / identity.** The moment a UI or an autonomous agent can *act* (recover,
  merge, configure), the engine must answer "who is allowed to do this." Light for
  single-tenant home/work (Tailscale + local trust); real for multi-tenant cloud.
- **Provider / secret config + egress guard.** Model-provider selection (personal
  Anthropic key at home; company Bedrock/Vertex/gateway at work; per-tenant in
  cloud) is set at this boundary. The engine's worker-credential allowlist
  (today the hardcoded `["ANTHROPIC_API_KEY"]` in `spawn-config.ts` /
  `backends.ts`) must become a per-deployment provider set, and a work/cloud
  deployment must **refuse to start a worker carrying a non-sanctioned credential**
  — a personal key silently outranks a Bedrock switch and would leak company code
  to a personal account.

## Graduation — when a private package earns its own repo

A package leaves the monorepo for its own repo only when it earns one of:

- a separate release cadence,
- a separate deploy target / host,
- a separate team or access boundary,
- a partner / external-contributor ecosystem,
- its own customer-facing SKU.

Likely order, if it happens: **enterprise connectors** first (partner
contributions), **UI** second (own deploy pipeline / host), **coding-assistant**
third (its own users, distinct from March operators — the one most likely to
become a product in its own right). The **escalation-automation agent does not
graduate** — it stays glued to the core contract.

## Consequences

**What this buys.** The open engine is the funnel and the credibility — public,
auditable, self-hostable, and (Rule 2) genuinely runnable. The private layer is
the moat — marketplace-shaped (premium connectors + behavior packs + control
plane + cloud). The split is low-regret: nothing must be retracted from public
history, because the private pieces do not exist there yet. The substrate
interfaces the engine already has (`TeardownSubstrate`, `SessionRepository`, the
Castra substrate) are the slots the cloud layer plugs into — the architecture was
already shaped for this.

**What it costs.** Boundary-contract changes are inherently two-repo (open defines,
private consumes) — accepted, and the reason the private side stays a monorepo to
keep its half atomic. The engine must carry a baseline agent and an open
connector framework it might otherwise have skipped — the price of Rule 2, and
worth it. Multi-tenancy in the cloud layer is **net-new** (isolation, sandboxing
untrusted agent code, billing) — the generic engine gets you ~30% of the way to
SaaS, not 80%; budget accordingly.

## Non-goals

- This does not decide licensing of the open engine (permissive vs.
  source-available). That is a separate decision, relevant only if someone else
  hosting *the engine* as the product becomes a real threat — which it largely is
  not, since the moat is the private layer.
- This does not commit to building the cloud / SaaS layer. It only fixes *where*
  that layer would live and *how* it attaches if built.
- This does not schedule the work. Sequencing (harden the contract → escalation
  automation → UI → cloud) lives with the roadmap, not this boundary record.

## Open questions

- The exact versioning scheme for the boundary contract (semver on the npm
  package + image tags; how API breaking-changes are signalled to private
  consumers).
- Whether `contract-client` is generated from the engine's API types or
  hand-maintained.
- Auth model for the first private UI (single-tenant Tailscale-fronted vs. a
  real identity layer from the start).
