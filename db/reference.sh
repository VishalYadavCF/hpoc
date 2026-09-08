#!/usr/bin/env bash
# Builds hpoc_reference: a database with db/schema.sql applied, untouched by
# Prisma. Two things use it, both documented in prisma/README.md:
#
#   * prisma/patch-baseline.mjs reads the CHECK constraints out of it
#   * a regenerated baseline is diffed against it to prove nothing was lost
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
