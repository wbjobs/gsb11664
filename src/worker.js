import {
  createExportBundle,
  createLegacyV1Sample,
  createSnapshot,
  createStarterState,
  createDefaultState,
  analyzeImport,
  diffStates,
  equalJson,
  normalizeState,
  reconstructAll
} from './core.js';
import { getDraft, getRecords, saveDraft, saveRecords } from './db.js';

self.onmessage = async (event) => {
  const { requestId, action, payload = {} } = event.data || {};
  try {
    const result = await handleAction(action, payload);
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: error.message || String(error) });
  }
};

async function handleAction(action, payload) {
  switch (action) {
    case 'bootstrap':
      return bootstrap();
    case 'snapshot':
      return createNamedSnapshot(payload);
    case 'rename':
      return renameSnapshot(payload);
    case 'rollback':
      return rollback(payload);
    case 'saveDraft':
      return persistDraft(payload);
    case 'import':
      return importSnapshots(payload);
    case 'addLegacySample':
      return addLegacySample();
    case 'export':
      return exportSnapshots();
    case 'diff':
      return { changes: diffStates(payload.before, payload.after) };
    default:
      throw new Error(`未知 Worker 操作：${action}`);
  }
}

async function bootstrap() {
  let records = await getRecords();
  let draft = await getDraft();
  if (records.length === 0 && !draft) {
    const seeded = await seedRecords();
    records = seeded.records;
    draft = { state: seeded.state, baseSnapshotId: seeded.baseSnapshotId, updatedAt: Date.now() };
    await saveRecords(records);
    await saveDraft(draft);
  }
  const state = draft?.state ? normalizeState(draft.state) : createDefaultState();
  const reconstructed = await reconstructAll(records);
  return {
    state,
    baseSnapshotId: draft?.baseSnapshotId ?? null,
    records,
    reconstructed: attachDiffMetadata(reconstructed, state),
    exportBundle: createExportBundle(records)
  };
}

async function seedRecords() {
  const base = Date.now();
  const firstState = createStarterState();
  const first = await createSnapshot({
    state: firstState,
    name: '项目立项',
    reason: 'seed',
    createdAt: base - 86400000
  });

  const secondState = normalizeState(firstState);
  secondState.values.status = '评审中';
  secondState.values.progress = 60;
  secondState.values.riskAccepted = true;
  secondState.values.riskNote = '灰度方案已补充，剩余风险由评审会确认。';
  secondState.milestones[1].done = true;
  secondState.milestones.push({
    id: makeLocalId('milestone'),
    title: '灰度发布',
    date: '2026-10-24',
    owner: '运维值班',
    done: false
  });
  const second = await createSnapshot({
    state: secondState,
    parentId: first.id,
    parentState: firstState,
    records: [first],
    name: '评审通过',
    reason: 'seed',
    createdAt: base - 3600000
  });

  const legacy = await createLegacyV1Sample(base - 172800000);
  return { records: [first, second, legacy], state: secondState, baseSnapshotId: second.id };
}

function makeLocalId(prefix) {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
}

async function loadView() {
  const records = await getRecords();
  const draft = await getDraft();
  const reconstructed = await reconstructAll(records);
  const state = draft?.state ? normalizeState(draft.state) : createDefaultState();
  return { records, draft, reconstructed, state };
}

async function createNamedSnapshot(payload) {
  const { records, reconstructed } = await loadView();
  const state = normalizeState(payload.state);
  const parentId = payload.parentId || null;
  const parentItem = parentId ? reconstructed.find((item) => item.ok && item.record.id === parentId) : null;
  if (parentId && !parentItem) throw new Error('指定的父快照不存在或无法重建');

  const record = await createSnapshot({
    state,
    parentId,
    parentState: parentItem?.state ?? null,
    records,
    name: payload.name,
    reason: payload.reason || 'manual'
  });
  const nextRecords = [...records, record];
  await saveRecords(nextRecords);
  await saveDraft({ state, baseSnapshotId: record.id });
  return respond(nextRecords, state, record.id);
}

