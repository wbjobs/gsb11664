// Application orchestration: persistence + form + timeline + rollback flows.
import * as DB from './lib/db.js';
import {
  DEFAULT_SCHEMA, createEmptyState, normalizeLoadedState,
  migrateStateToSchema, evolveSchema, validateStateShape,
} from './lib/schema.js';
import { CompressionClient, packSync, unpackSync } from './lib/worker-client.js';
import { assertSerializable } from './lib/serialize.js';
import {
  createSnapshot, renameSnapshot, buildExportBundle, prepareImport,
  layoutTimeline, findLCA, planRollback, findHeads, buildIndex,
} from './lib/snapshot.js';
import { diffStates, diffSnapshots, threeWayMerge, resolveConflicts } from './lib/diff.js';
import { FormView } from './ui/form-view.js';
import { TimelineCanvas } from './ui/timeline.js';
import { modal, promptModal, confirmModal, toast } from './ui/modal.js';
import { openSchemaTools } from './ui/schema-tools.js';
import { debounce, deepClone, deepEqual, formatBytes, formatTime, escapeHtml, humanJson, nowIso } from './lib/util.js';

class App {
  constructor() {
    this.db = null;
    this.schemas = [];
    this.schema = DEFAULT_SCHEMA;
    this.state = null;
    this.snapshots = []; // records WITH state attached
    this.baseId = null; // snapshot the draft was created from
    this.selectedId = null;
    this.client = new CompressionClient();
    this.autoSnapshot = true;
    this.replay = { timer: null, index: -1, chain: [], playing: false };
    this._lastSavedDraftKey = '';
  }

  async init() {
    try {
      this.db = await DB.initDB();
    } catch (e) {
      this.showFatal(`IndexedDB 初始化失败：${e.message}`);
      return;
    }
    this.schemas = await DB.getAllSchemas(this.db);
    this.schema = this.schemas[this.schemas.length - 1] || DEFAULT_SCHEMA;

    const records = await DB.getAllSnapshotRecords(this.db);
    this.snapshots = [];
    for (const record of records) {
      try {
        const state = DB.decodeSnapshotFrame(record);
        this.snapshots.push(stripFrame({ ...record, state }));
      } catch (e) {
        toast(`快照 ${record.name || record.id} 无法读取：${e.message}`, 'error', 6000);
      }
    }

    const draft = await DB.loadDraft(this.db);
    const meta = await DB.loadMeta(this.db);
    this.baseId = meta?.baseId || this.snapshots[this.snapshots.length - 1]?.id || null;
    this.autoSnapshot = meta?.autoSnapshot !== false;
    document.getElementById('autosnapToggle').checked = this.autoSnapshot;

    if (draft?.state) {
      try {
        const { state, log } = normalizeLoadedState(draft.state, this.schema, this.schemas);
        this.state = state;
        if (log.length) console.info('[draft migration]', log);
      } catch (e) {
        toast(`草稿恢复失败（${e.message}），使用空表单`, 'error');
        this.state = createEmptyState(this.schema);
      }
    } else if (this.baseId) {
      const base = this.snapshots.find((s) => s.id === this.baseId);
      this.state = base ? this.materialize(base) : createEmptyState(this.schema);
    } else {
      this.state = createEmptyState(this.schema);
    }

    this.form = new FormView(document.getElementById('complexForm'), {
      onDirty: (state) => this.onFormDirty(state),
    });
    this.form.render(this.schema, this.state);

    this.timeline = new TimelineCanvas(document.getElementById('timelineCanvas'), {
      onSelect: (id) => this.selectSnapshot(id),
      getTooltip: (id, event) => this.showCanvasTooltip(id, event),
    });
    this.timeline.setData(this.snapshots, { baseId: this.baseId });

    this.bindUI();
    this.refreshSnapshotList();
    this.refreshComparePickers();
    this.updateBadges();
    this.hideTooltipOnLeave();
    toast(`已加载 ${this.snapshots.length} 个快照，schema v${this.schema.schemaVersion}`, 'ok', 2200);
  }

  materialize(snap) {
    // Migrate an older snapshot's state onto the currently active schema.
    if (snap.schemaVersion === this.schema.schemaVersion) return deepClone(snap.state);
    const snapSchema = this.schemas.find((s) => s.schemaVersion === snap.schemaVersion);
    if (!snapSchema) return deepClone(snap.state);
    const { state, log } = migrateStateToSchema(snap.state, snapSchema, this.schema);
    console.info('[snapshot materialize]', log);
    return state;
  }

