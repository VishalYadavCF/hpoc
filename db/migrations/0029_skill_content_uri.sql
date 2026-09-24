-- Skills authored by uploading a file rather than typing `instructions` as JSON. The
-- uploaded body lives in object storage (MinIO in any real deployment); this column holds
-- the URI `ObjectStore.get` expects, resolved and streamed on demand when an agent's
-- prompt actually reads the skill -- never eagerly loaded into every run that merely has
-- it pinned, which is the whole point of an upload path existing at all.
--
-- Nullable and coexists with `instructions` indefinitely, not a migration of it: existing
-- skills, and any future JSON-authored ones, keep working exactly as before. Nothing here
-- requires a backfill.
ALTER TABLE skill_versions
    ADD COLUMN content_uri text;

-- `instructions` drops its NOT NULL so an uploaded skill can leave it empty; the CHECK
-- below is what keeps that safe. Without it, a row with both set would leave
-- `PlatformBackend` guessing which is current, and a row with neither would publish a
-- skill with no procedure to follow -- both are worse than a rejected write.
ALTER TABLE skill_versions
    ALTER COLUMN instructions DROP NOT NULL;

ALTER TABLE skill_versions
    ADD CONSTRAINT skill_versions_content_source_chk
    CHECK ((instructions IS NOT NULL) <> (content_uri IS NOT NULL));
