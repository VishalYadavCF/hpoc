-- migration: a durable high-water mark for OTLP trace export (§15.2)
--
-- Traces were queryable here and nowhere else: nothing ever shipped them to the collector
-- the rest of the estate reports to. The exporter needs to know where it left off, and
-- an in-memory cursor would re-export everything after each deploy -- or, worse, export
-- nothing that finished while the process was down.
--
-- One row, not one per run. Runs are exported in `ended_at` order and a run's `ended_at`
-- is written once, in its terminal transaction, so a single high-water mark is sufficient
-- and costs no per-run bookkeeping. The exporter reads only runs that ended a few seconds
-- ago, which is what keeps a commit landing microseconds after the cursor read from being
-- stepped over.
CREATE TABLE trace_export_cursor (
    -- Single-row by construction: the CHECK makes a second row unrepresentable rather
    -- than merely unlikely, so a race cannot produce two disagreeing cursors.
    id                boolean PRIMARY KEY DEFAULT true CHECK (id),
    exported_through  timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now()
);
