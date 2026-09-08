-- migration: A2A — peers, agent cards, task correlation (§13.4, §13.5, §13.6)
--
-- The governing constraint from §13.4: "If a second event store appears for A2A, the
-- design has gone wrong." A2A concepts map onto primitives that already exist --
--
--   Task            -> Run
--   contextId       -> Thread
--   task states     -> run status (§4.1)
--   input-required  -> waiting + Interaction (§14)
--   status/artifact
--     update events -> projections over the event log
--   subscription    -> SSE with Last-Event-ID
--   push            -> the existing async webhook path
--
-- so almost nothing here is state. What IS here is the minimum A2A cannot derive: which
-- peers exist and how to reach them, and the correlation between one of our steps and a
-- task id minted by someone else's runtime.

-- A peer call is a delegation ACROSS a trust boundary, and the trace has to be able to
-- tell the two apart: "we delegated inside our team" and "we called another team" have
-- different blast radii, different failure semantics (§13.5 containment), and different
-- people to page.
ALTER TYPE step_kind ADD VALUE IF NOT EXISTS 'peer_call';

-- ---------------------------------------------------------------------------
-- Peer registry
-- ---------------------------------------------------------------------------

ALTER TABLE peers
  -- §13.5: failure is CONTAINED by default, propagation is opt-in. Stored per peer
  -- because it is a property of the relationship, not of any one call: "the pricing
  -- team's service is advisory" and "the ledger is load-bearing" are different answers
  -- that should not be re-decided at every call site.
  ADD COLUMN failure_mode text NOT NULL DEFAULT 'contain'
      CHECK (failure_mode IN ('contain', 'propagate')),

  -- A remote peer is egress (§16.1). A call with no ceiling is an unbounded hold on one
  -- of our runs, decided by someone else's runtime.
  ADD COLUMN timeout_ms integer NOT NULL DEFAULT 300000,

  -- The key a remote peer's card signature is verified against. Separate from the card
  -- itself, deliberately: a card carrying the key that verifies it proves nothing.
  ADD COLUMN public_key text,
  ADD COLUMN card_fetched_at timestamptz,

  -- §15.4: "Accept inbound context at server endpoints subject to tenant trust policy."
  -- What we are willing to believe from this peer about identity and tenancy. Default is
  -- the strict reading: the peer speaks for itself and nobody else.
  ADD COLUMN inbound_trust text NOT NULL DEFAULT 'self'
      CHECK (inbound_trust IN ('self', 'delegated_identity'));

-- A local peer's card is derived, so it has no signature of its own to verify and no
-- endpoint to fetch from; a remote peer's must be verified before it is trusted.
ALTER TABLE peers
  ADD CONSTRAINT peer_local_has_no_remote_material_ck
  CHECK (binding = 'remote' OR (public_key IS NULL AND endpoint_url IS NULL));

-- Two peers under one alias would make dispatch ambiguous, and the ambiguity would be
-- resolved by whichever row the planner returned first.
ALTER TABLE agent_version_peers
  ADD CONSTRAINT agent_version_peers_alias_unique UNIQUE (agent_version_id, alias);

-- NOTE: `agents.expose_as_peer` already exists (0001) and is deliberately NOT duplicated
-- onto agent_versions.
--
-- The AgentSpec's `a2a.exposeAsPeer` is the INPUT; `agents.expose_as_peer` is the resolved
-- state, written when a version is published. Two columns would be two answers to "is this
-- exposed", and dispatch and card-serving would each pick one.
--
-- Per-agent rather than per-version is also the right granularity: the ADDRESS is the
-- agent name, so a card is served for an agent. If exposure were per-version, promoting v4
-- could silently un-expose an agent other teams depend on -- a breaking change to a
-- published contract with no signal at the moment it happens. The card's CONTENT is still
-- derived from the current version's spec, so §13.6's "generated, not registered" holds:
-- there is no card table.

-- ---------------------------------------------------------------------------
-- Task correlation
-- ---------------------------------------------------------------------------

-- Maps one of our steps to the task it dispatched.
--
-- Not an event store and not a task store: the task's STATE lives in `runs` for a local
-- binding and in the callee's runtime for a remote one. This table holds only the
-- identifier we could not otherwise know -- a remote task id minted elsewhere -- plus the
-- last state we observed, so a resumed parent can tell "still running" from "finished
-- while we were down" without re-dispatching.
--
-- Both bindings write the same row shape on purpose. §13.4 requires the bindings to be
-- semantically identical, and a conformance suite can only assert that if there is a
-- single place to look.
CREATE TABLE peer_tasks (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id             uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id            uuid NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    peer_id            uuid NOT NULL REFERENCES peers(id) ON DELETE RESTRICT,
    binding            peer_binding NOT NULL,

    -- Exactly one of these. A local task IS a child run in this event log; a remote task
    -- is an opaque id in someone else's. A single polymorphic column would have lost the
    -- FK, and with it the guarantee that a local task points at a run that exists.
    child_run_id       uuid REFERENCES runs(id) ON DELETE CASCADE,
    remote_task_id     text,
    remote_context_id  text,

    -- The normalised state, shared by both bindings. Remote vocabularies are translated
    -- into this on the way in; §13.4's conformance requirement is that they must be the
    -- same states in the same order whichever binding served the call.
    state              text NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted','working','input_required','completed','failed','cancelled')),
    error              jsonb,
    last_observed_at   timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT peer_task_binding_ck CHECK (
        (binding = 'local'  AND child_run_id IS NOT NULL AND remote_task_id IS NULL)
     OR (binding = 'remote' AND remote_task_id IS NOT NULL AND child_run_id IS NULL)
    ),
    -- One dispatch per step. A retried step must reuse its task rather than mint a second
    -- one: dispatching twice to a peer that is not idempotent is the §8.3 failure, and it
    -- is worse across a trust boundary because we cannot compensate someone else's run.
    UNIQUE (step_id)
);
CREATE INDEX peer_tasks_run_idx ON peer_tasks (run_id);
CREATE INDEX peer_tasks_remote_idx ON peer_tasks (peer_id, remote_task_id)
    WHERE remote_task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Inbound push notification configuration
-- ---------------------------------------------------------------------------

-- A2A push notifications are the protocol's name for what §12.1 already calls the async
-- webhook transport, so this records the destination and the existing outbox delivers it.
-- Building a second delivery path would mean a second retry policy and a second set of
-- dead letters for the same failure.
CREATE TABLE a2a_push_configs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    url           text NOT NULL,
    -- A REFERENCE, never the token. §16.3: the broker holds secret material and the
    -- control plane holds the fact that a credential exists.
    token_ref     text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id)
);
