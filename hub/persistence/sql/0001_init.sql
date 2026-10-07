-- Token Monitor hub: initial schema (PostgreSQL 15+).
--
-- Every object lives in the hub's own schema: the store creates it and puts it
-- first on the search_path (TOKEN_MONITOR_DATABASE_SCHEMA, default
-- token_monitor), so nothing here names it. A migration runs in one
-- transaction and is recorded in schema_migrations; later changes are new
-- files (NNNN_name.sql), never edits to this one.
--
-- Conventions (docs/postgres.zh-TW.md):
--   - tables snake_case and plural, columns snake_case and singular
--   - text rather than varchar(n); a closed set of values is text + CHECK
--   - flags are boolean; instants timestamptz (*_at); days date
--   - token counts bigint >= 0, money numeric(18,8), structured data jsonb
--   - constraint and index names are PostgreSQL's own defaults:
--     <table>_pkey, <table>_<column>_fkey, <table>_<column>_key,
--     <table>_<column>_check, <table>_<columns>_idx
--   - emails are stored lowercased
--
-- Identifiers that come from clients (device, client, model, session and
-- project keys) are case-sensitive, as upstream keys them by JavaScript object
-- keys; text comparison in PostgreSQL already is.

-- The device record each client last uploaded. record_json is the whole
-- record exactly as upstream's hub holds it, kept as text: it is rehydrated
-- verbatim at start, never queried, and a jsonb round trip would reorder it.
CREATE TABLE devices (
  device_id                text PRIMARY KEY,
  hostname                 text NOT NULL DEFAULT '',
  platform                 text NOT NULL DEFAULT '',
  os_name                  text,
  os_version               text,
  agent_version            text NOT NULL DEFAULT '',
  agent_runtime            text NOT NULL DEFAULT '',
  time_zone                text,
  today_key                date,
  month_key                text,
  sync_upload_interval_ms  integer CHECK (sync_upload_interval_ms >= 0),
  projects_enabled         boolean,
  session_details_omitted  jsonb,
  updated_at               timestamptz NOT NULL,
  received_at              timestamptz NOT NULL,
  last_source_ip           inet,
  record_json              text NOT NULL,
  record_bytes             integer NOT NULL CHECK (record_bytes >= 0),
  first_seen_at            timestamptz NOT NULL,
  deleted_at               timestamptz
);
CREATE INDEX devices_received_at_idx ON devices (received_at);
CREATE INDEX devices_hostname_idx ON devices (hostname);
CREATE INDEX devices_agent_version_idx ON devices (agent_version);

-- One row per upload, applied or not: the audit trail (retention
-- TOKEN_MONITOR_AUDIT_RETENTION_DAYS).
CREATE TABLE ingest_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id       text NOT NULL,
  received_at     timestamptz NOT NULL,
  source_ip       inet,
  auth_role       text NOT NULL CHECK (auth_role IN ('client', 'admin')),
  auth_key_index  smallint CHECK (auth_key_index BETWEEN 0 AND 255),
  agent_version   text NOT NULL DEFAULT '',
  payload_bytes   integer NOT NULL CHECK (payload_bytes >= 0),
  had_history     boolean NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('applied', 'coalesced', 'rejected'))
);
CREATE INDEX ingest_events_device_id_received_at_idx ON ingest_events (device_id, received_at);
CREATE INDEX ingest_events_received_at_idx ON ingest_events (received_at);

