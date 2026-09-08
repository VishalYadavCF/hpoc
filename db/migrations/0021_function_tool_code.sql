-- migration: make a function tool's CODE data, so the sandbox has something to run (§0.4, §8.1)
--
-- The container sandbox has had a correct isolation envelope since 0001 -- no network, a
-- read-only root, dropped capabilities, a non-root user, pid/memory/cpu caps -- wrapped
-- around an entrypoint of `sh -c cat`, which echoes its payload back. Nothing ever
-- executed. `origin = 'function'` was a registry value with no runtime behind it.
--
-- These columns are the same move migration 0016 made for HTTP tools: the thing that
-- varies per tool becomes data, so registering one is an INSERT rather than a deploy.
-- The source is handed to the sandbox on STDIN alongside the arguments -- never as argv
-- (world-readable in /proc) and never baked into an image, which would make every tool
-- edit a rebuild.
ALTER TABLE tools
  -- Which interpreter the sandbox image provides. Deliberately a small closed set: each
  -- value needs a harness that speaks the calling convention below, so an unrecognised
  -- one must fail at write time rather than at the first invocation.
  ADD COLUMN code_runtime text
      CHECK (code_runtime IS NULL OR code_runtime IN ('node','python')),

  -- The tool body. Contract, enforced by the harness rather than by the schema:
  --   node   - assign `module.exports = async (args, ctx) => ...`
  --   python - define `def handler(args, ctx)`
  -- `ctx` carries the broker-minted headers and the declared endpoint, so a function tool
  -- can make an authorised call without ever seeing a raw secret (§16.3).
  ADD COLUMN code_source text;

-- A runtime with no body, or a body with no runtime, is a tool that cannot run. Refused
-- here rather than discovered on the first invocation.
ALTER TABLE tools
  ADD CONSTRAINT tool_code_pairing_ck
  CHECK ((code_runtime IS NULL) = (code_source IS NULL));

-- `origin = 'function'` now MEANS something: there is code, and the platform runs it.
-- Without this an author can still register a function tool that does nothing, which is
-- exactly the state this migration exists to end.
ALTER TABLE tools
  ADD CONSTRAINT tool_function_needs_code_ck
  CHECK (origin <> 'function' OR code_source IS NOT NULL);
