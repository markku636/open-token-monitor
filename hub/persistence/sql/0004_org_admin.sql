-- An admin's email rule can give an address to a department or team instead
-- of an employee (hub/org.js): for contractors, shared accounts and anyone else
-- the HR lists do not have. A rule names exactly one of an employee, a unit, or
-- "other".
ALTER TABLE email_assignments ADD COLUMN unit_id text REFERENCES org_units (unit_id);
ALTER TABLE email_assignments DROP CONSTRAINT email_assignments_check;
ALTER TABLE email_assignments ADD CONSTRAINT email_assignments_target_check
  CHECK (num_nonnulls(employee_id, unit_id) + (CASE WHEN is_other THEN 1 ELSE 0 END) = 1);
CREATE INDEX email_assignments_unit_id_idx ON email_assignments (unit_id);

-- A device a unit rule assigned is charged to that unit with no employee.
ALTER TABLE device_owners ALTER COLUMN employee_id DROP NOT NULL;

-- The day an HR list says an employee's current placement took effect: the
-- announcement's date, or the day an admin chose when importing it. A device's
-- change of unit is charged from that day (org.js reconcile).
ALTER TABLE employee_placements ADD COLUMN effective_from date;

-- Every HR import (hub/org.js): which file, the day it is dated and takes
-- effect, who imported it, and what it changed (counts and the employee nos.
-- of each kind of change), so each month's import can be looked back on.
CREATE TABLE org_imports (
  import_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      text NOT NULL,
  file_name       text,
  file_date       date,
  effective_from  date NOT NULL,
  imported_by     text NOT NULL,
  imported_at     timestamptz NOT NULL,
  summary         jsonb NOT NULL
);
CREATE INDEX org_imports_company_id_imported_at_idx ON org_imports (company_id, imported_at);

-- Signed-in dashboard admins (hub/sessions.js). The browser holds a random
-- session token in an HttpOnly cookie instead of the admin secret; only its
-- SHA-256 is kept. secret_fingerprint ties a session to the admin secret it
-- was opened with, so changing TOKEN_MONITOR_SECRET ends every session.
CREATE TABLE admin_sessions (
  token_hash          bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  secret_fingerprint  bytea NOT NULL,
  source_ip           text,
  created_at          timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL
);
CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions (expires_at);
