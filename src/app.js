import { FIELD_GROUPS, FIELDS, diffStates } from './core.js';
import { SnapshotTimeline } from './timeline.js';

const $ = (selector) => document.querySelector(selector);
const elements = {
  form: $('#formRoot'),
  statusLine: $('#statusLine'),
  saveBadge: $('#saveBadge'),
  previewBanner: $('#previewBanner'),
  retiredView: $('#retiredView'),
  snapshotName: $('#snapshotName'),
  parentSelect: $('#parentSelect'),
  createSnapshotBtn: $('#createSnapshotBtn'),
  legacySampleBtn: $('#legacySampleBtn'),
  snapshotList: $('#snapshotList'),
  compareLeft: $('#compareLeft'),
  compareRight: $('#compareRight'),
  compareBtn: $('#compareBtn'),
  diffView: $('#diffView'),
  exportBtn: $('#exportBtn'),
  importInput: $('#importInput'),
  playBtn: $('#playBtn')
};

const worker = new Worker('./worker.js', { type: 'module' });
const pendingRequests = new Map();
let requestSequence = 0;
let currentState = null;
let draftState = null;
let baseSnapshotId = null;
let records = [];
let reconstructed = [];
let selectedSnapshotId = null;
let previewSnapshotId = null;
let playingTimer = null;
let autoSaveTimer = 0;
let lastSavedSignature = '';
let timeline;

worker.onmessage = (event) => {
  const { requestId, ok, result, error } = event.data || {};
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  if (ok) pending.resolve(result);
  else pending.reject(new Error(error));
};

