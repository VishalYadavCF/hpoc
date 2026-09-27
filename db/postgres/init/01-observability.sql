-- =====================================================================
-- Observability helper views.
--
-- Thin wrappers over pg_stat_statements / pg_buffercache so the common
-- questions are one SELECT rather than a remembered join.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS obs;
COMMENT ON SCHEMA obs IS 'Observability helper views. Not part of the application schema.';

-- Slowest statements by total time. The usual first stop.
CREATE OR REPLACE VIEW obs.slow_queries AS
SELECT
    queryid,
    calls,
    round(total_exec_time::numeric, 2)               AS total_ms,
    round(mean_exec_time::numeric, 2)                AS mean_ms,
    round(stddev_exec_time::numeric, 2)              AS stddev_ms,
    rows,
    round(100.0 * shared_blks_hit
          / nullif(shared_blks_hit + shared_blks_read, 0), 2) AS hit_pct,
    round(shared_blk_read_time::numeric, 2)                 AS read_ms,
    round(shared_blk_write_time::numeric, 2)                AS write_ms,
    query
FROM pg_stat_statements
ORDER BY total_exec_time DESC;

COMMENT ON VIEW obs.slow_queries IS
    'pg_stat_statements ordered by total execution time. hit_pct below ~99 on a hot query means it is reading from disk.';

-- Statements doing the most physical I/O, which is often not the same
-- set as the slowest ones.
CREATE OR REPLACE VIEW obs.io_hogs AS
SELECT
    queryid,
    calls,
    shared_blks_read,
    shared_blks_written,
    temp_blks_read,
    temp_blks_written,
    round(shared_blk_read_time::numeric, 2)  AS read_ms,
    round(shared_blk_write_time::numeric, 2) AS write_ms,
    query
FROM pg_stat_statements
WHERE shared_blks_read + temp_blks_read > 0
ORDER BY shared_blks_read + temp_blks_read DESC;

COMMENT ON VIEW obs.io_hogs IS
    'Statements by physical blocks read. temp_blks_* above zero means work_mem was exceeded and it spilled.';

-- What is actually resident in shared_buffers, per relation.
CREATE OR REPLACE VIEW obs.cache_residency AS
SELECT
    c.relname                                              AS relation,
    n.nspname                                              AS schema,
    count(*)                                               AS buffers,
    pg_size_pretty(count(*) * current_setting('block_size')::bigint) AS cached,
    pg_size_pretty(pg_table_size(c.oid))                   AS total,
    round(100.0 * count(*) * current_setting('block_size')::bigint
          / nullif(pg_table_size(c.oid), 0), 1)            AS cached_pct
FROM pg_buffercache b
JOIN pg_class     c ON b.relfilenode = pg_relation_filenode(c.oid)
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE b.reldatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
GROUP BY c.oid, c.relname, n.nspname
ORDER BY count(*) DESC;

COMMENT ON VIEW obs.cache_residency IS
    'Per-relation shared_buffers occupancy. Drives pg_prewarm decisions: a hot table at low cached_pct is a prewarm candidate.';

-- Index usage. Unused indexes cost write throughput for nothing.
CREATE OR REPLACE VIEW obs.unused_indexes AS
SELECT
    s.schemaname                        AS schema,
    s.relname                           AS table_name,
    s.indexrelname                      AS index_name,
    s.idx_scan                          AS scans,
    pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
    i.indisunique                       AS is_unique
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;

COMMENT ON VIEW obs.unused_indexes IS
    'Never-scanned indexes. Check uptime before acting - a freshly reset stat counter makes everything look unused.';

-- Table bloat and vacuum health.
CREATE OR REPLACE VIEW obs.table_health AS
SELECT
    schemaname                          AS schema,
    relname                             AS table_name,
    n_live_tup                          AS live_rows,
    n_dead_tup                          AS dead_rows,
    round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;

COMMENT ON VIEW obs.table_health IS
    'Dead tuple accumulation per table. Sustained high dead_pct with a stale last_autovacuum means autovacuum is not keeping up.';

-- Live blocking chains.
CREATE OR REPLACE VIEW obs.blocking AS
SELECT
    blocked.pid                                  AS blocked_pid,
    blocked.usename                              AS blocked_user,
    blocked.query                                AS blocked_query,
    blocked.wait_event_type,
    blocked.wait_event,
    now() - blocked.query_start                  AS blocked_for,
    blocking.pid                                 AS blocking_pid,
    blocking.usename                             AS blocking_user,
    blocking.query                               AS blocking_query,
    blocking.state                               AS blocking_state
FROM pg_stat_activity blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bpid ON true
JOIN pg_stat_activity blocking ON blocking.pid = bpid
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;

COMMENT ON VIEW obs.blocking IS
    'Who is blocking whom, right now. Empty is the healthy state.';
