import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeImport,
  cloneJson,
  createExportBundle,
  createLegacyV1Sample,
  createSnapshot,
  createStarterState,
  diffStates,
  equalJson,
  migrateState,
  normalizeState,
  reconstructAll
} from '../src/core.js';

test('delta snapshot reconstructs without losing any state', async () => {
  const firstState = createStarterState();
  const first = await createSnapshot({ state: firstState, name: 'first' });
  const secondState = normalizeState(firstState);
  secondState.values.projectName = '新名称';
  secondState.values.budget = 42;
  secondState.values.tags = ['安全', '性能'];
  secondState.milestones.push({ id: 'milestone_new', title: '新增', date: '2026-11-01', owner: 'A', done: false });
  const second = await createSnapshot({
    state: secondState,
    parentId: first.id,
    parentState: firstState,
    records: [first],
    name: 'second'
  });

  assert.equal(second.compression.kind, 'delta');
  assert.ok(second.compression.byteSize <= second.compression.fullByteSize);
  const items = await reconstructAll([first, second]);
  assert.equal(items.every((item) => item.ok), true);
  assert.deepEqual(items[1].state, normalizeState(secondState));
  assert.deepEqual(items[1].rawState, normalizeState(secondState));
});

test('v1 migration preserves deleted fields, type changes, and unknown root data', async () => {
  const legacy = await createLegacyV1Sample();
  const [item] = await reconstructAll([legacy]);
  assert.equal(item.ok, true);
  assert.equal(item.state.values.priority, 'P0');
  assert.equal(item.state.retired['values.riskLevel'].value, '高');
  assert.equal(item.state.values.riskAccepted, true);
  assert.deepEqual(item.state.values.tags, ['合规', '体验']);
  assert.equal(item.state.values.budget, 25000);
  assert.equal(item.state.retired['values.riskLevel'].value, '高');
  assert.equal(item.state.retired['values.tags@v2:string'].value, '合规,体验');
  assert.equal(item.state.foreignState, null);
  assert.equal(item.state.legacy['unknown.root.customApproval'].value.required, true);
});

test('future schema keeps complete raw payload and downgrades known fields', async () => {
  const rawState = {
    schemaVersion: 99,
    values: { projectName: '未来表单', futureFlag: ['a'] },
    milestones: [{ title: '未来里程碑' }],
    futureOnly: { nested: true }
  };
  const { hashJson } = await import('../src/core.js');
  const record = {
    id: 'snapshot_future',
    formatVersion: 1,
    schemaVersion: 99,
    name: 'future',
    createdAt: Date.now(),
    parentId: null,
    parentName: null,
    stateHash: await hashJson(rawState),
    reason: 'test',
    ancestryCount: 0,
    compression: { kind: 'full', rawState, ops: [], byteSize: 0, fullByteSize: 0, parentHash: null }
  };
  const [item] = await reconstructAll([record]);
  assert.equal(item.ok, true);
  assert.equal(item.state.values.projectName, '未来表单');
  assert.equal(item.state.foreignState.futureOnly.nested, true);
  assert.deepEqual(item.state.foreignState.values.futureFlag, ['a']);
  assert.match(item.warnings[0], /更高结构版本/);
});

test('field removal and type mismatch are preserved instead of silently dropped', () => {
  const migrated = migrateState({
    schemaVersion: 3,
    values: {
      projectName: '类型异常',
      budget: 'not-a-number',
      removedField: { kept: true }
    },
    milestones: [],
    futureRoot: [1, 2, 3]
  }, 3);
  assert.equal(migrated.values.projectName, '类型异常');
  assert.equal(migrated.legacy['typeMismatch.values.budget'].value, 'not-a-number');
  assert.equal(migrated.legacy['unknown.values.removedField'].value.kept, true);
  assert.deepEqual(migrated.legacy['unknown.root.futureRoot'].value, [1, 2, 3]);
});

