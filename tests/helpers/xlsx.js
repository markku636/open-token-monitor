'use strict';

// Builds small .xlsx files for the org import tests, so no test ever needs a
// real HR workbook. Just the parts hub/xlsx.js reads: the workbook, its
// relationships, shared strings and one XML part per sheet, deflated in a zip.

const zlib = require('node:zlib');

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// entries: [[name, text or Buffer], ...] → a zip file.
function zip(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = store ? data : zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
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
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// sheets: [{ name, rows: [[cell, ...], ...] }]. Strings go to the shared string
// table (or inline with { inline: true }); numbers are stored as numbers.
function buildXlsx(sheets, { inline = false } = {}) {
  const strings = [];
  const index = new Map();
  const shared = (text) => {
    if (!index.has(text)) {
      index.set(text, strings.length);
      strings.push(text);
    }
    return index.get(text);
  };
  const parts = sheets.map((sheet, sheetIndex) => {
    const rows = sheet.rows.map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const xml = cells.map((value, col) => {
        const ref = `${columnName(col)}${r}`;
        if (value === null || value === undefined || value === '') return '';
        if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
        if (inline) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        return `<c r="${ref}" t="s"><v>${shared(String(value))}</v></c>`;
      }).join('');
      return `<row r="${r}">${xml}</row>`;
    }).join('');
    return [`xl/worksheets/sheet${sheetIndex + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`];
  });
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  }</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  }</Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${
    strings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('')
  }</sst>`;
  return zip([
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels],
    ...(inline ? [] : [['xl/sharedStrings.xml', sst]]),
    ...parts
  ]);
}

// The columns an HR announcement has, in its order, with the sensitive ones
// filled so a test can prove they are never read.
const ANNOUNCEMENT_HEADER = ['Employee No.', 'English Name', 'Chinese Name', 'Join Date', 'BU', 'Department ', 'Team', 'Category', 'Job Title', 'Mgt Grade', 'E Grade', 'E Grade 2', 'E Level', 'Email Address ', 'Chat ID', 'Location', 'Promotion Type'];

// people: [{ no, en, zh, bu, department, team, email }]
function announcement(people, { sheet = 'Sheet1', extraSheets = [] } = {}) {
  const rows = [ANNOUNCEMENT_HEADER, ...people.map((p) => [
    p.no, p.en || '', p.zh || '', 45000, p.bu ?? '', p.department || '', p.team ?? '', 'Developer', 'Engineer',
    'SECRET-MGT-GRADE', 'SECRET-E-GRADE', 'E4', 'B', p.email || '', 'chat-secret', 'Taipei', 'SECRET-PROMOTION'
  ])];
  return buildXlsx([{ name: sheet, rows }, ...extraSheets]);
}

module.exports = { ANNOUNCEMENT_HEADER, announcement, buildXlsx, zip };
