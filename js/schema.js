/* 表单结构定义 + 状态版本迁移 + 类型矫正 */
'use strict';

const SCHEMA_VERSION = 3;          // 当前表单状态结构版本
const SNAPSHOT_FORMAT_VERSION = 2; // 当前快照文件格式版本

const FORM_SCHEMA = [
  {
    id: 'basic', title: '基本信息', fields: [
      { key: 'title',        label: '项目标题', type: 'text' },
      { key: 'code',         label: '项目编号', type: 'text' },
      { key: 'category',     label: '项目类别', type: 'select', options: ['科研', '工程', '服务', '其他'] },
      { key: 'startDate',    label: '开始日期', type: 'date' },
      { key: 'duration',     label: '周期(月)', type: 'number' },
      { key: 'confidential', label: '是否涉密', type: 'checkbox' },
    ],
  },
  {
    id: 'members', title: '项目成员', type: 'repeat', itemFields: [
      { key: 'name',  label: '姓名',     type: 'text' },
      { key: 'role',  label: '角色',     type: 'select', options: ['负责人', '骨干', '参与'] },
      { key: 'ratio', label: '投入比%',  type: 'number' },
    ],
  },
  {
    id: 'budget', title: '预算信息', fields: [
      { key: 'amount',   label: '预算金额', type: 'number' },          // v1 曾为字符串，v2 起为数字
      { key: 'currency', label: '币种',     type: 'select', options: ['CNY', 'USD', 'EUR'] },
      { key: 'payPlan',  label: '拨款方式', type: 'radio', options: ['一次性', '分期'] },
      { key: 'note',     label: '预算说明', type: 'textarea' },
    ],
  },
  {
    id: 'misc', title: '其他', fields: [
      { key: 'priority', label: '优先级',   type: 'radio', options: ['low', 'medium', 'high'] }, // v3 新增
      { key: 'tags',     label: '标签',     type: 'checkbox-group', options: ['紧急', '跨部门', '需评审', '涉外部'] },
      { key: 'desc',     label: '备注',     type: 'textarea' },
    ],
  },
];

/* 当前结构下所有字段 key 集合（repeat 组按数组处理） */
function schemaFieldKeys() {
  const keys = [];
  for (const g of FORM_SCHEMA) {
    if (g.type === 'repeat') { keys.push(g.id); continue; }
    for (const f of g.fields) keys.push(f.key);
  }
  return keys;
}

function defaultState() {
  const s = { __v: SCHEMA_VERSION };
  for (const g of FORM_SCHEMA) {
    if (g.type === 'repeat') { s[g.id] = []; continue; }
    for (const f of g.fields) s[f.key] = defaultValue(f);
  }
  return s;
}

function defaultValue(f) {
  switch (f.type) {
    case 'number': return 0;
    case 'checkbox': return false;
    case 'checkbox-group': return [];
    case 'radio': return f.options[0];
    case 'select': return f.options[0];
    default: return '';
  }
}

/* 类型矫正：把任意值安全地转成字段声明类型，失败时回退默认值 */
function coerceValue(f, v) {
  try {
    switch (f.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(n) ? n : 0;
      }
      case 'checkbox': return v === true || v === 'true' || v === 1;
      case 'checkbox-group': return Array.isArray(v) ? v.filter(x => f.options.includes(x)) : [];
      case 'radio':
      case 'select': return f.options.includes(v) ? v : f.options[0];
      case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
      default: return v == null ? '' : String(v);
    }
  } catch { return defaultValue(f); }
}

/* 状态迁移链：__v 从旧版本逐级升到 SCHEMA_VERSION */
const STATE_MIGRATIONS = {
  1: (s) => { // v1 -> v2：amount 由字符串（可含 ¥、逗号）改为数字
    if (typeof s.amount === 'string') {
      s.amount = parseFloat(s.amount.replace(/[^0-9.\-]/g, '')) || 0;
    }
    s.__v = 2;
    return s;
  },
  2: (s) => { // v2 -> v3：新增 priority 字段
    if (s.priority === undefined) s.priority = 'medium';
    s.__v = 3;
    return s;
  },
};

/* 恢复任意旧版本状态：迁移 + 类型矫正 + 保留未知字段（不丢数据） */
function normalizeState(raw) {
  let s = (raw && typeof raw === 'object') ? JSON.parse(JSON.stringify(raw)) : {};
  let v = Number(s.__v) || 1;
  while (v < SCHEMA_VERSION && STATE_MIGRATIONS[v]) { s = STATE_MIGRATIONS[v](s); v = s.__v; }
  s.__v = SCHEMA_VERSION;

  const known = new Set(schemaFieldKeys());
  const out = { __v: SCHEMA_VERSION };
  for (const g of FORM_SCHEMA) {
    if (g.type === 'repeat') {
      const rows = Array.isArray(s[g.id]) ? s[g.id] : [];
      out[g.id] = rows.map(row => {
        const r = {};
        for (const f of g.itemFields) r[f.key] = coerceValue(f, row ? row[f.key] : undefined);
        return r;
      });
      continue;
    }
    for (const f of g.fields) out[f.key] = coerceValue(f, s[f.key]);
  }
  // 未知/已删除字段保留到 _legacy，保证不丢数据
  const legacy = {};
  for (const k of Object.keys(s)) {
    if (k === '__v' || k === '_legacy') continue;
    if (!known.has(k)) legacy[k] = s[k];
  }
  if (s._legacy && typeof s._legacy === 'object') Object.assign(legacy, s._legacy);
  if (Object.keys(legacy).length) out._legacy = legacy;
  return out;
}

/* 状态 -> 扁平路径 map，用于 diff。路径如 members[0].name */
function flattenState(state, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(state)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      if (v.length === 0) out[path] = '[]';
      v.forEach((item, i) => {
        if (item && typeof item === 'object') flattenState(item, `${path}[${i}]`, out);
        else out[`${path}[${i}]`] = item;
      });
    } else if (v && typeof v === 'object') {
      flattenState(v, path, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

function diffStates(a, b) {
  const fa = flattenState(a), fb = flattenState(b);
  const rows = [];
  for (const k of Object.keys(fa)) {
    if (!(k in fb)) rows.push({ path: k, type: 'removed', from: fa[k], to: '' });
    else if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) rows.push({ path: k, type: 'changed', from: fa[k], to: fb[k] });
  }
  for (const k of Object.keys(fb)) {
    if (!(k in fa)) rows.push({ path: k, type: 'added', from: '', to: fb[k] });
  }
  return rows;
}
