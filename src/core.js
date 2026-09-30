export const APP_VERSION = '1.0.0';
export const FORMAT_VERSION = 1;
export const SCHEMA_VERSION = 3;
export const DELTA_CHECK_EVERY = 4;

export const FIELD_GROUPS = [
  {
    id: 'basics',
    title: '基本信息',
    fields: [
      { id: 'projectName', label: '项目名称', type: 'text', required: true, placeholder: '例如：北极星平台' },
      { id: 'owner', label: '负责人', type: 'text', placeholder: '姓名或团队' },
      { id: 'priority', label: '优先级', type: 'select', options: ['P0', 'P1', 'P2', 'P3'], default: 'P2' },
      { id: 'startDate', label: '开始日期', type: 'date' }
    ]
  },
  {
    id: 'scope',
    title: '需求范围',
    fields: [
      { id: 'budget', label: '预算（元）', type: 'number', default: 0 },
      { id: 'tags', label: '标签', type: 'multiselect', options: ['合规', '增长', '性能', '安全', '体验'] },
      { id: 'description', label: '需求描述', type: 'textarea', placeholder: '记录目标、范围和限制' }
    ]
  },
  {
    id: 'execution',
    title: '执行与风险',
    fields: [
      { id: 'status', label: '状态', type: 'select', options: ['草稿', '评审中', '进行中', '暂停', '已完成'], default: '草稿' },
      { id: 'progress', label: '完成度（%）', type: 'number', default: 0, min: 0, max: 100 },
      { id: 'riskAccepted', label: '已知风险已接受', type: 'checkbox' },
      { id: 'riskNote', label: '风险说明', type: 'textarea', placeholder: '记录风险和应对方案' }
    ]
  }
];

export const FIELDS = Object.fromEntries(
  FIELD_GROUPS.flatMap((group) => group.fields.map((field) => [field.id, field]))
);

export function createDefaultState() {
  return {
    values: {
      projectName: '',
      owner: '',
      priority: 'P2',
      startDate: '',
      budget: 0,
      tags: [],
      description: '',
      status: '草稿',
      progress: 0,
      riskAccepted: false,
      riskNote: ''
    },
    milestones: [
      { id: makeId('milestone'), title: '需求澄清', date: '', owner: '', done: false },
      { id: makeId('milestone'), title: '方案评审', date: '', owner: '', done: false }
    ],
    retired: {},
    legacy: {},
    foreignState: null,
    schemaVersion: SCHEMA_VERSION
  };
}

export function createStarterState() {
  const state = createDefaultState();
  Object.assign(state.values, {
    projectName: '客户增长实验平台',
    owner: '林岚',
    priority: 'P1',
    startDate: '2026-10-08',
    budget: 180000,
    tags: ['增长', '体验'],
    description: '为运营团队提供实验配置、分流、指标看板和审批留痕。',
    status: '进行中',
    progress: 35,
    riskAccepted: false,
    riskNote: '需要确认埋点口径和灰度回滚策略。'
  });
  state.milestones = [
    { id: makeId('milestone'), title: '需求澄清', date: '2026-10-10', owner: '林岚', done: true },
    { id: makeId('milestone'), title: '方案评审', date: '2026-10-15', owner: '周启', done: false }
  ];
  return state;
}

export function makeId(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.() ??
    `x${DateNow()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${String(random).replace(/-/g, '')}`;
}

