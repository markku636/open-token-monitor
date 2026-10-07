'use strict';

// How column values come back from PostgreSQL, for the pg driver and the
// in-process PGlite the tests use alike (both take parsers keyed by type OID).
//
// The hub treats days and instants as strings throughout ('YYYY-MM-DD' and
// ISO 8601 with milliseconds and Z), so they are never turned into Date
// objects: a date comes back as the text PostgreSQL sends, a timestamptz as
// ISO. Every session runs in UTC (the driver sets TimeZone), so a timestamptz
// arrives as '2026-09-01 03:10:00.5+00'. bigint and numeric come back as
// numbers: token counts stay far below 2^53, and money has 8 decimals at most.

const OID = Object.freeze({ INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 });

function isoTimestamp(text) {
  const normalized = String(text).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const ms = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(text);
}

function number(text) {
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

const PARSERS = Object.freeze({
  [OID.INT8]: number,
  [OID.NUMERIC]: number,
  [OID.DATE]: (text) => text,
  [OID.TIMESTAMP]: isoTimestamp,
  [OID.TIMESTAMPTZ]: isoTimestamp
});

// node-postgres's `types` option: ours first, pg's own parsers for the rest
// (jsonb to objects, int4 to numbers, arrays, bytea to Buffer).
function pgTypes(defaults) {
  return {
    getTypeParser(oid, format) {
      if (format !== 'binary' && PARSERS[oid]) return PARSERS[oid];
      return defaults.getTypeParser(oid, format);
    }
  };
}

module.exports = { OID, PARSERS, isoTimestamp, pgTypes };