  showFatal(message) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="padding:20px;color:#ffb3bd;background:#3a1520">${escapeHtml(message)}</div>`);
  }

  bindUI() {
    document.getElementById('snapshotBtn').addEventListener('click', () => this.createSnapshotFlow('manual'));
    document.getElementById('schemaBtn').addEventListener('click', () => this.openSchemaTools());
    document.getElementById('autosnapToggle').addEventListener('change', async (e) => {
      this.autoSnapshot = e.target.checked;
      await DB.saveMeta(this.db, { baseId: this.baseId, autoSnapshot: this.autoSnapshot });
    });
    document.getElementById('exportBtn').addEventListener('click', () => this.exportSnapshots());
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', (e) => this.importSnapshots(e));

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.querySelector(`.tabpane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
        if (tab.dataset.tab === 'timeline') requestAnimationFrame(() => this.timeline.draw());
      });
    });

    document.getElementById('snapshotSearch').addEventListener('input', (e) => this.refreshSnapshotList(e.target.value));
    document.getElementById('compareA').addEventListener('change', () => this.runCompare());
    document.getElementById('compareB').addEventListener('change', () => this.runCompare());

    document.getElementById('replayFirstBtn').addEventListener('click', () => this.replayStep('first'));
    document.getElementById('replayPrevBtn').addEventListener('click', () => this.replayStep('prev'));
    document.getElementById('replayNextBtn').addEventListener('click', () => this.replayStep('next'));
    document.getElementById('replayLastBtn').addEventListener('click', () => this.replayStep('last'));
    document.getElementById('replayPlayBtn').addEventListener('click', () => this.toggleReplayPlay());

    this._draftSaver = debounce(() => this.persistDraft(), 400);
  }

  // ---- draft / dirty state ------------------------------------------------

  onFormDirty(state) {
    if (!state) return;
    // Preserve removed storage that the form does not render as inputs.
    state.removed = this.state.removed;
    state.typeChanges = this.state.typeChanges;
    state.stateVersion = this.state.stateVersion;
    state.schemaVersion = this.state.schemaVersion;
    this.state = state;
    this._draftSaver();
    this.updateBadges();
  }

  async persistDraft() {
    try {
      const synced = this.form?.collect();
      if (synced) {
        synced.removed = this.state.removed;
        synced.typeChanges = this.state.typeChanges;
        synced.stateVersion = this.state.stateVersion;
        synced.schemaVersion = this.state.schemaVersion;
        this.state = synced;
      }
      assertSerializable(this.state);
      await DB.saveDraft(this.db, this.state, { baseId: this.baseId });
    } catch (e) {
      toast(`草稿未保存：${e.message}`, 'error', 5000);
    }
  }

  updateBadges() {
    const badge = document.getElementById('dirtyBadge');
    const schemaBadge = document.getElementById('schemaBadge');
    schemaBadge.textContent = `state v${this.state.stateVersion} · schema v${this.state.schemaVersion}`;
    const base = this.snapshots.find((s) => s.id === this.baseId);
    const dirty = base ? !deepEqual(this.state, base.state) : this.snapshots.length > 0;
    badge.classList.toggle('hidden', !dirty);
    badge.textContent = dirty ? '未保存修改' : '';
    this.timeline?.setHighlight({ baseId: this.baseId, selectedId: this.selectedId });
  }

  // ---- snapshot create ----------------------------------------------------

  async createSnapshotFlow(reason = 'manual', overrides = {}) {
    if (this.replay?.playing) return null;
    const currentState = this.form.collect() || this.state;
    currentState.removed = this.state.removed;
    currentState.typeChanges = this.state.typeChanges;
    currentState.stateVersion = this.state.stateVersion;
    currentState.schemaVersion = this.state.schemaVersion;
    this.state = currentState;

    const problems = validateStateShape(this.state, this.schema);
    try {
      assertSerializable(this.state);
    } catch (e) {
      toast(`当前状态无法序列化：${e.message}`, 'error', 5000);
      return null;
    }
    if (problems.length) toast(`状态结构警告：${problems.join('；')}`, 'warn', 5000);

    // Duplicate-state guard: snapshotting an unchanged state is pointless,
    // but never blocks data the user explicitly wants saved.
    const base = this.snapshots.find((s) => s.id === this.baseId);
    if (base && deepEqual(this.state, base.state) && reason !== 'manual') {
      // Auto checkpoints must not litter the timeline with zero-diff commits.
      return null;
    }
    if (base && deepEqual(this.state, base.state) && reason === 'manual') {
      const proceed = await confirmModal({
        title: '内容与基线快照相同',
        message: '当前表单与基线快照完全一致，仍要创建快照吗？',
        confirmText: '仍然创建',
      });
      if (!proceed) return null;
    }

    let name = overrides.name;
    if (reason === 'manual' && !name) {
      name = await promptModal({ title: '为这个快照命名', label: '快照名称', placeholder: '例如：投递前最终版' });
      if (name === null) return null;
    }

    let pack;
    try {
      pack = await this.client.pack(this.state);
    } catch (e) {
      toast(`Worker 压缩失败，改用主线程：${e.message}`, 'warn', 4000);
      this.client.disabled = true;
      pack = packSync(this.state);
    }

    const meta = createSnapshot({
      name: name || '',
      state: this.state,
      schema: this.schema,
      parentId: this.baseId,
      reason,
      metrics: {
        compressedSize: pack.compressedSize,
        compression: { method: pack.method, ratio: pack.rawSize ? pack.compressedSize / pack.rawSize : 1 },
      },
    });
    await DB.putSnapshotRecord(this.db, meta, pack.frame);
    const stored = stripFrame({ ...deepClone(meta), state: deepClone(this.state) });
    this.snapshots.push(stored);
    this.baseId = meta.id;
    this.selectedId = meta.id;
    await DB.saveMeta(this.db, { baseId: this.baseId, autoSnapshot: this.autoSnapshot });
    await DB.saveDraft(this.db, this.state, { baseId: this.baseId });

    this.refreshAll(meta.id);
    const savedPct = pack.rawSize ? Math.round((1 - pack.compressedSize / pack.rawSize) * 100) : 0;
    toast(`快照已保存（${pack.method}${pack.compressed ? `，压缩 ${savedPct}%` : '，无需压缩'}）`, 'ok');
    return meta;
  }

  refreshAll(focusId = this.selectedId) {
    this.snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.timeline.setData(this.snapshots, { selectedId: focusId, baseId: this.baseId, replayId: this.replay.chain[this.replay.index] || null });
    this.refreshSnapshotList(document.getElementById('snapshotSearch')?.value || '');
    this.refreshComparePickers();
    this.updateBadges();
    if (focusId) this.showSnapshotDetail(focusId);
  }

  // ---- snapshot list / detail / rename ------------------------------------

  refreshSnapshotList(filter = '') {
    const ul = document.getElementById('snapshotList');
    if (!ul) return;
    const items = [...this.snapshots]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));
    ul.innerHTML = '';
    for (const snap of items) {
      const li = document.createElement('li');
      li.className = 'snap-item';
      if (snap.id === this.selectedId) li.classList.add('selected');
      if (snap.id === this.baseId) li.dataset.base = '1';
      const ratio = snap.compression?.ratio;
      const ratioText = ratio ? `${Math.round((1 - ratio) * 100)}% ↓` : '-';
      const reasonClass = { manual: '', auto: 'pill-auto', rollback: 'pill-rollback', checkpoint: 'pill-auto', import: 'pill-import' }[snap.reason] || '';
      li.innerHTML = `
        <div class="si-top">
          <span class="si-name">${escapeHtml(snap.name)}${snap.id === this.baseId ? ' <span class="pill pill-root">当前基线</span>' : ''}</span>
          <span class="si-time">${formatTime(snap.createdAt)}</span>
        </div>
        <div class="si-meta">
          <span class="pill ${reasonClass}">${escapeHtml(snap.reason)}</span>
          <span>schema v${snap.schemaVersion}</span>
          <span>原始 ${formatBytes(snap.stateSize)}</span>
          <span>帧 ${formatBytes(snap.compressedSize || snap.stateSize)} (${ratioText})</span>
          <span>crc ${(snap.stateChecksum >>> 0).toString(16)}</span>
        </div>
        <div class="si-actions"></div>`;
      const actions = li.querySelector('.si-actions');
      const mkBtn = (text, fn, danger = false) => {
        const b = document.createElement('button');
        b.className = `btn btn-small ${danger ? 'btn-danger' : ''}`;
        b.textContent = text;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        actions.appendChild(b);
      };
      mkBtn('查看', () => this.selectSnapshot(snap.id));
      mkBtn('重命名', () => this.renameSnapshotFlow(snap.id));
      mkBtn('对比当前', () => this.compareWithDraft(snap.id));
      mkBtn('回滚', () => this.rollbackFlow(snap.id), true);
      li.addEventListener('click', () => this.selectSnapshot(snap.id));
      ul.appendChild(li);
    }
    if (items.length === 0) {
      ul.innerHTML = '<li class="muted" style="list-style:none">还没有快照，点击上方“保存当前为快照”。</li>';
    }
  }

  async renameSnapshotFlow(id) {
    const snap = this.snapshots.find((s) => s.id === id);
    if (!snap) return;
    const name = await promptModal({ title: '重命名快照', initialValue: snap.name });
    if (name === null || !name.trim()) return;
    const renamed = renameSnapshot(snap, name);
    Object.assign(snap, { name: renamed.name, renamedAt: renamed.renamedAt });
    // Rewrite record preserving the frame.
    const record = await DB.getSnapshotRecord(this.db, id);
    await DB.putSnapshotRecord(this.db, { ...stripFrame(snap) }, record.frame);
    this.refreshAll(id);
    toast('快照已重命名', 'ok');
  }

  selectSnapshot(id) {
    this.selectedId = id;
    this.timeline.setHighlight({ selectedId: id, baseId: this.baseId });
    this.refreshSnapshotList(document.getElementById('snapshotSearch')?.value || '');
    this.showSnapshotDetail(id);
  }

  async showSnapshotDetail(id) {
    const snap = this.snapshots.find((s) => s.id === id);
    const el = document.getElementById('snapshotDetail');
    if (!snap) {
      el.innerHTML = '<p class="muted">快照不存在。</p>';
      return;
    }
    const parent = snap.parentId ? this.snapshots.find((s) => s.id === snap.parentId) : null;
    el.innerHTML = `
      <dl>
        <dt>名称</dt><dd><b>${escapeHtml(snap.name)}</b></dd>
        <dt>时间</dt><dd>${formatTime(snap.createdAt)}</dd>
        <dt>类型</dt><dd>${escapeHtml(snap.reason)}${snap.imported ? '（导入）' : ''}</dd>
        <dt>版本</dt><dd>record v${snap.recordVersion} · state v${snap.stateVersion} · schema v${snap.schemaVersion}</dd>
        <dt>父快照</dt><dd>${parent ? escapeHtml(parent.name) : '（根节点）'}</dd>
        <dt>校验</dt><dd>crc ${(snap.stateChecksum >>> 0).toString(16)} · 原始 ${formatBytes(snap.stateSize)} · 帧 ${formatBytes(snap.compressedSize || snap.stateSize)}</dd>
        ${snap.description ? `<dt>备注</dt><dd>${escapeHtml(snap.description)}</dd>` : ''}
      </dl>
      <div class="detail-actions"></div>`;
    const actions = el.querySelector('.detail-actions');
    const add = (text, fn, primary = false) => {
      const b = document.createElement('button');
      b.className = `btn btn-small ${primary ? 'btn-primary' : ''}`;
      b.textContent = text;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    add('回滚到此快照', () => this.rollbackFlow(id), true);
    add('与当前草稿对比', () => this.compareWithDraft(id));
    add('作为回放起点', () => this.startReplayFrom(id));
  }

  showCanvasTooltip(id, event) {
    const tip = document.getElementById('canvasTooltip');
    if (!id) { tip.classList.add('hidden'); return; }
    const snap = this.snapshots.find((s) => s.id === id);
    if (!snap) return;
    tip.innerHTML = `<b>${escapeHtml(snap.name)}</b>
      <span>${formatTime(snap.createdAt)} · ${snap.reason} · schema v${snap.schemaVersion}</span>
      <span>${formatBytes(snap.stateSize)} → ${formatBytes(snap.compressedSize || snap.stateSize)}</span>`;
    tip.classList.remove('hidden');
    const wrap = tip.parentElement.getBoundingClientRect();
    const x = Math.min(event.offsetX + 14, wrap.width - 250);
    const y = Math.max(8, event.offsetY - 60);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  hideTooltipOnLeave() {
    const canvas = document.getElementById('timelineCanvas');
    canvas.addEventListener('mouseleave', () => document.getElementById('canvasTooltip').classList.add('hidden'));
  }

  // ---- rollback with conflict detection -----------------------------------

  async rollbackFlow(targetId) {
    const plan = planRollback({
      snapshots: this.snapshots,
      targetId,
      workingState: this.state,
      baseId: this.baseId,
    });
    const targetState = this.materialize(plan.target);

    // Save dirty edits first so rollback can never lose data.
    let checkpointId = null;
    if (plan.dirty) {
      const confirmed = await confirmModal({
        title: '检测到未保存修改',
        message: '回滚前会把当前修改保存为“回滚前检查点”，之后再执行回滚。检查点保留在时间线上，可随时找回。是否继续？',
        confirmText: '保存检查点并继续',
      });
      if (!confirmed) return;
      const cp = await this.createSnapshotFlow('checkpoint', {
        name: `回滚前检查点 @ ${formatTime(nowIso())}`,
      });
      if (!cp) return;
      checkpointId = cp.id;
    }

    if (plan.base && this.baseId !== targetId) {
      // Three-way merge across branches: LCA vs current base vs target.
      const byId = buildIndex(this.snapshots).byId;
      const lcaId = findLCA(this.baseId, targetId, byId);
      const lcaSnap = lcaId ? byId.get(lcaId) : null;
      const baseSnap = byId.get(this.baseId);
      if (lcaSnap && baseSnap) {
        const lcaState = this.materialize(lcaSnap);
        const baseState = this.materialize(baseSnap);
        // If a checkpoint was just made it equals current state; otherwise
        // draft equals base. Merge using states on current schema.
        const merge = threeWayMerge({
          base: lcaState,
          ours: baseState,
          theirs: targetState,
          schema: this.schema,
        });
        if (merge.hasConflicts) {
          const resolvedState = await this.resolveConflictModal(merge, plan.target.name);
          if (!resolvedState) return;
          await this.commitRollback(plan.target, resolvedState, { checkpointId, merged: true });
          return;
        }
      }
    }

    const targetIsIdentical = deepEqual(this.state, targetState);
    const confirmed = targetIsIdentical ? true : await confirmModal({
      title: `回滚到「${plan.target.name}」？`,
      message: plan.onCurrentBranch
        ? '将创建一个新的回滚快照（历史不会被覆盖或删除），表单内容恢复为该快照。'
        : '目标位于另一条时间线分支，将创建分支回滚快照；无冲突字段会自动合并。',
      confirmText: '执行回滚',
      danger: true,
    });
    if (!confirmed) return;
    await this.commitRollback(plan.target, targetState, { checkpointId });
  }

  async commitRollback(target, state, { checkpointId, merged = false } = {}) {
    let pack;
    try {
      pack = await this.client.pack(state);
    } catch {
      this.client.disabled = true;
      pack = packSync(state);
    }
    const meta = createSnapshot({
      name: `回滚：${target.name}`,
      state,
      schema: this.schema,
      parentId: this.baseId,
      reason: 'rollback',
      description: `回滚到快照 ${target.id}${merged ? '（冲突已人工解决后合并）' : ''}${checkpointId ? `，检查点 ${checkpointId}` : ''}`,
      metrics: {
        compressedSize: pack.compressedSize,
        compression: { method: pack.method, ratio: pack.rawSize ? pack.compressedSize / pack.rawSize : 1 },
      },
    });
    await DB.putSnapshotRecord(this.db, meta, pack.frame);
    this.snapshots.push(stripFrame({ ...deepClone(meta), state: deepClone(state) }));
    this.state = deepClone(state);
    this.baseId = meta.id;
    this.form.render(this.schema, this.state);
    await DB.saveDraft(this.db, this.state, { baseId: this.baseId });
    await DB.saveMeta(this.db, { baseId: this.baseId, autoSnapshot: this.autoSnapshot });
    this.refreshAll(meta.id);
    toast('回滚完成：已生成新的回滚快照，历史完整保留', 'ok', 4200);
  }

  resolveConflictModal(merge, targetName) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="warn-box">
          检测到 <b>${merge.conflicts.length}</b> 个字段冲突（共同祖先 vs 当前分支 vs 目标「${escapeHtml(targetName)}」）。
          非冲突字段已自动合并；请逐字段选择保留哪边。所有选项都会被记录，不会静默丢数据。
        </div>
        <div id="conflictList"></div>
        <p class="muted">共同祖先值（base）用于参考；删除与修改冲突也会列出。</p>`;
      const list = body.querySelector('#conflictList');
      const decisions = new Map();
      for (const c of merge.conflicts) {
        decisions.set(c.path, 'ours');
        const item = document.createElement('div');
        item.className = 'conflict-item';
        const missing = (v) => v === undefined ? '<em style="color:#ef5b6e">（已删除）</em>' : humanJson(v);
        item.innerHTML = `
          <h4>${escapeHtml(c.path)} <span class="pill">${escapeHtml(c.kind)}</span></h4>
          <div class="conflict-opts">
            <button class="conflict-opt selected" data-choice="ours"><b>当前分支</b><pre>${escapeHtml(missing(c.ours))}</pre></button>
            <button class="conflict-opt" data-choice="theirs"><b>目标快照</b><pre>${escapeHtml(missing(c.theirs))}</pre></button>
            <button class="conflict-opt" data-choice="base"><b>共同祖先</b><pre>${escapeHtml(missing(c.base))}</pre></button>
          </div>`;
        item.querySelectorAll('.conflict-opt').forEach((btn) => {
          btn.addEventListener('click', () => {
            item.querySelectorAll('.conflict-opt').forEach((b) => b.classList.remove('selected'));
            btn.classList.add('selected');
            decisions.set(c.path, btn.dataset.choice);
          });
        });
        list.appendChild(item);
      }
      const m = modal({
        title: '回滚冲突需要人工解决',
        body,
        wide: true,
        footer: [
          { text: '取消回滚', onClick: ({ close }) => { close(); resolve(null); } },
          { text: `按选择合并（${merge.conflicts.length} 项）`, variant: 'primary', onClick: ({ close }) => {
            const resolutions = [...decisions.entries()].map(([path, resolution]) => ({ path, resolution }));
            const state = resolveConflicts(merge, resolutions);
            close();
            resolve(state);
          } },
        ],
      });
      void m;
    });
  }

  // ---- compare ------------------------------------------------------------

  refreshComparePickers() {
    for (const selectId of ['compareA', 'compareB']) {
      const select = document.getElementById(selectId);
      if (!select) continue;
      const current = select.value;
      select.innerHTML = this.snapshots.map((s) =>
        `<option value="${s.id}">${escapeHtml(`${s.name} · ${formatTime(s.createdAt)}`)}</option>`).join('');
      if (current && this.snapshots.some((s) => s.id === current)) select.value = current;
      else if (selectId === 'compareB' && this.snapshots.length > 1) select.value = this.snapshots[this.snapshots.length - 1].id;
      else if (this.snapshots.length > 0) select.value = this.snapshots[0].id;
    }
  }

  runCompare() {
    const aId = document.getElementById('compareA').value;
    const bId = document.getElementById('compareB').value;
    const out = document.getElementById('compareResult');
    const a = this.snapshots.find((s) => s.id === aId);
    const b = this.snapshots.find((s) => s.id === bId);
    if (!a || !b) {
      out.innerHTML = '<p class="muted">选择两个快照进行字段级对比。</p>';
      return;
    }
    let diff;
    if (a.schemaVersion === b.schemaVersion) {
      diff = diffStates(a.state, b.state);
    } else {
      diff = diffSnapshots(a, b,
        this.schemas.find((s) => s.schemaVersion === a.schemaVersion),
        this.schemas.find((s) => s.schemaVersion === b.schemaVersion));
    }
    this.renderDiff(out, diff, a.name, b.name);
  }

  compareWithDraft(id) {
    document.querySelector('.tab[data-tab="compare"]').click();
    const snap = this.snapshots.find((s) => s.id === id);
    // Build a transient compare: inject draft as ephemeral snapshot.
    const out = document.getElementById('compareResult');
    const targetState = this.materialize(snap);
    const diff = diffStates(targetState, this.state);
    this.renderDiff(out, diff, `${snap.name}（目标）`, '当前草稿');
    document.getElementById('compareA').value = id;
  }

  renderDiff(out, diff, nameA, nameB) {
    if (diff.total === 0) {
      out.innerHTML = '<div class="badge badge-ok">两个状态完全一致（含 removed 留存区与类型变更记录）。</div>';
      return;
    }
    const rows = [];
    for (const d of diff.added) {
      rows.push(`<div class="diff-row diff-added"><span class="diff-path">${escapeHtml(d.path)}</span>
        <span class="diff-val a muted">—</span><span class="diff-val b">${escapeHtml(humanJson(d.value))}</span></div>`);
    }
    for (const d of diff.removed) {
      rows.push(`<div class="diff-row diff-removed"><span class="diff-path">${escapeHtml(d.path)}</span>
        <span class="diff-val a">${escapeHtml(humanJson(d.value))}</span><span class="diff-val b muted">—</span></div>`);
    }
    for (const d of diff.changed) {
      rows.push(`<div class="diff-row diff-changed"><span class="diff-path">${escapeHtml(d.path)}</span>
        <span class="diff-val a">${escapeHtml(humanJson(d.oldValue))}</span>
        <span class="diff-val b">${escapeHtml(humanJson(d.newValue))}</span></div>`);
    }
    out.innerHTML = `
      <div class="diff-summary">
        <span class="badge badge-ok">新增 ${diff.added.length}</span>
        <span class="badge badge-danger">删除 ${diff.removed.length}</span>
        <span class="badge badge-warn">修改 ${diff.changed.length}</span>
      </div>
      <div class="diff-row" style="font-weight:600;color:#cdd5ff">
        <span>字段路径</span><span>${escapeHtml(nameA)}</span><span>${escapeHtml(nameB)}</span>
      </div>
      ${rows.join('')}`;
  }

  // ---- time travel replay -------------------------------------------------

  startReplayFrom(id) {
    const { byId } = buildIndex(this.snapshots);
    const chainIds = [];
    let cur = id;
    const guard = new Set();
    while (cur && byId.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      chainIds.unshift(cur);
      cur = byId.get(cur).parentId;
    }
    this.replay.chain = chainIds;
    this.replay.index = -1;
    this.replayStep('first');
    if (!this.replay.playing) this.toggleReplayPlay(true);
    toast(`时间旅行开始：共 ${chainIds.length} 个快照`, 'info', 2600);
  }

  replayStep(where) {
    const chain = this.replay.chain;
    if (chain.length === 0) {
      // Default: replay current branch from root.
      if (!this.baseId) return;
      this.startReplayFrom(this.baseId);
      return;
    }
    if (where === 'first') this.replay.index = 0;
    else if (where === 'last') this.replay.index = chain.length - 1;
    else if (where === 'prev') this.replay.index = Math.max(0, this.replay.index - 1);
    else if (where === 'next') this.replay.index = Math.min(chain.length - 1, this.replay.index + 1);
    else this.replay.index = Math.min(chain.length - 1, this.replay.index + 1);
    this.applyReplayFrame();
  }

  applyReplayFrame() {
    const id = this.replay.chain[this.replay.index];
    const snap = this.snapshots.find((s) => s.id === id);
    if (!snap) return;
    const state = this.materialize(snap);
    // Replay is view-only: it does not touch the working draft or baseline.
    this.timeline.setHighlight({ selectedId: id, baseId: this.baseId, replayId: id });
    this.form.render(this.schema, state);
    this.setFormReadonly(true);
    this.showSnapshotDetail(id);
    const pct = ((this.replay.index + 1) / this.replay.chain.length) * 100;
    document.getElementById('replayProgressBar').style.width = `${pct}%`;
    document.getElementById('replayPlayBtn').textContent =
      this.replay.index >= this.replay.chain.length - 1 && this.replay.playing
        ? '↻ 重新回放' : '▶ 时间旅行回放';
  }

  setFormReadonly(readonly) {
    this.form.root.querySelectorAll('input, textarea, select, button').forEach((el) => {
      if (readonly) el.setAttribute('disabled', 'disabled');
      else el.removeAttribute('disabled');
    });
    document.getElementById('snapshotBtn').disabled = readonly;
    const bannerId = 'replayBanner';
    const existing = document.getElementById(bannerId);
    if (readonly) {
      if (!existing) {
        const banner = document.createElement('div');
        banner.id = bannerId;
        banner.className = 'warn-box';
        banner.style.margin = '0 18px 12px';
        banner.textContent = '时间旅行回放中：当前为只读预览，点击“暂停回放”可返回正在编辑的草稿。';
        document.querySelector('.form-panel .complex-form').before(banner);
      }
    } else existing?.remove();
  }

  toggleReplayPlay(forcePlay = false) {
    if (this.replay.chain.length === 0) {
      this.startReplayFrom(this.baseId || this.snapshots[this.snapshots.length - 1]?.id);
      return;
    }
    if (this.replay.playing && !forcePlay) {
      clearInterval(this.replay.timer);
      this.replay.playing = false;
      document.getElementById('replayPlayBtn').textContent = '▶ 继续回放';
      // Restore working draft when leaving replay.
      this.form.render(this.schema, this.state);
      this.setFormReadonly(false);
      this.timeline.setHighlight({ replayId: null, selectedId: this.selectedId, baseId: this.baseId });
      return;
    }
    if (this.replay.index >= this.replay.chain.length - 1) this.replay.index = -1;
    this.replay.playing = true;
    document.getElementById('replayPlayBtn').textContent = '⏸ 暂停回放';
    const tick = () => {
      if (this.replay.index >= this.replay.chain.length - 1) {
        clearInterval(this.replay.timer);
        this.replay.playing = false;
        document.getElementById('replayPlayBtn').textContent = '↻ 重新回放';
        return;
      }
      this.replayStep('next');
    };
    tick();
    const speed = Number(document.getElementById('replaySpeed').value || 1000);
    clearInterval(this.replay.timer);
    this.replay.timer = setInterval(tick, speed);
  }

  // ---- export / import ----------------------------------------------------

  async exportSnapshots() {
    const withState = [];
    for (const snap of this.snapshots) {
      const record = await DB.getSnapshotRecord(this.db, snap.id);
      const state = DB.decodeSnapshotFrame(record);
      withState.push({ ...deepClone(snap), state });
    }
    const bundle = buildExportBundle({ snapshots: withState, schemas: this.schemas });
    const blob = new Blob([bundle.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = bundle.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${bundle.snapshotCount} 个快照（校验 ${bundle.checksum.toString(16)}）`, 'ok', 4000);
  }

  async importSnapshots(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    try {
      const result = prepareImport({
        bundleText: text,
        existingSnapshots: this.snapshots,
        existingSchemas: this.schemas,
      });
      for (const schema of result.schemasToAdd) await DB.putSchema(this.db, schema);
      for (const snap of result.imported) {
        const pack = this.client.disabled ? packSync(snap.state) : await this.client.pack(snap.state);
        const { state: importedState, ...metaRest } = snap;
        const meta = { ...metaRest, compressedSize: pack.compressedSize };
        await DB.putSnapshotRecord(this.db, meta, pack.frame);
        this.snapshots.push(stripFrame({ ...deepClone(meta), state: deepClone(importedState) }));
      }
      this.schemas = await DB.getAllSchemas(this.db);
      this.refreshAll(this.snapshots[this.snapshots.length - 1]?.id);
      const warn = result.problems.length
        ? `；${result.problems.length} 条提示（详见控制台）` : '';
      if (result.problems.length) console.warn('[import]', result.problems);
      toast(`导入成功：${result.imported.length} 个快照${warn}`, result.problems.length ? 'warn' : 'ok', 5200);
    } catch (e) {
      toast(`导入失败：${e.message}`, 'error', 6000);
      if (e.details?.problems) console.warn(e.details.problems);
    }
  }

  // ---- schema evolution tools --------------------------------------------

  openSchemaTools() {
    openSchemaTools({
      schemas: this.schemas,
      currentSchema: this.schema,
      currentState: this.state,
      onEvolve: (change) => this.applySchemaChange(change),
      onResetDemo: () => this.resetDemo(),
    });
  }

  async applySchemaChange(change) {
    const { schema: nextSchema, state: nextState, log } = evolveSchema(this.schema, this.state, change);
    this.schema = nextSchema;
    this.state = nextState;
    this.schemas.push(nextSchema);
    await DB.putSchema(this.db, nextSchema);
    await this.persistDraft();
    this.form.render(this.schema, this.state);
    this.refreshAll();
    toast(`schema 升级到 v${nextSchema.schemaVersion}`, 'warn', 3500);
    if (log.length) console.info('[schema evolution]', log);
  }

  async resetDemo() {
    await DB.clearAll(this.db);
    location.reload();
  }
}

function stripFrame(record) {
  const { frame, ...rest } = record;
  void frame;
  return rest;
}

// pagehide auto-checkpoint (async fire-and-forget; draft save remains fallback)
const app = new App();
window.__snapshotApp = app;
window.addEventListener('pagehide', () => {
  // Async checkpoint may finish before the page is discarded; the debounced
  // draft in IndexedDB is the guaranteed no-data-loss fallback.
  app.createSnapshotFlow?.('checkpoint', { name: '' }).catch(() => {});
});
app.init().catch((e) => {
  console.error(e);
  toast(`初始化失败：${e.message}`, 'error', 8000);
});
