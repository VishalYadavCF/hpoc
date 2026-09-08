-- migration: one live deployment per state, not just per 'active' (§17.4)
--
-- `deployments_active_uq` (0001) is partial on `state = 'active'`, which lets a `rolling`
-- row and an `active` row coexist for the same agent and environment. During a genuine
-- canary that pair is CORRECT -- the old version serves the remainder while the new one
-- takes a percentage -- so the index cannot simply be widened to cover both states.
--
-- What is not correct, and what actually happened, is TWO rows for the same version in
-- different states: a canary promote left a `rolling` row behind, a later rollback added
-- an `active` row, and the status subresource reported the environment twice. The
-- invariant is one row per (agent, environment, state), so it needs a second partial
-- index rather than a wider one.
-- Existing data violates both indexes below, which is how the bug was found: adding the
-- constraint failed. Repaired first, keeping the NEWEST live row per (agent,
-- environment, version) and retiring the rest -- newest, because a later promote or
-- rollback is the more recent statement of intent about what should be serving.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY agent_id, environment, agent_version_id
               ORDER BY created_at DESC, id DESC
           ) AS rn
      FROM deployments
     WHERE state IN ('active', 'rolling')
)
UPDATE deployments d
   SET state = 'retired'
  FROM ranked r
 WHERE d.id = r.id AND r.rn > 1;

-- Same for the per-state indexes: at most one active and one rolling row per environment.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY agent_id, environment, state
               ORDER BY created_at DESC, id DESC
           ) AS rn
      FROM deployments
     WHERE state IN ('active', 'rolling')
)
UPDATE deployments d
   SET state = 'retired'
  FROM ranked r
 WHERE d.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX deployments_rolling_uq
    ON deployments (agent_id, environment) WHERE state = 'rolling';

-- A canary and a full deployment of the SAME version is incoherent regardless of which
-- states they hold: the version is either taking a percentage or serving everything.
-- Not expressible as a CHECK (it spans rows), so it is a partial unique index over the
-- pair that must not repeat.
CREATE UNIQUE INDEX deployments_live_version_uq
    ON deployments (agent_id, environment, agent_version_id)
    WHERE state IN ('active', 'rolling');
