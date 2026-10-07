-- Every 刪除歷史資料 an admin ran (hub/purge.js): all usage before
-- before_date, the first day of a month, was deleted from the daily, monthly
-- and session tables. The newest before_date is the floor below which the hub
-- writes no usage a device uploads again (store.writeCapture): clients keep
-- re-sending 370 days of daily history and all of their monthly history. A
-- restored backup brings back its own rows of this table, and so its own floor.
CREATE TABLE usage_purges (
  purge_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  before_date   date NOT NULL CHECK (before_date = date_trunc('month', before_date)::date),
  purged_by     text NOT NULL,
  purged_at     timestamptz NOT NULL,
  deleted_rows  jsonb NOT NULL,
  totals        jsonb NOT NULL,
  backup_file   text
);
