'use strict';

// hub/periods.js: the natural day, week and month a day is in, and the window
// a stretch of one is compared with (GET /api/custom/usage `previous`).

const assert = require('node:assert/strict');
const test = require('node:test');

const { compareWindow, lastBucket, mergeSpans, naturalDays, overlaps, periodOf, windowBefore, yearAgoWindow, yearBefore } = require('../hub/periods');

test('a day is in one natural day, ISO week (Monday to Sunday) and calendar month', () => {
  assert.deepEqual(periodOf('2026-09-30', 'day'), { from: '2026-09-30', to: '2026-09-30' });
  assert.deepEqual(periodOf('2026-09-30', 'week'), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(periodOf('2026-10-04', 'week'), { from: '2026-09-28', to: '2026-10-04' }, 'Sunday ends its week');
  assert.deepEqual(periodOf('2026-12-31', 'week'), { from: '2026-12-28', to: '2027-01-03' }, 'a week across the new year');
  assert.deepEqual(periodOf('2026-09-15', 'month'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodOf('2024-02-10', 'month'), { from: '2024-02-01', to: '2024-02-29' }, 'a leap February');
  assert.deepEqual(periodOf('2026-02-28', 'month'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodOf('2026-12-01', 'month'), { from: '2026-12-01', to: '2026-12-31' });
});

test('a bucket has as many days as its natural period', () => {
  assert.equal(naturalDays({ key: '2026-09-30' }, 'day'), 1);
  assert.equal(naturalDays({ key: '2026-09-28' }, 'week'), 7);
  assert.equal(naturalDays({ key: '2026-09' }, 'month'), 30);
  assert.equal(naturalDays({ key: '2024-02' }, 'month'), 29);
  assert.equal(naturalDays({ key: '2026-02' }, 'month'), 28);
  assert.equal(naturalDays({ key: '2026-12' }, 'month'), 31);
});

test('a whole period is compared with the whole period before it; a part with the same days of it', () => {
  const window = (from, to, days, partial) => ({ from, to, days, partial });
  // Months.
  assert.deepEqual(compareWindow('2026-09-01', '2026-09-30', 'month'), window('2026-08-01', '2026-08-31', 31, false));
  assert.deepEqual(compareWindow('2026-03-01', '2026-03-31', 'month'), window('2026-02-01', '2026-02-28', 28, false));
  assert.deepEqual(compareWindow('2026-03-01', '2026-03-30', 'month'), window('2026-02-01', '2026-02-28', 28, true), 'cut off at the end of February');
  assert.deepEqual(compareWindow('2024-03-01', '2024-03-30', 'month'), window('2024-02-01', '2024-02-29', 29, true));
  assert.deepEqual(compareWindow('2026-09-15', '2026-09-30', 'month'), window('2026-08-15', '2026-08-30', 16, true), 'a month bucket clipped at the start');
  assert.deepEqual(compareWindow('2026-03-29', '2026-03-31', 'month'), window('2026-02-28', '2026-02-28', 1, true));
  assert.deepEqual(compareWindow('2026-01-01', '2026-01-20', 'month'), window('2025-12-01', '2025-12-20', 20, true), 'across the new year');
  // Weeks.
  assert.deepEqual(compareWindow('2026-09-28', '2026-10-04', 'week'), window('2026-09-21', '2026-09-27', 7, false));
  assert.deepEqual(compareWindow('2026-09-28', '2026-09-30', 'week'), window('2026-09-21', '2026-09-23', 3, true), 'Mon–Wed against Mon–Wed');
  assert.deepEqual(compareWindow('2026-09-30', '2026-10-02', 'week'), window('2026-09-23', '2026-09-25', 3, true), 'Wed–Fri, clipped at both ends');
  // Days: the same weekday one week earlier.
  assert.deepEqual(compareWindow('2026-09-30', '2026-09-30', 'day'), window('2026-09-23', '2026-09-23', 1, false));
  assert.deepEqual(compareWindow('2026-03-01', '2026-03-01', 'day'), window('2026-02-22', '2026-02-22', 1, false));
});

test('a range that is not one period is compared with as many days right before it', () => {
  assert.deepEqual(windowBefore('2026-09-01', '2026-09-30'), { from: '2026-08-02', to: '2026-08-31', days: 30, partial: false });
  assert.deepEqual(windowBefore('2026-09-30', '2026-09-30'), { from: '2026-09-29', to: '2026-09-29', days: 1, partial: false });
  // The longest range: 400 days, so the work window reaches 800 days back.
  assert.deepEqual(windowBefore('2025-01-01', '2026-02-04'), { from: '2023-11-28', to: '2024-12-31', days: 400, partial: false });
});

test('去年同期 is 52 weeks back for days and weeks and the same dates for months and ranges', () => {
  assert.equal(yearBefore('2026-09-28'), '2025-09-28');
  assert.equal(yearBefore('2024-02-29'), '2023-02-28', 'a leap day');
  assert.equal(yearBefore('2025-03-01'), '2024-03-01');
  // The week of Monday 2026-09-28 meets the week of Monday 2025-09-29.
  assert.deepEqual(yearAgoWindow('2026-09-28', '2026-10-04', 'week'), { from: '2025-09-29', to: '2025-10-05', days: 7, partial: false });
  assert.deepEqual(yearAgoWindow('2026-09-28', '2026-09-30', 'week', true), { from: '2025-09-29', to: '2025-10-01', days: 3, partial: true });
  // A Wednesday meets a Wednesday.
  assert.deepEqual(yearAgoWindow('2026-09-30', '2026-09-30', 'day'), { from: '2025-10-01', to: '2025-10-01', days: 1, partial: false });
  assert.equal(new Date('2025-10-01T00:00:00Z').getUTCDay(), new Date('2026-09-30T00:00:00Z').getUTCDay());
  assert.deepEqual(yearAgoWindow('2024-02-01', '2024-02-29', 'month'), { from: '2023-02-01', to: '2023-02-28', days: 28, partial: false });
  assert.deepEqual(yearAgoWindow('2024-02-29', '2024-03-31', 'range'), { from: '2023-02-28', to: '2023-03-31', days: 32, partial: false });
  assert.deepEqual(yearAgoWindow('2024-01-01', '2024-12-31', 'month'), { from: '2023-01-01', to: '2023-12-31', days: 365, partial: false }, 'a whole leap year');
});

test('the last bucket of a range, and windows that share a day', () => {
  assert.deepEqual(lastBucket('2026-08-31', '2026-09-16', 'week'), { from: '2026-09-14', to: '2026-09-16' });
  assert.deepEqual(lastBucket('2026-09-15', '2026-09-30', 'month'), { from: '2026-09-15', to: '2026-09-30' }, 'cut off at the range');
  assert.deepEqual(lastBucket('2026-09-01', '2026-09-07', 'day'), { from: '2026-09-07', to: '2026-09-07' });
  assert.equal(overlaps({ from: '2026-09-01', to: '2026-09-07' }, { from: '2026-09-07', to: '2026-09-10' }), true);
  assert.equal(overlaps({ from: '2026-09-01', to: '2026-09-07' }, { from: '2026-09-08', to: '2026-09-10' }), false);
});

test('the spans a statement reads are merged when they overlap or touch', () => {
  assert.deepEqual(mergeSpans([['2026-09-24', '2026-09-30'], ['2026-09-23', '2026-09-23']]), [['2026-09-23', '2026-09-30']], 'touching');
  assert.deepEqual(mergeSpans([['2026-08-31', '2026-09-16'], ['2026-09-07', '2026-09-09']]), [['2026-08-31', '2026-09-16']], 'inside');
  assert.deepEqual(mergeSpans([['2026-09-15', '2026-09-30'], ['2026-08-15', '2026-08-30']]), [['2026-08-15', '2026-08-30'], ['2026-09-15', '2026-09-30']], 'apart, in order');
  const input = [['2026-09-10', '2026-09-12'], ['2026-09-01', '2026-09-03']];
  mergeSpans(input);
  assert.deepEqual(input, [['2026-09-10', '2026-09-12'], ['2026-09-01', '2026-09-03']], 'the input is left alone');
});
