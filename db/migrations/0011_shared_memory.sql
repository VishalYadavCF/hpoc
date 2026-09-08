-- migration: opt-in cross-tenant shared memory (§6.2, §6.4)
--
-- The conflict raised in ai-docs/client-interactions/02: relay-agent-builder's knowledge
-- corpus is deliberately cross-merchant and PII-stripped, because one merchant's
-- successful build teaches the next. That is the product's compounding asset. §5.2 makes
-- tenant isolation structural, and `scope = 'org'` could hold such a row but could not
-- express "derived from tenant A, intentionally readable by tenant B, because redacted".
--
-- Resolved as a CAPABILITY the consuming service opts into per namespace, not a platform
-- default. Sharing merchant-derived data is a decision only the service owning those
-- merchants can make, so the platform provides the mechanism and refuses to assume the policy.

CREATE TABLE memory_sharing_policies (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id        uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,

    -- Which tiers may be shared. Deliberately per-tier: a service may want to share
    -- learned procedures while keeping episodic history strictly per-tenant.
    tiers               memory_tier[] NOT NULL,

    -- A row is only readable across tenants if it was written under a policy that named
    -- a redaction rule. "We stripped it" has to be a recorded claim, not an assumption.
    redaction_policy    text NOT NULL,

    -- Off unless someone turns it on, and revocable without deleting the corpus.
    enabled             boolean NOT NULL DEFAULT false,
    approved_by         uuid NOT NULL REFERENCES principals(id),
    approved_at         timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz,

    UNIQUE (org_id, namespace_id)
);

-- Which policy admitted a row into the shared pool, and which tenant it came FROM.
-- Both are needed for §15.3: "where did this claim come from" must stay answerable across
-- the tenant boundary, which is exactly what redaction makes hard.
ALTER TABLE memory_records
  ADD COLUMN shared            boolean NOT NULL DEFAULT false,
  ADD COLUMN sharing_policy_id uuid REFERENCES memory_sharing_policies(id) ON DELETE SET NULL,
  ADD COLUMN source_tenant_ref text;

-- A shared row must name the policy that admitted it. Without this, flipping a boolean
-- would be enough to expose a tenant's data, with nothing recording who allowed it.
ALTER TABLE memory_records
  ADD CONSTRAINT memory_shared_needs_policy_ck
  CHECK (NOT shared OR (sharing_policy_id IS NOT NULL AND source_tenant_ref IS NOT NULL));

CREATE INDEX memory_shared_idx ON memory_records (org_id, namespace_id, tier)
  WHERE shared = true AND superseded_by IS NULL;
