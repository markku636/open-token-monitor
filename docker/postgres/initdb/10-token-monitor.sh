#!/bin/sh
# Runs once, when the postgres container starts on an empty data directory
# (docker-entrypoint-initdb.d), as the superuser POSTGRES_USER in POSTGRES_DB.
# It sets up the three roles docs/postgres.zh-TW.md describes:
#
#   postgres                 the superuser: IT only, never the hub
#   token_monitor            the hub: owns schema token_monitor and every table
#                            the hub's migrations create in it, nothing else
#   token_monitor_readonly   SELECT on that schema, for reporting tools; the
#                            login token_monitor_reader is a member of it when
#                            TOKEN_MONITOR_DB_READONLY_PASSWORD is set
#
# A PostgreSQL that IT runs elsewhere gets the same SQL by hand (see the doc).

if [ -z "${TOKEN_MONITOR_DB_PASSWORD:-}" ]; then
  echo "10-token-monitor.sh: TOKEN_MONITOR_DB_PASSWORD is not set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$TOKEN_MONITOR_DB_PASSWORD" \
  -v reader_password="${TOKEN_MONITOR_DB_READONLY_PASSWORD:-}" <<'SQL'
CREATE ROLE token_monitor LOGIN PASSWORD :'app_password';
CREATE SCHEMA token_monitor AUTHORIZATION token_monitor;
ALTER ROLE token_monitor SET search_path = token_monitor;

-- Nobody but the owner creates objects anywhere else.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE token_monitor_readonly NOLOGIN;
GRANT USAGE ON SCHEMA token_monitor TO token_monitor_readonly;
-- Tables and views the hub creates later are readable too.
ALTER DEFAULT PRIVILEGES FOR ROLE token_monitor IN SCHEMA token_monitor
  GRANT SELECT ON TABLES TO token_monitor_readonly;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO token_monitor, token_monitor_readonly', current_database());
END
$$;

SELECT :'reader_password' <> '' AS has_reader \gset
\if :has_reader
CREATE ROLE token_monitor_reader LOGIN PASSWORD :'reader_password' IN ROLE token_monitor_readonly;
ALTER ROLE token_monitor_reader SET search_path = token_monitor;
ALTER ROLE token_monitor_reader SET default_transaction_read_only = on;
\endif
SQL
