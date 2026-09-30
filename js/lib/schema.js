// Form schema definition, state lifecycle and cross-version migration.
//
// Design points required by the task:
//  - Fields may be added / removed / re-typed over time.
//  - Removing a field NEVER deletes its data: the value is parked in
//    `state.removed.<groupId>.<fieldId>` and is restored if the field returns.
//  - Type changes are tracked in `state.typeChanges` and values are converted
//    with documented rules; values that cannot be converted are preserved in
//    removed storage so nothing is silently dropped.
//  - Every migration is versioned (`stateVersion` / `schemaVersion`) and older
//    states degrade gracefully (missing fields get defaults, unknown fields
//    are kept, unknown types render as JSON text).
import { deepClone, generateId } from './util.js';

export const KNOWN_TYPES = [
  'text', 'textarea', 'email', 'number', 'tel', 'password', 'date',
  'select', 'multiselect', 'radio', 'checkbox', 'boolean', 'range',
  'color', 'url', 'json',
];

export const SCHEMA_VERSION = 3;
export const STATE_VERSION = 2;

// ---- historical schema definitions (proves version compatibility) ---------
const SCHEMA_V1 = {
  schemaVersion: 1,
  releasedAt: '2026-01-10T00:00:00.000Z',
  note: '初始版本',
  groups: [
    {
      id: 'basic',
      title: '基本信息',
      repeatable: false,
      fields: [
        { id: 'name', label: '姓名', type: 'text', required: true },
        { id: 'email', label: '邮箱', type: 'email', required: true },
        { id: 'age', label: '年龄', type: 'number' },
        { id: 'bio', label: '个人简介', type: 'textarea' },
      ],
    },
    {
      id: 'contact',
      title: '联系方式',
      repeatable: false,
      fields: [
        { id: 'phone', label: '电话', type: 'tel' },
        { id: 'city', label: '城市', type: 'text' },
      ],
    },
  ],
};

const SCHEMA_V2 = {
  schemaVersion: 2,
  releasedAt: '2026-04-01T00:00:00.000Z',
  note: '新增偏好分组；年龄从 number 改为 range；新增工作经历可重复分组',
  groups: [
    {
      id: 'basic',
      title: '基本信息',
      repeatable: false,
      fields: [
        { id: 'name', label: '姓名', type: 'text', required: true },
        { id: 'email', label: '邮箱', type: 'email', required: true },
        // v1 中为 number —— 故意制造一次“字段类型变化”。
        { id: 'age', label: '年龄（滑块）', type: 'range', min: 18, max: 70, step: 1, default: 28 },
        { id: 'bio', label: '个人简介', type: 'textarea' },
        { id: 'birthDate', label: '出生日期', type: 'date' },
      ],
    },
    {
      id: 'contact',
      title: '联系方式',
      repeatable: false,
      fields: [
        { id: 'phone', label: '电话', type: 'tel' },
        { id: 'city', label: '城市', type: 'select', options: ['北京', '上海', '广州', '深圳', '杭州', '其他'], default: '杭州' },
      ],
    },
    {
      id: 'preferences',
      title: '偏好设置',
      repeatable: false,
      fields: [
        { id: 'departments', label: '关注部门', type: 'multiselect',
          options: ['工程', '设计', '产品', '市场', '运营'] },
        { id: 'employment', label: '求职状态', type: 'radio',
          options: ['在职', '离职可立即到岗', '在校'] },
        { id: 'remote', label: '接受远程办公', type: 'boolean', default: true },
        { id: 'newsletter', label: '订阅周报', type: 'checkbox', default: false },
      ],
    },
    {
      id: 'experience',
      title: '工作经历（可重复分组）',
      repeatable: true,
      fields: [
        { id: 'company', label: '公司', type: 'text' },
        { id: 'role', label: '职位', type: 'text' },
        { id: 'years', label: '年限', type: 'number', min: 0, max: 50 },
        { id: 'startDate', label: '开始日期', type: 'date' },
      ],
    },
  ],
};