-- Usage per device and day (the device's local date), and per device and
-- month. `source` says whether the row came from the live snapshot or from the
-- device's own history, which wins once it arrives.
CREATE TABLE device_daily_usage (
  device_id             text NOT NULL,
  usage_date            date NOT NULL,
  tokens                bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd              numeric(18,8) NOT NULL DEFAULT 0,
  messages              integer CHECK (messages >= 0),
  cache_read_tokens     bigint CHECK (cache_read_tokens >= 0),
  cache_write_tokens    bigint CHECK (cache_write_tokens >= 0),
  output_tokens         bigint CHECK (output_tokens >= 0),
  unclassified_tokens   bigint CHECK (unclassified_tokens >= 0),
  has_token_components  boolean NOT NULL DEFAULT false,
  active_time_ms        bigint NOT NULL DEFAULT 0 CHECK (active_time_ms >= 0),
  source                text NOT NULL CHECK (source IN ('live', 'history')),
  source_received_at    timestamptz NOT NULL,
  first_seen_at         timestamptz NOT NULL,
  last_written_at       timestamptz NOT NULL,
  PRIMARY KEY (device_id, usage_date)
);
CREATE INDEX device_daily_usage_usage_date_idx ON device_daily_usage (usage_date);

CREATE TABLE device_daily_client_usage (
  device_id            text NOT NULL,
  usage_date           date NOT NULL,
  client               text NOT NULL,
  tokens               bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd             numeric(18,8) NOT NULL DEFAULT 0,
  messages             integer CHECK (messages >= 0),
  cache_read_tokens    bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  output_tokens        bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  unclassified_tokens  bigint NOT NULL DEFAULT 0 CHECK (unclassified_tokens >= 0),
  PRIMARY KEY (device_id, usage_date, client)
);
CREATE INDEX device_daily_client_usage_usage_date_client_idx ON device_daily_client_usage (usage_date, client);

CREATE TABLE device_daily_model_usage (
  device_id            text NOT NULL,
  usage_date           date NOT NULL,
  model                text NOT NULL,
  tokens               bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd             numeric(18,8) NOT NULL DEFAULT 0,
  cache_read_tokens    bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  output_tokens        bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  unclassified_tokens  bigint NOT NULL DEFAULT 0 CHECK (unclassified_tokens >= 0),
  PRIMARY KEY (device_id, usage_date, model)
);
CREATE INDEX device_daily_model_usage_usage_date_model_idx ON device_daily_model_usage (usage_date, model);

CREATE TABLE device_daily_project_usage (
  device_id    text NOT NULL,
  usage_date   date NOT NULL,
  project_key  text NOT NULL,
  label        text NOT NULL,
  tokens       bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd     numeric(18,8) NOT NULL DEFAULT 0,
  clients      jsonb NOT NULL,
  PRIMARY KEY (device_id, usage_date, project_key)
);
CREATE INDEX device_daily_project_usage_usage_date_project_key_idx ON device_daily_project_usage (usage_date, project_key);

CREATE TABLE device_monthly_usage (
  device_id             text NOT NULL,
  usage_month           text NOT NULL,
  tokens                bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd              numeric(18,8) NOT NULL DEFAULT 0,
  messages              integer CHECK (messages >= 0),
  cache_read_tokens     bigint CHECK (cache_read_tokens >= 0),
  cache_write_tokens    bigint CHECK (cache_write_tokens >= 0),
  output_tokens         bigint CHECK (output_tokens >= 0),
  unclassified_tokens   bigint CHECK (unclassified_tokens >= 0),
  has_token_components  boolean NOT NULL DEFAULT false,
  active_time_ms        bigint NOT NULL DEFAULT 0 CHECK (active_time_ms >= 0),
  source                text NOT NULL CHECK (source IN ('live', 'history')),
  source_received_at    timestamptz NOT NULL,
  first_seen_at         timestamptz NOT NULL,
  last_written_at       timestamptz NOT NULL,
  PRIMARY KEY (device_id, usage_month)
);
CREATE INDEX device_monthly_usage_usage_month_idx ON device_monthly_usage (usage_month);

CREATE TABLE device_monthly_client_usage (
  device_id            text NOT NULL,
  usage_month          text NOT NULL,
  client               text NOT NULL,
  tokens               bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd             numeric(18,8) NOT NULL DEFAULT 0,
  messages             integer CHECK (messages >= 0),
  cache_read_tokens    bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  output_tokens        bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  unclassified_tokens  bigint NOT NULL DEFAULT 0 CHECK (unclassified_tokens >= 0),
  PRIMARY KEY (device_id, usage_month, client)
);
CREATE INDEX device_monthly_client_usage_usage_month_client_idx ON device_monthly_client_usage (usage_month, client);

CREATE TABLE device_monthly_model_usage (
  device_id            text NOT NULL,
  usage_month          text NOT NULL,
  model                text NOT NULL,
  tokens               bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd             numeric(18,8) NOT NULL DEFAULT 0,
  cache_read_tokens    bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  output_tokens        bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  unclassified_tokens  bigint NOT NULL DEFAULT 0 CHECK (unclassified_tokens >= 0),
  PRIMARY KEY (device_id, usage_month, model)
);
CREATE INDEX device_monthly_model_usage_usage_month_model_idx ON device_monthly_model_usage (usage_month, model);

CREATE TABLE device_monthly_project_usage (
  device_id    text NOT NULL,
  usage_month  text NOT NULL,
  project_key  text NOT NULL,
  label        text NOT NULL,
  tokens       bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  cost_usd     numeric(18,8) NOT NULL DEFAULT 0,
  clients      jsonb NOT NULL,
  PRIMARY KEY (device_id, usage_month, project_key)
);
CREATE INDEX device_monthly_project_usage_usage_month_project_key_idx ON device_monthly_project_usage (usage_month, project_key);

-- Session detail per device and month (retention
-- TOKEN_MONITOR_SESSION_RETENTION_MONTHS).
CREATE TABLE device_session_monthly_usage (
  device_id           text NOT NULL,
  usage_month         text NOT NULL,
  session_key         text NOT NULL,
  client              text NOT NULL,
  session_id          text NOT NULL,
  session_kind        text NOT NULL DEFAULT '',
  project_id          text,
  project_label       text,
  total_tokens        bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cost_usd            numeric(18,8) NOT NULL DEFAULT 0,
  message_count       integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  input_tokens        bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens  bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  reasoning_tokens    bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  started_at          timestamptz,
  last_used_at        timestamptz,
  models              jsonb NOT NULL,
  model_costs         jsonb NOT NULL,
  providers           jsonb NOT NULL,
  source_received_at  timestamptz NOT NULL,
  PRIMARY KEY (device_id, usage_month, session_key)
);
CREATE INDEX device_session_monthly_usage_usage_month_idx ON device_session_monthly_usage (usage_month);
CREATE INDEX device_session_monthly_usage_last_used_at_idx ON device_session_monthly_usage (last_used_at);
CREATE INDEX device_session_monthly_usage_project_id_idx ON device_session_monthly_usage (project_id);

-- The AI accounts and plan limits each device last reported.
CREATE TABLE device_limits (
  device_id            text NOT NULL,
  provider             text NOT NULL,
  account_key          text NOT NULL DEFAULT '',
  account_label        text,
  plan_label           text,
  account_name         text,
  account_email        text,
  workspace_kind       text,
  status               text,
  source               text,
  provider_updated_at  timestamptz,
  balance_usd          numeric(18,8),
  balance              jsonb,
  windows              jsonb,
  provider_json        jsonb NOT NULL,
  source_received_at   timestamptz NOT NULL,
  PRIMARY KEY (device_id, provider, account_key)
);
CREATE INDEX device_limits_lower_account_email_idx ON device_limits (lower(account_email));
CREATE INDEX device_limits_provider_plan_label_idx ON device_limits (provider, plan_label);

-- Upstream's subscription list, one document for the whole hub.
CREATE TABLE hub_subscriptions (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  updated_at_token  text NOT NULL DEFAULT '',
  document          text NOT NULL,
  written_at        timestamptz NOT NULL
);

-- The company org charts imported from HR announcements (hub/org.js), as one
-- tree: company → BU → department → team. unit_id is the path of names
-- (ACME/<BU>/<department>/<team>). Units a newer list no longer has are
-- deactivated, never deleted, because ownership history still points at them.
CREATE TABLE org_units (
  unit_id         text PRIMARY KEY,
  parent_unit_id  text REFERENCES org_units (unit_id),
  level           text NOT NULL CHECK (level IN ('company', 'bu', 'department', 'team')),
  name            text NOT NULL,
  cost_center     text,
  is_active       boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL,
  CHECK (parent_unit_id IS DISTINCT FROM unit_id)
);
CREATE INDEX org_units_parent_unit_id_idx ON org_units (parent_unit_id);

CREATE TABLE employees (
  employee_id  text PRIMARY KEY,
  name         text NOT NULL,
  email        text UNIQUE CHECK (email = lower(email)),
  is_active    boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL
);

-- Where each employee sits now, as the last imported list for their company
-- said: one row per employee, overwritten by every import. unit_id is the
-- deepest unit listed for them; company_id is the root of its tree.
CREATE TABLE employee_placements (
  employee_id  text PRIMARY KEY REFERENCES employees (employee_id),
  company_id   text NOT NULL REFERENCES org_units (unit_id),
  unit_id      text NOT NULL REFERENCES org_units (unit_id),
  imported_at  timestamptz NOT NULL
);
CREATE INDEX employee_placements_company_id_idx ON employee_placements (company_id);
CREATE INDEX employee_placements_unit_id_idx ON employee_placements (unit_id);

-- Which employee held a device, and which unit its usage went to, from
-- valid_from up to (not including) valid_to. Ranges of one device never
-- overlap (hub/admin.js enforces it); each day of usage is charged to the
-- range that covers it.
CREATE TABLE device_owners (
  device_id    text NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date CHECK (valid_to >= valid_from),
  employee_id  text NOT NULL REFERENCES employees (employee_id),
  unit_id      text NOT NULL REFERENCES org_units (unit_id),
  note         text,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (device_id, valid_from)
);
CREATE INDEX device_owners_employee_id_idx ON device_owners (employee_id);
CREATE INDEX device_owners_unit_id_idx ON device_owners (unit_id);

-- The company email a client says its user has (an upload's ownerEmail),
-- kept here because upstream drops unknown fields from the device record.
CREATE TABLE device_claims (
  device_id    text PRIMARY KEY,
  email        text NOT NULL CHECK (email = lower(email)),
  reported_at  timestamptz NOT NULL
);
CREATE INDEX device_claims_email_idx ON device_claims (email);

-- Daily usage with the owner and unit of that day, for reporting tools that
-- read the database directly (the hub itself queries the tables).
CREATE VIEW v_daily_usage_by_owner AS
SELECT u.usage_date, u.device_id,
       o.employee_id, e.name AS employee_name,
       o.unit_id, ou.name AS unit_name, ou.level AS unit_level, ou.cost_center,
       u.tokens, u.cost_usd
FROM device_daily_usage u
LEFT JOIN device_owners o
  ON o.device_id = u.device_id
 AND u.usage_date >= o.valid_from
 AND (o.valid_to IS NULL OR u.usage_date < o.valid_to)
LEFT JOIN employees e  ON e.employee_id = o.employee_id
LEFT JOIN org_units ou ON ou.unit_id = o.unit_id;

CREATE VIEW v_daily_client_usage_by_owner AS
SELECT u.usage_date, u.device_id, u.client,
       o.employee_id, e.name AS employee_name,
       o.unit_id, ou.name AS unit_name, ou.level AS unit_level, ou.cost_center,
       u.tokens, u.cost_usd
FROM device_daily_client_usage u
LEFT JOIN device_owners o
  ON o.device_id = u.device_id
 AND u.usage_date >= o.valid_from
 AND (o.valid_to IS NULL OR u.usage_date < o.valid_to)
LEFT JOIN employees e  ON e.employee_id = o.employee_id
LEFT JOIN org_units ou ON ou.unit_id = o.unit_id;

CREATE VIEW v_monthly_cost_by_unit AS
SELECT to_char(usage_date, 'YYYY-MM') AS usage_month,
       unit_id, unit_name, unit_level, cost_center,
       sum(tokens) AS tokens, sum(cost_usd) AS cost_usd
FROM v_daily_usage_by_owner
GROUP BY to_char(usage_date, 'YYYY-MM'), unit_id, unit_name, unit_level, cost_center;
