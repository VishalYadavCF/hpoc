-- migration: indexes for the observability read paths (§15)
--
-- Analytics reads are cross-run aggregates over a time window -- the seq-scan shape ADR
-- 0001 describes. These indexes keep that honest at current volume; when they stop being
-- enough, the ADR says the answer is Timescale compression and continuous aggregates,
-- not a new datastore.

-- Success rate, latency and cost, grouped by agent version over a window.
CREATE INDEX runs_version_status_idx
  ON runs (agent_version_id, status, created_at DESC);

-- Per-run latency attribution: which step kinds consumed the wall clock (§15.2).
CREATE INDEX steps_kind_latency_idx
  ON steps (run_id, kind) INCLUDE (latency_ms, status);

-- Tool health: call volume and failure rate per tool.
CREATE INDEX tool_invocations_health_idx
  ON tool_invocations (tool_id, status, created_at DESC);

-- Feedback rollups by version, which is how one version is compared with the next.
CREATE INDEX feedback_version_created_idx
  ON feedback (agent_version_id, created_at DESC);
CREATE INDEX feedback_thread_idx ON feedback (thread_id) WHERE thread_id IS NOT NULL;

-- Trace assembly walks a whole trace across runs, not one run at a time.
CREATE INDEX runs_trace_lookup_idx ON runs (trace_id) WHERE trace_id IS NOT NULL;