function callWorker(action, payload = {}) {
  const requestId = `request_${requestSequence += 1}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    worker.postMessage({ requestId, action, payload });
  });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  return JSON.stringify(sortForCompare(value));
}

function sortForCompare(value) {
  if (Array.isArray(value)) return value.map(sortForCompare);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForCompare(value[key])]));
  }
  return value;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function toast(message, type = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast ${type === 'info' ? '' : type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 4200);
}

function getSelectedItem() {
  return reconstructed.find((item) => item.ok && item.record.id === selectedSnapshotId) || null;
}

function getPreviewItem() {
  return reconstructed.find((item) => item.ok && item.record.id === previewSnapshotId) || null;
}

function bootstrap() {
  timeline = new SnapshotTimeline($('#timelineCanvas'), (id) => selectSnapshot(id));
  bindEvents();
  renderFormShell();
  callWorker('bootstrap').then(applyWorkerResult).catch((error) => {
    elements.statusLine.textContent = '加载失败';
    toast(error.message, 'error');
  });
}

function bindEvents() {
  elements.form.addEventListener('input', handleFormInput);
  elements.form.addEventListener('change', handleFormInput);
  elements.form.addEventListener('click', handleFormClick);
  elements.createSnapshotBtn.addEventListener('click', handleCreateSnapshot);
  elements.legacySampleBtn.addEventListener('click', handleLegacySample);
  elements.compareBtn.addEventListener('click', handleCompare);
  elements.exportBtn.addEventListener('click', handleExport);
  elements.importInput.addEventListener('change', handleImportFile);
  elements.playBtn.addEventListener('click', handlePlayOrStop);
}

function applyWorkerResult(result, options = {}) {
  records = result.records || records;
  reconstructed = result.reconstructed || reconstructBrokenFallback(records);
  if (result.state) {
    currentState = deepClone(result.state);
    draftState = deepClone(result.state);
  }
  if ('baseSnapshotId' in result) baseSnapshotId = result.baseSnapshotId;
  if (options.clearPreview) previewSnapshotId = null;
  if (!selectedSnapshotId || !reconstructed.some((item) => item.record.id === selectedSnapshotId)) {
    selectedSnapshotId = baseSnapshotId || reconstructed.find((item) => item.ok)?.record.id || null;
  }
  renderAll();
  lastSavedSignature = stable(currentState);
  updateDirtyBadge();
  if (result.message) toast(result.message, result.safetySnapshotId ? 'warning' : 'info');
  return result;
}

function reconstructBrokenFallback(sourceRecords) {
  return sourceRecords.map((record) => ({
    ok: false,
    record,
    error: '重建结果缺失',
    rawState: null,
    state: null,
    warnings: []
  }));
}

function renderAll() {
  renderFormValues();
  renderSnapshotControls();
  renderSnapshotList();
  renderCompareSelectors();
  renderRetired();
  renderPreviewBanner();
  timeline.render(reconstructed, selectedSnapshotId, previewSnapshotId);
  updateStatusLine();
}

function updateStatusLine() {
  const broken = reconstructed.filter((item) => !item.ok).length;
  elements.statusLine.textContent = `${reconstructed.length} 个快照 · ${broken ? `${broken} 个损坏 · ` : ''}当前基准：${getBaseName()}`;
}

function getBaseName() {
  const base = reconstructed.find((item) => item.ok && item.record.id === baseSnapshotId);
  return base ? base.record.name : '未关联快照';
}

function renderFormShell() {
  elements.form.innerHTML = '';
  for (const group of FIELD_GROUPS) {
    const section = document.createElement('fieldset');
    section.className = 'group-card';
    const legend = document.createElement('legend');
    legend.className = 'group-title field-label';
    legend.textContent = group.title;
    section.append(legend);
    const grid = document.createElement('div');
    grid.className = 'field-grid';
    for (const field of group.fields) {
      grid.append(createField(field));
    }
    section.append(grid);
    elements.form.append(section);
  }

  const milestoneSection = document.createElement('fieldset');
  milestoneSection.className = 'group-card';
  milestoneSection.innerHTML = '<legend class="group-title field-label">里程碑分组</legend>';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'button secondary';
  addButton.dataset.action = 'add-milestone';
  addButton.textContent = '新增里程碑';
  const milestoneList = document.createElement('div');
  milestoneList.id = 'milestoneList';
  milestoneSection.append(milestoneList, addButton);
  elements.form.append(milestoneSection);
}

function createField(field) {
  const wrapper = document.createElement('label');
  wrapper.className = `field ${['textarea', 'multiselect'].includes(field.type) ? 'wide' : ''}`;
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = field.label;

  if (field.type === 'checkbox') {
    wrapper.classList.add('checkbox-field');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.field = field.id;
    input.dataset.type = field.type;
    wrapper.append(input, label);
    return wrapper;
  }

  wrapper.append(label);
  let control;
  if (field.type === 'textarea') {
    control = document.createElement('textarea');
  } else if (field.type === 'select') {
    control = document.createElement('select');
    for (const option of field.options) {
      const optionNode = document.createElement('option');
      optionNode.value = option;
      optionNode.textContent = option;
      control.append(optionNode);
    }
  } else {
    control = document.createElement('input');
    control.type = field.type === 'multiselect' ? 'hidden' : field.type;
    if (field.type === 'number') {
      if (typeof field.min === 'number') control.min = String(field.min);
      if (typeof field.max === 'number') control.max = String(field.max);
    }
    if (field.placeholder) control.placeholder = field.placeholder;
  }
  control.dataset.field = field.id;
  control.dataset.type = field.type;
  wrapper.append(control);

  if (field.type === 'multiselect') {
    const choices = document.createElement('div');
    choices.className = 'choice-list';
    for (const option of field.options) {
      const choice = document.createElement('label');
      choice.className = 'choice';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.field = field.id;
      checkbox.dataset.option = option;
      choice.append(checkbox, document.createTextNode(option));
      choices.append(choice);
    }
    wrapper.append(choices);
  }
  return wrapper;
}

function renderFormValues() {
  if (!currentState) return;
  const previewState = getPreviewItem()?.state || null;
  for (const [id, field] of Object.entries(FIELDS)) {
    const value = currentState.values[id];
    if (field.type === 'checkbox') {
      const input = elements.form.querySelector(`input[type="checkbox"][data-field="${id}"]:not([data-option])`);
      if (input) input.checked = Boolean(value);
    } else if (field.type === 'multiselect') {
      const selected = new Set(Array.isArray(value) ? value : []);
      elements.form.querySelectorAll(`input[type="checkbox"][data-field="${id}"][data-option]`).forEach((input) => {
        input.checked = selected.has(input.dataset.option);
      });
    } else {
      const input = elements.form.querySelector(`[data-field="${id}"]:not([data-option])`);
      if (input) input.value = value ?? '';
    }
  }
  renderMilestones();
  elements.form.querySelectorAll('input, textarea, select, button').forEach((control) => {
    control.disabled = Boolean(previewState);
  });
}

function renderMilestones() {
  const list = $('#milestoneList');
  list.innerHTML = '';
  currentState.milestones.forEach((milestone, index) => {
    const row = document.createElement('div');
    row.className = 'milestone-row';
    row.dataset.milestoneIndex = String(index);
    row.append(
      createMilestoneInput('checkbox', 'done', milestone.done, { checked: milestone.done }),
      createMilestoneInput('text', 'title', milestone.title, { placeholder: '里程碑标题' }),
      createMilestoneInput('date', 'date', milestone.date),
      createMilestoneInput('text', 'owner', milestone.owner, { placeholder: '负责人', classNames: ['owner-input'] }),
      createRemoveMilestoneButton()
    );
    list.append(row);
  });
}

function createMilestoneInput(type, key, value, options = {}) {
  const input = document.createElement('input');
  input.type = type;
  input.dataset.milestoneKey = key;
  if (type === 'checkbox') input.checked = Boolean(options.checked);
  else input.value = value ?? '';
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.classNames) input.classList.add(...options.classNames);
  return input;
}

function createRemoveMilestoneButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button danger remove-milestone';
  button.dataset.action = 'remove-milestone';
  button.textContent = '删除';
  return button;
}

function handleFormInput(event) {
  if (previewSnapshotId) return;
  const target = event.target;
  if (target.matches('[data-field]') && target.dataset.option) {
    const fieldId = target.dataset.field;
    const selected = new Set(draftState.values[fieldId]);
    if (target.checked) selected.add(target.dataset.option);
    else selected.delete(target.dataset.option);
    const nextValue = FIELDS[fieldId].options.filter((option) => selected.has(option));
    draftState.values[fieldId] = nextValue;
    currentState.values[fieldId] = nextValue;
  } else if (target.matches('[data-field]')) {
    const field = FIELDS[target.dataset.field];
    const nextValue = readControlValue(target, field);
    draftState.values[field.id] = nextValue;
    currentState.values[field.id] = nextValue;
  } else if (target.matches('[data-milestone-key]')) {
    const row = target.closest('.milestone-row');
    const index = Number(row.dataset.milestoneIndex);
    const key = target.dataset.milestoneKey;
    const nextValue = key === 'done' ? target.checked : target.value;
    draftState.milestones[index][key] = nextValue;
    currentState.milestones[index][key] = nextValue;
  }
  renderRetired();
  scheduleDraftSave();
}

function readControlValue(target, field) {
  if (field.type === 'checkbox') return target.checked;
  if (field.type === 'number') {
    const value = target.value === '' ? 0 : Number(target.value);
    if (!Number.isFinite(value)) return currentState.values[field.id];
    return Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, value));
  }
  return target.value;
}

function handleFormClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || previewSnapshotId) return;
  if (action === 'add-milestone') {
    const milestone = {
      id: `milestone_${globalThis.crypto.randomUUID().replace(/-/g, '')}`,
      title: '新里程碑',
      date: '',
      owner: '',
      done: false
    };
    draftState.milestones.push(milestone);
    currentState.milestones.push(deepClone(milestone));
    renderMilestones();
    scheduleDraftSave();
  }
  if (action === 'remove-milestone') {
    const row = event.target.closest('.milestone-row');
    const index = Number(row.dataset.milestoneIndex);
    draftState.milestones.splice(index, 1);
    currentState.milestones.splice(index, 1);
    renderMilestones();
    scheduleDraftSave();
  }
}

function renderSnapshotControls() {
  const valid = reconstructed.filter((item) => item.ok);
  elements.parentSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '独立根快照（检测为分支）';
  elements.parentSelect.append(none);
  for (const item of [...valid].sort(byRecordTime)) {
    const option = document.createElement('option');
    option.value = item.record.id;
    option.textContent = item.record.name;
    option.selected = item.record.id === (selectedSnapshotId || baseSnapshotId);
    elements.parentSelect.append(option);
  }
}

function byRecordTime(left, right) {
  return (left.record.createdAt || 0) - (right.record.createdAt || 0);
}

function renderSnapshotList() {
  elements.snapshotList.innerHTML = '';
  for (const item of [...reconstructed].sort(byRecordTime)) {
    elements.snapshotList.append(createSnapshotCard(item));
  }
}

function createSnapshotCard(item) {
  const record = item.record;
  const card = document.createElement('article');
  card.className = `snapshot-card ${record.id === selectedSnapshotId ? 'selected' : ''} ${item.ok ? '' : 'broken'}`;

  const titleRow = document.createElement('div');
  titleRow.className = 'snapshot-title-row';
  const name = document.createElement('span');
  name.className = 'snapshot-name';
  name.textContent = record.name;
  const changed = document.createElement('span');
  changed.className = `pill ${item.matchesCurrent ? 'full' : 'delta'}`;
  changed.textContent = item.ok ? (item.matchesCurrent ? '当前一致' : `${item.currentDiffCount ?? '?'} 处差异`) : '无法重建';
  titleRow.append(name, changed);

  const meta = document.createElement('div');
  meta.className = 'snapshot-meta';
  const parentName = record.parentName || (record.parentId ? '外部父节点' : '根快照');
  meta.textContent = `${formatTime(record.createdAt)} · schema v${record.schemaVersion} · 父节点：${parentName}`;

  const pills = document.createElement('div');
  const kind = document.createElement('span');
  kind.className = `pill ${record.compression?.kind === 'full' ? 'full' : 'delta'}`;
  kind.textContent = record.compression?.kind === 'full'
    ? `全量 ${formatBytes(record.compression.byteSize)}`
    : `Delta ${formatBytes(record.compression.byteSize)} / 全量 ${formatBytes(record.compression.fullByteSize)}`;
  pills.append(kind);
  if (record.reason === 'rollback-safety') {
    const pill = document.createElement('span');
    pill.className = 'pill warn';
    pill.textContent = '回滚保护';
    pills.append(pill);
  }
  for (const warning of item.warnings || []) {
    const pill = document.createElement('span');
    pill.className = 'pill warn';
    pill.textContent = '降级兼容';
    pill.title = warning;
    pills.append(pill);
  }

  card.append(titleRow, meta, pills);
  if (!item.ok) {
    const error = document.createElement('p');
    error.className = 'muted';
    error.style.color = '#b91c1c';
    error.textContent = item.error;
    card.append(error);
  } else {
    card.append(createSnapshotActions(record.id));
  }
  card.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    selectSnapshot(record.id);
  });
  return card;
}

function createSnapshotActions(id) {
  const actions = document.createElement('div');
  actions.className = 'snapshot-actions';
  actions.append(
    createActionButton(id, 'view', '查看'),
    createActionButton(id, 'diff-current', '对比当前'),
    createActionButton(id, 'rename', '重命名'),
    createActionButton(id, 'rollback', '回滚', 'danger')
  );
  actions.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'view') startPreview(id);
    if (action === 'diff-current') renderDiffWithCurrent(id);
    if (action === 'rename') handleRename(id);
    if (action === 'rollback') handleRollback(id);
  });
  return actions;
}

function createActionButton(id, action, label, variant = 'secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button tiny ${variant}`;
  button.dataset.action = action;
  button.dataset.id = id;
  button.textContent = label;
  return button;
}

