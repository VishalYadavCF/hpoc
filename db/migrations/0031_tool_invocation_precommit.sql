-- Lets a non-idempotent tool invocation be recorded BEFORE the side effect, durably.
--
-- §4.5's recovery rule says a resumed run that finds one of its own non-idempotent
-- invocations still `running` must neither retry it nor assume it succeeded. The guard that
-- enforces it (ToolRuntime.assertNoIndeterminateInvocations) was unreachable: the `running`
-- row was written on the STEP's transaction, so the crash it exists to detect was exactly the
-- event that rolled the evidence back. Measured against ap-executor's ai-agent-v2 driving nine
-- Google Sheets writes, killing the worker mid-write produced eleven writes, two duplicate
-- rows, and a run that reported `completed`.
--
-- Committing that row first requires a SEPARATE connection, and a separate connection cannot
-- see the step row -- the step is still uncommitted in the transaction that is, at that moment,
-- blocked awaiting the tool call. The FK check would wait on that transaction while that
-- transaction waits on the tool, which is a deadlock Postgres cannot see and would not break.
--
-- So the reference goes and the column stays. `step_id` remains NOT NULL and remains the
-- step's id: what is lost is only the database's promise that the step row EXISTS, and for a
-- pre-committed invocation that promise was never true to begin with. A join to `steps`
-- returning nothing is the honest answer -- it says the step never committed, which is
-- precisely what the operator reading a stuck invocation needs to know.
--
-- Cleanup is unaffected: `run_id` and `thread_id` still cascade, and every step belongs to a
-- run, so deleting a run still takes its invocations with it.
ALTER TABLE tool_invocations
    DROP CONSTRAINT tool_invocations_step_id_fkey;

-- The guard runs once per resumed run, before the framework is driven. Without this it is a
-- sequential scan of every invocation the run ever made, on the hot path of every resume.
CREATE INDEX IF NOT EXISTS tool_invocations_running_idx
    ON tool_invocations (run_id)
    WHERE status = 'running';
