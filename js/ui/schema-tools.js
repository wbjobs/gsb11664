// "字段 / 版本管理" modal: add/remove fields, change types, inspect version
// history and migration log. Every change produces a new schema version and
// migrates state losslessly via evolveSchema().
import { KNOWN_TYPES } from '../lib/schema.js';
import { modal, toast } from './modal.js';
import { escapeHtml, formatTime } from '../lib/util.js';

export function openSchemaTools({ schemas, currentSchema, currentState, onEvolve, onResetDemo }) {
  const body = document.createElement('div');
  body.className = 'schema-tools';
  body.innerHTML = `
    <div class="warn-box">
      任何字段增删或类型修改都会生成<b>新的 schema 版本</b>，并对当前状态做无损迁移：
      删除的字段值进入 <code>removed</code> 留存区，类型无法转换时旧值记录在 <code>typeChanges</code>。
    </div>
    <div class="grid3">
      <button class="btn" id="stAddField">＋ 新增字段</button>
      <button class="btn btn-danger" id="stRemoveField">－ 删除字段</button>
      <button class="btn" id="stChangeType">⇄ 修改字段类型</button>
    </div>
    <h4>当前 schema v${currentSchema.schemaVersion} 字段表</h4>
    <div class="schema-field-list" id="stFieldList"></div>
    <h4 style="margin-top:16px">版本历史</h4>
    <div id="stVersions"></div>
    <h4>最近的类型变化记录（typeChanges）</h4>
    <div class="kv-log" id="stTypeLog"></div>
    <div style="margin-top:12px">
      <button class="btn btn-ghost btn-small" id="stReset">重置演示数据（清空全部快照）</button>
    </div>
  `;

  const fieldList = body.querySelector('#stFieldList');
  const renderFields = () => {
    fieldList.innerHTML = '';
    for (const group of currentSchema.groups) {
      const head = document.createElement('div');
      head.style.cssText = 'margin-top:8px;color:#cdd5ff;font-size:12px';
      head.textContent = `${group.title} (${group.id}${group.repeatable ? ', 可重复' : ''})`;
      fieldList.appendChild(head);
      for (const field of group.fields) {
        const row = document.createElement('div');
        row.className = 'schema-field';
        row.innerHTML = `<span>${escapeHtml(field.label)} <small style="color:#6f79a6">(${field.id})</small></span>
          <span class="badge">${escapeHtml(field.type)}</span>
          <span>${field.options ? escapeHtml(field.options.slice(0, 3).join('/') + (field.options.length > 3 ? '…' : '')) : ''}</span>
          <span></span>`;
        const del = document.createElement('button');
        del.className = 'btn btn-small btn-danger';
        del.textContent = '删除';
        del.addEventListener('click', () => doRemove(group.id, field.id, field.label));
        row.lastElementChild.appendChild(del);
        const chType = document.createElement('button');
        chType.className = 'btn btn-small';
        chType.textContent = '改类型';
        chType.style.marginLeft = '4px';
        chType.addEventListener('click', () => doChangeType(group.id, field));
        row.lastElementChild.appendChild(chType);
        fieldList.appendChild(row);
      }
    }
  };

  const versionsEl = body.querySelector('#stVersions');
  const renderVersions = () => {
    versionsEl.innerHTML = schemas.map((s) => `
      <div style="font-size:12px;margin:4px 0">
        <b>v${s.schemaVersion}</b> · ${formatTime(s.releasedAt)} ${s.importedFrom ? `(导入自 v${s.importedFrom})` : ''}
        <div class="muted">${escapeHtml(s.note || '')}</div>
      </div>`).join('');
  };

  const typeLog = body.querySelector('#stTypeLog');
  const renderLog = () => {
    const changes = currentState.typeChanges || [];
    typeLog.textContent = changes.length === 0
      ? '（暂无）'
      : changes.slice(-20).map((c) =>
        `${formatTime(c.at)} ${c.groupId}${c.rowId ? `[${c.rowId}]` : ''}.${c.fieldId}: ${c.fromType} → ${c.toType}${c.restored ? ' (恢复)' : ''}\n    ${c.note || ''}`).join('\n');
  };

  const doAdd = async () => {
    const groupId = await pickGroup(currentSchema, '在哪个分组新增字段？');
    if (!groupId) return;
    const id = await ask('字段 id（英文，例如 wechat）', 'wechat');
    if (!id) return;
    const label = await ask('显示名称', '微信号');
    if (!label) return;
    const type = await pickType();
    if (!type) return;
    const field = { id: id.trim(), label: label.trim(), type };
    if (type === 'select' || type === 'radio' || type === 'multiselect') {
      const raw = await ask('选项（逗号分隔）', '选项一,选项二');
      field.options = String(raw || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    onEvolve({
      kind: 'addField', groupId, field,
      note: `新增字段 ${groupId}.${field.id} (${field.type})`,
    });
    toast(`字段 ${field.id} 已新增，schema 升级到 v${currentSchema.schemaVersion + 1}`, 'ok');
  };

  const doRemove = async (groupId, fieldId, fieldLabel) => {
    const ok = window.confirm(`删除字段「${fieldLabel}」？其数据会保留在 removed 区，不会丢失。`);
    if (!ok) return;
    onEvolve({ kind: 'removeField', groupId, fieldId, note: `删除字段 ${groupId}.${fieldId}` });
    toast(`字段 ${fieldId} 已从 schema 删除，旧值已留存`, 'warn');
  };

  const doChangeType = async (groupId, field) => {
    const newType = await pickType(field.type);
    if (!newType || newType === field.type) return;
    let options;
    if (['select', 'radio', 'multiselect'].includes(newType)) {
      const raw = await ask('选项（逗号分隔）', (field.options || []).join(','));
      options = String(raw || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    onEvolve({
      kind: 'changeFieldType', groupId, fieldId: field.id, newType,
      options, note: `字段 ${groupId}.${field.id} 类型 ${field.type} → ${newType}`,
    });
    toast(`字段 ${field.id} 类型改为 ${newType}，旧值保留在 typeChanges`, 'warn');
  };

  body.querySelector('#stAddField').addEventListener('click', doAdd);
  body.querySelector('#stRemoveField').addEventListener('click', async () => {
    const groupId = await pickGroup(currentSchema, '选择分组');
    if (!groupId) return;
    const group = currentSchema.groups.find((g) => g.id === groupId);
    const fieldId = await ask(`删除哪个字段 id？（${group.fields.map((f) => f.id).join(', ')}）`, group.fields[0]?.id || '');
    if (!fieldId || !group.fields.some((f) => f.id === fieldId)) return toast('字段不存在', 'error');
    doRemove(groupId, fieldId.trim(), fieldId.trim());
  });
  body.querySelector('#stChangeType').addEventListener('click', async () => {
    const groupId = await pickGroup(currentSchema, '选择分组');
    if (!groupId) return;
    const group = currentSchema.groups.find((g) => g.id === groupId);
    const fieldId = await ask(`字段 id？（${group.fields.map((f) => f.id).join(', ')}）`, group.fields[0]?.id || '');
    const field = group.fields.find((f) => f.id === fieldId?.trim());
    if (!field) return toast('字段不存在', 'error');
    doChangeType(groupId, field);
  });
  body.querySelector('#stReset').addEventListener('click', async () => {
    if (await window.confirm('确定清空全部快照与草稿，恢复初始演示数据？')) onResetDemo();
  });

  renderFields();
  renderVersions();
  renderLog();
  const m = modal({ title: '字段 / 版本管理', body, wide: true });
  // Re-render after evolve callbacks replace outer state: the modal keeps a
  // closure over pre-change objects, so close it and let user reopen.
  const observer = { refresh() { m.close(); } };
  body._observer = observer;
  return m;
}

function ask(labelText, initial = '') {
  return new Promise((resolve) => {
    const m = modal({
      title: labelText,
      body: `<input class="input" id="askInput" value="${escapeHtml(initial)}" />`,
      footer: [
        { text: '取消', onClick: ({ close }) => { close(); resolve(null); } },
        { text: '确定', variant: 'primary', onClick: ({ close, bodyEl }) => {
          close();
          resolve(bodyEl.querySelector('#askInput').value.trim());
        } },
      ],
    });
    const input = m.bodyEl.querySelector('#askInput');
    input.focus();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.parentElement.parentElement.querySelector('.modal-foot .btn-primary').click(); });
  });
}

function pickGroup(schema, title) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<select class="input" id="pickGroup">${schema.groups.map((g) => `<option value="${g.id}">${escapeHtml(g.title)} (${g.id})</option>`).join('')}</select>`,
      footer: [
        { text: '取消', onClick: ({ close }) => { close(); resolve(null); } },
        { text: '确定', variant: 'primary', onClick: ({ close, bodyEl }) => {
          close();
          resolve(bodyEl.querySelector('#pickGroup').value);
        } },
      ],
    });
    void m;
  });
}

function pickType(current = '') {
  return new Promise((resolve) => {
    const m = modal({
      title: '选择字段类型',
      body: `<select class="input" id="pickType">${KNOWN_TYPES.map((t) => `<option value="${t}" ${t === current ? 'selected' : ''}>${t}</option>`).join('')}</select>`,
      footer: [
        { text: '取消', onClick: ({ close }) => { close(); resolve(null); } },
        { text: '确定', variant: 'primary', onClick: ({ close, bodyEl }) => {
          close();
          resolve(bodyEl.querySelector('#pickType').value);
        } },
      ],
    });
    void m;
  });
}