function DateNow() {
  return Date.now();
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function ensureSerializable(value, path = '$') {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`状态不可序列化：${path} 的类型为 ${typeof value}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => ensureSerializable(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') {
      ensureSerializable(value.toJSON(), path);
      return;
    }
    for (const [key, child] of Object.entries(value)) ensureSerializable(child, joinPath(path, key));
  }
}

export function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object' && typeof value.toJSON !== 'function') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

export async function hashJson(value) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return fnv1aHex(stableStringify(value));
}

function fnv1aHex(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function joinPath(path, key) {
  return `${path}.${String(key).replace(/~/g, '~0').replace(/\./g, '~1')}`;
}

export function equalJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

export function migrateState(input, declaredVersion) {
  const rawVersion = Number.isInteger(declaredVersion) ? declaredVersion : 1;
  if (rawVersion < 1) throw new Error('不支持的状态版本：版本号必须从 1 开始');
  if (rawVersion > SCHEMA_VERSION) return downgradeFutureState(input, rawVersion);

  let state = cloneJson(isPlainObject(input) ? input : {});
  state.schemaVersion = rawVersion;
  state.values = isPlainObject(state.values) ? state.values : {};
  state.milestones = Array.isArray(state.milestones) ? state.milestones : [];

  if (state.schemaVersion === 1) state = migrateV1ToV2(state);
  if (state.schemaVersion === 2) state = migrateV2ToV3(state);
  state.schemaVersion = SCHEMA_VERSION;
  return normalizeState(state);
}

function migrateV1ToV2(state) {
  const values = { ...state.values };
  const retired = isPlainObject(state.retired) ? { ...state.retired } : {};

  if ('riskLevel' in values && !('priority' in values)) values.priority = values.riskLevel;
  if ('confirmed' in values && !('riskAccepted' in values)) {
    values.riskAccepted = values.confirmed === true || values.confirmed === 'yes';
  }
  if ('notes' in values && !('description' in values)) values.description = stringifyLegacy(values.notes);
  for (const key of ['riskLevel', 'confirmed', 'notes']) {
    if (key in values) retired[`values.${key}`] = { version: 1, value: values[key] };
  }

  return { ...state, values, retired, schemaVersion: 2 };
}

function migrateV2ToV3(state) {
  const values = { ...state.values };
  const retired = { ...(isPlainObject(state.retired) ? state.retired : {}) };

  if ('tags' in values && typeof values.tags === 'string') {
    const previous = values.tags;
    values.tags = previous.split(',').map((tag) => tag.trim()).filter(Boolean);
    retired['values.tags@v2:string'] = { version: 2, value: previous, reason: 'string-to-array' };
  }
  if ('budgetText' in values) {
    const parsed = Number(String(values.budgetText).replace(/[^-\d.]/g, ''));
    if (Number.isFinite(parsed)) {
      if ('budget' in values) retired['values.budget@v2:number'] = { version: 2, value: values.budget, reason: 'replaced-by-budgetText' };
      values.budget = parsed;
    }
    retired['values.budgetText'] = { version: 2, value: values.budgetText, reason: 'text-to-number' };
  }

  return { ...state, values, retired, schemaVersion: 3 };
}

function downgradeFutureState(input, version) {
  const source = cloneJson(isPlainObject(input) ? input : {});
  const fallback = createDefaultState();
  const sourceValues = isPlainObject(source.values) ? source.values : {};
  const values = { ...fallback.values };

  for (const field of FIELD_GROUPS.flatMap((group) => group.fields)) {
    if (!(field.id in sourceValues)) continue;
    const coerced = coerceField(field, sourceValues[field.id]);
    if (coerced.ok) values[field.id] = coerced.value;
  }

  const state = {
    values,
    milestones: Array.isArray(source.milestones) ? source.milestones.map(normalizeMilestone).filter(Boolean) : [],
    retired: isPlainObject(source.retired) ? source.retired : {},
    legacy: {
      downgradedFrom: version,
      unsupportedRootKeys: Object.keys(source).filter((key) => !['values', 'milestones', 'retired', 'legacy', 'foreignState', 'schemaVersion'].includes(key))
    },
    foreignState: source,
    schemaVersion: SCHEMA_VERSION
  };
  return normalizeState(state, { allowForeign: true });
}

export function normalizeState(input, options = {}) {
  const source = cloneJson(isPlainObject(input) ? input : {});
  const values = { ...createDefaultState().values };
  const legacy = isPlainObject(source.legacy) ? cloneJson(source.legacy) : {};
  const sourceValues = isPlainObject(source.values) ? source.values : {};

  for (const [id, field] of Object.entries(FIELDS)) {
    if (!(id in sourceValues)) continue;
    const candidate = sourceValues[id];
    const result = candidate === undefined ? { ok: true, value: field.default ?? defaultValue(field.type) } : coerceField(field, candidate);
    if (result.ok) {
      values[id] = result.value;
    } else {
      legacy[`typeMismatch.values.${id}`] = {
        expected: field.type,
        actual: describeType(candidate),
        value: candidate
      };
    }
  }

  for (const key of Object.keys(sourceValues)) {
    if (!(key in FIELDS)) {
      legacy[`unknown.values.${key}`] = { value: sourceValues[key] };
    }
  }

  const state = {
    values,
    milestones: Array.isArray(source.milestones) ? source.milestones.map(normalizeMilestone).filter(Boolean) : [],
    retired: isPlainObject(source.retired) ? cloneJson(source.retired) : {},
    legacy,
    foreignState: options.allowForeign || source.foreignState !== undefined ? source.foreignState ?? null : null,
    schemaVersion: SCHEMA_VERSION
  };

  for (const key of Object.keys(source)) {
    if (!['values', 'milestones', 'retired', 'legacy', 'foreignState', 'schemaVersion'].includes(key)) {
      state.legacy[`unknown.root.${key}`] = { value: source[key] };
    }
  }

  ensureSerializable(state);
  return state;
}

function normalizeMilestone(item, index) {
  if (typeof item === 'string') {
    return { id: makeId('milestone'), title: item, date: '', owner: '', done: false };
  }
  if (!isPlainObject(item)) {
    return { id: makeId('milestone'), title: `里程碑 ${index + 1}`, date: '', owner: '', done: false, legacyValue: cloneJson(item) };
  }
  return {
    id: typeof item.id === 'string' && item.id ? item.id : makeId('milestone'),
    title: stringValue(item.title, `里程碑 ${index + 1}`),
    date: stringValue(item.date, ''),
    owner: stringValue(item.owner, ''),
    done: item.done === true,
    ...(Object.keys(item).some((key) => !['id', 'title', 'date', 'owner', 'done'].includes(key))
      ? { extra: Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'title', 'date', 'owner', 'done'].includes(key))) }
      : {})
  };
}

function coerceField(field, value) {
  if (value === null || value === undefined) return { ok: true, value: field.default ?? defaultValue(field.type) };
  switch (field.type) {
    case 'text':
    case 'date':
    case 'textarea':
      return typeof value === 'string' ? { ok: true, value } : typeof value === 'number' || typeof value === 'boolean'
        ? { ok: true, value: String(value) }
        : { ok: false };
    case 'number': {
      if (typeof value === 'boolean') return { ok: false };
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return { ok: false };
      return { ok: true, value: clampNumber(number, field) };
    }
    case 'checkbox':
      return typeof value === 'boolean' ? { ok: true, value } : value === 'true' || value === 'false'
        ? { ok: true, value: value === 'true' }
        : { ok: false };
    case 'select':
      return typeof value === 'string' && field.options.includes(value) ? { ok: true, value } : { ok: false };
    case 'multiselect':
      if (!Array.isArray(value)) return { ok: false };
      return value.every((item) => typeof item === 'string') && value.every((item) => field.options.includes(item))
        ? { ok: true, value: [...new Set(value)] }
        : { ok: false };
    default:
      return { ok: false };
  }
}

function defaultValue(type) {
  if (type === 'number') return 0;
  if (type === 'checkbox') return false;
  if (type === 'multiselect') return [];
  return '';
}

function clampNumber(value, field) {
  let next = value;
  if (typeof field.min === 'number') next = Math.max(field.min, next);
  if (typeof field.max === 'number') next = Math.min(field.max, next);
  return next;
}

function stringifyLegacy(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stableStringify(value);
}

function stringValue(value, fallback) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? fallback : String(value));
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export async function createSnapshot({ state, parentId = null, parentState = null, name, records = [], createdAt = Date.now(), reason = 'manual' }) {
  ensureSerializable(state);
  const id = makeId('snapshot');
  const normalized = normalizeState(state);
  const stateHash = await hashJson(normalized);
  const ordered = orderRecords(records);
  const parent = ordered.find((record) => record.id === parentId) ?? null;
  const parentRawState = parent ? parentState ?? null : null;
  const ancestryCount = parent ? (Number(parent.ancestryCount) || 0) + 1 : 0;
  const forceFull = !parent || !parentRawState || ancestryCount % DELTA_CHECK_EVERY === 0;

  let compression = {
    kind: 'full',
    rawState: cloneJson(normalized),
    ops: [],
    byteSize: 0,
    fullByteSize: 0,
    parentHash: null
  };

  if (!forceFull && parentRawState) {
    const parentNormalized = normalizeState(parentRawState);
    const ops = diffToOps(parentNormalized, normalized);
    const deltaCandidate = { ...compression, kind: 'delta', rawState: null, ops, parentHash: await hashJson(parentNormalized) };
    const deltaSize = byteLength(stableStringify(deltaCandidate));
    const fullSize = byteLength(stableStringify(compression));
    if (deltaSize < fullSize) {
      compression = { ...deltaCandidate, byteSize: deltaSize, fullByteSize: fullSize };
    } else {
      compression = { ...compression, byteSize: fullSize, fullByteSize: fullSize };
    }
  } else {
    const fullSize = byteLength(stableStringify(compression));
    compression = { ...compression, byteSize: fullSize, fullByteSize: fullSize };
  }

  return {
    id,
    formatVersion: FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    name: typeof name === 'string' && name.trim() ? name.trim() : `快照 ${new Date(createdAt).toLocaleString('zh-CN', { hour12: false })}`,
    createdAt,
    parentId: parent ? parent.id : null,
    parentName: parent ? parent.name : null,
    stateHash,
    reason,
    ancestryCount,
    compression
  };
}

export function orderRecords(records) {
  return [...records].sort((left, right) =>
    (left.createdAt || 0) - (right.createdAt || 0) ||
    String(left.id).localeCompare(String(right.id))
  );
}

export async function reconstructAll(records, options = {}) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const memo = new Map();
  const result = [];

  for (const record of orderRecords(records)) {
    const item = await reconstructOne(record, byId, memo, options);
    if (item) result.push(item);
  }
  return result;
}

async function reconstructOne(record, byId, memo, options) {
  if (memo.has(record.id)) return memo.get(record.id);
  const envelope = record.compression;
  if (!envelope || !['full', 'delta'].includes(envelope.kind)) {
    return failedRecord(record, '快照格式无效：缺少 full/delta 压缩包');
  }

  let rawState;
  if (envelope.kind === 'full') {
    if (!isPlainObject(envelope.rawState)) return failedRecord(record, '全量快照缺少 rawState');
    rawState = cloneJson(envelope.rawState);
  } else {
    if (!record.parentId || !byId.has(record.parentId)) return failedRecord(record, 'Delta 快照的父快照缺失');
    const parent = await reconstructOne(byId.get(record.parentId), byId, memo, options);
    if (!parent?.ok) return failedRecord(record, `父快照无法重建：${parent?.error ?? '未知错误'}`);
    const parentRaw = getOriginalRawState(parent, record);
    const expectedParentHash = await hashJson(parentRaw);
    if (envelope.parentHash && envelope.parentHash !== expectedParentHash) {
      return failedRecord(record, '父快照哈希不一致，Delta 链可能损坏');
    }
    try {
      rawState = applyOps(parentRaw, envelope.ops || []);
    } catch (error) {
      return failedRecord(record, `应用 Delta 失败：${error.message}`);
    }
  }

  const rawHash = await hashJson(rawState);
  if (rawHash !== record.stateHash) return failedRecord(record, 'stateHash 校验失败，压缩数据不完整');

  let state = rawState;
  const warnings = [];
  try {
    state = migrateState(rawState, Number(record.schemaVersion) || 1);
  } catch (error) {
    return failedRecord(record, `版本迁移失败：${error.message}`);
  }
  if ((Number(record.schemaVersion) || 1) > SCHEMA_VERSION) {
    warnings.push(`快照来自更高结构版本 v${record.schemaVersion}，已保留原始状态并按 v${SCHEMA_VERSION} 降级显示`);
  }

  const item = { ok: true, record, rawState, state, warnings };
  memo.set(record.id, item);
  return item;
}

function getOriginalRawState(parentItem, child) {
  if (child.schemaVersion !== parentItem.record.schemaVersion) {
    const original = parentItem.state.foreignState;
    if (original && isPlainObject(original) && Number(original.schemaVersion) === Number(child.schemaVersion)) return cloneJson(original);
  }
  return cloneJson(parentItem.rawState);
}

function failedRecord(record, error) {
  return { ok: false, record, error };
}

export function diffToOps(base, target) {
  const ops = [];
  const baseJson = isPlainObject(base) ? base : {};
  const targetJson = isPlainObject(target) ? target : {};
  collectOps(baseJson, targetJson, '$', ops);
  return ops.sort(compareOps);
}

function collectOps(base, target, path, ops) {
  if (stableStringify(base) === stableStringify(target)) return;
  if (Array.isArray(base) || Array.isArray(target) || !isPlainObject(base) || !isPlainObject(target)) {
    ops.push({ op: 'replace', path, value: cloneJson(target) });
    return;
  }

  for (const key of Object.keys(base)) {
    const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
    if (!(key in target)) ops.push({ op: 'remove', path: childPath });
  }
  for (const key of Object.keys(target)) {
    const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
    const exists = key in base;
    if (!exists) {
      ops.push({ op: 'add', path: childPath, value: cloneJson(target[key]) });
    } else if (stableStringify(base[key]) !== stableStringify(target[key])) {
      collectOps(base[key], target[key], childPath, ops);
    }
  }
}

function compareOps(left, right) {
  const leftRemove = left.op === 'remove' ? 1 : 0;
  const rightRemove = right.op === 'remove' ? 1 : 0;
  if (leftRemove !== rightRemove) return rightRemove - leftRemove;
  return left.path.localeCompare(right.path);
}

export function applyOps(input, operations) {
  let output = cloneJson(input);
  for (const operation of operations) {
    const parts = parsePath(operation.path);
    if (parts.length === 0) throw new Error('非法路径：$');
    if (operation.op === 'remove') {
      removeAtPath(output, parts);
    } else if (operation.op === 'add' || operation.op === 'replace') {
      setAtPath(output, parts, cloneJson(operation.value));
    } else {
      throw new Error(`未知 Delta 操作：${operation.op}`);
    }
  }
  return output;
}

function parsePath(path) {
  if (!path.startsWith('$')) throw new Error(`非法路径：${path}`);
  const remainder = path.slice(1);
  if (!remainder) return [];
  if (!remainder.startsWith('.')) throw new Error(`非法路径：${path}`);
  return remainder.slice(1).split('.').map((part) => part.replace(/~1/g, '.').replace(/~0/g, '~'));
}

function setAtPath(root, parts, value) {
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const next = parts[index + 1];
    if (Array.isArray(cursor)) {
      const itemIndex = Number(key);
      if (!Number.isInteger(itemIndex)) throw new Error(`数组索引非法：${key}`);
      if (!isPlainObject(cursor[itemIndex])) cursor[itemIndex] = {};
      cursor = cursor[itemIndex];
    } else {
      if (!isPlainObject(cursor[key])) cursor[key] = /^\d+$/.test(next) ? [] : {};
      cursor = cursor[key];
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cursor)) cursor[Number(last)] = value;
  else cursor[last] = value;
}

function removeAtPath(root, parts) {
  let cursor = root;
  for (const key of parts.slice(0, -1)) {
    if (cursor == null) return;
    cursor = Array.isArray(cursor) ? cursor[Number(key)] : cursor[key];
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cursor)) cursor.splice(Number(last), 1);
  else if (isPlainObject(cursor)) delete cursor[last];
}

function byteLength(text) {
  return new Blob([text]).size;
}

export async function analyzeImport(incomingRecords, existingRecords = []) {
  const existingById = new Map(existingRecords.map((record) => [record.id, record]));
  const combined = new Map(existingById);
  const conflicts = [];
  const accepted = [];
  const warnings = [];

  for (const record of incomingRecords) {
    const validation = validateEnvelope(record);
    if (!validation.ok) {
      conflicts.push({ kind: 'invalid', id: record?.id ?? null, message: validation.error, record });
      continue;
    }
    if (existingById.has(record.id)) {
      const current = existingById.get(record.id);
      if (!equalJson(current, record)) {
        conflicts.push({ kind: 'same-id-divergent', id: record.id, message: `快照 ${record.name} 的 ID 已存在但内容不同`, record });
      } else {
        warnings.push({ kind: 'duplicate-identical', id: record.id, message: `快照 ${record.name} 已存在，导入时跳过` });
      }
      continue;
    }
    if (combined.has(record.id) && !equalJson(combined.get(record.id), record)) {
      conflicts.push({ kind: 'import-id-divergent', id: record.id, message: `导入文件内快照 ID ${record.id} 出现不同内容`, record });
      continue;
    }
    if (record.parentId && !combined.has(record.parentId)) {
      conflicts.push({ kind: 'missing-parent', id: record.id, message: `快照 ${record.name} 缺少父快照 ${record.parentId}`, record });
      continue;
    }
    combined.set(record.id, record);
    accepted.push(record);
  }

  const reconstructed = await reconstructAll(Array.from(combined.values()));
  for (const item of reconstructed) {
    if (!item.ok) {
      const isIncoming = incomingRecords.some((record) => record.id === item.record.id);
      if (isIncoming) conflicts.push({ kind: 'broken-chain', id: item.record.id, message: item.error, record: item.record });
    }
  }

  const acceptedIds = new Set(accepted.map((record) => record.id));
  const safeAccepted = accepted.filter((record) => !conflicts.some((conflict) => conflict.id === record.id));
  return { ok: conflicts.length === 0, conflicts, warnings, accepted: safeAccepted, records: orderRecords([...existingRecords, ...safeAccepted]) };
}

function validateEnvelope(record) {
  if (!isPlainObject(record) || typeof record.id !== 'string' || !record.id) return { ok: false, error: '快照不是有效对象或缺少 ID' };
  if (record.formatVersion !== FORMAT_VERSION) return { ok: false, error: `不支持的快照格式版本：${record.formatVersion}` };
  if (!Number.isInteger(record.schemaVersion) || record.schemaVersion < 1) return { ok: false, error: '快照结构版本无效' };
  if (!isPlainObject(record.compression)) return { ok: false, error: '快照缺少压缩包' };
  if (typeof record.stateHash !== 'string' || !record.stateHash) return { ok: false, error: '快照缺少 stateHash' };
  if (!['full', 'delta'].includes(record.compression.kind)) return { ok: false, error: '压缩类型不受支持' };
  try {
    ensureSerializable(record);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export function diffStates(beforeState, afterState) {
  const before = normalizeState(beforeState);
  const after = normalizeState(afterState);
  const changes = [];

  for (const [id, field] of Object.entries(FIELDS)) {
    const beforeValue = before.values[id];
    const afterValue = after.values[id];
    if (!equalJson(beforeValue, afterValue)) {
      changes.push({
        category: field.type === 'multiselect' ? '数组字段' : '字段',
        path: `values.${id}`,
        label: field.label,
        kind: describeValueChange(beforeValue, afterValue),
        before: beforeValue,
        after: afterValue
      });
    }
  }

  const beforeMilestones = new Map(before.milestones.map((item) => [item.id, item]));
  const afterMilestones = new Map(after.milestones.map((item) => [item.id, item]));
  for (const [id, item] of beforeMilestones) {
    if (!afterMilestones.has(id)) {
      changes.push({ category: '里程碑', path: `milestones.${id}`, label: item.title, kind: '删除', before: item, after: null });
    }
  }
  for (const [id, item] of afterMilestones) {
    if (!beforeMilestones.has(id)) {
      changes.push({ category: '里程碑', path: `milestones.${id}`, label: item.title, kind: '新增', before: null, after: item });
      continue;
    }
    for (const key of ['title', 'date', 'owner', 'done']) {
      if (!equalJson(beforeMilestones.get(id)[key], item[key])) {
        changes.push({
          category: '里程碑',
          path: `milestones.${id}.${key}`,
          label: `${item.title} / ${milestoneLabel(key)}`,
          kind: '修改',
          before: beforeMilestones.get(id)[key],
          after: item[key]
        });
      }
    }
  }

  collectMapChanges(changes, '历史字段', before.retired, after.retired, 'retired');
  collectMapChanges(changes, '兼容信息', before.legacy, after.legacy, 'legacy');
  if (!equalJson(Boolean(before.foreignState), Boolean(after.foreignState))) {
    changes.push({
      category: '版本兼容',
      path: 'foreignState',
      label: '高版本原始状态',
      kind: after.foreignState ? '新增' : '删除',
      before: before.foreignState,
      after: after.foreignState
    });
  }

  return changes.sort((left, right) => left.category.localeCompare(right.category, 'zh-CN') || left.label.localeCompare(right.label, 'zh-CN'));
}

function collectMapChanges(changes, category, beforeMap, afterMap, prefix) {
  const before = isPlainObject(beforeMap) ? beforeMap : {};
  const after = isPlainObject(afterMap) ? afterMap : {};
  for (const key of Object.keys(before)) {
    if (!(key in after)) changes.push({ category, path: `${prefix}.${key}`, label: key, kind: '删除', before: before[key], after: null });
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      changes.push({ category, path: `${prefix}.${key}`, label: key, kind: '新增', before: null, after: after[key] });
    } else if (!equalJson(before[key], after[key])) {
      changes.push({ category, path: `${prefix}.${key}`, label: key, kind: '修改', before: before[key], after: after[key] });
    }
  }
}

function describeValueChange(before, after) {
  if (before === undefined) return '新增';
  if (after === undefined) return '删除';
  if (describeType(before) !== describeType(after)) return `类型变化 ${describeType(before)} → ${describeType(after)}`;
  if (Array.isArray(before) && Array.isArray(after)) {
    return `集合修改（${before.length} → ${after.length}）`;
  }
  return '修改';
}

function milestoneLabel(key) {
  return { title: '标题', date: '日期', owner: '负责人', done: '完成' }[key] || key;
}

export function createExportBundle(records) {
  return {
    kind: 'snapshot-time-machine-export',
    formatVersion: FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    count: records.length,
    records: orderRecords(records).map((record) => cloneJson(record))
  };
}

export async function createLegacyV1Sample(createdAt = Date.now()) {
  const rawState = {
    schemaVersion: 1,
    values: {
      projectName: '旧版客户问卷',
      owner: '陈序',
      priority: 'P0',
      startDate: '2026-09-01',
      budget: 0,
      tags: '合规,体验',
      budgetText: '¥25,000',
      riskLevel: '高',
      confirmed: 'yes',
      notes: '这是旧版文本备注，迁移后不能丢失。'
    },
    milestones: [
      { title: '旧版字段评审', owner: '陈序' }
    ],
    customApproval: { approver: '质量组', required: true }
  };
  const stateHash = await hashJson(rawState);
  return {
    id: makeId('snapshot'),
    formatVersion: FORMAT_VERSION,
    schemaVersion: 1,
    name: '兼容示例：v1 字段迁移',
    createdAt,
    parentId: null,
    parentName: null,
    stateHash,
    reason: 'legacy-sample',
    ancestryCount: 0,
    compression: {
      kind: 'full',
      rawState,
      ops: [],
      byteSize: byteLength(stableStringify(rawState)),
      fullByteSize: byteLength(stableStringify(rawState)),
      parentHash: null
    }
  };
}
