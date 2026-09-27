#!/usr/bin/env bash
# Builds hpoc_reference: a scratch database with db/schema.sql applied.
# db/drift-check.mjs diffs the migrated database against it, so schema.sql
# cannot silently drift from db/migrations/.
#
# It is scratch. Dropping it costs nothing; this script rebuilds it.
set -euo pipefail

cd "$(dirname "$0")/.."

container="${PG_CONTAINER:-hpoc-pg}"
db="${REFERENCE_DB:-hpoc_reference}"
user="${POSTGRES_USER:-hpoc}"

docker exec "$container" psql -U "$user" -d postgres -q \
  -c "DROP DATABASE IF EXISTS $db" \
  -c "CREATE DATABASE $db"

docker exec -i "$container" psql -U "$user" -d "$db" -q -v ON_ERROR_STOP=1 \
  < db/schema.sql

echo "$db rebuilt from db/schema.sql"
