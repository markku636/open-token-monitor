'use strict';

// Small helpers shared by the persistence modules. Kept free of any driver so
// capture.js stays a pure function that tests can call without a database.

// Every timestamp crosses the boundary as ISO 8601 in UTC with milliseconds
// ('2026-09-01T03:10:00.000Z'): written into timestamptz columns as that text,
// and read back in the same shape (drivers/types.js). Outside 1970–9999 an
// instant is almost certainly a broken device clock, and toISOString() would
// produce a six-digit year, so it becomes "unknown" instead of a write that
// fails forever.
const MIN_DB_MS = 0;
const MAX_DB_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function toDbTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(ms) || ms < MIN_DB_MS || ms > MAX_DB_MS) return null;
  return new Date(ms).toISOString();
}

function fromDbTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text.replace(' ', 'T') : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Deterministic JSON used to decide whether a derived row changed between two
// snapshots. Key order must not matter: the same row rebuilt from a record that
// was serialized and parsed again has to compare equal.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return fallback;
  }
}

module.exports = { fromDbTime, hasOwn, parseJsonColumn, stableJson, toDbTime };
