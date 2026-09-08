#!/usr/bin/env bash
# Healthcheck for the hpoc Postgres container.
#
# pg_isready alone reports ready while the initdb.d scripts are still running,
# so a dependent service can connect to a database that has no extensions yet.
# Requiring the extensions to be present makes "healthy" mean "usable".
#
# Lives in a file rather than inline in docker-compose.yml because a folded
# YAML scalar keeps newlines on more-indented lines, which silently mangles a
# multi-line shell command.
set -euo pipefail

db="${POSTGRES_DB:-hpoc}"
user="${POSTGRES_USER:-hpoc}"

pg_isready --username="$user" --dbname="$db" --quiet

missing=$(psql --username="$user" --dbname="$db" --no-align --tuples-only --command "
  SELECT coalesce(string_agg(e, ', '), '')
  FROM unnest(ARRAY['vector', 'timescaledb', 'pgcrypto', 'citext']) AS e
  WHERE NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = e);
")

if [ -n "$missing" ]; then
  echo "missing extensions: $missing" >&2
  exit 1
fi
