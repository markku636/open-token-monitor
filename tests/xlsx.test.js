'use strict';

// hub/xlsx.js: the dependency-free reader behind the org import.

const assert = require('node:assert/strict');
const test = require('node:test');

const { XlsxError, findTable, readWorkbook } = require('../hub/xlsx');
const { buildXlsx, zip } = require('./helpers/xlsx');

test('sheets come back in workbook order with shared and inline strings', () => {
  const shared = readWorkbook(buildXlsx([
    { name: '名單', rows: [['Employee No.', 'Email Address'], ['ACME-1', 'a@example.test'], ['ACME-2', 7]] },
    { name: 'Other', rows: [['x']] }
  ]));
  assert.deepEqual(shared.map((s) => s.name), ['名單', 'Other']);
  assert.deepEqual(shared[0].rows[1], { number: 2, cells: { A: 'ACME-1', B: 'a@example.test' } });
  assert.equal(shared[0].rows[2].cells.B, '7', 'numbers come back as text');

  const inline = readWorkbook(buildXlsx([{ name: 'S', rows: [['a & <b>', '王小明']] }], { inline: true }));
  assert.deepEqual(inline[0].rows[0].cells, { A: 'a & <b>', B: '王小明' });
});

test('rich text runs are joined and phonetic guides left out', () => {
  const workbook = '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const sst = '<sst><si><r><t>張</t></r><r><t xml:space="preserve">美玲</t></r><rPh sb="0" eb="1"><t>チョウ</t></rPh></si><si><t>&#x4E2D;&amp;&#25991;</t></si></sst>';
  const sheet = '<worksheet><sheetData><row r="3"><c r="B3" t="s"><v>0</v></c><c r="C3" t="s"><v>1</v></c></row></sheetData></worksheet>';
  const [parsed] = readWorkbook(zip([['xl/workbook.xml', workbook], ['xl/_rels/workbook.xml.rels', rels], ['xl/sharedStrings.xml', sst], ['xl/worksheets/sheet1.xml', sheet]]));
  assert.deepEqual(parsed.rows, [{ number: 3, cells: { B: '張美玲', C: '中&文' } }]);
});

test('the table is found by its headers, spaced and cased as HR types them', () => {
  const sheets = readWorkbook(buildXlsx([
    { name: 'Notes', rows: [['Employee ID', 'Promotion']] },
    { name: 'List', rows: [['Company announcement'], [], ['employee no.', 'Department ', 'EMAIL  ADDRESS '], ['ACME-1', 'Arcade', 'a@example.test']] }
  ]));
  const table = findTable(sheets, [['Employee No.', 'Employee ID'], ['Email Address']]);
  assert.equal(table.sheet, 'List', 'a sheet without an email column is not the list');
  assert.equal(table.headerLine, 3);
  assert.equal(table.records[0].get('Department'), 'Arcade');
  assert.equal(table.records[0].get(['Missing', 'Email Address']), 'a@example.test');
  assert.equal(table.records[0].get('Team'), '');
  assert.equal(findTable(sheets, [['Nothing like this']]), null);
});

test('files that are not workbooks, or too big to be one, are refused', () => {
  assert.throws(() => readWorkbook(Buffer.from('not a zip at all, just text')), XlsxError);
  assert.throws(() => readWorkbook(zip([['hello.txt', 'hi']])), /not an \.xlsx file/);
  const workbook = buildXlsx([{ name: 'S', rows: [['a']] }]);
  assert.throws(() => readWorkbook(workbook, { maxBytes: 100 }), /larger than 100 bytes/);
  assert.throws(() => readWorkbook(workbook, { maxEntries: 2 }), /more than 2 parts/);
  // A part that inflates past its limit (a zip bomb) stops inside zlib.
  const bomb = zip([
    ['xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${' '.repeat(200000)}</sheetData></worksheet>`]
  ]);
  assert.throws(() => readWorkbook(bomb, { maxEntryBytes: 10000 }), /larger than 10000 bytes/);
});
