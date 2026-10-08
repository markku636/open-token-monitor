'use strict';

// Company org charts, and which employee each device belongs to: what the
// dashboard's company → department filters and comparisons, and the
// reports by unit, are built on.
//
// Import. One HR announcement workbook per company (.xlsx) is that company's
// latest list. Its units and employees are upserted, and the ones the new list
// no longer has are marked inactive, never deleted, so ownership history keeps
// pointing at them. Only identity and placement columns are read (employee
// no., names, email, BU, department, team); grades, promotion data and every
// other column never leave the workbook.
//
// Units are rows of `org_units`, as a tree, each with its level:
//   ACME                              company (the code the file name starts with)
//   ACME/Games                        bu (BU column)
//   ACME/Games/Arcade                 department (Department column)
//   ACME/Games/Arcade/Pixel Team   team (Team column)
// Names are matched case-insensitively, so one unit spelled two ways is one
// unit. A level HR left empty ('-' or blank) is skipped: a department with no BU
// hangs right under its company, as ACME/-/<department> so it can never take the
// id of a BU of the same name, and whoever has no unit at some level counts as
// "other" when units of that level are compared. A team of the department's own
// name or "<department> Department" is the department's own staff, and a
// department of the BU's own name or "<BU> BU" the BU's.
//
// Ownership goes by email: the HR lists first, an admin's rule only for an
// address no list has. reconcile() gives each device an owner from the
// evidence below, strongest first, as the same date ranges (device_owners) an
// admin writes:
//   1. the company email the client reports with its uploads (ownerEmail),
//      when it is on an HR list
//   2. the AI account emails in the device's latest limits, when they are on
//      the lists and name exactly one active employee (two or more is a
//      conflict: no owner, and issues() lists it)
//   3. an admin's rule for an address the lists do not have
//      (email_assignments): the reported address's, else the AI accounts'
//      rules when they name one target. A rule gives an address to a
//      department or team (the device counts there, with no employee), or to
//      an employee (a personal account, a former address)
// An address an admin marked "other" is no evidence, and a device with no
// evidence counts as "other". A device with no evidence keeps the owner it
// had, except that withdrawing the email rule an owner came from ends that
// owner's range today. A device an admin assigned by hand (updated_by without
// "auto:", from before ownership went by email) is never overridden; the
// dashboard lists those (issues()) and turns them back to automatic
// (releaseManualOwner()).
//
// A change of owner starts today, but an employee the HR list moves to
// another unit is charged to it from the day the move took effect
// (employee_placements.effective_from: the day the list is dated, or the day
// the admin chose on importing it).
//
// Monthly imports. Every import can be previewed first (dryRun): diffImport()
// says who joined, left, moved, was renamed or changed address, which units
// came and went and which email rules the list now supersedes. An import that
// looks wrong (older than the last one, retiring a large share of the
// company, or mostly another company's addresses) waits for an admin's
// confirm. Every import is kept in org_imports.
//
// Unclassified emails. The addresses on devices that have no owner, and no rule
// yet, are what an admin classifies: to a department or team, or as other
// (unclassifiedEmails(), setEmailRule()).
//
// A device's first automatic owner covers its whole history: the range starts
// on the earliest day the device has usage for (or the day the hub first saw
// it, if that is earlier), and moves back when older history arrives later.
// The collector reads the signed-in user's own profile, so that history is the
// owner's. A first range an admin wrote is never moved.
//
// Company by domain. A device no employee matches still counts in its company
// when its addresses have a domain only that company's list uses (initech.example →
// INITECH): at company level, in the dashboard's tree and filters only. No
// ownership range is written for it, so the reports keep it unassigned.
//
// The dashboard reads the tree (tree(): unit names and device counts, never
// people) and stats for the devices under one unit (devicesUnder()).

const crypto = require('node:crypto');
const path = require('node:path');
const { AdminError, assignOwner, validDay } = require('./admin');
const { LIMITS: XLSX_LIMITS, XlsxError, findTable, readWorkbook } = require('./xlsx');
const { normalizeOwnerEmail } = require('./ingestGuard');
const { toDbTime } = require('./persistence/util');
const { LEVELS, unitTree } = require('./units');

const MAX_UNIT_ID = 255;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const CLAIM_RECONCILE_DELAY_MS = 10 * 1000;
const SOURCE_REPORTED = 'auto:reported';
const SOURCE_AI_EMAIL = 'auto:ai-email';
const SOURCE_EMAIL_RULE = 'auto:email-assigned';
// A range that reopened when an admin released a hand-made owner.
const SOURCE_RELEASED = 'auto:released';
const RECENT_DAYS = 30;
// The levels an email rule may give an address to.
const RULE_LEVELS = new Set(['department', 'team']);
// Where a department with no BU keeps its BU's place in its id.
const NO_BU = '-';
const COLUMNS = Object.freeze({
  employeeNo: ['Employee No.', 'Employee No', 'Employee ID'],
  email: ['Email Address', 'Email'],
  chineseName: ['Chinese Name'],
  englishName: ['English Name'],
  bu: ['BU', 'Business Unit'],
  department: ['Department'],
  team: ['Team']
});

function collapse(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

// Unit ids are the path of names; an absurdly long one keeps its prefix and
// ends in a hash of the whole path.
function unitId(parts) {
  const id = parts.join('/');
  if (id.length <= MAX_UNIT_ID) return id;
  return `${id.slice(0, MAX_UNIT_ID - 9)}~${crypto.createHash('sha1').update(id).digest('hex').slice(0, 8)}`;
}

// "ACME Announcement 20260801.xlsx" → "ACME".
function companyFromFileName(fileName) {
  // win32: splits on \ as well as /, so a Windows path names the file on a
  // Linux hub too.
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)/.exec(path.win32.basename(String(fileName || '')));
  return match ? match[1].toUpperCase() : '';
}

