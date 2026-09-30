// Path-based state diff and three-way merge with explicit conflict detection.
import { deepEqual, deepClone } from './util.js';
import { migrateStateToSchema } from './schema.js';

const SENTINEL = Symbol('missing');

// Flatten a state to ordered [path, value] pairs. Paths:
//   basic.name                     (single group)
//   experience[row_abc].company    (repeatable row)
//   <removed>.basic.fields.bio     (parked values are first-class data)
export function flattenState(state, schema = null) {
  const out = [];

  const pushScalar = (path, value) => {
    if (value === undefined) return;
    if (value !== null && typeof value === 'object') {
      out.push([path, deepClone(value)]);
    } else {
      out.push([path, value]);
    }
  };

  const groups = state.groups || {};
  for (const [groupId, data] of Object.entries(groups)) {
    if (Array.isArray(data)) {
      for (const row of data) {
        const label = row.__rowId || 'row';
        for (const [key, value] of Object.entries(row)) {
          if (key === '__rowId' || key === '__deleted') continue;
          pushScalar(`${groupId}[${label}].${key}`, value);
        }
        if (row.__deleted) out.push([`${groupId}[${label}].__deleted`, true]);
      }
    } else if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (key === '__rowId' || key === '__deleted') continue;
        pushScalar(`${groupId}.${key}`, value);
      }
    }
  }

  // Parked removed fields / deleted rows — compare them too so compression and
  // rollback can never hide data movement.
  const removed = state.removed || {};
  const walkRemoved = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'at') continue;
      const next = `${path}.${key}`;
      if (key === 'fields' || key === 'rows') {
        walkRemoved(value, next);
      } else if (value && typeof value === 'object' && ('value' in value)) {
        pushScalar(`${next}.value`, value.value);
        if (value.type) out.push([`${next}.type`, value.type]);
      } else if (Array.isArray(value) || typeof value === 'object') {
        walkRemoved(value, next);
      } else {
        pushScalar(next, value);
      }
    }
  };
  walkRemoved(removed, '<removed>');

  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

export function toValueMap(state, schema) {
  return new Map(flattenState(state, schema).map(([p, v]) => [p, v]));
}

// Compare two states that already share a schema.
// Returns added / removed / changed entries plus row-level structure events.
export function diffStates(baseState, otherState, options = {}) {
  const a = toValueMap(baseState, options.schemaA || null);
  const b = toValueMap(otherState, options.schemaB || null);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [path, value] of b) {
    if (!a.has(path)) {
      added.push({ path, value });
    } else if (!deepEqual(a.get(path), value)) {
      changed.push({ path, oldValue: a.get(path), newValue: value });
    }
  }
  for (const [path, value] of a) {
    if (!b.has(path)) removed.push({ path, value });
  }
  return { added, removed, changed, total: added.length + removed.length + changed.length };
}

function valuesCompatible(base, side) {
  return typeof base === typeof side || (base === null || side === null);
}

// Three-way merge: base = LCA snapshot state, ours = current draft state,
// theirs = rollback target state. All three must already be on the same schema
// (the caller migrates first).
//
// Conflict rule: a path changed on BOTH sides and the two new values differ.
// Add/add with different values also conflicts. Delete-vs-modify conflicts.
export function threeWayMerge({ base, ours, theirs, schema = null }) {
  const baseMap = toValueMap(base, schema);
  const oursMap = toValueMap(ours, schema);
  const theirsMap = toValueMap(theirs, schema);
  const paths = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  const conflicts = [];
  const autoMerged = [];
  const resultMap = new Map();

  for (const path of paths) {
    const b = baseMap.has(path) ? baseMap.get(path) : SENTINEL;
    const o = oursMap.has(path) ? oursMap.get(path) : SENTINEL;
    const t = theirsMap.has(path) ? theirsMap.get(path) : SENTINEL;
    const changedO = !sameValue(b, o);
    const changedT = !sameValue(b, t);

    if (!changedO && !changedT) {
      if (o !== SENTINEL) resultMap.set(path, deepClone(o));
      continue;
    }
    if (changedO && !changedT) {
      if (o !== SENTINEL) resultMap.set(path, deepClone(o));
      autoMerged.push({ path, action: 'keep-ours' });
      continue;
    }
    if (!changedO && changedT) {
      if (t !== SENTINEL) resultMap.set(path, deepClone(t));
      autoMerged.push({ path, action: 'take-theirs' });
      continue;
    }
    // Both sides changed.
    if (sameValue(o, t)) {
      if (o !== SENTINEL) resultMap.set(path, deepClone(o));
      autoMerged.push({ path, action: 'identical-edits' });
      continue;
    }

    let kind = 'edit-edit';
    if (o === SENTINEL || t === SENTINEL) kind = 'delete-modify';
    else if (b === SENTINEL) kind = 'add-add';
    else if (!valuesCompatible(o, t)) kind = 'type-mismatch';

    conflicts.push({
      path,
      kind,
      base: b === SENTINEL ? SENTINEL : deepClone(b),
      ours: o === SENTINEL ? SENTINEL : deepClone(o),
      theirs: t === SENTINEL ? SENTINEL : deepClone(t),
      resolution: null, // 'ours' | 'theirs' | { custom }
    });
  }

  const merged = unflatten(resultMap, base, ours, theirs);
  return { merged, conflicts, autoMerged, hasConflicts: conflicts.length > 0 };
}