export const SCHEMA_V3 = {
  schemaVersion: 3,
  releasedAt: '2026-09-01T00:00:00.000Z',
  note: '删除 city 文本遗留字段（contact.city 变为 select 始于 v2）；新增薪资范围、技能标签、个人主页；工作经历新增 description',
  groups: [
    {
      id: 'basic',
      title: '基本信息',
      repeatable: false,
      fields: [
        { id: 'name', label: '姓名', type: 'text', required: true, placeholder: '例如：张三' },
        { id: 'email', label: '邮箱', type: 'email', required: true },
        { id: 'age', label: '年龄（滑块）', type: 'range', min: 18, max: 70, step: 1, default: 28 },
        { id: 'birthDate', label: '出生日期', type: 'date' },
        { id: 'bio', label: '个人简介', type: 'textarea', rows: 4, span: 2 },
      ],
    },
    {
      id: 'contact',
      title: '联系方式',
      repeatable: false,
      fields: [
        { id: 'phone', label: '电话', type: 'tel' },
        { id: 'city', label: '城市', type: 'select', options: ['北京', '上海', '广州', '深圳', '杭州', '成都', '其他'], default: '杭州' },
        { id: 'homepage', label: '个人主页', type: 'url', placeholder: 'https://' },
      ],
    },
    {
      id: 'preferences',
      title: '偏好设置',
      repeatable: false,
      fields: [
        { id: 'departments', label: '关注部门', type: 'multiselect',
          options: ['工程', '设计', '产品', '市场', '运营', '人力'] },
        { id: 'employment', label: '求职状态', type: 'radio',
          options: ['在职', '离职可立即到岗', '在校'] },
        { id: 'salaryExpect', label: '期望月薪（K）', type: 'number', min: 0, max: 500, step: 5, default: 30 },
        { id: 'skills', label: '技能标签', type: 'multiselect',
          options: ['JavaScript', 'TypeScript', 'Canvas', 'IndexedDB', 'Web Worker', 'CSS', 'Node.js'] },
        { id: 'remote', label: '接受远程办公', type: 'boolean', default: true },
        { id: 'newsletter', label: '订阅周报', type: 'checkbox', default: false },
      ],
    },
    {
      id: 'experience',
      title: '工作经历（可重复分组）',
      repeatable: true,
      fields: [
        { id: 'company', label: '公司', type: 'text' },
        { id: 'role', label: '职位', type: 'text' },
        { id: 'years', label: '年限', type: 'number', min: 0, max: 50 },
        { id: 'startDate', label: '开始日期', type: 'date' },
        { id: 'endDate', label: '结束日期', type: 'date' },
        { id: 'description', label: '工作描述', type: 'textarea', rows: 2, span: 2 },
      ],
    },
  ],
};

export const SCHEMA_HISTORY = [deepClone(SCHEMA_V1), deepClone(SCHEMA_V2), deepClone(SCHEMA_V3)];
export const DEFAULT_SCHEMA = deepClone(SCHEMA_V3);

export function defaultForField(field) {
  if (Object.prototype.hasOwnProperty.call(field, 'default')) return deepClone(field.default);
  switch (field.type) {
    case 'multiselect': return [];
    case 'checkbox': return false;
    case 'boolean': return false;
    case 'number':
    case 'range':
      return field.min !== undefined ? Number(field.min) : '';
    case 'json':
      return {};
    default:
      return '';
  }
}

export function createEmptyState(schema = DEFAULT_SCHEMA) {
  const state = {
    stateVersion: STATE_VERSION,
    schemaVersion: schema.schemaVersion,
    groups: {},
    removed: {},
    typeChanges: [],
  };
  for (const group of schema.groups) {
    if (group.repeatable) {
      state.groups[group.id] = [];
    } else {
      const row = { __rowId: generateId('row') };
      for (const field of group.fields) row[field.id] = defaultForField(field);
      state.groups[group.id] = row;
    }
  }
  return state;
}

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function findField(schema, groupId, fieldId) {
  const group = schema.groups.find((g) => g.id === groupId);
  return group ? group.fields.find((f) => f.id === fieldId) : undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value : value === '' || value === undefined || value === null ? [] : [value];
}

