-- migration: scope artifact dedup to the tenant, not the org
--
-- `UNIQUE (org_id, content_hash)` claimed in its own comment to keep one tenant's bytes
-- from resolving into another's. It did the opposite: two tenants in the SAME org storing
-- identical bytes collide, and the second one's insert resolves to the first one's row --
-- carrying the first tenant's `tenant_ref`, `thread_id` and `produced_by_run_id`.
--
-- Identical bytes are not rare in this system: the same prompt template, the same repo
-- checkout at the same commit, the same empty JSON document.
--
-- Storage-level dedup is given up deliberately. Sharing one blob path across tenants means
-- deleting one tenant's artifact destroys bytes another still references, and refcounting
-- across a tenant boundary is a worse problem than paying twice for a blob.

ALTER TABLE artifacts DROP CONSTRAINT artifacts_org_id_content_hash_key;

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_tenant_content_hash_key
  UNIQUE (org_id, namespace_id, tenant_ref, content_hash);

-- GC scans live, unheld, expired artifacts; legal hold must beat TTL (§11.2).
DROP INDEX IF EXISTS artifacts_gc_idx;
CREATE INDEX artifacts_gc_idx ON artifacts (expires_at)
  WHERE state = 'live' AND legal_hold = false AND expires_at IS NOT NULL;

CREATE INDEX artifacts_run_idx ON artifacts (produced_by_run_id)
  WHERE produced_by_run_id IS NOT NULL;
