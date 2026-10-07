'use strict';

// 刪除歷史資料 (admin key only, admin.js): every device's usage before the
// first day of a month is deleted from the daily, monthly and session tables
// (store.purgeUsage), after a backup made for the purpose (backups.js):
//
//   GET  /api/admin/usage-purge                    the floor, the earliest
//                                                  usage, the last purges
//   GET  /api/admin/usage-purge/preview?month=     what a purge would delete
//   POST /api/admin/usage-purge { month, confirm } delete; confirm repeats month
//
// Whole months only, so a month is either kept or gone: the reports' monthly
// fallback (reports.js) never mixes a half-deleted month with a kept one. The
// floor only moves up; lowering it means restoring a backup from before.
// Devices keep re-sending their own history, and the store writes none of it
// below the floor, so what was deleted stays deleted.

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const LISTED_PURGES = 50;

class PurgeError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function createPurge({ store, backups = null, onPurged = () => {}, now = () => Date.now(), logger = console } = {}) {
  let running = false;
  const currentMonth = () => new Date(now()).toISOString().slice(0, 7);

  // The month to keep from: a real one, not after this one, above the floor.
  function check(month) {
    const text = String(month ?? '').trim();
    const m = MONTH_RE.exec(text);
    if (!m || Number(m[1]) < 2000) throw new PurgeError(400, 'bad_month', 'month must be YYYY-MM');
    if (text > currentMonth()) throw new PurgeError(400, 'bad_month', 'month must not be after the current month');
    const { floor } = store.purgeState();
    if (floor && text <= floor.month) {
      throw new PurgeError(409, 'already_purged', `usage before ${floor.month} is deleted already; the floor only moves up`, { floor: floor.month });
    }
    return text;
  }

  async function state() {
    const [earliest, purges] = await Promise.all([store.earliestUsage(), store.listPurges(LISTED_PURGES)]);
    const { floor, belowFloorSkipped } = store.purgeState();
    return { floor, belowFloorSkipped, earliest, currentMonth: currentMonth(), running, purges };
  }

  async function preview(month) {
    const keepFrom = check(month);
    return { month: keepFrom, ...(await store.previewPurge(`${keepFrom}-01`)) };
  }

  async function run(body, actor = 'admin') {
    const month = check(body?.month);
    if (String(body?.confirm ?? '').trim() !== month) {
      throw new PurgeError(400, 'confirm_mismatch', 'confirm must repeat the month, to say this purge is meant');
    }
    if (running) throw new PurgeError(409, 'purge_running', 'another purge is running');
    running = true;
    try {
      if (!backups) throw new PurgeError(503, 'backup_unavailable', 'a purge needs a backup first, and this hub makes none', { reason: 'no_database' });
      // Nothing is deleted unless this dump exists: it is the one copy left.
      const backup = await backups.create('purge', actor, { wait: true });
      const result = await store.purgeUsage({ beforeDate: `${month}-01`, actor, backupFile: backup.name });
      onPurged();
      const rows = Object.values(result.deleted).reduce((sum, n) => sum + n, 0);
      (logger.log || console.log)(`[purge] ${actor} deleted the usage before ${month}-01: ${rows} row(s); backup ${backup.name}`);
      return { month, ...result, backup };
    } finally {
      running = false;
    }
  }

  return { preview, run, state };
}

module.exports = { PurgeError, createPurge };