function selectSnapshot(id) {
  selectedSnapshotId = id;
  if (elements.parentSelect.querySelector(`option[value="${CSS.escape(id)}"]`)) elements.parentSelect.value = id;
  renderSnapshotList();
  timeline.render(reconstructed, selectedSnapshotId, previewSnapshotId);
}

function startPreview(id) {
  previewSnapshotId = id;
  selectedSnapshotId = id;
  const item = getPreviewItem();
  if (!item) return;
  currentState = deepClone(item.state);
  renderAll();
}

function exitPreview(persistEditableState = null) {
  stopPlayback(false);
  previewSnapshotId = null;
  currentState = deepClone(persistEditableState || draftState);
  renderAll();
}

function renderPreviewBanner() {
  const item = getPreviewItem();
  if (!item) {
    elements.previewBanner.className = 'preview-banner hidden';
    elements.previewBanner.innerHTML = '';
    return;
  }
  const info = document.createElement('div');
  info.textContent = `时间旅行查看中：${item.record.name}。表单为只读；选择退出后回到编辑稿，选择回滚会先自动保存保护快照。`;
  const actions = document.createElement('div');
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'button tiny secondary';
  exit.textContent = '退出查看';
  exit.addEventListener('click', () => exitPreview());
  const rollback = document.createElement('button');
  rollback.type = 'button';
  rollback.className = 'button tiny danger';
  rollback.textContent = '回滚到这里';
  rollback.addEventListener('click', () => handleRollback(item.record.id));
  actions.append(exit, rollback);
  elements.previewBanner.replaceChildren(info, actions);
  elements.previewBanner.className = 'preview-banner';
}