// Returns { value, note }. A failed coercion returns `null` value + note; the
// caller then uses the field default while preserving `oldValue` in typeChanges.
export function coerceValue(oldValue, oldType, field) {
  const target = field.type;
  if (oldType === target) return { value: deepClone(oldValue), note: '' };
  const note = `${oldType} → ${target}`;

  if (oldValue === null || oldValue === undefined || oldValue === '') {
    return { value: defaultForField(field), note: `${note}（空值取默认值）` };
  }

  switch (target) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'tel':
    case 'url':
    case 'password': {
      if (typeof oldValue === 'string') return { value: oldValue, note };
      if (Array.isArray(oldValue)) return { value: oldValue.join(', '), note };
      return { value: JSON.stringify(oldValue), note };
    }
    case 'number':
    case 'range': {
      const n = typeof oldValue === 'number' ? oldValue : Number(String(oldValue).trim());
      if (!Number.isFinite(n)) return { value: null, note: `${note}：无法解析为数字，旧值保留在变更记录` };
      let v = n;
      if (field.min !== undefined) v = Math.max(Number(field.min), v);
      if (field.max !== undefined) v = Math.min(Number(field.max), v);
      if (field.step && Number.isFinite(Number(field.step))) {
        const snapped = Math.round(v / Number(field.step)) * Number(field.step);
        v = Number(snapped.toFixed(6));
      }
      return { value: v, note };
    }
    case 'boolean':
    case 'checkbox': {
      if (typeof oldValue === 'boolean') return { value: oldValue, note };
      if (typeof oldValue === 'number') return { value: oldValue !== 0, note };
      const truthy = new Set(['true', '1', 'yes', 'on', '是', '接受']);
      const falsy = new Set(['false', '0', 'no', 'off', '否', '不接受']);
      const key = String(oldValue).trim().toLowerCase();
      if (truthy.has(key)) return { value: true, note };
      if (falsy.has(key)) return { value: false, note };
      return { value: null, note: `${note}：无法判定布尔值，旧值保留` };
    }
    case 'date': {
      if (typeof oldValue === 'number') {
        return { value: new Date(oldValue).toISOString().slice(0, 10), note };
      }
      const s = String(oldValue).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s, note };
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return { value: d.toISOString().slice(0,10), note };
      return { value: null, note: `${note}：无法解析日期，旧值保留` };
    }
    case 'select':
    case 'radio': {
      if (typeof oldValue === 'string' && (!field.options || field.options.includes(oldValue))) {
        return { value: oldValue, note };
      }
      if (Array.isArray(oldValue)) {
        const firstKnown = oldValue.find((v) => !field.options || field.options.includes(v));
        if (firstKnown !== undefined) return { value: firstKnown, note: `${note}（数组取第一个合法选项）` };
      }
      if (!field.options) return { value: String(oldValue), note };
      return { value: null, note: `${note}：选项不再存在，旧值保留在变更记录` };
    }
    case 'multiselect': {
      const items = asArray(oldValue).map((v) => String(v).trim()).filter(Boolean);
      if (!field.options) return { value: items, note };
      const known = items.filter((v) => field.options.includes(v));
      const dropped = items.filter((v) => !field.options.includes(v));
      if (dropped.length) {
        return { value: known, note: `${note}：选项 ${dropped.join('/')} 已删除，旧值保留在变更记录` };
      }
      return { value: known, note };
    }
    case 'json': {
      if (typeof oldValue === 'object') return { value: deepClone(oldValue), note };
      try { return { value: JSON.parse(String(oldValue)), note }; }
      catch { return { value: { legacy: String(oldValue) }, note: `${note}：非法 JSON 已包裹保留` }; }
    }
    default: {
      // Unknown future types: keep the value as JSON text so a newer app can
      // still read it and nothing is discarded.
      if (typeof oldValue === 'string') return { value: oldValue, note: `${note}（未知类型，降级为文本）` };
      return { value: JSON.stringify(oldValue), note: `${note}（未知类型，降级为 JSON 文本）` };
    }
  }
}

function ensureRemovedGroup(state, groupId) {
  if (!state.removed[groupId]) state.removed[groupId] = {};
  return state.removed[groupId];
}

function parkRemovedField(store, fieldId, entry) {
  if (!store.fields) store.fields = {};
  store.fields[fieldId] = entry;
}

