# A2A

> §13.4: *"If a second event store appears for A2A, the design has gone wrong."*

That sentence determined almost everything below. A2A is a protocol for durable,
long-running inter-agent work — which is what this runtime already is. So the build is a
**registry, a transport seam and a projection**, not a subsystem.

| A2A concept | Platform primitive | New state? |
|---|---|---|
| Task | Run | no |
| `contextId` | Thread | no |
| Task lifecycle states | Run status (§4.1) | no |
| `input-required` | `waiting` + Interaction (§14) | no |
| Status / artifact updates | Projections over the event log | no |
| Streaming subscription | SSE with `Last-Event-ID` | no |
| Push notifications | The existing async webhook + outbox | no |
| `tenant` | `tenantRef` (§5.2) | no |
| **Which peers exist and how to reach them** | `peers` | **yes** |
| **A task id another runtime minted** | `peer_tasks` | **yes** |

Two tables. Everything else is a view over what was already there.

## Sub-agent or peer

§13.3's table, as code:

| | Sub-agent (`delegate`) | Peer (`peer_call`) |
|---|---|---|
| Resolution | Namespace-scoped | **Org-scoped** |
| Thread | Shares the caller's | **Its own** |
| Trust domain | Shared | Separate |
| Failure | Fails the parent | **Contained by default**, propagation opt-in per peer |
| Location | Always here | Here or elsewhere — the caller cannot tell |

`peer_call` is a separate `NextAction` and a separate `step_kind` rather than a flag on
delegation. The two differ in every row of that table, and a trace that cannot distinguish
"we delegated inside our team" from "we called another team" cannot answer either
question — different blast radius, different failure semantics, different people to page.

The asymmetry in resolution *is* the design. `subAgents` resolves within the namespace and
a composite foreign key makes cross-namespace references unrepresentable. `a2a.peers`
resolves across the org. Reaching another team's agent is legitimate; it is just required
to go over A2A, where the boundary is explicit.

## Bindings, and why they are interchangeable

`PeerTransport` has two implementations. **Local** dispatches straight into the execution
engine as a child run in the same event log — no JSON-RPC, no HTTP round trip to
ourselves. **Remote** speaks JSON-RPC over HTTPS.

The `PeerRouter` resolves which, from the registry row, per call. Callers name a peer;
they never see a binding, and `PeerHandle` deliberately carries none. An adapter that
could tell would encode today's deployment topology into its reasoning, and moving an
agent out of this runtime would become a caller-visible change — §13.4's "bug discovered
during a migration at the worst moment".

**Where they live differs, and that is deliberate.** `LocalPeerTransport` is in
`src/domain/`, not `src/adapters/`: it is the platform dispatching into its own engine,
which is domain behaviour. Only the remote binding adapts to something outside. Filing the
local one under adapters is what first made it reach back into `QueueService` and
`AgentService` across a module boundary that does not run in that direction — the Nest
container refused to start, which was the correct answer to a wrong layering.

### Conformance

§13.4 requires the bindings to be **semantically identical** — same states, same ordering,
same error taxonomy, same cancellation — and says to run the suite against both.
`test/a2a.spec.ts` does exactly that: every assertion is written once and executed against
a local peer and a real loopback JSON-RPC server.

What it pins:

- **Same task shape and same initial state.** A remote peer answering `working` where a
  local one answered `submitted` would make a caller's state machine depend on where the
  peer runs.
- **One error taxonomy.** Remote A2A state names (`input-required`, `canceled`,
  `auth-required`, `rejected`) are translated inside the adapter and never leak past it.
  An unknown state is reported as `failed`, not optimistically mapped to `working` — the
  optimistic reading hangs the caller on a task nobody is advancing.
- **Idempotent cancellation.** Cancelling twice must not throw; §13.5 propagates
  cancellation through retries. Terminal tasks are left alone rather than overwritten — a
  task that completed did complete.
- **A local peer gets its own thread.** The single line separating a peer from a
  sub-agent, asserted rather than assumed.
- **Budget propagates.** §13.5: the callee spends the *originating* tenant's ceiling.

