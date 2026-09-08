-- migration: base_url is the vendor's API ROOT, not the versioned path
--
-- Vendor access moved from hand-written HTTP to LangChain's `BaseChatModel`, and the two
-- disagree about who owns the version segment of the URL.
--
-- The old adapters treated `models.base_url` as "everything before the operation", so a
-- Google row read `https://generativelanguage.googleapis.com/v1beta` and the adapter
-- appended `/models/<id>:generateContent`. Each vendor SDK instead takes the API root and
-- builds the whole versioned path itself, so the same row now yields
-- `.../v1beta/v1beta/models/...` -- a 404 that looks like a credential problem.
--
-- Stripping the suffix rather than tolerating it at runtime, deliberately: a provider that
-- silently deletes a trailing `/v1beta` would also mangle a legitimately versioned private
-- endpoint, and would hide the semantic change from whoever writes the next row.
--
-- OpenAI-compatible rows are NOT touched. That SDK's `baseURL` genuinely does include
-- `/v1` (it is OpenAI's own documented convention), so those rows were already correct.
-- The convention is per vendor because the SDKs define it per vendor, which is exactly the
-- kind of detail we no longer want to be the ones getting wrong.

UPDATE models
   SET base_url = regexp_replace(base_url, '/v1beta/?$', '')
 WHERE provider = 'google'
   AND base_url ~ '/v1beta/?$';

UPDATE models
   SET base_url = regexp_replace(base_url, '/v1/?$', '')
 WHERE provider = 'anthropic'
   AND base_url ~ '/v1/?$';