function migrateRow({ row, sourceGroup, targetGroup, state, groupId, rowId, log, at }) {
  const out = { __rowId: row.__rowId || rowId || generateId('row') };
  const removedStore = sourceGroup.repeatable ? ensureRepeatRemoved(state, groupId, out.__rowId) : null;

  for (const targetField of targetGroup.fields) {
    const sourceField = sourceGroup.fields.find((f) => f.id === targetField.id);
    const hadValue = Object.prototype.hasOwnProperty.call(row, targetField.id);
    let restored = null;
    if (!sourceGroup.repeatable) {
      const parked = state.removed[groupId]?.fields?.[targetField.id];
      if (parked && !hadValue) restored = parked;
    } else if (removedStore?.fields?.[targetField.id]) {
      restored = removedStore.fields[targetField.id];
    }

    if (hadValue) {
      const oldValue = row[targetField.id];
      if (sourceField && sourceField.type !== targetField.type) {
        const { value, note: coerceNote } = coerceValue(oldValue, sourceField.type, targetField);
        state.typeChanges.push({
          groupId, rowId: sourceGroup.repeatable ? out.__rowId : null,
          fieldId: targetField.id, fromType: sourceField.type, toType: targetField.type,
          oldValue: deepClone(oldValue), newValue: value === null ? defaultForField(targetField) : deepClone(value),
          note: coerceNote, at,
        });
        out[targetField.id] = value === null ? defaultForField(targetField) : value;
        if (value === null) log.push(`字段 ${groupId}.${targetField.id} 类型 ${sourceField.type}→${targetField.type} 无法转换，已取默认值，旧值保留`);
      } else {
        out[targetField.id] = deepClone(oldValue);
      }
    } else if (restored) {
      if (restored.type !== targetField.type) {
        const { value, note: coerceNote } = coerceValue(restored.value, restored.type, targetField);
        state.typeChanges.push({
          groupId, rowId: sourceGroup.repeatable ? out.__rowId : null,
          fieldId: targetField.id, fromType: restored.type, toType: targetField.type,
          oldValue: deepClone(restored.value), newValue: value === null ? defaultForField(targetField) : deepClone(value),
          note: coerceNote, at, restored: true,
        });
        out[targetField.id] = value === null ? defaultForField(targetField) : value;
      } else {
        out[targetField.id] = deepClone(restored.value);
        log.push(`字段 ${groupId}.${targetField.id} 随字段恢复而还原`);
      }
      if (!sourceGroup.repeatable) delete state.removed[groupId].fields[targetField.id];
      else delete removedStore.fields[targetField.id];
    } else {
      out[targetField.id] = defaultForField(targetField);
      if (sourceField) log.push(`字段 ${groupId}.${targetField.id} 使用默认值补齐`);
    }
  }

  // Values whose fields disappeared are parked, never discarded.
  for (const key of Object.keys(row)) {
    if (key === '__rowId' || key === '__deleted') continue;
    if (!targetGroup.fields.some((f) => f.id === key)) {
      const sourceField = sourceGroup.fields.find((f) => f.id === key);
      const entry = { type: sourceField?.type || 'unknown', value: deepClone(row[key]), at };
      if (sourceGroup.repeatable) parkRemovedField(removedStore, key, entry);
      else parkRemovedField(ensureRemovedGroup(state, groupId), key, entry);
      log.push(`字段 ${groupId}.${key} 已删除，数据移入 removed 保留`);
    }
  }
  if (row.__deleted) out.__deleted = true;
  return out;
}

function ensureRepeatRemoved(state, groupId, rowId) {
  const store = ensureRemovedGroup(state, groupId);
  if (!store.rows) store.rows = {};
  if (!store.rows[rowId]) store.rows[rowId] = {};
  return store.rows[rowId];
}

