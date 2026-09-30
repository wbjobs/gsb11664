/* 主控：装配表单、快照、时间线、回放、对比、导入导出 */
'use strict';

const App = (() => {
  let snaps = [];
  let selectedId = null;
  let lastSavedHash = null;   // 最近一次快照/载入时的状态哈希
  let replayTimer = null;
  let replayIdx = -1;

  const $ = (id) => document.getElementById(id);

  function log(msg, level = 'info') {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (level !== 'info') li.className = level;
    $('log').prepend(li);
  }

  /* ---------- 状态与脏检查 ---------- */
  async function currentHash() {
    return SnapshotManager.stateHash(FormUI.readState());
  }

  async function refreshDirty() {
    const h = await currentHash();
    $('dirtyBadge').classList.toggle('hidden', h === lastSavedHash);
    return h;
  }

  let saveTimer = null;
  function onFormChange() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await DB.kvSet('currentState', FormUI.readState()); // 状态可序列化：刷新不丢
      refreshDirty();
    }, 300);
  }

  /* ---------- 快照列表 ---------- */
  async function reload() {
    snaps = await DB.allSnapshots();
    Timeline.setData(snaps);
    $('snapCount').textContent = `(${snaps.length})`;
    const ul = $('snapshotList');
    ul.innerHTML = '';
    for (const s of [...snaps].reverse()) {
      const li = document.createElement('li');
      li.dataset.id = s.id;
      if (s.id === selectedId) li.classList.add('selected');
      const tagClass = s.kind === 'manual' ? '' : s.kind === 'auto-backup' ? 'auto' : s.kind === 'conflict-backup' ? 'conflict' : '';
      const tagText = { manual: '手动', 'auto-backup': '自动', 'conflict-backup': '冲突', imported: '导入' }[s.kind] || '手动';
      li.innerHTML = `
        <span class="name" title=""></span>
        <span class="tag ${tagClass}">${tagText}</span>
        <span class="muted">${new Date(s.createdAt).toLocaleTimeString()}</span>
        <span class="ops">
          <button data-op="rollback">回滚</button>
          <button data-op="rename">改名</button>
          <button data-op="del" class="danger">删</button>
        </span>`;
      li.querySelector('.name').textContent = s.name;
      li.querySelector('.name').title = `${s.name} · ${s.rawSize}B→${s.size}B · hash ${s.hash.slice(0, 8)}`;
      li.addEventListener('click', (e) => {
        const op = e.target.dataset && e.target.dataset.op;
        if (op === 'rollback') return rollbackTo(s.id);
        if (op === 'rename') return renameSnapshot(s.id);
        if (op === 'del') return removeSnapshot(s.id);
        selectSnapshot(s.id);
      });
      ul.appendChild(li);
    }
    // diff 下拉
    for (const sel of [$('diffA'), $('diffB')]) {
      const prev = sel.value;
      sel.innerHTML = '';
      for (const s of snaps) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.name} (${new Date(s.createdAt).toLocaleTimeString()})`;
        sel.appendChild(o);
      }
      if (prev) sel.value = prev;
    }
    if (snaps.length >= 2) {
      $('diffA').value = $('diffA').value || snaps[0].id;
      $('diffB').value = $('diffB').value || snaps[snaps.length - 1].id;
    }
  }

  function selectSnapshot(id) {
    selectedId = id;
    Timeline.setSelected(id);
    document.querySelectorAll('#snapshotList li').forEach(li =>
      li.classList.toggle('selected', li.dataset.id === id));
  }

  /* ---------- 创建 / 改名 / 删除 ---------- */
  async function createSnapshot(name, kind = 'manual') {
    const snap = await SnapshotManager.create(FormUI.readState(), { name, kind });
    lastSavedHash = snap.hash;
    await DB.kvSet('currentState', FormUI.readState());
    await reload();
    refreshDirty();
    return snap;
  }

  function askCreateSnapshot() {
    const dlg = $('nameDialog');
    $('snapshotName').value = '';
    dlg.showModal();
    $('snapshotName').focus();
    $('btnConfirmSnapshot').onclick = async (e) => {
      e.preventDefault();
      dlg.close();
      const name = $('snapshotName').value.trim() || undefined;
      const snap = await createSnapshot(name);
      log(`创建快照「${snap.name}」(${snap.rawSize}B → ${snap.size}B，${snap.compressed.algo} 压缩)`);
    };
  }

  async function renameSnapshot(id) {
    const s = snaps.find(x => x.id === id);
    if (!s) return;
    const name = prompt('重命名快照：', s.name);
    if (!name || !name.trim()) return;
    s.name = name.trim();
    await DB.putSnapshot(s);
    await reload();
    log(`快照已重命名为「${s.name}」`);
  }

  async function removeSnapshot(id) {
    const s = snaps.find(x => x.id === id);
    if (!s || !confirm(`删除快照「${s.name}」？`)) return;
    await DB.deleteSnapshot(id);
    if (selectedId === id) selectedId = null;
    await reload();
    log(`已删除快照「${s.name}」`, 'warn');
  }

  /* ---------- 回滚（冲突检测 + 不丢数据） ---------- */
  async function rollbackTo(id) {
    const target = snaps.find(x => x.id === id);
    if (!target) return;

    // 冲突检测：当前有未保存修改（既不等于目标，也不等于最近快照）
    const curHash = await currentHash();
    const dirty = curHash !== lastSavedHash;
    const diverged = dirty && curHash !== target.hash;
    if (diverged) {
      const backup = await createSnapshot(
        `回滚前自动备份 ${new Date().toLocaleTimeString()}`, 'conflict-backup');
      log(`检测到冲突：当前修改与目标快照不一致，已自动备份为「${backup.name}」，未丢数据`, 'warn');
    } else if (dirty) {
      await createSnapshot(`回滚前自动备份 ${new Date().toLocaleTimeString()}`, 'auto-backup');
      log('回滚前已自动备份当前修改', 'warn');
    }

    let state;
    try {
      state = await SnapshotManager.load(target); // 解压 + 哈希校验 + 版本迁移
    } catch (err) {
      log(String(err.message || err), 'error');
      return;
    }
    const before = FormUI.readState();
    const changed = diffStates(before, state).map(r => r.path);
    FormUI.applyState(state, changed);
    lastSavedHash = target.hash;
    await DB.kvSet('currentState', state);
    selectSnapshot(id);
    refreshDirty();
    const migrated = target.schemaVersion < SCHEMA_VERSION ? `（已从 v${target.schemaVersion} 迁移到 v${SCHEMA_VERSION}）` : '';
    log(`已回滚到「${target.name}」${migrated}`);
  }

  /* ---------- 时间旅行回放 ---------- */
  function stopReplay(msg) {
    clearInterval(replayTimer);
    replayTimer = null;
    Timeline.setReplay(null);
    $('btnReplayPlay').textContent = '▶';
    $('replayStatus').textContent = msg || '回放空闲';
  }

  async function replayStep() {
    replayIdx++;
    if (replayIdx >= snaps.length) { stopReplay('回放结束'); return; }
    const s = snaps[replayIdx];
    try {
      const state = await SnapshotManager.load(s);
      const prev = replayIdx > 0 ? await SnapshotManager.load(snaps[replayIdx - 1]) : defaultState();
      const changed = diffStates(prev, state).map(r => r.path);
      FormUI.applyState(state, changed);
      Timeline.setReplay(s.id);
      selectSnapshot(s.id);
      $('replayStatus').textContent = `回放中 ${replayIdx + 1}/${snaps.length}：${s.name}`;
    } catch (err) {
      log(String(err.message || err), 'error');
      stopReplay('回放中断');
    }
  }

  function toggleReplay() {
    if (replayTimer) { stopReplay('回放已暂停'); return; }
    if (snaps.length === 0) { log('没有可回放的快照', 'warn'); return; }
    if (replayIdx < 0 || replayIdx >= snaps.length - 1) replayIdx = -1; // 播完后重新来
    $('btnReplayPlay').textContent = '⏸';
    const speed = Number($('replaySpeed').value);
    replayStep();
    replayTimer = setInterval(replayStep, speed);
  }

  async function stepReplay(dir) {
    stopReplay();
    if (!snaps.length) return;
    const cur = selectedId ? snaps.findIndex(s => s.id === selectedId) : -1;
    const next = Math.min(Math.max(cur + dir, 0), snaps.length - 1);
    replayIdx = next - 1;
    await replayStep();
    clearInterval(replayTimer);
    replayTimer = null;
    $('btnReplayPlay').textContent = '▶';
    $('replayStatus').textContent = `定位到 ${next + 1}/${snaps.length}`;
  }

  /* ---------- 对比 ---------- */
  async function runDiff() {
    const a = snaps.find(s => s.id === $('diffA').value);
    const b = snaps.find(s => s.id === $('diffB').value);
    const box = $('diffResult');
    if (!a || !b) { box.textContent = '请先创建至少两个快照'; return; }
    if (a.id === b.id) { box.textContent = '请选择两个不同的快照'; return; }
    const [sa, sb] = await Promise.all([SnapshotManager.load(a), SnapshotManager.load(b)]);
    const rows = diffStates(sa, sb);
    if (!rows.length) { box.textContent = '两个快照内容完全一致'; return; }
    const typeText = { added: '新增', removed: '删除', changed: '变更' };
    box.innerHTML = `<table><tr><th>字段路径</th><th>类型</th><th>${escapeHtml(a.name)}</th><th>${escapeHtml(b.name)}</th></tr>${
      rows.map(r => `<tr class="${r.type}"><td>${escapeHtml(r.path)}</td><td>${typeText[r.type]}</td><td>${escapeHtml(fmtVal(r.from))}</td><td>${escapeHtml(fmtVal(r.to))}</td></tr>`).join('')
    }</table>`;
    log(`对比「${a.name}」→「${b.name}」：${rows.length} 处差异`);
  }

  function fmtVal(v) {
    if (v === '' || v === undefined) return '—';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- 导出 / 导入 ---------- */
  async function exportSnapshots() {
    if (!snaps.length) { log('没有可导出的快照', 'warn'); return; }
    const json = await SnapshotManager.exportAll(snaps);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `snapshots-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    log(`已导出 ${snaps.length} 个快照（含校验和）`);
  }

  async function importSnapshots(file) {
    try {
      const text = await file.text();
      const { added, conflicts, migrated } = await SnapshotManager.importAll(text);
      await reload();
      log(`导入完成：新增 ${added} 个快照` + (migrated ? `，${migrated} 个旧版本已迁移` : ''));
      for (const c of conflicts) {
        log(`冲突：快照「${c.name}」id 相同但内容不同，已保留双方（导入方改名）`, 'warn');
      }
    } catch (err) {
      log(String(err.message || err), 'error');
    }
  }

  /* ---------- 演示数据 ---------- */
  function fillDemo() {
    FormUI.applyState(normalizeState({
      title: '智慧城市数据平台', code: 'PRJ-2026-011', category: '科研',
      startDate: '2026-10-01', duration: 18, confidential: false,
      members: [
        { name: '张三', role: '负责人', ratio: 60 },
        { name: '李四', role: '骨干', ratio: 40 },
      ],
      amount: 1200000, currency: 'CNY', payPlan: '分期', note: '按季度拨款',
      priority: 'high', tags: ['紧急', '需评审'], desc: '首期聚焦数据接入层。',
    }));
    onFormChange();
    log('已填充示例数据');
  }

  /* ---------- 启动 ---------- */
  async function init() {
    FormUI.render();
    FormUI.setOnChange(onFormChange);

    const saved = await DB.kvGet('currentState');
    if (saved) {
      FormUI.applyState(normalizeState(saved));
      log('已恢复上次未保存的表单内容');
    } else {
      FormUI.applyState(defaultState());
    }
    lastSavedHash = await currentHash();

    await reload();

    $('btnSnapshot').addEventListener('click', askCreateSnapshot);
    $('btnFillDemo').addEventListener('click', fillDemo);
    $('btnExport').addEventListener('click', exportSnapshots);
    $('fileImport').addEventListener('change', (e) => {
      if (e.target.files[0]) importSnapshots(e.target.files[0]);
      e.target.value = '';
    });
    $('btnDiff').addEventListener('click', runDiff);
    $('btnReplayPlay').addEventListener('click', toggleReplay);
    $('btnReplayPrev').addEventListener('click', () => stepReplay(-1));
    $('btnReplayNext').addEventListener('click', () => stepReplay(1));
    Timeline.setOnSelect(selectSnapshot);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