// Picks the spelling a name was written with most often (the first on a tie).
function spellingOf(tally) {
  let best = '';
  let bestCount = 0;
  for (const [spelling, count] of tally) {
    if (count > bestCount) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}

// A unit of the tally: how often each spelling of its name was written, and
// the units under it keyed by "<level>:<lower-case name>".
function tallyNode() {
  return { spellings: new Map(), children: new Map() };
}

function tallyChild(parent, level, key, spelling) {
  const childKey = `${level}:${key}`;
  if (!parent.children.has(childKey)) parent.children.set(childKey, tallyNode());
  const child = parent.children.get(childKey);
  child.spellings.set(spelling, (child.spellings.get(spelling) || 0) + 1);
  return { child, childKey };
}

// A blank cell, or HR's "-", names no unit.
function named(key) {
  return Boolean(key) && key !== '-';
}

// Whether a unit name only repeats the unit above it: a team called like its
// department, or "<department> Department"; a department called like its BU,
// or "<BU> BU".
function isOwnStaff(childKey, parentKey, word) {
  return !named(childKey) || childKey === parentKey || childKey === `${parentKey} ${word}`;
}

// The units and employees one announcement workbook lists, from rows the xlsx
// reader found. Pure: nothing is written.
function parseAnnouncement(sheets, { company }) {
  const table = findTable(sheets, [COLUMNS.employeeNo, COLUMNS.email]);
  if (!table) throw new AdminError(400, 'bad_workbook', 'no sheet has both an Employee No. and an Email Address column');
  const root = tallyNode();
  const listed = [];
  const skipped = [];
  const warnings = [];
  const ids = new Set();
  const emails = new Set();
  for (const record of table.records) {
    const employeeNo = collapse(record.get(COLUMNS.employeeNo));
    const rawEmail = collapse(record.get(COLUMNS.email));
    const chineseName = collapse(record.get(COLUMNS.chineseName));
    const englishName = collapse(record.get(COLUMNS.englishName));
    if (!employeeNo && !rawEmail && !chineseName && !englishName) continue;
    const email = normalizeOwnerEmail(rawEmail);
    if (!employeeNo || employeeNo.length > 64) {
      skipped.push({ line: record.line, reason: 'employee_no' });
      continue;
    }
    if (!email) {
      skipped.push({ line: record.line, reason: 'email' });
      continue;
    }
    if (ids.has(employeeNo) || emails.has(email)) {
      warnings.push(`line ${record.line}: ${ids.has(employeeNo) ? `employee ${employeeNo}` : 'this email'} is listed twice; the first entry is kept`);
      continue;
    }
    ids.add(employeeNo);
    emails.add(email);
    const buName = collapse(record.get(COLUMNS.bu));
    const departmentName = collapse(record.get(COLUMNS.department));
    const teamName = collapse(record.get(COLUMNS.team));
    const buKey = buName.toLowerCase();
    const departmentKey = departmentName.toLowerCase();
    const teamKey = teamName.toLowerCase();
    // The employee's chain of units below the company, as tally keys. A team
    // only counts under a department.
    const chain = [];
    let parent = root;
    const step = (level, key, spelling) => {
      const { child, childKey } = tallyChild(parent, level, key, spelling);
      chain.push(childKey);
      parent = child;
    };
    if (named(buKey)) step('bu', buKey, buName);
    if (named(departmentKey) && !(named(buKey) && isOwnStaff(departmentKey, buKey, 'bu'))) {
      step('department', departmentKey, departmentName);
      if (!isOwnStaff(teamKey, departmentKey, 'department')) step('team', teamKey, teamName);
    }
    listed.push({
      employeeId: employeeNo,
      name: [chineseName, englishName].filter(Boolean).join(' ') || email,
      email,
      chain: chain.join('\n')
    });
  }

  const units = [{ id: company, name: company, parentId: null, level: 'company' }];
  const idsByChain = new Map();
  const build = (node, parentId, names, keys) => {
    for (const [childKey, child] of node.children) {
      const level = childKey.slice(0, childKey.indexOf(':'));
      const name = spellingOf(child.spellings);
      const path = level === 'department' && names.length === 1 ? [...names, NO_BU, name] : [...names, name];
      const id = unitId(path);
      const chain = [...keys, childKey];
      idsByChain.set(chain.join('\n'), id);
      units.push({ id, name, parentId, level });
      build(child, id, path, chain);
    }
  };
  build(root, company, [company], []);
  const employees = listed.map(({ chain, ...employee }) => ({ ...employee, unitId: (chain && idsByChain.get(chain)) || company }));
  return { company, sheet: table.sheet, units, employees, skipped, warnings };
}

// The AI account addresses in a device's latest limits, normalized.
function aiEmails(record) {
  const out = new Set();
  for (const provider of record?.limits?.providers || []) {
    const email = normalizeOwnerEmail(provider?.accountEmail);
    if (email) out.add(email);
  }
  return [...out];
}

// The distinct owners among `targets` ({ employeeId, unitId }, or null),
// keyed by employee, or by unit for a unit rule's target.
function distinctTargets(targets) {
  const found = new Map();
  for (const target of targets) if (target) found.set(target.employeeId ? `e:${target.employeeId}` : `u:${target.unitId}`, target);
  return [...found.values()];
}

// The employees on the HR lists a device's addresses belong to: the reported
// address's, else every AI account's. More than one is a conflict an admin
// settles (issues()).
function listedOwners(record, claimedEmail, people) {
  if (claimedEmail && people.has(claimedEmail)) return [people.get(claimedEmail)];
  return distinctTargets(aiEmails(record).map((email) => people.get(email)));
}

// Whose the device is, from its addresses. The HR lists come first: `people`
// maps an address on them to its employee. Only an address they do not have
// is looked up in `rules`, an admin's rule ({ employeeId }, { unitId } or
// { other: true }); `staff` maps an employee no. to where they sit. Returns
// { employeeId, unitId, source }, where a unit rule's employeeId is null.
function evidenceFor(record, claimedEmail, people, rules = new Map(), staff = new Map()) {
  const listed = listedOwners(record, claimedEmail, people);
  if (listed.length === 1) {
    const source = claimedEmail && people.has(claimedEmail) ? SOURCE_REPORTED : SOURCE_AI_EMAIL;
    return { ...listed[0], source };
  }
  // Two people on the lists: no rule may pick one of them.
  if (listed.length > 1) return null;
  const ruled = (email) => {
    const rule = people.has(email) ? null : rules.get(email);
    if (!rule || rule.other) return null;
    if (rule.unitId) return { employeeId: null, unitId: rule.unitId };
    return staff.get(rule.employeeId) || null;
  };
  if (claimedEmail && ruled(claimedEmail)) return { ...ruled(claimedEmail), source: SOURCE_EMAIL_RULE };
  const byRule = distinctTargets(aiEmails(record).map(ruled));
  return byRule.length === 1 ? { ...byRule[0], source: SOURCE_EMAIL_RULE } : null;
}

// Whether any of a device's addresses still has a rule that gives it to
// someone (not "other"): while one does, an owner a rule made is kept, even
// when the employee it names has left.
function hasGivingRule(record, claimedEmail, rules) {
  return [claimedEmail, ...aiEmails(record)].some((email) => {
    const rule = email ? rules.get(email) : null;
    return Boolean(rule && !rule.other);
  });
}

// "Announcement 20260801.xlsx" → "2026-08-01", the day the list is dated.
function fileDateOf(fileName) {
  const match = /(20\d{2})(\d{2})(\d{2})(?!\d)/.exec(path.basename(String(fileName || '')));
  return match ? validDay(`${match[1]}-${match[2]}-${match[3]}`) : null;
}

// An email_assignments row as a rule: { other }, { unitId } or { employeeId }.
function ruleOf(row) {
  if (row.is_other) return { other: true };
  return row.unit_id ? { unitId: row.unit_id } : { employeeId: row.employee_id };
}

function domainOf(email) {
  const text = String(email || '');
  const at = text.lastIndexOf('@');
  return at > 0 ? text.slice(at + 1).trim().toLowerCase() : '';
}

// The company a device's addresses point at by their domain alone: the
// reported address first, else the AI accounts' domains when they agree on one
// company. `domains` maps a domain to the one company whose list uses it; an
// address an admin marked "other" (`rules`) points nowhere.
function companyFromDomains(record, claimedEmail, domains, rules = new Map()) {
  const counts = (email) => Boolean(email) && !rules.get(email)?.other;
  const claimed = counts(claimedEmail) ? domains.get(domainOf(claimedEmail)) : null;
  if (claimed) return claimed;
  const companies = new Set();
  for (const provider of record?.limits?.providers || []) {
    const email = normalizeOwnerEmail(provider?.accountEmail);
    const company = counts(email) ? domains.get(domainOf(email)) : null;
    if (company) companies.add(company);
  }
  return companies.size === 1 ? [...companies][0] : null;
}

// The kinds of change an import can make (diffImport), and those that list
// employees by their employee no.
const EMPLOYEE_CHANGE_KINDS = Object.freeze(['joined', 'departed', 'transferred', 'renamed', 'emailChanged']);
const CHANGE_KINDS = Object.freeze([...EMPLOYEE_CHANGE_KINDS, 'emailMoved', 'unitsAdded', 'unitsDeactivated', 'rulesSuperseded']);
// An import that would retire more than this share of the company's active
// employees (and at least MASS_DEPARTURE_MIN of them) is probably the wrong
// file, or the right file under the wrong company code.
const MASS_DEPARTURE_SHARE = 0.3;
const MASS_DEPARTURE_MIN = 3;
// A company's list is expected every month.
const OVERDUE_DAYS = 35;

// What importing `parsed` (parseAnnouncement()) would change, against what is
// there now. Pure: nothing is read or written.
//   employees     employee no. → { employeeId, name, email, active, companyId,
//                 unitId, effectiveFrom }, every employee of every company
//   units         unit id → { id, name, level, active }, this company's
//   rules         address → an admin's email rule
//   lastFileDate  the latest day a list of this company imported so far is dated
//   domains       email domain → the one company whose list uses it
//   seen          the addresses current devices use
// The changes, each a list (see CHANGE_KINDS), plus `unchanged` (a count) and
// `warnings`: what makes the import wait for an admin's confirmation.
//   older_file       the file is dated before the last one imported
//   mass_departure   it would retire a large share of the company
//   domain_mismatch  most of its addresses use another company's domain
function diffImport(parsed, { employees = new Map(), units = new Map(), rules = new Map(), lastFileDate = null, domains = new Map(), seen = new Set() } = {}, { fileDate = null } = {}) {
  const company = parsed.company;
  const out = Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, []]));
  out.unchanged = 0;
  const holders = new Map();
  for (const employee of employees.values()) if (employee.email) holders.set(employee.email, employee);
  const listed = new Set(parsed.employees.map((employee) => employee.employeeId));

  for (const next of parsed.employees) {
    const { employeeId, name, email, unitId } = next;
    const before = employees.get(employeeId);
    const holder = holders.get(email);
    if (holder && holder.employeeId !== employeeId) {
      out.emailMoved.push({ email, from: holder.employeeId, fromName: holder.name, to: employeeId, name });
    }
    const rule = rules.get(email);
    if (rule) out.rulesSuperseded.push({ email, employeeId, name, rule });
    if (!before || !before.active || before.companyId !== company) {
      out.joined.push({
        employeeId, name, email, unitId,
        // Back on a list after being off every one, or moved from another
        // company under the same employee no.
        returning: Boolean(before && !before.active),
        fromCompany: before?.active && before.companyId && before.companyId !== company ? before.companyId : null
      });
      continue;
    }
    let changed = false;
    if (before.unitId !== unitId) {
      out.transferred.push({ employeeId, name, email, from: before.unitId, to: unitId });
      changed = true;
    }
    if (before.name !== name) {
      out.renamed.push({ employeeId, from: before.name, to: name });
      changed = true;
    }
    if ((before.email || null) !== email) {
      out.emailChanged.push({ employeeId, name, from: before.email || null, to: email, onDevices: Boolean(before.email && seen.has(before.email)) });
      changed = true;
    }
    if (!changed) out.unchanged += 1;
  }

  const active = [...employees.values()].filter((employee) => employee.active && employee.companyId === company);
  for (const employee of active) {
    if (!listed.has(employee.employeeId)) out.departed.push({ employeeId: employee.employeeId, name: employee.name, email: employee.email, unitId: employee.unitId });
  }
  const nextUnits = new Set(parsed.units.map((unit) => unit.id));
  for (const unit of parsed.units) {
    const before = units.get(unit.id);
    if (!before || !before.active) out.unitsAdded.push({ id: unit.id, name: unit.name, level: unit.level, returning: Boolean(before) });
  }
  for (const unit of units.values()) {
    if (unit.active && !nextUnits.has(unit.id)) out.unitsDeactivated.push({ id: unit.id, name: unit.name, level: unit.level });
  }

  const warnings = [];
  if (fileDate && lastFileDate && fileDate < lastFileDate) warnings.push({ code: 'older_file', fileDate, lastFileDate });
  if (active.length && out.departed.length >= MASS_DEPARTURE_MIN && out.departed.length > active.length * MASS_DEPARTURE_SHARE) {
    warnings.push({ code: 'mass_departure', departed: out.departed.length, active: active.length });
  }
  const tally = new Map();
  for (const employee of parsed.employees) {
    const domain = domainOf(employee.email);
    if (domain) tally.set(domain, (tally.get(domain) || 0) + 1);
  }
  for (const [domain, count] of tally) {
    const owner = domains.get(domain);
    if (owner && owner !== company && count * 2 >= parsed.employees.length) warnings.push({ code: 'domain_mismatch', domain, company: owner });
  }
  return { ...out, warnings };
}