async function handleCreateSnapshot() {
  const name = elements.snapshotName.value.trim();
  if (!name) {
    toast('请先为快照命名', 'warning');
    elements.snapshotName.focus();
    return;
  }
  try {
    const result = await callWorker('snapshot', {
      state: previewSnapshotId ? draftState : currentState,
      name,
      parentId: elements.parentSelect.value || null
    });
    elements.snapshotName.value = '';
    selectedSnapshotId = result.baseSnapshotId;
    previewSnapshotId = null;
    applyWorkerResult(result);
    toast('快照已创建，完整状态已校验并持久化');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleRollback(id) {
  const item = reconstructed.find((candidate) => candidate.ok && candidate.record.id === id);
  if (!item) return toast('目标快照无法回滚', 'error');
  const confirmed = window.confirm(`回滚到「${item.record.name}」？当前编辑稿会先保存为保护快照，因此不会丢失。`);
  if (!confirmed) return;
  try {
    const result = await callWorker('rollback', { targetId: id, state: draftState });
    previewSnapshotId = null;
    selectedSnapshotId = result.baseSnapshotId;
    applyWorkerResult(result);
    timeline.render(reconstructed, selectedSnapshotId, null);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleRename(id) {
  const item = reconstructed.find((candidate) => candidate.ok && candidate.record.id === id);
  if (!item) return;
  const name = window.prompt('输入新的快照名称', item.record.name);
  if (name === null) return;
  try {
    const result = await callWorker('rename', { id, name });
    applyWorkerResult(result);
    selectedSnapshotId = id;
    renderAll();
    toast('快照已重命名');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderRetired() {
  const visible = {
    retired: currentState?.retired || {},
    legacy: currentState?.legacy || {},
    foreignState: currentState?.foreignState || null
  };
  elements.retiredView.textContent = JSON.stringify(visible, null, 2);
}

function updateDirtyBadge() {
  const dirty = stable(draftState) !== lastSavedSignature;
  elements.saveBadge.textContent = dirty ? '未保存' : '已同步 IndexedDB';
  elements.saveBadge.className = `badge ${dirty ? 'dirty' : ''}`;
}

function scheduleDraftSave() {
  updateDirtyBadge();
  clearTimeout(autoSaveTimer);
  elements.saveBadge.textContent = '保存中…';
  autoSaveTimer = setTimeout(async () => {
    try {
      const result = await callWorker('saveDraft', { state: draftState, baseSnapshotId });
      applyWorkerResult(result);
      toast('编辑稿已自动保存', 'info');
    } catch (error) {
      elements.saveBadge.textContent = '保存失败';
      elements.saveBadge.className = 'badge error';
      toast(error.message, 'error');
    }
  }, 450);
}

function renderCompareSelectors() {
  const valid = reconstructed.filter((item) => item.ok).sort(byRecordTime);
  const currentLeft = elements.compareLeft.value;
  const currentRight = elements.compareRight.value;
  elements.compareLeft.innerHTML = '';
  elements.compareRight.innerHTML = '';
  valid.forEach((item, index) => {
    const left = document.createElement('option');
    left.value = item.record.id;
    left.textContent = item.record.name;
    const right = left.cloneNode(true);
    if (item.record.id === selectedSnapshotId) left.selected = true;
    if (valid[index + 1]?.record.id === selectedSnapshotId || index === valid.length - 1) right.selected = true;
    elements.compareLeft.append(left);
    elements.compareRight.append(right);
  });
  if (currentLeft) elements.compareLeft.value = currentLeft;
  if (currentRight) elements.compareRight.value = currentRight;
}

function handleCompare() {
  const leftItem = reconstructed.find((item) => item.ok && item.record.id === elements.compareLeft.value);
  const rightItem = reconstructed.find((item) => item.ok && item.record.id === elements.compareRight.value);
  if (!leftItem || !rightItem) return toast('请选择两个可重建快照', 'warning');
  renderDiff(diffStates(leftItem.state, rightItem.state), leftItem.record.name, rightItem.record.name);
}

function renderDiffWithCurrent(id) {
  const item = reconstructed.find((candidate) => candidate.ok && candidate.record.id === id);
  if (!item) return;
  elements.compareLeft.value = id;
  renderDiff(diffStates(item.state, draftState), item.record.name, '当前编辑稿');
}

function renderDiff(changes, leftName, rightName) {
  elements.diffView.classList.remove('empty');
  elements.diffView.innerHTML = '';
  const summary = document.createElement('p');
  summary.className = 'muted';
  summary.textContent = `${leftName} → ${rightName}：${changes.length} 处差异`;
  elements.diffView.append(summary);
  if (changes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diff-item';
    empty.textContent = '两个状态的规范化内容完全一致。';
    elements.diffView.append(empty);
    return;
  }
  for (const change of changes) {
    const card = document.createElement('article');
    card.className = 'diff-item';
    const head = document.createElement('div');
    head.className = 'diff-head';
    const label = document.createElement('span');
    label.textContent = `${change.category} · ${change.label}`;
    const kind = document.createElement('span');
    kind.className = 'diff-kind';
    kind.textContent = change.kind;
    head.append(label, kind);

    const values = document.createElement('div');
    values.className = 'diff-values';
    const oldValue = document.createElement('div');
    oldValue.className = 'old';
    oldValue.textContent = '旧值：';
    oldValue.append(createValueNode(change.before));
    const newValue = document.createElement('div');
    newValue.className = 'new';
    newValue.textContent = '新值：';
    newValue.append(createValueNode(change.after));
    values.append(oldValue, newValue);
    card.append(head, values);
    elements.diffView.append(card);
  }
}

function createValueNode(value) {
  const node = document.createElement('span');
  node.className = 'code-inline';
  if (value === null || value === undefined) node.textContent += '∅';
  else if (typeof value === 'object') node.textContent += JSON.stringify(value);
  else node.textContent += String(value);
  return node;
}

function handlePlayOrStop() {
  if (playingTimer) {
    stopPlayback(true);
    return;
  }
  const valid = reconstructed.filter((item) => item.ok).sort(byRecordTime);
  if (valid.length < 1) return toast('没有可回放的快照', 'warning');
  let index = 0;
  elements.playBtn.textContent = '停止回放';
  const playStep = () => {
    const item = valid[index];
    if (!item) {
      stopPlayback(true);
      return;
    }
    previewSnapshotId = item.record.id;
    selectedSnapshotId = item.record.id;
    currentState = deepClone(item.state);
    renderAll();
    toast(`回放 ${index + 1}/${valid.length}：${item.record.name}`, 'info');
    index += 1;
    playingTimer = setTimeout(playStep, 1600);
  };
  playStep();
}

function stopPlayback(rerender = true) {
  clearTimeout(playingTimer);
  playingTimer = null;
  elements.playBtn.textContent = '回放';
  if (rerender) {
    previewSnapshotId = null;
    currentState = deepClone(draftState);
    renderAll();
  }
}

async function handleExport() {
  try {
    const result = await callWorker('export');
    const bundle = result.exportBundle;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `snapshot-timeline-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${bundle.count} 个快照，包含完整 Delta 链`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const bundle = JSON.parse(await file.text());
    const result = await callWorker('import', { bundle });
    if (result.ok) {
      applyWorkerResult(result);
      toast(`导入成功：新增 ${result.accepted.length} 个快照`);
    } else {
      renderImportConflicts(result);
    }
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error');
  } finally {
    event.target.value = '';
  }
}

function renderImportConflicts(result) {
  const details = result.conflicts.map((conflict, index) => `${index + 1}. ${conflict.message}`).join('\n');
  toast(`检测到 ${result.conflicts.length} 个冲突，已阻止导入。\n${details}`, 'error');
}

async function handleLegacySample() {
  try {
    const result = await callWorker('addLegacySample');
    applyWorkerResult(result);
    toast('已加入 v1 快照：删除字段、字符串转数组、文本转数字和未知根字段均已保留');
  } catch (error) {
    toast(error.message, 'error');
  }
}

bootstrap();