## Agent cards: generated, not registered

§13.6 is explicit — `exposeAsPeer: true` publishes a card *derived from the spec*, "the
way a Kubernetes Service acquires DNS. No second source of truth."

So there is no card table. `GET /a2a/v1/agents/{name}/card` derives and signs on every
read. A stored card goes stale the moment a version is published, and a stale capability
descriptor is worse than none because callers act on it.

Three details worth stating:

- **Exposure lives on `agents`, not `agent_versions`.** The address is the agent name, so
  the card is served per agent. Per-version exposure would let promoting v4 silently
  un-expose an agent other teams depend on — a breaking change to a published contract
  with no signal. (An earlier draft of migration 0013 added a second column here; it was
  removed before it shipped, because two columns are two answers.)
- **Canonical JSON before signing.** A signature over `JSON.stringify` is a signature over
  V8's key insertion order; two runtimes building the same card produce different bytes and
  verification fails for a reason invisible in either document.
- **The verifying key is a parameter, never read from the card.** A document carrying the
  key that verifies it proves only that its author owns a keypair. The registry holds the
  key out of band, and re-verification *clears* a stale timestamp rather than leaving the
  last success standing.

Cards advertise skills — already named, described and versioned for exactly this purpose —
so exposure needs no separate capability vocabulary. `instructions` is excluded: that is
the procedure, not the offer, and a peer is outside the trust domain. No model ref, no tool
endpoints, no sub-agent names either; a discovery document should not double as a
reconnaissance one.

## Inbound: trust is a policy, not a header

`POST /a2a/v1` requires `x-a2a-peer` naming a peer we registered. What that peer may then
*assert* is governed by `peers.inbound_trust` — §15.4's "accept inbound context subject to
tenant trust policy":

| `inbound_trust` | Effect |
|---|---|
| `self` (default) | The run is scoped to `peer:<name>`, whatever the request claims |
| `delegated_identity` | `metadata.tenantRef` is honoured |

Verified live: a peer sent `metadata.tenantRef: "someone-elses-tenant"` and the run was
created as `peer:settlement`. Inbound `delegationDepth` is carried so our own limits still
bite on a chain that started elsewhere, and clamped so a peer cannot buy extra depth by
understating it.

Runs are attributed to the peer's own service principal, never to the human the peer
*claims* is behind it — an unverified header must not become the basis of an audit trail.

## Delegation safety (§13.5)

- **Depth and cycles** are checked on peer id as well as agent id. A peer calling back into
  us is the cycle most likely to happen by accident, because neither team can read the
  other's spec.
- **Budget** propagates as the originating tenant's ceiling. Across a remote hop this is
  sent as an explicit `budgetHintMicros` and described in the code as a *request*: we
  cannot enforce a ceiling inside someone else's runtime. `timeout_ms` is the containment
  that actually works.
- **Cancellation** is best-effort outbound. A peer that refuses or is unreachable does not
  make *our* run uncancellable — otherwise an unreachable peer could pin a run open forever.
- **Failure is contained by default**, propagation opt-in per peer. It is a property of the
  relationship — "the pricing team's service is advisory" versus "the ledger is
  load-bearing" — not a decision to re-make at each call site.
- **One dispatch per step**, enforced by `UNIQUE (step_id)` on `peer_tasks`. A retried step
  reuses its task; dispatching twice to a peer we cannot compensate is §8.3 in its least
  recoverable form.

## Verified end to end

Against live Postgres and a real Gemini model:

```
caller (echo, demo namespace)
  └─ peer_call "settlement"  ──local binding──►  settlement-expert (deep-agents)
                                                   └─ skill: settlement-answers@1
                                                   └─ knowledge: settlement-manual

ask:    "Ask the settlement peer about international cards."
answer: "International card settlement happens on T+5 business days."
trace:  1 model_call  succeeded  latencyMs=3
        2 peer_call   succeeded  latencyMs=6555
```

Inbound, over JSON-RPC, with SSE replay from `Last-Event-ID: 2` returning only the events
after it — the same log, no second store.
