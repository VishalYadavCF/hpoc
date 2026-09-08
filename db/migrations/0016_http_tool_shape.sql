-- migration: make the HTTP request shape data, not code (§8.1)
--
-- `origin = 'http'` promised a general HTTP tool and delivered a first-party RPC one: the
-- sandbox hardcoded POST to `endpoint_url` with the arguments as a JSON body. That is
-- sufficient only when every tool endpoint is a service we also write, and it silently
-- pushes every third-party API behind a shim nobody wanted to build.
--
-- With these columns a GitHub, Jira or Slack endpoint is an INSERT rather than a deploy.

ALTER TABLE tools
  ADD COLUMN http_method text NOT NULL DEFAULT 'POST'
      CHECK (http_method IN ('GET','POST','PUT','PATCH','DELETE')),

  -- Appended to `endpoint_url`, which is now the ORIGIN (plus any fixed prefix).
  -- Placeholders use RFC 6570 notation:
  --   {name}  - one path segment; the value is percent-encoded, so `/` becomes %2F and
  --             cannot introduce a segment the template did not declare.
  --   {+name} - reserved expansion; `/` survives. Required for APIs that take a file path
  --             in one position (GitHub contents), and the ONLY way to get a slash in.
  -- A tool with no template calls `endpoint_url` directly, which is the old behaviour.
  ADD COLUMN path_template text,

  -- Where arguments that the template did not consume are sent. NULL means "by method":
  -- query for GET and DELETE, body for the rest -- the convention every REST API follows.
  -- Set it explicitly for the APIs that do not.
  ADD COLUMN arg_placement text
      CHECK (arg_placement IS NULL OR arg_placement IN ('query','body','none')),

  -- Static headers (Accept, API version pins). Credential headers are NOT here -- those
  -- are minted per call by the broker (§16.3) and never stored on a registry row.
  ADD COLUMN static_headers jsonb NOT NULL DEFAULT '{}'::jsonb;

-- A template is meaningless without an endpoint to resolve it against, and the SSRF guard
-- in the sandbox compares the resolved URL's origin to `endpoint_url` -- so a template
-- with no endpoint would have nothing to be checked against.
ALTER TABLE tools
  ADD CONSTRAINT tool_template_needs_endpoint_ck
  CHECK (path_template IS NULL OR endpoint_url IS NOT NULL);

-- A body on GET or DELETE is not portable and several servers reject it outright.
ALTER TABLE tools
  ADD CONSTRAINT tool_no_body_on_get_ck
  CHECK (arg_placement <> 'body' OR http_method NOT IN ('GET','DELETE'));
