-- Where a tool's MODEL-SUPPLIED arguments go in the request body.
--
-- Until now they went at the top level, merged flat with the tool's bound arguments. That fits an
-- API whose request body IS the argument list, and fits nothing else. ap-executor's execute route
-- is the counter-example, and it is the first consumer of the ai-agent migration: it takes
-- `{ action, merchantId, auth, input: { ...the piece's own fields } }`, so the model's arguments
-- belong one level down while the routing fields stay at the top.
--
-- The alternative was to make the MODEL produce the nesting, by showing it a schema of
-- `{ input: { … } }`. Measured against gemini-2.5-flash that fails: across five calls and two
-- tools it emitted the fields flat every time, ignoring the wrapper, and the executor then
-- rejected the request for missing required fields. A shape the platform can guarantee is worth
-- more than one the model is asked to remember.
--
-- NULL keeps the existing behaviour exactly, so no registered tool changes.
ALTER TABLE tools
    ADD COLUMN arg_wrapper_key text
        CHECK (arg_wrapper_key IS NULL OR arg_wrapper_key <> '');

-- Only meaningful when the arguments are in the body at all; in `query` or `none` there is no
-- object to nest into, and silently ignoring it there would make a misconfiguration invisible.
ALTER TABLE tools
    ADD CONSTRAINT tool_arg_wrapper_needs_body
        CHECK (arg_wrapper_key IS NULL OR arg_placement IS NULL OR arg_placement = 'body');