function sameValue(a, b) {
  if (a === SENTINEL || b === SENTINEL) return a === b;
  return deepEqual(a, b);
}

// Rebuild a state object from the flat merge result. Non-flattened metadata
// (typeChanges etc.) is merged conservatively from ours + theirs.
function unflatten(map, base, ours, theirs) {
  const result = {
    stateVersion: ours.stateVersion ?? theirs.stateVersion ?? base.stateVersion,
    schemaVersion: ours.schemaVersion ?? theirs.schemaVersion ?? base.schemaVersion,
    groups: {},
    removed: mergeObjects(ours.removed, theirs.removed, base.removed),
    typeChanges: mergeArrays(ours.typeChanges, theirs.typeChanges),
  };

  const rowData = new Map(); // groupId -> Map(rowId -> object)
  for (const [path, value] of map) {
    if (path.startsWith('<removed>')) continue; // already merged into removed
    const m = path.match(/^([^.[\]]+)(?:\[([^\]]+)\])?\.(.+)$/);
    if (!m) continue;
    const [, groupId, rowId, key] = m;
    const sourceRows = Array.isArray(ours.groups[groupId]) ? ours.groups[groupId]
      : Array.isArray(theirs.groups[groupId]) ? theirs.groups[groupId] : null;
    if (rowId) {
      if (!rowData.has(groupId)) rowData.set(groupId, new Map());
      const rows = rowData.get(groupId);
      if (!rows.has(rowId)) rows.set(rowId, { __rowId: rowId });
      if (key === '__deleted') rows.get(rowId).__deleted = value;
      else rows.get(rowId)[key] = deepClone(value);
    } else {
      if (!rowData.has(groupId)) rowData.set(groupId, null);
      const sourceSingle = ours.groups[groupId] && !Array.isArray(ours.groups[groupId])
        ? ours.groups[groupId]
        : theirs.groups[groupId] && !Array.isArray(theirs.groups[groupId])
          ? theirs.groups[groupId] : { __rowId: `row_${groupId}` };
      const existing = result.groups[groupId] || { __rowId: sourceSingle.__rowId || `row_${groupId}` };
      if (key !== '__deleted') existing[key] = deepClone(value);
      result.groups[groupId] = existing;
    }
  }
  for (const [groupId, rows] of rowData) {
    if (rows instanceof Map) {
      const orderSource = Array.isArray(ours.groups[groupId]) ? ours.groups[groupId] : theirs.groups[groupId] || [];
      const ordered = [];
      for (const row of orderSource) {
        if (rows.has(row.__rowId)) { ordered.push(rows.get(row.__rowId)); rows.delete(row.__rowId); }
      }
      for (const row of rows.values()) ordered.push(row);
      result.groups[groupId] = ordered;
    }
  }
  return result;
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], value);
    } else if (!(key in target)) {
      target[key] = deepClone(value);
    }
  }
  return target;
}

function mergeObjects(a, b, base) {
  return deepMerge(deepMerge(deepClone(base || {}), b || {}), a || {});
}
function mergeArrays(a, b) {
  const seen = new Set();
  const out = [];
  for (const item of [...(a || []), ...(b || [])]) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); out.push(deepClone(item)); }
  }
  return out;
}

// Apply the user's per-conflict decisions and produce the final state.
export function resolveConflicts(merge, resolutions) {
  if (!merge.hasConflicts && resolutions.length === 0) return merge.merged;
  const merged = deepClone(merge.merged);
  const flat = new Map(flattenState(merged).map(([p, v]) => [p, v]));
  for (const conflict of merge.conflicts) {
    const decision = resolutions.find((r) => r.path === conflict.path);
    const choice = decision?.resolution || 'ours';
    let value;
    if (choice === 'ours') value = conflict.ours;
    else if (choice === 'theirs') value = conflict.theirs;
    else if (choice === 'base') value = conflict.base;
    else value = choice.custom;
    if (value === SENTINEL) {
      flat.delete(conflict.path);
    } else {
      flat.set(conflict.path, deepClone(value));
    }
  }
  // Re-run unflatten by constructing a fake three-way input.
  return unflatten(flat, merged, merged, merged);
}

// Compare two snapshots even if their schemas differ: migrate B onto A first.
export function diffSnapshots(snapA, snapB, schemaA, schemaB) {
  if (snapA.state.schemaVersion === snapB.state.schemaVersion
      || schemaA.schemaVersion === schemaB.schemaVersion) {
    return diffStates(snapA.state, snapB.state, { schemaA, schemaB });
  }
  const { state } = migrateStateToSchema(snapB.state, schemaB, schemaA);
  return diffStates(snapA.state, state, { schemaA });
}
