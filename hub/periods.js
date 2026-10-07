'use strict';

// Days, weeks and months as the usage views and the reports count them. A day
// is a device's local date ('YYYY-MM-DD'), a week an ISO week (Monday to
// Sunday, named by its Monday), a month a calendar month ('YYYY-MM'). Windows
// of days are inclusive at both ends: { from, to }.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const GRANULARITIES = Object.freeze(['day', 'week', 'month']);

function validDay(value) {
  if (!DAY_RE.test(String(value || ''))) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// The Monday of the ISO week a day is in.
function weekStart(day) {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

// The key of the bucket a day falls in.
function bucketKey(day, granularity) {
  if (granularity === 'week') return weekStart(day);
  if (granularity === 'month') return day.slice(0, 7);
  return day;
}

// [from, to] cut into buckets, in order: { key, from, to, days }, with the
// first and last clipped to the range. `indexOf` maps a day to its bucket.
function bucketsFor(from, to, granularity) {
  const buckets = [];
  const index = new Map();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const key = bucketKey(day, granularity);
    let bucket = buckets[buckets.length - 1];
    if (!bucket || bucket.key !== key) {
      bucket = { key, from: day, to: day, days: 0 };
      buckets.push(bucket);
    }
    bucket.to = day;
    bucket.days += 1;
    index.set(day, buckets.length - 1);
  }
  return { buckets, indexOf: (day) => index.get(String(day).slice(0, 10)) };
}

// The whole day, ISO week or calendar month a day is in: { from, to }.
function periodOf(day, granularity) {
  if (granularity === 'week') {
    const monday = weekStart(day);
    return { from: monday, to: addDays(monday, 6) };
  }
  if (granularity === 'month') {
    const [year, month] = day.split('-').map(Number);
    return { from: `${day.slice(0, 7)}-01`, to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
  }
  return { from: day, to: day };
}

// How many days a bucket has when nothing clips it.
function naturalDays(bucket, granularity) {
  if (granularity === 'week') return 7;
  if (granularity === 'month') {
    const [year, month] = bucket.key.split('-').map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }
  return 1;
}

function span(from, to, partial) {
  return { from, to, days: daysBetween(from, to) + 1, partial };
}

// What a window [from, to] inside one natural period is compared with: the
// same stretch of the period before it. A whole period is set against the
// whole period before (September against all of August); a part of one
// against the same days counted from the start, cut off at the end of that
// period (Mon–Wed against last week's Mon–Wed, March 1–30 against February
// 1–28, a month clipped to the 15th–30th against the 15th–30th before). A day
// is set against the same weekday one week earlier, not the day before: most
// usage follows the working week. `partial` says the window is not a whole
// period.
function compareWindow(from, to, granularity) {
  const period = periodOf(from, granularity);
  const start = granularity === 'month' ? `${addDays(period.from, -1).slice(0, 7)}-01` : addDays(period.from, -7);
  const before = periodOf(start, granularity);
  if (from === period.from && to === period.to) return span(before.from, before.to, false);
  const at = (day) => {
    const shifted = addDays(before.from, daysBetween(period.from, day));
    return shifted > before.to ? before.to : shifted;
  };
  return span(at(from), at(to), true);
}

// The window of the same length right before [from, to]: what a range that is
// not one period (the last 30 days, a custom range) is compared with.
function windowBefore(from, to) {
  const days = daysBetween(from, to) + 1;
  return span(addDays(from, -days), addDays(from, -1), false);
}

// The same date a year earlier; a 29 February becomes the 28th.
function yearBefore(day) {
  const [year, month, date] = day.split('-').map(Number);
  const last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${String(year - 1).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(date, last)).padStart(2, '0')}`;
}

// What [from, to] is compared with a year back (去年同期). Days and weeks go
// back 52 weeks, so a weekday meets the same weekday: the week of 2026-09-28
// meets the week of 2025-09-29. Months and longer ranges keep their calendar
// dates: September against last September, 2026 against 2025.
function yearAgoWindow(from, to, granularity, partial = false) {
  if (granularity === 'day' || granularity === 'week') return span(addDays(from, -364), addDays(to, -364), partial);
  return span(yearBefore(from), yearBefore(to), partial);
}

// The last bucket of [from, to]: the period `to` is in, cut off at `from`.
function lastBucket(from, to, granularity) {
  const period = periodOf(to, granularity);
  return { from: period.from < from ? from : period.from, to };
}

// Whether two windows of days share a day.
function overlaps(a, b) {
  return a.from <= b.to && b.from <= a.to;
}

// Windows of days ([from, to] pairs) in order, the ones that overlap or touch
// merged into one, so a statement reads each day once.
function mergeSpans(windows) {
  const out = [];
  for (const [from, to] of windows.slice().sort(([a], [b]) => a.localeCompare(b))) {
    const last = out[out.length - 1];
    if (last && from <= addDays(last[1], 1)) {
      if (to > last[1]) last[1] = to;
    } else {
      out.push([from, to]);
    }
  }
  return out;
}

module.exports = {
  GRANULARITIES,
  addDays,
  bucketKey,
  bucketsFor,
  compareWindow,
  daysBetween,
  lastBucket,
  mergeSpans,
  naturalDays,
  overlaps,
  periodOf,
  validDay,
  weekStart,
  windowBefore,
  yearAgoWindow,
  yearBefore
};
