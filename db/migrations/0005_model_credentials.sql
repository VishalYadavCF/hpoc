-- migration: model endpoint and credential reference
--
-- The model registry could name a provider but not say WHERE it lives or WHICH secret
-- reaches it, so no provider other than the in-process echo one was actually callable.
--
-- `credential_ref` is a NAME, never a secret (§16.3). The broker resolves it at call time
-- through the secret store; the value never lands in a column, a log line, or model
-- context.

ALTER TABLE models
  ADD COLUMN base_url       text,
  ADD COLUMN credential_ref text;

COMMENT ON COLUMN models.base_url IS
  'Provider endpoint. A LiteLLM proxy is modelled as an openai-compatible provider with its own base_url.';
COMMENT ON COLUMN models.credential_ref IS
  'Name resolved by the credential broker against the secret store. Never the secret itself.';

-- An external provider that names no credential is a misconfiguration that would only
-- surface as a 401 mid-run. Internal providers (the echo one) legitimately need neither.
ALTER TABLE models
  ADD CONSTRAINT models_external_needs_endpoint_ck
  CHECK (residency <> 'external' OR (base_url IS NOT NULL AND credential_ref IS NOT NULL));
