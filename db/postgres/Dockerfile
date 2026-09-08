# =====================================================================
# hpoc Postgres — PostgreSQL 17 with the extension set the platform needs.
#
# Built rather than pulled. The obvious off-the-shelf candidate,
# timescale/timescaledb-ha, bundles TimescaleDB and pgvector but relocates
# PGDATA and wraps the entrypoint for Patroni, which fights a plain
# `-c config_file=` dev setup. Starting from the official image keeps the
# standard entrypoint and initdb.d behaviour, at the cost of one build.
#
#   vector storage   pgvector (+ hnsw), pgvectorscale where buildable
#   time series      timescaledb, timescaledb-toolkit
#   caching          pg_cron, pg_prewarm
#   observability    pg_stat_statements, auto_explain, pg_buffercache,
#                    pgstattuple, pg_visibility, pg_wait_sampling,
#                    pg_stat_kcache, hypopg, amcheck
# =====================================================================
FROM postgres:17-bookworm

ARG PG_MAJOR=17

# The official image already has the PGDG apt repo and postgresql-contrib
# (pg_stat_statements, pg_buffercache, pgstattuple, pg_prewarm,
# pg_visibility, amcheck, auto_explain all ship there). Everything below
# is what contrib does not cover.
# Extra trust roots for the build. Empty on a normal network; on one doing
# TLS interception (corporate proxy) drop the intercepting CA in here or the
# packagecloud.io fetch below fails with "self-signed certificate in chain".
# See ca-certificates/README.md.
COPY ca-certificates/ /usr/local/share/ca-certificates/

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg; \
    update-ca-certificates; \
    \
    # TimescaleDB is not in PGDG; add its repo.
    curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey \
        | gpg --dearmor -o /usr/share/keyrings/timescaledb.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/timescaledb.gpg] \
https://packagecloud.io/timescale/timescaledb/debian/ bookworm main" \
        > /etc/apt/sources.list.d/timescaledb.list; \
    \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "postgresql-${PG_MAJOR}-pgvector" \
        "postgresql-${PG_MAJOR}-cron" \
        "postgresql-${PG_MAJOR}-hypopg" \
        "postgresql-${PG_MAJOR}-pg-wait-sampling" \
        "postgresql-${PG_MAJOR}-pg-stat-kcache" \
        "timescaledb-2-postgresql-${PG_MAJOR}" \
        "timescaledb-toolkit-postgresql-${PG_MAJOR}"; \
    \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*

# timescaledb-tune would rewrite postgresql.conf on first boot. We mount our
# own config instead, so it is deliberately not run.

COPY postgresql.conf /etc/postgresql/postgresql.conf
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chown postgres:postgres /etc/postgresql/postgresql.conf \
 && chmod +x /usr/local/bin/healthcheck.sh

CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
