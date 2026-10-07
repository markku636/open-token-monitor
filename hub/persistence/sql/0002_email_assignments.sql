-- Emails an admin classified by hand (hub/org.js). An address seen on devices
-- no owner was found for is given to an employee on the HR list, or marked as
-- "other": it says nothing about whose the device is (a personal or shared
-- account, a contractor), and its devices count as other. The rules feed the
-- automatic device owners: a device whose address has one is assigned to that
-- employee from its first day (device_owners.updated_by 'auto:email-assigned').
CREATE TABLE email_assignments (
  email        text PRIMARY KEY CHECK (email = lower(email)),
  employee_id  text REFERENCES employees (employee_id),
  is_other     boolean NOT NULL DEFAULT false,
  note         text,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL,
  CHECK ((employee_id IS NULL) = is_other)
);
CREATE INDEX email_assignments_employee_id_idx ON email_assignments (employee_id);