test('rollback safety snapshot plus restore creates a branch and both states remain available', async () => {
  const original = createStarterState();
  const first = await createSnapshot({ state: original, name: '原始' });
  const changed = normalizeState(original);
  changed.values.projectName = '调整后的方向';
  changed.milestones[0].done = true;
  const second = await createSnapshot({
    state: changed,
    parentId: first.id,
    parentState: original,
    records: [first],
    name: '调整'
  });
  const safety = await createSnapshot({
    state: changed,
    parentId: second.id,
    parentState: changed,
    records: [first, second],
    name: '保护'
  });
  const restored = await createSnapshot({
    state: original,
    parentId: first.id,
    parentState: original,
    records: [first, second, safety],
    name: '回滚恢复'
  });

  const items = await reconstructAll([first, second, safety, restored]);
  assert.equal(items.every((item) => item.ok), true);
  assert.equal(restored.parentId, first.id);
  const findState = (record) => items.find((item) => item.record.id === record.id).state;
  assert.deepEqual(findState(restored), normalizeState(original));
  assert.deepEqual(findState(second), normalizeState(changed));
});

test('same snapshot id with different payload is a conflict', async () => {
  const first = await createSnapshot({ state: createStarterState(), name: 'A' });
  const divergent = cloneJson(first);
  divergent.name = 'Mutated';
  const analysis = await analyzeImport([divergent], [first]);
  assert.equal(analysis.ok, false);
  assert.equal(analysis.conflicts[0].kind, 'same-id-divergent');
});

test('missing delta parent and tampered state hash are rejected', async () => {
  const state = createStarterState();
  const first = await createSnapshot({ state, name: 'first' });
  const changed = normalizeState(state);
  changed.values.projectName = 'Delta 损坏测试';
  const second = await createSnapshot({
    state: changed,
    parentId: first.id,
    parentState: state,
    records: [first],
    name: 'second'
  });

  const orphanAnalysis = await analyzeImport([second], []);
  assert.equal(orphanAnalysis.ok, false);
  assert.equal(orphanAnalysis.conflicts.some((conflict) => conflict.kind === 'missing-parent'), true);

  const tampered = cloneJson(first);
  tampered.compression.rawState.values.projectName = '未更新哈希';
  const tamperedItems = await reconstructAll([tampered]);
  assert.equal(tamperedItems[0].ok, false);
  assert.match(tamperedItems[0].error, /stateHash/);
});

test('sibling snapshots with one parent are accepted as branches', async () => {
  const state = createStarterState();
  const first = await createSnapshot({ state, name: 'base' });
  const leftState = normalizeState(state);
  leftState.values.projectName = '分支 A';
  const left = await createSnapshot({
    state: leftState,
    parentId: first.id,
    parentState: state,
    records: [first],
    name: 'A'
  });
  const rightState = normalizeState(state);
  rightState.values.projectName = '分支 B';
  const right = await createSnapshot({
    state: rightState,
    parentId: first.id,
    parentState: state,
    records: [first, left],
    name: 'B'
  });
  const analysis = await analyzeImport([first, left, right], []);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.accepted.length, 3);
  assert.equal(right.parentId, first.id);
});

test('structured diff reports field, array, milestone and compatibility changes', async () => {
  const before = createStarterState();
  const after = normalizeState(before);
  after.values.projectName = '新名称';
  after.values.tags = ['安全'];
  after.milestones[0].done = !before.milestones[0].done;
  after.retired['values.old'] = { value: 'kept' };
  const changes = diffStates(before, after);
  assert.ok(changes.some((change) => change.path === 'values.projectName'));
  assert.ok(changes.some((change) => change.path === 'values.tags'));
  assert.ok(changes.some((change) => change.path.startsWith('milestones.')));
  assert.ok(changes.some((change) => change.category === '历史字段'));
});

test('export bundle round trip is serializable and accepted', async () => {
  const first = await createSnapshot({ state: createStarterState(), name: 'export' });
  const bundle = createExportBundle([first]);
  const reparsed = JSON.parse(JSON.stringify(bundle));
  const analysis = await analyzeImport(reparsed.records, []);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.accepted.length, 1);
  assert.equal(equalJson(analysis.records[0], first), true);
});