function createOrg({ store, hub, onChange = () => {}, logger = console, now = () => Date.now() } = {}) {
  const claims = new Map();
  let orgTree = unitTree([]);
  let units = orgTree.units;
  let deviceUnits = new Map();
  // Email domain → company, learned from the imported lists: a domain only
  // one company's employees use (initech.example → INITECH). A device no employee
  // matches still lands in its company this way, at company level, for the
  // dashboard's filter; no ownership range is written for it.
  let domains = new Map();
  // Address → an admin's rule: { employeeId } or { other: true }.
  let emailRules = new Map();
  let signature = '';
  let running = null;
  let lastReconcile = null;
  let claimTimer = null;
  let everyTimer = null;
  let stopped = false;

  const warn = (message) => (logger.warn || console.warn)(`[org] ${message}`);

  function today() {
    return new Date(now()).toISOString().slice(0, 10);
  }

  // Rebuilds the in-memory tree and the device → unit map from the database.
  async function refresh() {
    const unitRows = await store.query('SELECT unit_id, name, parent_unit_id, level, is_active FROM org_units ORDER BY unit_id');
    const ownerRows = await store.query('SELECT device_id, unit_id FROM device_owners WHERE valid_to IS NULL ORDER BY device_id');
    const nextTree = unitTree(unitRows);
    const nextOwners = new Map(ownerRows.map((row) => [row.device_id, row.unit_id]));
    const companiesByDomain = new Map();
    const people = await store.query(
      'SELECT e.email, p.company_id FROM employees e JOIN employee_placements p ON p.employee_id = e.employee_id WHERE e.is_active AND e.email IS NOT NULL'
    );
    for (const row of people) {
      const domain = domainOf(row.email);
      if (!domain) continue;
      if (!companiesByDomain.has(domain)) companiesByDomain.set(domain, new Set());
      companiesByDomain.get(domain).add(row.company_id);
    }
    // A domain two companies share says nothing about which one it is.
    const nextDomains = new Map([...companiesByDomain].filter(([, set]) => set.size === 1).map(([domain, set]) => [domain, [...set][0]]));
    for (const row of await store.query('SELECT device_id, email FROM device_claims')) claims.set(row.device_id, row.email);
    const ruleRows = await store.query('SELECT email, employee_id, unit_id, is_other FROM email_assignments ORDER BY email');
    const nextRules = new Map(ruleRows.map((row) => [row.email, ruleOf(row)]));
    const nextSignature = JSON.stringify([unitRows, ownerRows, ruleRows, [...nextDomains].sort(([a], [b]) => a.localeCompare(b))]);
    orgTree = nextTree;
    units = nextTree.units;
    emailRules = nextRules;
    deviceUnits = nextOwners;
    domains = nextDomains;
    if (nextSignature !== signature) {
      signature = nextSignature;
      onChange();
    }
  }

  // Where each current device counts: its owner's unit, else the company its
  // email domains point at. Worked out on each call from the live records, so
  // a device's newest limits count without waiting for a reconcile.
  function effectiveUnits() {
    const out = new Map();
    for (const record of hub.getDevices?.() || []) {
      const owner = deviceUnits.get(record.deviceId);
      if (owner) {
        out.set(record.deviceId, { unitId: owner, source: 'owner' });
        continue;
      }
      const company = companyFromDomains(record, claims.get(record.deviceId), domains, emailRules);
      if (company && units.has(company)) out.set(record.deviceId, { unitId: company, source: 'domain' });
    }
    return out;
  }

  // The current devices of a unit or any unit under it; null for a unit that
  // does not exist.
  function devicesUnder(unitIdValue) {
    if (!units.has(unitIdValue)) return null;
    const scope = orgTree.subtree(unitIdValue);
    const out = new Set();
    for (const [deviceId, { unitId: unit }] of effectiveUnits()) {
      if (scope.has(unit)) out.add(deviceId);
    }
    return out;
  }

  // What the dashboard may show anyone: unit names, their place in the tree and
  // how many devices they hold. Inactive units are left out unless a device is
  // still charged to them.
  function tree() {
    const direct = new Map();
    for (const { unitId: unit } of effectiveUnits().values()) direct.set(unit, (direct.get(unit) || 0) + 1);
    const counts = new Map();
    const countOf = (id, seen = new Set()) => {
      if (counts.has(id)) return counts.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      const unit = units.get(id);
      const total = (direct.get(id) || 0) + (unit ? unit.children.reduce((sum, child) => sum + countOf(child, seen), 0) : 0);
      counts.set(id, total);
      return total;
    };
    return [...units.values()]
      .map((unit) => ({ unit, devices: countOf(unit.id) }))
      .filter(({ unit, devices }) => unit.active || devices > 0)
      .map(({ unit, devices }) => ({
        id: unit.id,
        name: unit.name,
        parentId: unit.parentId,
        level: unit.level,
        devices
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // What the database holds now, for diffImport(): every employee with their
  // placement, this company's units, the email rules, the latest list of
  // this company imported so far, and the addresses current devices use.
  async function currentState(code) {
    const employees = new Map((await store.query(
      'SELECT e.employee_id, e.name, e.email, e.is_active, p.company_id, p.unit_id, p.effective_from FROM employees e LEFT JOIN employee_placements p ON p.employee_id = e.employee_id'
    )).map((row) => [row.employee_id, {
      employeeId: row.employee_id,
      name: row.name,
      email: row.email || null,
      active: row.is_active === true,
      companyId: row.company_id || null,
      unitId: row.unit_id || null,
      effectiveFrom: row.effective_from || null
    }]));
    const unitRows = await store.query('SELECT unit_id, name, level, is_active FROM org_units WHERE unit_id = $1 OR unit_id LIKE $2', [code, `${code}/%`]);
    const companyUnits = new Map(unitRows.map((row) => [row.unit_id, { id: row.unit_id, name: row.name, level: row.level, active: row.is_active === true }]));
    const rules = new Map((await store.query('SELECT email, employee_id, unit_id, is_other FROM email_assignments')).map((row) => [row.email, ruleOf(row)]));
    const [last] = await store.query('SELECT MAX(file_date) AS file_date FROM org_imports WHERE company_id = $1', [code]);
    const seen = new Set();
    for (const record of hub.getDevices?.() || []) {
      for (const email of [claims.get(record.deviceId), ...aiEmails(record)]) if (email) seen.add(email);
    }
    return { employees, units: companyUnits, rules, lastFileDate: last?.file_date || null, domains, seen };
  }

  // One company's HR announcement workbook, as that company's latest list.
  //   dryRun               only compare it with what is there (the preview)
  //   effectiveFrom        the day its moves take effect (default: the day in
  //                        the file name, else today; never in the future)
  //   confirm              import although diffImport() warned
  //   dropSupersededRules  delete the email rules of addresses the list has
  //   keepOldEmails        a changed address still on a device stays its
  //                        employee's, by an email rule
  async function importCompany(workbook, {
    company = '', fileName = '', effectiveFrom = '', dryRun = false, confirm = false,
    dropSupersededRules = false, keepOldEmails = false, actor = 'admin'
  } = {}) {
    const code = collapse(company) || companyFromFileName(fileName);
    if (!COMPANY_RE.test(code)) {
      throw new AdminError(400, 'bad_company', 'company must be a short code such as ACME (letters, digits and -)');
    }
    let sheets;
    try {
      sheets = readWorkbook(workbook);
    } catch (error) {
      if (error instanceof XlsxError) throw new AdminError(400, 'bad_workbook', error.message);
      throw error;
    }
    const parsed = parseAnnouncement(sheets, { company: code });
    if (!parsed.employees.length) throw new AdminError(400, 'bad_workbook', 'the workbook lists no employee with an email address');
    const fileDate = fileDateOf(fileName);
    let effective;
    if (effectiveFrom) {
      effective = validDay(effectiveFrom);
      if (!effective) throw new AdminError(400, 'bad_request', 'effectiveFrom must be YYYY-MM-DD');
      if (effective > today()) throw new AdminError(400, 'bad_request', 'effectiveFrom cannot be in the future');
    } else {
      effective = fileDate && fileDate <= today() ? fileDate : today();
    }
    const current = await currentState(code);
    const diff = diffImport(parsed, current, { fileDate });
    const counts = {
      employees: parsed.employees.length,
      bus: parsed.units.filter((unit) => unit.level === 'bu').length,
      departments: parsed.units.filter((unit) => unit.level === 'department').length,
      teams: parsed.units.filter((unit) => unit.level === 'team').length
    };
    const preview = { company: code, fileName: fileName || null, fileDate, effectiveFrom: effective, sheet: parsed.sheet, ...counts, skipped: parsed.skipped, parseWarnings: parsed.warnings, diff };
    if (dryRun) return { dryRun: true, ...preview };
    if (diff.warnings.length && !confirm) {
      throw new AdminError(409, 'needs_confirm', `this import needs confirming: ${diff.warnings.map((w) => w.code).join(', ')}`, { preview });
    }

    const stamp = toDbTime(now());
    const moves = new Set([...diff.joined, ...diff.transferred].map((employee) => employee.employeeId));
    const listedEmails = new Set(parsed.employees.map((employee) => employee.email));
    const written = await store.transaction(async (tx) => {
      const unitSql = store.upsertSql('org_units', ['unit_id', 'name', 'parent_unit_id', 'level', 'is_active', 'updated_at'], ['unit_id']);
      for (const unit of parsed.units) await tx.run(unitSql, [unit.id, unit.name, unit.parentId, unit.level, true, stamp]);
      const listedUnits = new Set(parsed.units.map((unit) => unit.id));
      let unitsDeactivated = 0;
      const known = await tx.all('SELECT unit_id FROM org_units WHERE (unit_id = $1 OR unit_id LIKE $2) AND is_active', [code, `${code}/%`]);
      for (const row of known) {
        if (listedUnits.has(row.unit_id)) continue;
        await tx.run('UPDATE org_units SET is_active = false, updated_at = $1 WHERE unit_id = $2', [stamp, row.unit_id]);
        unitsDeactivated += 1;
      }

      const moved = [];
      const employeeSql = store.upsertSql('employees', ['employee_id', 'name', 'email', 'is_active', 'updated_at'], ['employee_id']);
      const placementSql = store.upsertSql('employee_placements', ['employee_id', 'company_id', 'unit_id', 'imported_at', 'effective_from'], ['employee_id']);
      for (const employee of parsed.employees) {
        // The address now belongs to this entry (a transfer between companies
        // gets a new employee no.): the old entry gives it up and is retired.
        const holders = await tx.all('SELECT employee_id FROM employees WHERE email = $1 AND employee_id <> $2', [employee.email, employee.employeeId]);
        for (const holder of holders) {
          await tx.run('UPDATE employees SET email = NULL, is_active = false, updated_at = $1 WHERE employee_id = $2', [stamp, holder.employee_id]);
          moved.push(`${holder.employee_id} → ${employee.employeeId}`);
        }
        await tx.run(employeeSql, [employee.employeeId, employee.name, employee.email, true, stamp]);
        // Only a move takes this list's day; a placement it does not change
        // keeps the day it took effect.
        const since = moves.has(employee.employeeId) ? effective : current.employees.get(employee.employeeId)?.effectiveFrom || null;
        await tx.run(placementSql, [employee.employeeId, code, employee.unitId, stamp, since]);
      }
      const listedEmployees = new Set(parsed.employees.map((employee) => employee.employeeId));
      let employeesDeactivated = 0;
      const previous = await tx.all(
        'SELECT p.employee_id FROM employee_placements p JOIN employees e ON e.employee_id = p.employee_id WHERE p.company_id = $1 AND e.is_active',
        [code]
      );
      for (const row of previous) {
        if (listedEmployees.has(row.employee_id)) continue;
        await tx.run('UPDATE employees SET is_active = false, updated_at = $1 WHERE employee_id = $2', [stamp, row.employee_id]);
        employeesDeactivated += 1;
      }

      let rulesDropped = 0;
      if (dropSupersededRules && diff.rulesSuperseded.length) {
        const result = await tx.run('DELETE FROM email_assignments WHERE email = ANY($1)', [diff.rulesSuperseded.map((rule) => rule.email)]);
        rulesDropped = result?.changes ?? diff.rulesSuperseded.length;
      }
      let rulesKept = 0;
      if (keepOldEmails) {
        const ruleSql = store.upsertSql('email_assignments', ['email', 'employee_id', 'unit_id', 'is_other', 'note', 'updated_by', 'updated_at'], ['email']);
        for (const change of diff.emailChanged) {
          if (!change.from || !change.onDevices || listedEmails.has(change.from)) continue;
          await tx.run(ruleSql, [change.from, change.employeeId, null, false, `former address (HR import ${fileDate || effective})`, actor, stamp]);
          rulesKept += 1;
        }
      }

      const summary = {
        ...counts,
        confirmed: diff.warnings.map((warning) => warning.code),
        skipped: parsed.skipped.length,
        changes: Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, diff[kind].length])),
        employeeIds: Object.fromEntries(EMPLOYEE_CHANGE_KINDS.map((kind) => [kind, diff[kind].map((entry) => entry.employeeId)])),
        unitIds: { unitsAdded: diff.unitsAdded.map((unit) => unit.id), unitsDeactivated: diff.unitsDeactivated.map((unit) => unit.id) },
        // Each of those units' level, so the dashboard can count the ones it shows.
        unitLevels: Object.fromEntries([...diff.unitsAdded, ...diff.unitsDeactivated].map((unit) => [unit.id, unit.level])),
        rulesDropped,
        rulesKept
      };
      const [row] = await tx.all(
        'INSERT INTO org_imports (company_id, file_name, file_date, effective_from, imported_by, imported_at, summary) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING import_id',
        [code, fileName ? path.basename(String(fileName)).slice(0, 255) : null, fileDate, effective, actor, stamp, JSON.stringify(summary)]
      );
      return { unitsDeactivated, employeesDeactivated, moved, rulesDropped, rulesKept, importId: String(row.import_id) };
    });
    await refresh();
    const reconciled = await reconcile();
    return {
      ...preview,
      importId: written.importId,
      unitsDeactivated: written.unitsDeactivated,
      employeesDeactivated: written.employeesDeactivated,
      rulesDropped: written.rulesDropped,
      rulesKept: written.rulesKept,
      warnings: [...parsed.warnings, ...written.moved.map((move) => `email moved: ${move}`)],
      reconciled
    };
  }

  // Each company's latest import, and with `company` its last imports too. A
  // company whose list was last imported over OVERDUE_DAYS ago is `overdue`.
  async function importHistory({ company = '' } = {}) {
    const placed = await store.query(
      `SELECT p.company_id, u.name, MAX(p.imported_at) AS imported_at, COUNT(*) FILTER (WHERE e.is_active) AS employees
       FROM employee_placements p JOIN employees e ON e.employee_id = p.employee_id LEFT JOIN org_units u ON u.unit_id = p.company_id
       GROUP BY p.company_id, u.name ORDER BY p.company_id`
    );
    const view = (row) => row && ({
      importId: String(row.import_id),
      company: row.company_id,
      fileName: row.file_name,
      fileDate: row.file_date,
      effectiveFrom: row.effective_from,
      importedBy: row.imported_by,
      importedAt: row.imported_at,
      summary: typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary
    });
    const latest = new Map((await store.query(
      'SELECT DISTINCT ON (company_id) import_id, company_id, file_name, file_date, effective_from, imported_by, imported_at, summary FROM org_imports ORDER BY company_id, imported_at DESC, import_id DESC'
    )).map((row) => [row.company_id, view(row)]));
    const overdueBefore = new Date(now() - OVERDUE_DAYS * 86400000).toISOString();
    const imports = placed.map((row) => ({
      company: row.company_id,
      name: row.name || row.company_id,
      importedAt: row.imported_at,
      employees: Number(row.employees),
      overdue: String(row.imported_at) < overdueBefore,
      last: latest.get(row.company_id) || null
    }));
    const code = collapse(company);
    const history = code
      ? (await store.query('SELECT import_id, company_id, file_name, file_date, effective_from, imported_by, imported_at, summary FROM org_imports WHERE company_id = $1 ORDER BY imported_at DESC, import_id DESC LIMIT 24', [code])).map(view)
      : null;
    return { imports, history };
  }

  // The first day each device has anything for: the day the hub first saw it,
  // its oldest daily row, or the 1st of its oldest history month (older than
  // the daily history), whichever is earliest. The live month's total is not
  // counted: it cannot be placed on a day. `deviceIds` limits it to those
  // devices; every device by default.
  async function firstDays(deviceIds = null) {
    const out = new Map();
    const earlier = (deviceId, day) => {
      if (DAY_RE.test(day) && (!out.has(deviceId) || day < out.get(deviceId))) out.set(deviceId, day);
    };
    const params = deviceIds ? [deviceIds] : [];
    const only = (glue) => (deviceIds ? ` ${glue} device_id = ANY($1)` : '');
    for (const row of await store.query(`SELECT device_id, first_seen_at FROM devices${only('WHERE')}`, params)) earlier(row.device_id, String(row.first_seen_at || '').slice(0, 10));
    for (const row of await store.query(`SELECT device_id, MIN(usage_date) AS day FROM device_daily_usage${only('WHERE')} GROUP BY device_id`, params)) earlier(row.device_id, String(row.day || '').slice(0, 10));
    for (const row of await store.query(`SELECT device_id, MIN(usage_month) AS month FROM device_monthly_usage WHERE source = 'history'${only('AND')} GROUP BY device_id`, params)) earlier(row.device_id, `${String(row.month || '').slice(0, 7)}-01`);
    return out;
  }

  // History older than a device's first automatic range (uploaded after the
  // device was assigned) belongs to that owner too: the range starts earlier.
  async function backdateFirstOwners(earliest, firstDay, result) {
    for (const [deviceId, first] of earliest) {
      if (stopped) break;
      const start = firstDay.get(deviceId);
      if (!start || start >= first.valid_from || !String(first.updated_by).startsWith('auto:')) continue;
      try {
        await store.execute("UPDATE device_owners SET valid_from = $1 WHERE device_id = $2 AND valid_from = $3 AND updated_by LIKE 'auto:%'", [start, deviceId, first.valid_from]);
        result.backdated += 1;
      } catch (error) {
        result.errors.push({ deviceId, message: error.message });
      }
    }
  }

  // The day an owner starts. A device's first owner is charged from its first
  // day, so the history it uploaded lands in the reports too. The same
  // employee moving unit is charged to the new unit from the day their HR list
  // says the move took effect (never before the range it closes, never after
  // today); any other change starts today.
  function changeDay(last, open, evidence, firstDay) {
    if (!last) return firstDay || today();
    const moved = open && evidence.employeeId && open.employee_id === evidence.employeeId && evidence.effectiveFrom;
    if (!moved) return today();
    const from = evidence.effectiveFrom < last.valid_from ? last.valid_from : evidence.effectiveFrom;
    return from > today() ? today() : from;
  }

  async function runReconcile() {
    const people = new Map();
    const staff = new Map();
    const rows = await store.query(
      'SELECT e.employee_id, e.email, p.unit_id, p.effective_from FROM employees e JOIN employee_placements p ON p.employee_id = e.employee_id WHERE e.is_active'
    );
    for (const row of rows) {
      const person = { employeeId: row.employee_id, unitId: row.unit_id, effectiveFrom: row.effective_from ? String(row.effective_from).slice(0, 10) : null };
      staff.set(row.employee_id, person);
      if (row.email) people.set(String(row.email).toLowerCase(), person);
    }
    const rules = new Map((await store.query('SELECT email, employee_id, unit_id, is_other FROM email_assignments')).map((row) => [row.email, ruleOf(row)]));
    for (const row of await store.query('SELECT device_id, email FROM device_claims')) claims.set(row.device_id, row.email);
    const latest = new Map();
    const earliest = new Map();
    for (const row of await store.query('SELECT device_id, valid_from, valid_to, employee_id, unit_id, updated_by FROM device_owners ORDER BY device_id, valid_from')) {
      latest.set(row.device_id, row);
      if (!earliest.has(row.device_id)) earliest.set(row.device_id, row);
    }
    const firstDay = await firstDays();

    const result = { devices: 0, assigned: 0, changed: 0, unchanged: 0, manual: 0, unmatched: 0, companyOnly: 0, withdrawn: 0, backdated: 0, errors: [] };
    for (const record of hub.getDevices?.() || []) {
      if (stopped) break;
      result.devices += 1;
      const deviceId = record.deviceId;
      const last = latest.get(deviceId);
      const open = last && last.valid_to === null ? last : null;
      if (open && !String(open.updated_by).startsWith('auto:')) {
        result.manual += 1;
        continue;
      }
      const evidence = evidenceFor(record, claims.get(deviceId), people, rules, staff);
      if (!evidence && open && open.updated_by === SOURCE_EMAIL_RULE && !hasGivingRule(record, claims.get(deviceId), rules)) {
        // The rule this owner came from is gone: the owner's days end today.
        // One that names an employee who has left keeps its owner.
        try {
          const outcome = await store.transaction(async (tx) => {
            const [current] = await tx.all('SELECT valid_from, valid_to, updated_by FROM device_owners WHERE device_id = $1 ORDER BY valid_from DESC LIMIT 1', [deviceId]);
            if (!current || current.valid_to !== null || current.updated_by !== SOURCE_EMAIL_RULE) return 'unchanged';
            await tx.run('UPDATE device_owners SET valid_to = GREATEST($1::date, valid_from), updated_at = $2 WHERE device_id = $3 AND valid_from = $4', [today(), toDbTime(now()), deviceId, current.valid_from]);
            return 'withdrawn';
          });
          result[outcome] += 1;
        } catch (error) {
          result.errors.push({ deviceId, message: error.message });
        }
        continue;
      }
      if (!evidence) {
        result.unmatched += 1;
        // No employee, but the domain still says which company it belongs to.
        if (!open && companyFromDomains(record, claims.get(deviceId), domains, rules)) result.companyOnly += 1;
        continue;
      }
      if (open && (open.employee_id ?? null) === evidence.employeeId && open.unit_id === evidence.unitId) {
        result.unchanged += 1;
        continue;
      }
      const validFrom = changeDay(last, open, evidence, firstDay.get(deviceId));
      try {
        const outcome = await store.transaction(async (tx) => {
          // Checked again inside the write: an admin may have just assigned it.
          const [current] = await tx.all('SELECT updated_by, valid_to FROM device_owners WHERE device_id = $1 ORDER BY valid_from DESC LIMIT 1', [deviceId]);
          if (current && current.valid_to === null && !String(current.updated_by).startsWith('auto:')) return 'manual';
          await assignOwner(tx, { deviceId, employeeId: evidence.employeeId, unitId: evidence.unitId, validFrom }, evidence.source, now);
          return open ? 'changed' : 'assigned';
        });
        result[outcome] += 1;
      } catch (error) {
        result.errors.push({ deviceId, message: error.message });
      }
    }
    await backdateFirstOwners(earliest, firstDay, result);
    await refresh();
    lastReconcile = { at: new Date(now()).toISOString(), ...result, errors: result.errors.length };
    if (result.errors.length) warn(`${result.errors.length} device(s) could not be assigned: ${result.errors[0].message}`);
    return result;
  }

  // An admin's rule for an address the HR lists do not have (Excel comes
  // first: an address on a list is that employee's, and gets no rule):
  //   { unitId }      its devices count in that department or team, with no
  //                   employee (a contractor, a shared account)
  //   { employeeId }  its devices are that employee's (active, placed by an HR
  //                   import): a personal account, a former address
  //   { other: true } nobody's: its devices count as "other"
  // Applied by a reconcile right away.
  async function setEmailRule(address, { employeeId = '', unitId = '', other = false, note = '' } = {}, actor = 'admin') {
    const email = normalizeOwnerEmail(address);
    if (!email) throw new AdminError(400, 'bad_email', 'not an email address');
    const employee = String(employeeId || '').trim();
    const unit = String(unitId || '').trim();
    if ([Boolean(employee), Boolean(unit), Boolean(other)].filter(Boolean).length !== 1) {
      throw new AdminError(400, 'bad_request', 'give one of unitId, employeeId or other: true');
    }
    const [holder] = await store.query('SELECT employee_id, name FROM employees WHERE email = $1 AND is_active', [email]);
    if (holder) {
      throw new AdminError(409, 'listed_in_hr', `${email} is on the HR list as ${holder.employee_id}: the HR list decides whose it is`);
    }
    if (employee) {
      const [row] = await store.query(
        'SELECT e.employee_id FROM employees e JOIN employee_placements p ON p.employee_id = e.employee_id WHERE e.employee_id = $1 AND e.is_active',
        [employee]
      );
      if (!row) throw new AdminError(400, 'unknown_employee', `employee ${employee} is not an active employee from an HR import`);
    }
    if (unit) {
      const [row] = await store.query('SELECT level, is_active FROM org_units WHERE unit_id = $1', [unit]);
      if (!row || !row.is_active) throw new AdminError(400, 'unknown_unit', `unit ${unit} is not an active unit from an HR import`);
      if (!RULE_LEVELS.has(row.level)) throw new AdminError(400, 'bad_unit', `an address can be given to a department or a team, not a ${row.level}`);
    }
    await store.execute(
      store.upsertSql('email_assignments', ['email', 'employee_id', 'unit_id', 'is_other', 'note', 'updated_by', 'updated_at'], ['email']),
      [email, employee || null, unit || null, Boolean(other), String(note || '').trim().slice(0, 255) || null, actor, toDbTime(now())]
    );
    await refresh();
    return { email, employeeId: employee || null, unitId: unit || null, other: Boolean(other), reconciled: await reconcile() };
  }

  async function removeEmailRule(address) {
    const email = normalizeOwnerEmail(address);
    if (!email) throw new AdminError(400, 'bad_email', 'not an email address');
    const { changes } = await store.execute('DELETE FROM email_assignments WHERE email = $1', [email]);
    if (!changes) throw new AdminError(404, 'not_found', `no rule for ${email}`);
    await refresh();
    return { email, reconciled: await reconcile() };
  }

  // The rules an admin wrote, each with what is wrong with it now, if
  // anything (`problem`): 'superseded' (the address is on an HR list now, which
  // decides instead), 'departed' (its employee left), 'unit_inactive' (its
  // unit is no longer on any list).
  async function emailRuleList() {
    const rows = await store.query(
      `SELECT a.email, a.employee_id, e.name AS employee_name, e.is_active AS employee_active,
              a.unit_id, u.name AS unit_name, u.is_active AS unit_active,
              a.is_other, a.note, a.updated_by, a.updated_at, h.employee_id AS listed_as
       FROM email_assignments a
       LEFT JOIN employees e ON e.employee_id = a.employee_id
       LEFT JOIN org_units u ON u.unit_id = a.unit_id
       LEFT JOIN employees h ON h.email = a.email AND h.is_active
       ORDER BY a.email`
    );
    return rows.map((row) => ({
      email: row.email,
      employeeId: row.employee_id,
      employeeName: row.employee_name || null,
      unitId: row.unit_id || null,
      unitName: row.unit_name || null,
      unitPath: row.unit_id && units.has(row.unit_id) ? orgTree.pathOf(row.unit_id) : null,
      other: row.is_other,
      note: row.note,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      problem: row.listed_as ? 'superseded'
        : row.employee_id && !row.employee_active ? 'departed'
          : row.unit_id && !row.unit_active ? 'unit_inactive'
            : null
    }));
  }

  // The active employees on the HR lists, by address and by employee no., the
  // way the reconcile sees them.
  async function roster() {
    const people = new Map();
    const staff = new Map();
    const rows = await store.query(
      'SELECT e.employee_id, e.name, e.email, p.unit_id FROM employees e JOIN employee_placements p ON p.employee_id = e.employee_id WHERE e.is_active'
    );
    for (const row of rows) {
      const person = { employeeId: row.employee_id, name: row.name, email: row.email, unitId: row.unit_id };
      staff.set(row.employee_id, person);
      if (row.email) people.set(String(row.email).toLowerCase(), person);
    }
    return { people, staff };
  }

  // The addresses an admin still has to classify: on current devices that have
  // no owner, and with no rule yet. With each, its devices, when they last
  // reported, their usage over the last 30 days, the employee on the HR list
  // with that address, and why it is here (`reason`):
  //   not_in_hr  no list has it: give it to a department or team, or other
  //   conflict   it is on a list, but the device's addresses name more than
  //              one employee (settled on the device's side)
  //   departed   it belonged to someone who is on no list any more
  async function unclassifiedEmails() {
    const { people } = await roster();
    const byEmail = new Map();
    const conflicted = new Set();
    for (const record of hub.getDevices?.() || []) {
      if (deviceUnits.has(record.deviceId)) continue;
      const addresses = new Set([claims.get(record.deviceId), ...aiEmails(record)].filter(Boolean));
      if (listedOwners(record, claims.get(record.deviceId), people).length > 1) conflicted.add(record.deviceId);
      for (const email of addresses) {
        if (emailRules.has(email) && !people.has(email)) continue;
        if (!byEmail.has(email)) byEmail.set(email, []);
        byEmail.get(email).push({ deviceId: record.deviceId, hostname: record.hostname || null, lastSeenAt: record.receivedAt || null });
      }
    }
    const deviceIds = [...new Set([...byEmail.values()].flat().map((device) => device.deviceId))];
    const recent = await recentUsageByDevice(deviceIds);
    const former = new Map(byEmail.size
      ? (await store.query('SELECT employee_id, name, email FROM employees WHERE email = ANY($1) AND NOT is_active', [[...byEmail.keys()]])).map((row) => [row.email, row])
      : []);
    return [...byEmail].map(([email, devices]) => {
      const listed = people.get(email);
      const reason = listed ? 'conflict' : former.has(email) ? 'departed' : 'not_in_hr';
      return {
        email,
        reason,
        devices: devices.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))),
        lastSeenAt: devices.reduce((latest, device) => (String(device.lastSeenAt) > String(latest) ? device.lastSeenAt : latest), null),
        recentTokens: devices.reduce((sum, device) => sum + Number(recent.get(device.deviceId)?.tokens || 0), 0),
        recentCostUsd: Number(devices.reduce((sum, device) => sum + Number(recent.get(device.deviceId)?.cost_usd || 0), 0).toFixed(6)),
        employee: listed ? { id: listed.employeeId, name: listed.name } : former.has(email) ? { id: former.get(email).employee_id, name: former.get(email).name, active: false } : null,
        company: domains.get(domainOf(email)) || null
      };
    })
      // A listed address on a device with no conflict is merely waiting for the
      // next reconcile; it is not the admin's to classify.
      .filter((row) => row.reason !== 'conflict' || row.devices.some((device) => conflicted.has(device.deviceId)))
      .sort((a, b) => b.recentTokens - a.recentTokens || a.email.localeCompare(b.email));
  }

  function since(days) {
    return new Date(now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  }

  async function recentUsageByDevice(deviceIds) {
    if (!deviceIds.length) return new Map();
    const rows = await store.query('SELECT device_id, SUM(tokens) AS tokens, SUM(cost_usd) AS cost_usd FROM device_daily_usage WHERE device_id = ANY($1) AND usage_date >= $2 GROUP BY device_id', [deviceIds, since(RECENT_DAYS)]);
    return new Map(rows.map((row) => [row.device_id, row]));
  }

  // What an admin should look at after an import or now and then (admin
  // only; names and addresses included):
  //   conflicts      unowned devices whose addresses name several employees
  //   departed       devices still reporting, owned by someone no list has any
  //                  more (their history stays theirs; reassign by email)
  //   rules          email rules that are superseded, or name someone who left
  //                  or a unit no list has any more
  //   manualOwners   devices an admin assigned by hand before ownership went by
  //                  email: kept until turned back to automatic
  async function issues() {
    const { people } = await roster();
    const devices = new Map((hub.getDevices?.() || []).map((record) => [record.deviceId, record]));
    const describe = (person) => ({ employeeId: person.employeeId, name: person.name, email: person.email, unitId: person.unitId });
    const conflicts = [];
    for (const record of devices.values()) {
      if (deviceUnits.has(record.deviceId)) continue;
      const owners = listedOwners(record, claims.get(record.deviceId), people);
      if (owners.length > 1) conflicts.push({ deviceId: record.deviceId, hostname: record.hostname || null, lastSeenAt: record.receivedAt || null, employees: owners.map(describe) });
    }
    // Settling a conflict gives the device an owner from its first day, as an
    // automatic first owner would have been.
    const first = conflicts.length ? await firstDays(conflicts.map((conflict) => conflict.deviceId)) : new Map();
    for (const conflict of conflicts) conflict.firstDay = first.get(conflict.deviceId) || null;
    const open = await store.query(
      `SELECT o.device_id, o.valid_from, o.employee_id, e.name AS employee_name, e.is_active, o.unit_id, o.updated_by, o.updated_at
       FROM device_owners o LEFT JOIN employees e ON e.employee_id = o.employee_id
       WHERE o.valid_to IS NULL ORDER BY o.device_id`
    );
    const recentSince = `${since(RECENT_DAYS)}T00:00:00.000Z`;
    const row = (owner) => ({
      deviceId: owner.device_id,
      hostname: devices.get(owner.device_id)?.hostname || null,
      lastSeenAt: devices.get(owner.device_id)?.receivedAt || null,
      employeeId: owner.employee_id,
      name: owner.employee_name || null,
      unitId: owner.unit_id,
      unitPath: units.has(owner.unit_id) ? orgTree.pathOf(owner.unit_id) : null,
      validFrom: owner.valid_from,
      updatedBy: owner.updated_by
    });
    const departed = open
      .filter((owner) => owner.employee_id && owner.is_active === false && devices.has(owner.device_id))
      .filter((owner) => String(devices.get(owner.device_id).receivedAt || '') >= recentSince)
      .map(row);
    const manualOwners = open.filter((owner) => !String(owner.updated_by).startsWith('auto:')).map(row);
    const rules = (await emailRuleList()).filter((rule) => rule.problem);
    return { conflicts, departed, rules, manualOwners };
  }

  // Turns a device an admin assigned by hand back to automatic: the hand-made
  // range is removed (the one before it reopens) and the reconcile decides
  // again from the device's addresses.
  async function releaseManualOwner(deviceId) {
    const id = String(deviceId || '').trim();
    await store.transaction(async (tx) => {
      const [latest] = await tx.all('SELECT valid_from, valid_to, updated_by FROM device_owners WHERE device_id = $1 ORDER BY valid_from DESC LIMIT 1', [id]);
      if (!latest || latest.valid_to !== null || String(latest.updated_by).startsWith('auto:')) {
        throw new AdminError(409, 'not_manual', `device ${id} has no hand-made owner to release`);
      }
      await tx.run('DELETE FROM device_owners WHERE device_id = $1 AND valid_from = $2', [id, latest.valid_from]);
      // The range before reopens as automatic: closing it for the hand-made
      // owner stamped the admin on it, and the reconcile must be free to
      // decide again.
      await tx.run('UPDATE device_owners SET valid_to = NULL, updated_by = $1, updated_at = $2 WHERE device_id = $3 AND valid_to = $4', [SOURCE_RELEASED, toDbTime(now()), id, latest.valid_from]);
    });
    await refresh();
    return { deviceId: id, reconciled: await reconcile() };
  }

  // Every unit, with its active headcount (its own and under it), its devices
  // and its usage over the last 30 days as the ownership ranges charged it.
  async function unitStats() {
    const direct = new Map();
    for (const { unitId: unit } of effectiveUnits().values()) direct.set(unit, (direct.get(unit) || 0) + 1);
    const heads = new Map((await store.query(
      'SELECT p.unit_id, COUNT(*) AS n FROM employee_placements p JOIN employees e ON e.employee_id = p.employee_id WHERE e.is_active GROUP BY p.unit_id'
    )).map((r) => [r.unit_id, Number(r.n)]));
    const usageRows = await store.query(
      'SELECT unit_id, SUM(tokens) AS tokens, SUM(cost_usd) AS cost_usd FROM v_daily_usage_by_owner WHERE usage_date >= $1 AND unit_id IS NOT NULL GROUP BY unit_id',
      [since(RECENT_DAYS)]
    );
    const usage = new Map(usageRows.map((r) => [r.unit_id, { tokens: Number(r.tokens || 0), costUsd: Number(r.cost_usd || 0) }]));
    const sum = (id, pick) => [...orgTree.subtree(id)].reduce((total, unit) => total + pick(unit), 0);
    return [...units.values()].map((unit) => ({
      id: unit.id,
      name: unit.name,
      level: unit.level,
      parentId: unit.parentId,
      path: orgTree.pathOf(unit.id),
      active: unit.active,
      ownHeadcount: heads.get(unit.id) || 0,
      headcount: sum(unit.id, (id) => heads.get(id) || 0),
      devices: sum(unit.id, (id) => direct.get(id) || 0),
      recentTokens: sum(unit.id, (id) => usage.get(id)?.tokens || 0),
      recentCostUsd: Number(sum(unit.id, (id) => usage.get(id)?.costUsd || 0).toFixed(6))
    })).sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
  }

  // Every employee the HR lists ever had, with where they sit, since when,
  // the devices charged to them now and their usage over the last 30 days.
  async function employeeList() {
    const rows = await store.query(
      `SELECT e.employee_id, e.name, e.email, e.is_active, e.updated_at, p.company_id, p.unit_id, p.effective_from, p.imported_at
       FROM employees e LEFT JOIN employee_placements p ON p.employee_id = e.employee_id
       ORDER BY e.employee_id`
    );
    const devices = new Map((await store.query(
      'SELECT employee_id, COUNT(*) AS n FROM device_owners WHERE valid_to IS NULL AND employee_id IS NOT NULL GROUP BY employee_id'
    )).map((r) => [r.employee_id, Number(r.n)]));
    const usage = new Map((await store.query(
      'SELECT employee_id, SUM(tokens) AS tokens, SUM(cost_usd) AS cost_usd FROM v_daily_usage_by_owner WHERE usage_date >= $1 AND employee_id IS NOT NULL GROUP BY employee_id',
      [since(RECENT_DAYS)]
    )).map((r) => [r.employee_id, r]));
    return rows.map((row) => ({
      employeeId: row.employee_id,
      name: row.name,
      email: row.email,
      active: row.is_active === true,
      updatedAt: row.updated_at,
      companyId: row.company_id || null,
      unitId: row.unit_id || null,
      unitPath: row.unit_id && units.has(row.unit_id) ? orgTree.pathOf(row.unit_id) : null,
      effectiveFrom: row.effective_from || null,
      importedAt: row.imported_at || null,
      devices: devices.get(row.employee_id) || 0,
      recentTokens: Number(usage.get(row.employee_id)?.tokens || 0),
      recentCostUsd: Number(Number(usage.get(row.employee_id)?.cost_usd || 0).toFixed(6))
    }));
  }

  // One run at a time; a caller during a run gets that run's result.
  function reconcile() {
    if (!running) running = runReconcile().finally(() => { running = null; });
    return running;
  }

  function background() {
    reconcile().catch((error) => warn(`reconcile failed: ${error.message}`));
  }

  // A client reported (or changed) its user's company email: remember it and
  // assign the device shortly, batching a burst of first uploads into one run.
  function recordClaim(deviceId, email) {
    if (stopped || !deviceId || !email || claims.get(deviceId) === email) return;
    claims.set(deviceId, email);
    store.execute(store.upsertSql('device_claims', ['device_id', 'email', 'reported_at'], ['device_id']), [deviceId, email, toDbTime(now())])
      .then(() => {
        if (claimTimer || stopped) return;
        claimTimer = setTimeout(() => {
          claimTimer = null;
          background();
        }, CLAIM_RECONCILE_DELAY_MS);
        claimTimer.unref?.();
      })
      .catch((error) => {
        claims.delete(deviceId);
        warn(`could not store the email reported by ${deviceId}: ${error.message}`);
      });
  }

  async function start() {
    await refresh();
    background();
    everyTimer = setInterval(background, RECONCILE_EVERY_MS);
    everyTimer.unref?.();
  }

  return {
    maxWorkbookBytes: XLSX_LIMITS.maxBytes,
    start,
    refresh,
    reconcile,
    recordClaim,
    importCompany,
    importHistory,
    setEmailRule,
    removeEmailRule,
    emailRuleList,
    unclassifiedEmails,
    issues,
    releaseManualOwner,
    unitStats,
    employeeList,
    tree,
    has: (id) => units.has(id),
    devicesUnder,
    // Where each device counts and why (usage.js).
    devices() {
      return [...effectiveUnits()].map(([deviceId, place]) => ({ deviceId, ...place }));
    },
    // Admin only (/api/admin/org/devices): every current device, where it
    // counts and why (unitId and source null when nowhere below "every
    // company"), and its first day: where a first owner starts, as reconcile
    // would start one, so the owner form can offer it.
    async placements() {
      const places = effectiveUnits();
      const ids = (hub.getDevices?.() || []).map((record) => record.deviceId);
      const first = ids.length ? await firstDays(ids) : new Map();
      return ids.map((deviceId) => ({
        deviceId,
        unitId: places.get(deviceId)?.unitId ?? null,
        source: places.get(deviceId)?.source ?? null,
        firstDay: first.get(deviceId) || null
      }));
    },
    status() {
      return { units: units.size, ownedDevices: deviceUnits.size, claims: claims.size, domains: domains.size, emailRules: emailRules.size, lastReconcile };
    },
    async stop() {
      stopped = true;
      clearInterval(everyTimer);
      clearTimeout(claimTimer);
      await running?.catch(() => {});
    }
  };
}

module.exports = {
  CHANGE_KINDS, LEVELS, NO_BU, SOURCE_AI_EMAIL, SOURCE_EMAIL_RULE, SOURCE_REPORTED,
  companyFromDomains, companyFromFileName, createOrg, diffImport, domainOf, evidenceFor, fileDateOf, parseAnnouncement, unitId
};
