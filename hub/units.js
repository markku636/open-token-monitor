'use strict';

// The company org charts as the hub holds them (org_units): one tree per
// company, company → BU → department → team, where a level HR left empty is
// skipped (a department with no BU sits right under its company). Everything
// that compares units at one level asks the tree the same question: which unit
// of that level a unit is in, if any. A unit with none there counts as
// "other" at that level.
//
// The tree keeps every level HR fills in, but the dashboard shows two: company
// and department. A BU is not shown, and a team counts in its department.

const LEVELS = Object.freeze(['company', 'bu', 'department', 'team']);
// The levels units are shown and compared at.
const SHOWN_LEVELS = Object.freeze(['company', 'department']);

function levelIndex(level) {
  return LEVELS.indexOf(level);
}

// The level below `level`, or null under a team.
function levelBelow(level) {
  return LEVELS[levelIndex(level) + 1] || null;
}

// rows: org_units rows (unit_id, name, parent_unit_id, level, is_active).
function unitTree(rows) {
  const units = new Map(rows.map((row) => [row.unit_id, {
    id: row.unit_id,
    name: row.name,
    parentId: row.parent_unit_id || null,
    level: row.level,
    active: row.is_active === true,
    children: []
  }]));
  for (const unit of units.values()) {
    if (unit.parentId && unit.parentId !== unit.id && units.has(unit.parentId)) units.get(unit.parentId).children.push(unit.id);
    else unit.parentId = null;
  }

  const chains = new Map();
  // The unit first, its company last; a cycle ends the chain where it repeats.
  function chainOf(id) {
    if (chains.has(id)) return chains.get(id);
    const chain = [];
    const seen = new Set();
    for (let unit = units.get(id); unit && !seen.has(unit.id); unit = units.get(unit.parentId)) {
      seen.add(unit.id);
      chain.push(unit.id);
    }
    chains.set(id, chain);
    return chain;
  }

  // The unit of `level` that `id` is (or is under), or null.
  function ancestorAt(id, level) {
    for (const unitId of chainOf(id)) if (units.get(unitId).level === level) return unitId;
    return null;
  }

  // Whether `id` is `scopeId` or under it.
  function within(id, scopeId) {
    return chainOf(id).includes(scopeId);
  }

  function pathOf(id) {
    return chainOf(id).slice().reverse().map((unitId) => units.get(unitId).name);
  }

  // The unit `id` is shown as: its department, or its company when it is in
  // no department.
  function shownOf(id) {
    if (!units.has(id)) return null;
    return ancestorAt(id, 'department') || ancestorAt(id, 'company') || id;
  }

  // The names of the shown units from the company down to `id`'s shown unit.
  function shownPathOf(id) {
    const shown = shownOf(id);
    if (!shown) return [];
    return chainOf(shown).slice().reverse().filter((unitId) => SHOWN_LEVELS.includes(units.get(unitId).level)).map((unitId) => units.get(unitId).name);
  }

  // `id` and every unit under it.
  function subtree(id) {
    const out = new Set();
    const stack = [id];
    while (stack.length) {
      const next = stack.pop();
      if (out.has(next) || !units.has(next)) continue;
      out.add(next);
      stack.push(...units.get(next).children);
    }
    return out;
  }

  return { units, chainOf, ancestorAt, within, pathOf, shownOf, shownPathOf, subtree };
}

module.exports = { LEVELS, SHOWN_LEVELS, levelBelow, levelIndex, unitTree };
