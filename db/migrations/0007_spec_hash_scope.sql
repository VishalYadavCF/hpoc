-- migration: restrict spec-hash uniqueness to the ephemeral lifetime
--
-- `UNIQUE (org_id, spec_hash)` exists to COLLAPSE duplicates: a consuming service firing
-- the same inline spec a thousand times should resolve to one AgentVersion and one
-- prompt-cache key (§18.1, §10).
--
-- Applied to REGISTERED versions it does the opposite of what is wanted. Two agents that
-- happen to share a spec, or one agent republished unchanged, are distinct versions --
-- a version is what a deployment, a trigger and a rollback point at, so collapsing them
-- makes "roll back to v3" ambiguous. The collision surfaced as a duplicate-key error on
-- the second agent to publish an identical spec.

ALTER TABLE agent_versions DROP CONSTRAINT agent_versions_org_id_spec_hash_key;

CREATE UNIQUE INDEX agent_versions_ephemeral_spec_hash_uq
  ON agent_versions (org_id, spec_hash)
  WHERE lifetime = 'ephemeral';

-- Registered versions keep the true content hash, which stays useful for comparing two
-- versions and for prompt-cache keying -- it simply no longer has to be unique.
CREATE INDEX agent_versions_spec_hash_idx ON agent_versions (org_id, spec_hash);