async function rollback(payload) {
  const { records, draft, reconstructed } = await loadView();
  const target = reconstructed.find((item) => item.ok && item.record.id === payload.targetId);
  if (!target) throw new Error('目标快照不存在或无法重建');
  const current = normalizeState(payload.state ?? draft?.state ?? createDefaultState());
  let nextRecords = records;
  let safety = null;

  if (!equalJson(current, target.state)) {
    const currentBase = draft?.baseSnapshotId ?? null;
    const baseItem = currentBase ? reconstructed.find((item) => item.ok && item.record.id === currentBase) : null;
    safety = await createSnapshot({
      state: current,
      parentId: baseItem ? baseItem.record.id : null,
      parentState: baseItem?.state ?? null,
      records,
      name: `回滚保护：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      reason: 'rollback-safety'
    });
    nextRecords = [...records, safety];
  }

  await saveRecords(nextRecords);
  await saveDraft({ state: target.state, baseSnapshotId: target.record.id });
  return respond(nextRecords, target.state, target.record.id, safety ? {
    safetySnapshotId: safety.id,
    message: '已先保存当前内容为“回滚保护”快照，然后恢复到目标快照。'
  } : { message: '当前内容与目标快照一致，已切换基准快照。' });
}

async function renameSnapshot(payload) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('快照名称不能为空');
  const records = await getRecords();
  const index = records.findIndex((record) => record.id === payload.id);
  if (index < 0) throw new Error('待重命名快照不存在');
  const nextRecords = records.map((record) => record.id === payload.id
    ? { ...record, name, renamedAt: Date.now() }
    : record
  );
  await saveRecords(nextRecords);
  return respond(nextRecords, null, null);
}

async function persistDraft(payload) {
  const state = normalizeState(payload.state);
  const draft = { state, baseSnapshotId: payload.baseSnapshotId ?? null, updatedAt: Date.now() };
  await saveDraft(draft);
  const records = await getRecords();
  const reconstructed = await reconstructAll(records);
  return {
    state,
    baseSnapshotId: draft.baseSnapshotId,
    records,
    reconstructed: attachDiffMetadata(reconstructed, state),
    savedAt: draft.updatedAt
  };
}

async function importSnapshots(payload) {
  const existing = await getRecords();
  const bundle = payload.bundle;
  const incoming = Array.isArray(bundle) ? bundle : bundle?.records;
  if (!Array.isArray(incoming)) throw new Error('导入文件必须是快照数组或导出包');
  const analysis = await analyzeImport(incoming, existing);
  if (!analysis.ok) return analysis;
  await saveRecords(analysis.records);
  return {
    ...analysis,
    ...await respond(analysis.records, null, null)
  };
}

async function addLegacySample() {
  const existing = await getRecords();
  const legacy = await createLegacyV1Sample();
  const analysis = await analyzeImport([legacy], existing);
  if (!analysis.ok) throw new Error(analysis.conflicts[0]?.message || '旧版示例快照无法加入');
  await saveRecords(analysis.records);
  return respond(analysis.records, null, null);
}

async function exportSnapshots() {
  const records = await getRecords();
  return { exportBundle: createExportBundle(records) };
}

async function respond(records, state, baseSnapshotId, extra = {}) {
  const reconstructed = await reconstructAll(records);
  return {
    records,
    reconstructed: attachDiffMetadata(reconstructed, state),
    ...(state ? { state: normalizeState(state), baseSnapshotId } : {}),
    ...extra
  };
}

function attachDiffMetadata(reconstructed, state) {
  return reconstructed.map((item) => {
    if (!item.ok || !state) return item;
    const changes = diffStates(item.state, state);
    return { ...item, currentDiffCount: changes.length, matchesCurrent: changes.length === 0 };
  });
}