// Migrate an arbitrary state to a target schema. Used when rolling back to /
// importing a snapshot taken with a different schema version.
export function migrateStateToSchema(sourceState, sourceSchema, targetSchema, at = new Date(0).toISOString()) {
  if (!sourceState || typeof sourceState !== 'object') throw new MigrationError('source state is not an object');
  const state = {
    stateVersion: STATE_VERSION,
    schemaVersion: targetSchema.schemaVersion,
    groups: {},
    removed: deepClone(sourceState.removed || {}),
    typeChanges: Array.isArray(sourceState.typeChanges) ? deepClone(sourceState.typeChanges) : [],
  };
  const log = [];

  for (const targetGroup of targetSchema.groups) {
    const sourceGroup = sourceSchema.groups.find((g) => g.id === targetGroup.id);
    if (!sourceGroup) {
      if (targetGroup.repeatable) {
        state.groups[targetGroup.id] = [];
        log.push(`新增可重复分组 ${targetGroup.id}：空列表`);
      } else {
        state.groups[targetGroup.id] = createEmptyState(targetSchema).groups[targetGroup.id];
        log.push(`新增分组 ${targetGroup.id}：全部字段取默认值`);
      }
      continue;
    }

    if (targetGroup.repeatable || sourceGroup.repeatable) {
      if (!targetGroup.repeatable) {
        // repeatable -> single: keep every row's data parked, nothing lost.
        const rows = asArray(sourceState.groups[sourceGroup.id]);
        const rowsStore = {};
        rows.forEach((row, i) => {
          const rowId = row.__rowId || `row_${i}`;
          rowsStore[rowId] = { fields: {} };
          for (const key of Object.keys(row)) {
            if (key === '__rowId' || key === '__deleted') continue;
            const sf = sourceGroup.fields.find((f) => f.id === key);
            rowsStore[rowId].fields[key] = { type: sf?.type || 'unknown', value: deepClone(row[key]), at };
          }
        });
        state.removed[targetGroup.id] = { ...(state.removed[targetGroup.id] || {}), rows: rowsStore };
        state.groups[targetGroup.id] = createEmptyState(targetSchema).groups[targetGroup.id];
        log.push(`分组 ${targetGroup.id} 从可重复变为单值，${rows.length} 行数据移入 removed 保留`);
        continue;
      }
      const sourceRows = asArray(sourceState.groups[sourceGroup.id]);
      const migratedRows = sourceRows.map((row, i) =>
        migrateRow({
          row, sourceGroup, targetGroup, state,
          groupId: targetGroup.id, rowId: row.__rowId || `row_${i}`, log, at,
        }));
      // Restore previously deleted rows that are still marked deleted.
      state.groups[targetGroup.id] = migratedRows;
      continue;
    }

    const sourceRow = sourceState.groups[sourceGroup.id] || {};
    state.groups[targetGroup.id] = migrateRow({
      row: sourceRow, sourceGroup, targetGroup, state,
      groupId: targetGroup.id, log, at,
    });
  }

  // Groups that no longer exist: park all of their data.
  for (const sourceGroup of sourceSchema.groups) {
    if (targetSchema.groups.some((g) => g.id === sourceGroup.id)) continue;
    const store = ensureRemovedGroup(state, sourceGroup.id);
    const src = sourceState.groups[sourceGroup.id];
    if (sourceGroup.repeatable) {
      asArray(src).forEach((row, i) => {
        const rowId = row.__rowId || `row_${i}`;
        const rowStore = { fields: {} };
        for (const key of Object.keys(row)) {
          if (key === '__rowId' || key === '__deleted') continue;
          const sf = sourceGroup.fields.find((f) => f.id === key);
          rowStore.fields[key] = { type: sf?.type || 'unknown', value: deepClone(row[key]), at };
        }
        if (!store.rows) store.rows = {};
        store.rows[rowId] = rowStore;
      });
    } else if (src && typeof src === 'object') {
      for (const key of Object.keys(src)) {
        if (key === '__rowId') continue;
        const sf = sourceGroup.fields.find((f) => f.id === key);
        parkRemovedField(store, key, { type: sf?.type || 'unknown', value: deepClone(src[key]), at });
      }
    }
    log.push(`分组 ${sourceGroup.id} 已删除，全部数据移入 removed 保留`);
  }

  return { state, log };
}

