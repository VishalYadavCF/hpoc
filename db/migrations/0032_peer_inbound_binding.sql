-- A peer that CALLS us but that we never call.
--
-- `peers` was written for outbound delegation: `local` is an agent in this deployment, `remote`
-- is someone else's runtime with an endpoint and a signed card. The inbound A2A surface then
-- reused the same rows as its caller identity (`x-a2a-peer`), which works only while every
-- caller is also something we call.
--
-- agentorchestratorsvc is not. It is a production A2A CLIENT: it discovers our agents and
-- invokes them, and nothing here ever invokes it. It has no agent of ours to point at, and its
-- own cards are not signed with a key we hold, so neither binding can describe it honestly.
-- The two ways to force it -- a `local` row bound to some arbitrary exposed agent, or reusing
-- an unrelated peer as the default -- both put the wrong name on every inbound run's
-- delegation chain and in the audit trail.
--
-- `inbound` is a caller identity and nothing more: an org, a trust level, a status that can be
-- revoked. It carries no outbound material, and PeerService.resolve refuses to route to one.
ALTER TYPE peer_binding ADD VALUE IF NOT EXISTS 'inbound';

-- Compared as TEXT: a value added by ALTER TYPE cannot be used as an enum literal inside the
-- transaction that added it, and every migration here runs as one transaction. The text form
-- is equivalent and is what db/schema.sql states, so the drift check compares like with like.
ALTER TABLE peers DROP CONSTRAINT peer_binding_ck;
ALTER TABLE peers ADD CONSTRAINT peer_binding_ck CHECK (
    (binding::text = 'local'   AND local_agent_id IS NOT NULL)
 OR (binding::text = 'remote'  AND endpoint_url   IS NOT NULL AND agent_card IS NOT NULL)
 OR (binding::text = 'inbound' AND local_agent_id IS NULL
                               AND endpoint_url   IS NULL
                               AND agent_card     IS NULL)
);

-- How THIS caller expects `message/send` to be answered. A dialect belongs to the caller, not
-- to the endpoint, which is why it lives on the peer row.
--
--   task     A2A 0.3.0 as written: return a Task immediately, the caller polls `tasks/get` or
--            streams. What hpoc's own peer transport speaks, and the default.
--   message  Wait for the run and answer with ONE `kind: "message"` result carrying a flat
--            status string and text parts. What agentorchestratorsvc speaks: it never polls,
--            reads `result.parts[].text`, and treats any status outside its own enum -- A2A's
--            `working` and `submitted` included -- as FAILED.
ALTER TABLE peers
    ADD COLUMN reply_mode text NOT NULL DEFAULT 'task'
        CHECK (reply_mode IN ('task', 'message'));
