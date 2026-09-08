# 03 · Coding agent — the open-swe archetype

**Service:** a coding-agent service (not yet built here; open-swe is the archetype).
**Class:** §1.1 #3 coding & SWE, and #7 stateful hours→weeks · **Lifetime:** registered ·
**Durability:** strict · **Transport:** SSE + webhook.

> This is the one consumer with no local implementation to read. What follows is designed from the
> archetype's published shape — a manager/planner/programmer/reviewer graph, sandboxed workspace,
> GitHub issue in and pull request out, human approval on the plan — and from §1.1 #3, §11.2 and
> §0.4. Where a detail is an assumption rather than a requirement, it is marked **[assumption]**.

## Why it is last and why it matters most

The first two consumers can run on a modest substrate. This one is the only one whose requirements
**change the substrate**, in three places:

1. **§0.4 sandbox.** Agent-authored code executes here. A deny-list is not an isolation boundary.
   This consumer forces the in-process / container / microVM decision (Appendix A #4) — and §0.4 is
   explicit that the boundary is uniform for all agent types, so choosing here chooses for
   consumers 01 and 02 too.
2. **§4.2 checkpoint granularity.** A run spanning hours must survive a routine worker redeploy.
   Every deploy window becomes a correctness test.
3. **§11.2 artifact lifecycle.** Repo checkouts, patches, test logs and diffs are the bulk of what
   this agent produces. "Artifacts become foundational for coding workspaces" is §11.2 naming this
   case directly.

## Shape

```yaml
metadata: { name: swe-agent, namespace: platform-eng }
spec:
  subAgents: [planner, programmer, reviewer]      # same team, same namespace (§13.3)
  execution:
    durability: strict
    checkpointing: { strategy: step }
    timeouts: { step: 600, run: 86400 }           # a step may be a full test suite
    limits:   { maxSteps: 2000, maxCost: ... }
  transport: sse
  triggers:
    - { type: webhook, path: /external/github-issue }
  memory:
    tiers: [working, conversational, episodic, procedural, external]
    scope: { procedural: agent, episodic: agent }
  context:
    offloading: { enabled: true, store: artifacts }   # the codebase does not fit in a window
  security:
    dataClass: internal
```

`procedural: agent` and `episodic: agent` are the interesting scopes — this agent learns *repo
conventions* and *what happened last time it touched this module*, and that knowledge belongs to the
agent across every task, not to a thread. §20's "no agent-scoped memory without registration" is
exactly why this consumer cannot be ephemeral.

## Integration sequence

```
GitHub issue labelled 'swe-agent'
      │  webhook
      ▼
coding-agent service  (thin: GitHub auth, repo allowlist, PR write-back)
      │  POST /v1/triggers/webhooks/github-issue        → Run
      ▼
Agent Platform
      │
      ├─ planner sub-agent    ── reads repo via MCP ── drafts a plan
      │        │
      │        ▼
      │   Interaction { kind: 'approval' }   ─── run status 'waiting' ───┐
      │        ▲                                                         │
      │        └── engineer approves in GitHub / Slack / dashboard ──────┘
      │
      ├─ programmer sub-agent ── sandboxed workspace ── patches as artifacts
      ├─ reviewer sub-agent    ── test output as artifacts
      │
      └─ pr.create  [essential, idempotent]  → PR opened
                 webhook back to the service → service comments on the issue
```

| Step | Route | Notes |
|---|---|---|
| 1 | `POST /v1/triggers/webhooks/github-issue` | The trigger primitive. **Issue triage, labels and repo policy stay in the consuming service** (§18.2) |
| 2 | `GET /v1/runs/{id}/events` | SSE for a live view. Hours-long, so `Last-Event-ID` resume is not optional |
| 3 | `GET /v1/interactions` · `POST /v1/interactions/{id}/respond` | Plan approval. The engineer who filed the issue is the responder |
| 4 | `GET /v1/runs/{id}/artifacts` | Patches, diffs, test logs |
| 5 | `GET /v1/artifacts/{id}/content` | Fetch a patch to attach to the PR |
| 6 | *(webhook)* | Completion → the service opens or updates the PR |
| 7 | `POST /v1/threads/{id}/runs` | Review feedback arrives as a **new run on the same thread** — the workspace and memory persist, the execution state does not |

Step 7 is where §3's thread/run split earns itself: "address the review comments" is a new run, but
the checked-out workspace, the accumulated artifacts and the episodic memory of the first attempt
are all thread state. Conflating them would mean re-cloning and re-deriving context on every review
cycle.

## Sandbox — the decision this consumer forces

| Option | Fits this consumer? |
|---|---|
| **In-process** (consumer 01's deny-list) | No. Agent-authored code executes; a deny-list is a policy, not a boundary |
| **Container** | Workable. Per-run container, no host mount, egress allowlist, CPU/memory caps. Familiar to operate |
| **microVM** (Firecracker/gVisor class) | Strongest. Kernel-level isolation, survives a container escape |

§0.4's phrasing — *"as models grow more capable the blast radius of tool execution grows with them,
and security isolation must be the substrate, not a layer"* — argues for microVM. The operational
cost is real: image lifecycle, cold-start latency on every tool call, and a build-and-run pipeline
none of the other consumers need.

**Recommendation:** container per run with a hardened profile for Phase 1, microVM as the declared
Phase-3 target, with `tools.sandbox_profile` (already in the schema) as the seam so the swap is a
registry change rather than a code change. The decision must be made **before the first tool
executes** (Appendix A #4), and writing it down as "container now, microVM at Phase 3, seam is
`sandbox_profile`" is what makes that deadline meetable without pretending microVM is free.

## Effect contracts

This is the richest effect-contract case in the three consumers, and the one that exercises every
class in §8.3:

```yaml
tools:
  - ref: git.read
    effects: [readOnly, cacheable]
    cache: { ttl: 60s, scope: agent }

  - ref: repo.checkout
    effects: [readOnly]              # reads the remote; writes only into the sandbox workspace
                                     # the workspace is an artifact, not an external side effect

  - ref: test.run
    effects: [readOnly]              # no external state changes; expensive but freely retryable

  - ref: git.push
    effects: [essential, idempotent]
    idempotencyKey: "${runId}:${branch}:${commitSha}"

  - ref: pr.create
    effects: [essential, idempotent]
    idempotencyKey: "${runId}:${branch}"

  - ref: pr.merge
    effects: [essential, nonIdempotent, humanApprovalRequired]
    # §4.5: a non-idempotent tool cannot be made exactly-once. It is declared as such
    # and routed through human approval rather than pretended about.
```

`repo.checkout` as `readOnly` is the subtle one and worth stating explicitly: it changes sandbox
state, not *external* state. §8.2 keeps tool execution and external side effects as separate
concerns for exactly this reason — misclassifying it as non-idempotent would forfeit retry on the
cheapest, most-retried step in the run.

## Artifacts carry the workload

| Artifact | Lifecycle concern |
|---|---|
| Repo checkout / workspace snapshot | Large. Content-addressed dedup earns its keep — the same base commit across many runs stores once |
| Patches and diffs | Small, versioned, chained via `parent_artifact_id` across review cycles |
| Test output and build logs | High volume, short TTL |
| Generated PR body | Small, but it is the **proposal** §3.1 talks about — the PR itself is GitHub's record, not the platform's |

Retention diverges sharply by kind: test logs want days, patches want the life of the PR, and a
workspace snapshot wants to disappear the moment the run ends. That is `artifacts.retention_policy`
plus the GC index doing real work rather than sitting decorative.

## Credentials — no token passthrough

§13.2 and §16.3 are load-bearing here because a GitHub token is the single most valuable secret in
the flow.

```
run → credential broker → GitHub App installation token
                          · scoped to ONE repository
                          · audience-restricted
                          · short-lived, auto-rotated
                          · minted on behalf of the issue filer  (§16.2)
                          → sandbox
```

The token **never enters model context**. `credential_grants` records the mint — audience, scopes,
`on_behalf_of_principal_id`, `token_id` (jti) — and never the token itself. The engineer's own
entitlements govern: if they cannot write to the repo, neither can the agent acting for them, and
absence of that grant is a **rejection, never a fallback to the service identity** (§16.2).

## Failure behaviour

| Failure | Expected behaviour |
|---|---|
| Worker redeploy at hour 3 | Lease expires; another worker resumes from the last step checkpoint. **The test for whether §4.2 actually works** |
| Sandbox dies mid-`test.run` | `readOnly` → retried freely; workspace rebuilt from the checkout artifact |
| Engineer never approves the plan | Interaction expires → defined run outcome, not a hang (§14.2). Service comments on the issue and closes the run |
| PR already exists (retry after crash) | `pr.create` idempotency key `${runId}:${branch}` → effectively-once (§4.5) |
| Agent asks to merge | Blocked on `humanApprovalRequired`; a `nonIdempotent` merge is never blind-retried |
| Run exceeds `maxCost` | Terminated against the budget, with partial artifacts retained for diagnosis |

## What stays in the consuming service

- GitHub App installation, webhook signature verification, repo allowlist.
- Issue triage and labelling policy. §18.2: *the platform provides the primitive; the consuming
  service owns domain scheduling.*
- Opening, updating and commenting on the PR. The PR is GitHub's record (§3.1).
- Branch naming and merge policy.

## Open questions

1. **Sandbox technology.** Appendix A #4, and blocking — it must be settled before the first tool
   executes, and it is settled for all three consumers at once. Recommendation above.
2. **Checkpoint granularity for a 90-minute step.** §4.3's `strict` tier checkpoints at every step
   boundary, but a single `test.run` step may be 90 minutes. Either steps get finer-grained, or the
   tier needs an intra-step progress concept — which §4.3 does not currently have. **[assumption:
   test suites of that length exist here.]**
3. **Does the workspace survive between runs on a thread?** Cheaper to keep, but a stale workspace
   across a week-old review cycle is a correctness hazard. Proposal: keep the checkout artifact,
   rebuild the sandbox — cheap because content-addressed.
4. **Is the reviewer sub-agent or peer?** Same team today, so sub-agent. If code review ever becomes
   a separately-deployed service owned by another team, §13.3 says it becomes a peer.

   **This is now a switch, not a migration.** A2A ships with both bindings behind one
   transport seam, and the conformance suite runs every assertion against both. Register the
   reviewer as a peer with `binding: local` and it still dispatches in-process as a child run
   in the same event log — no JSON-RPC, no HTTP hop to ourselves. When it moves out, change
   the registry row to `binding: remote`; the caller's spec, the adapter's reasoning and the
   trace shape are unchanged, because the caller only ever named an alias. See
   [a2a.md](../a2a.md).

   The one thing that *does* change is deliberate: a peer gets its own thread (§13.3 isolated
   memory) and its failure is contained rather than failing the parent. If the reviewer's
   verdict is load-bearing, set the peer's `failure_mode` to `propagate`.
