'use strict';

// Just enough of an .xlsx reader for the roster files the org import takes
// (hub/org.js): sheet names and each row's cell values as text. And just
// enough of a writer for the roster template the dashboard downloads
// (writeWorkbook): text cells, a bold header row, column widths.
// No dependency: an .xlsx is a zip of XML parts, and zlib inflates the parts.
//
// The file comes from an admin, but it is still a zip from outside, so every
// size is bounded before anything is inflated: the whole file, the number of
// entries, and each entry's inflated size (maxOutputLength stops a zip bomb
// inside zlib instead of after it has filled memory).

const zlib = require('node:zlib');

const LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxEntries: 200,
  maxEntryBytes: 50 * 1024 * 1024
});

class XlsxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XlsxError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function unzip(buffer, limits) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new XlsxError('not an .xlsx file');
  if (buffer.length > limits.maxBytes) throw new XlsxError(`file is larger than ${limits.maxBytes} bytes`);
  // The end-of-central-directory record sits in the last 22 bytes plus at most
  // a 64 KiB comment.
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('not an .xlsx file');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > limits.maxEntries) throw new XlsxError(`more than ${limits.maxEntries} parts`);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new XlsxError('damaged .xlsx file');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new XlsxError('zip64 files are not supported');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new XlsxError('damaged .xlsx file');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) throw new XlsxError('damaged .xlsx file');
    entries.set(name, { method, compressed, size, start });
  }
  return {
    has: (name) => entries.has(name),
    text(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.size > limits.maxEntryBytes) throw new XlsxError(`${name} is larger than ${limits.maxEntryBytes} bytes`);
      const data = buffer.subarray(entry.start, entry.start + entry.compressed);
      if (entry.method === 0) return data.toString('utf8');
      if (entry.method !== 8) throw new XlsxError(`${name} uses an unsupported compression`);
      try {
        return zlib.inflateRawSync(data, { maxOutputLength: limits.maxEntryBytes }).toString('utf8');
      } catch (error) {
        throw new XlsxError(error.code === 'ERR_BUFFER_TOO_LARGE' ? `${name} is larger than ${limits.maxEntryBytes} bytes` : `${name} could not be read`);
      }
    }
  };
}

function decode(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// The text of a shared or inline string: every <t> run, without the phonetic
// guides (<rPh>) that CJK workbooks attach to names.
function runText(xml) {
  const plain = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [...plain.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
}

function sheetRows(xml, strings) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const number = Number(/\br="(\d+)"/.exec(row[1])?.[1]) || rows.length + 1;
    const cells = {};
    for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const column = /\br="([A-Z]+)\d+"/.exec(cell[1])?.[1];
      if (!column) continue;
      const type = /\bt="(\w+)"/.exec(cell[1])?.[1];
      const body = cell[2] || '';
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text;
      if (type === 's') text = strings[Number(value)] ?? '';
      else if (type === 'inlineStr') text = runText(body);
      else text = value === undefined ? '' : decode(value);
      cells[column] = text;
    }
    rows.push({ number, cells });
  }
  return rows;
}

// Every worksheet in workbook order, as { name, rows: [{ number, cells }] }
// where cells maps a column letter to its text.
function readWorkbook(buffer, limits = LIMITS) {
  const zip = unzip(buffer, { ...LIMITS, ...limits });
  const workbook = zip.text('xl/workbook.xml');
  const rels = zip.text('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new XlsxError('not an .xlsx file');
  const strings = sharedStrings(zip.text('xl/sharedStrings.xml'));
  const targets = new Map();
  for (const rel of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[1])?.[1];
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const sheets = [];
  for (const sheet of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decode(/\bname="([^"]*)"/.exec(sheet[1])?.[1] || '');
    const path = targets.get(/\br:id="([^"]+)"/.exec(sheet[1])?.[1]);
    const xml = path ? zip.text(path) : null;
    if (xml) sheets.push({ name, rows: sheetRows(xml, strings) });
  }
  return sheets;
}

// A header cell as it is compared: trimmed, inner spaces collapsed, lower case,
// so `Department `, `Email Address ` and `employee no.` all match.
function headerKey(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// The first sheet whose header row names every column in `required` (each an
// array of accepted header spellings), with its rows keyed by header.
function findTable(sheets, required) {
  for (const sheet of sheets) {
    for (const [index, row] of sheet.rows.slice(0, 10).entries()) {
      const columns = new Map(Object.entries(row.cells).map(([column, text]) => [headerKey(text), column]));
      const found = required.every((names) => names.some((name) => columns.has(headerKey(name))));
      if (!found) continue;
      const records = sheet.rows.slice(index + 1).map((r) => ({
        line: r.number,
        get(names) {
          for (const name of [].concat(names)) {
            const column = columns.get(headerKey(name));
            if (column) return String(r.cells[column] ?? '').trim();
          }
          return '';
        }
      }));
      return { sheet: sheet.name, headerLine: row.number, records };
    }
  }
  return null;
}

// ---- writing

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// entries: [[name, text], ...] → a zip of deflated entries, names in UTF-8.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
// Style 0 plain, 1 bold (a header row), 2 text (a column of ids, so Excel
// keeps their leading zeros).
const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

// sheets: [{ name, rows: [[text, ...], ...], widths: [characters, ...],
// header: true for a bold first row that stays put, textColumns: [index, ...]
// for columns Excel should keep as text }] → an .xlsx file. Every cell is text.
function writeWorkbook(sheets) {
  const parts = sheets.map((sheet, sheetIndex) => {
    const text = new Set(sheet.textColumns || []);
    const cols = (sheet.widths || []).map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"${text.has(i) ? ' style="2"' : ''}/>`).join('');
    const rows = sheet.rows.map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const bold = sheet.header && rowIndex === 0;
      const xml = cells.map((value, col) => {
        if (value === null || value === undefined || value === '') return '';
        const style = bold ? ' s="1"' : text.has(col) ? ' s="2"' : '';
        return `<c r="${columnName(col)}${r}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      }).join('');
      return `<row r="${r}">${xml}</row>`;
    }).join('');
    const frozen = sheet.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    return [`xl/worksheets/sheet${sheetIndex + 1}.xml`, `${XML_HEAD}<worksheet xmlns="${MAIN_NS}">${frozen}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`];
  });
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>';
  const rootRels = `${XML_HEAD}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${
    sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  }</sheets></workbook>`;
  const workbookRels = `${XML_HEAD}<Relationships xmlns="${PACKAGE_REL_NS}">${
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  }<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
  return zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/styles.xml', STYLES],
    ...parts
  ]);
}

module.exports = { LIMITS, XlsxError, findTable, headerKey, readWorkbook, writeWorkbook };
