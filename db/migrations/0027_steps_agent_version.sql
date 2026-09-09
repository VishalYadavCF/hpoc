-- Which agent version actually did the work in this step.
--
-- Until now a step's agent was implied by its run: one run, one version, no ambiguity.
-- In-process sub-agents (§13.3, `mode: 'inline'`) break that implication -- a registered
-- sub-agent can now reason and call tools inside its CALLER's run, so without this column
-- the child's model spend and tool invocations are silently attributed to the parent's
-- version, and no eval or cost report could tell a stage's regression from its caller's.
--
-- Nullable, and left NULL for every existing row: backfilling it to the run's version
-- would assert something about history we did not record, and `COALESCE(agent_version_id,
-- <run's version>)` reads correctly either way.
ALTER TABLE steps
    ADD COLUMN agent_version_id uuid REFERENCES agent_versions(id);

-- Attribution queries are "all steps for this version", which is a scan without this.
CREATE INDEX steps_agent_version_idx ON steps (agent_version_id) WHERE agent_version_id IS NOT NULL;
