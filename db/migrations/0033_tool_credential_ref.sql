-- A tool that calls a THIRD-PARTY API with that API's own credential.
--
-- Until now every tool call carried exactly one credential: the broker's platform-signed bearer
-- token, minted per call (§16.3). That is right for a first-party service that trusts our signing
-- key, and useless for GitHub, which only accepts its own token -- in the same `Authorization`
-- header the broker occupies. Baking the token into `static_headers` would put a secret in
-- registry data, which is exactly what that column's comment forbids.
--
-- `credential_ref` is the same idea as `models.credential_ref`: a NAME the secret store resolves at
-- call time, never the value. When set, the broker sends that credential INSTEAD of its own token,
-- not alongside it -- a platform JWT handed to a third party is a credential leak with no upside.
-- The grant is still recorded in `credential_grants`, so the audit trail is unchanged.
--
-- On the template because it is part of the CONTRACT an operator sets (§18.5): a spec cannot name
-- a credential, so an inline tool cannot borrow one its template was not given. Copied onto the
-- instantiated `tools` row, like `endpoint_url`. NULL keeps today's behaviour exactly.
ALTER TABLE tool_templates
    ADD COLUMN credential_ref text
        CHECK (credential_ref IS NULL OR credential_ref <> '');

ALTER TABLE tools
    ADD COLUMN credential_ref text
        CHECK (credential_ref IS NULL OR credential_ref <> '');