// Load a state that may come from an older application version.
// Runs the schema chain v1 -> v2 -> ... -> current and bumps stateVersion.
export function normalizeLoadedState(rawState, targetSchema = DEFAULT_SCHEMA, schemaHistory = SCHEMA_HISTORY) {
  if (rawState === null || rawState === undefined) {
    return { state: createEmptyState(targetSchema), log: ['空状态，创建默认表单'] };
  }
  if (typeof rawState !== 'object' || Array.isArray(rawState)) {
    throw new MigrationError('state must be an object');
  }
  let state = deepClone(rawState);
  const log = [];
  const fromSchemaVersion = Number(state.schemaVersion ?? 0);

  if (!state.groups || typeof state.groups !== 'object') {
    throw new MigrationError('state.groups missing or invalid');
  }
  if (!state.removed) state.removed = {};
  if (!Array.isArray(state.typeChanges)) state.typeChanges = [];

  const chain = schemaHistory
    .filter((s) => s.schemaVersion >= fromSchemaVersion)
    .sort((a, b) => a.schemaVersion - b.schemaVersion);

  if (chain.length === 0) {
    // State claims to be from a newer/unknown schema. Degrade: keep raw values
    // in removed storage, build current defaults.
    log.push(`未知 schema 版本 ${fromSchemaVersion}：旧数据保留在 removed，当前字段使用默认值`);
    const fallback = createEmptyState(targetSchema);
    fallback.removed = state.removed;
    fallback.removed.__legacy__ = deepClone(state.groups);
    fallback.typeChanges = state.typeChanges;
    return { state: fallback, log };
  }

  let currentSchema = chain[0];
  if (chain.length > 1) {
    for (let i = 1; i < chain.length; i += 1) {
      const next = chain[i];
      const result = migrateStateToSchema(state, currentSchema, next, new Date(0).toISOString());
      state = result.state;
      log.push(...result.log.map((l) => `[schema v${currentSchema.schemaVersion}→v${next.schemaVersion}] ${l}`));
      currentSchema = next;
    }
  }
  if (currentSchema.schemaVersion !== targetSchema.schemaVersion) {
    const result = migrateStateToSchema(state, currentSchema, targetSchema, new Date(0).toISOString());
    state = result.state;
    log.push(...result.log);
  }
  state.stateVersion = STATE_VERSION;
  state.schemaVersion = targetSchema.schemaVersion;
  return { state, log };
}

// Evolve the live (runtime-edited) schema: add / remove / retype a field.
// Produces a brand-new schema version and migrates current state with no loss.
export function evolveSchema(currentSchema, currentState, change, at = new Date().toISOString(), idGen = generateId) {
  const nextSchema = deepClone(currentSchema);
  nextSchema.schemaVersion = currentSchema.schemaVersion + 1;
  nextSchema.releasedAt = at;
  nextSchema.note = change.note || '运行时字段调整';
  const group = nextSchema.groups.find((g) => g.id === change.groupId);
  if (!group) throw new MigrationError(`group ${change.groupId} not found`);

  if (change.kind === 'addField') {
    if (group.fields.some((f) => f.id === change.field.id)) {
      throw new MigrationError(`field ${change.field.id} already exists`);
    }
    group.fields.push(deepClone(change.field));
  } else if (change.kind === 'removeField') {
    // Field stays out of the schema; migration parks its values.
    group.fields = group.fields.filter((f) => f.id !== change.fieldId);
  } else if (change.kind === 'changeFieldType') {
    const field = group.fields.find((f) => f.id === change.fieldId);
    if (!field) throw new MigrationError(`field ${change.fieldId} not found`);
    field.type = change.newType;
    if (change.options) field.options = change.options;
    if (change.default !== undefined) field.default = change.default;
  } else if (change.kind === 'addGroup') {
    if (nextSchema.groups.some((g) => g.id === change.group.id)) {
      throw new MigrationError(`group ${change.group.id} already exists`);
    }
    nextSchema.groups.push(deepClone(change.group));
  } else {
    throw new MigrationError(`unknown schema change kind ${change.kind}`);
  }
  void idGen;

  const { state, log } = migrateStateToSchema(currentState, currentSchema, nextSchema, at);
  return { schema: nextSchema, state, log };
}

// Validate that a state object matches its declared schema shape (used before
// creating a snapshot). Returns a list of problems; empty array means healthy.
export function validateStateShape(state, schema) {
  const problems = [];
  if (!state || typeof state !== 'object') return ['state 不是对象'];
  if (state.schemaVersion !== schema.schemaVersion) {
    problems.push(`schemaVersion 不匹配：state=${state.schemaVersion}, schema=${schema.schemaVersion}`);
  }
  for (const group of schema.groups) {
    const data = state.groups?.[group.id];
    if (group.repeatable) {
      if (!Array.isArray(data)) { problems.push(`分组 ${group.id} 应为数组`); continue; }
      data.forEach((row, i) => {
        if (!row || typeof row !== 'object' || !row.__rowId) problems.push(`${group.id}[${i}] 缺少 __rowId`);
      });
    } else if (!data || typeof data !== 'object') {
      problems.push(`分组 ${group.id} 缺少行对象`);
    }
  }
  return problems;
}
