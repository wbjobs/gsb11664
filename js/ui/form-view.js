// DOM rendering + value collection for the complex form. No framework:
// fields are rendered from the schema and read back via `collect()`.
import { escapeHtml, generateId } from '../lib/util.js';
import { defaultForField } from '../lib/schema.js';

export class FormView {
  constructor(rootEl, { onDirty } = {}) {
    this.root = rootEl;
    this.schema = null;
    this.state = null;
    this.onDirty = onDirty || (() => {});
    this._changeHandler = () => this.onDirty(this.collect());
  }

  render(schema, state) {
    this.schema = schema;
    this.state = state;
    this.root.innerHTML = '';
    for (const group of schema.groups) {
      this.root.appendChild(this.renderGroup(group, state.groups[group.id], state.removed[group.id]));
    }
    this.bindChanges();
  }

  rerenderPreserveFocus(schema, state) {
    const active = document.activeElement;
    const activeKey = active?.dataset?.fieldKey || null;
    const selection = active && active.selectionStart != null
      ? [active.selectionStart, active.selectionEnd] : null;
    this.render(schema, state);
    if (activeKey) {
      const el = this.root.querySelector(`[data-field-key="${CSS.escape(activeKey)}"]`);
      if (el) {
        el.focus();
        if (selection) try { el.setSelectionRange(selection[0], selection[1]); } catch { /* noop */ }
      }
    }
  }

  renderGroup(group, data, removedData) {
    const wrap = document.createElement('fieldset');
    wrap.className = 'field-group';
    const legend = document.createElement('legend');
    legend.className = 'group-title';
    legend.innerHTML = `${escapeHtml(group.title)} ${group.repeatable ? '<span class="tag">可重复</span>' : ''}`;
    wrap.appendChild(legend);

    if (group.repeatable) {
      const list = document.createElement('div');
      list.className = 'repeater';
      list.dataset.group = group.id;
      const rows = Array.isArray(data) ? data : [];
      rows.forEach((row, index) => list.appendChild(this.renderRepeatRow(group, row, index)));
      wrap.appendChild(list);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-small';
      addBtn.textContent = '＋ 添加一条经历';
      addBtn.addEventListener('click', () => {
        this.addRepeatRow(group.id);
      });
      wrap.appendChild(addBtn);

      const tray = this.renderDeletedTray(group, removedData, rows);
      if (tray) wrap.appendChild(tray);
    } else {
      const grid = document.createElement('div');
      grid.className = 'grid';
      grid.dataset.group = group.id;
      const row = data || {};
      for (const field of group.fields) {
        grid.appendChild(this.renderField(field, row[field.id], group.id, null));
      }
      wrap.appendChild(grid);
      const tray = this.renderRemovedFieldsTray(group, removedData);
      if (tray) wrap.appendChild(tray);
    }
    return wrap;
  }

  renderRepeatRow(group, row, index) {
    const rowEl = document.createElement('div');
    rowEl.className = 'repeat-row';
    if (row.__deleted) rowEl.classList.add('hidden');
    rowEl.dataset.rowId = row.__rowId;
    rowEl.dataset.index = index;

    const head = document.createElement('div');
    head.className = 'row-head';
    head.innerHTML = `<span class="row-id">#${escapeHtml(row.__rowId)}</span>`;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-small btn-danger';
    delBtn.textContent = '删除此行';
    delBtn.addEventListener('click', () => this.markRowDeleted(group.id, row.__rowId));
    head.appendChild(delBtn);
    rowEl.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const field of group.fields) grid.appendChild(this.renderField(field, row[field.id], group.id, row.__rowId));
    rowEl.appendChild(grid);
    return rowEl;
  }

  fieldKey(groupId, rowId, fieldId) {
    return rowId ? `${groupId}::${rowId}::${fieldId}` : `${groupId}::${fieldId}`;
  }

  renderField(field, value, groupId, rowId) {
    const item = document.createElement('div');
    item.className = 'field';
    if (field.span === 2) item.classList.add('span-2');
    const key = this.fieldKey(groupId, rowId, field.id);
    item.dataset.fieldKey = key;

    const label = document.createElement('label');
    label.innerHTML = `${escapeHtml(field.label)}${field.required ? '<span class="req">*</span>' : ''}<span class="type-tag">${escapeHtml(field.type)}</span>`;
    item.appendChild(label);

    const control = this.createControl(field, value, key);
    item.appendChild(control);
    if (field.help) {
      const help = document.createElement('div');
      help.className = 'help';
      help.textContent = field.help;
      item.appendChild(help);
    }
    return item;
  }

  createControl(field, value, key) {
    const host = document.createElement('div');
    const name = key.replace(/::/g, '__');
    switch (field.type) {
      case 'textarea': {
        const el = document.createElement('textarea');
        el.rows = field.rows || 3;
        el.dataset.fieldKey = key;
        el.value = value ?? '';
        if (field.placeholder) el.placeholder = field.placeholder;
        host.appendChild(el);
        break;
      }
      case 'select': {
        const el = document.createElement('select');
        el.dataset.fieldKey = key;
        for (const option of ['', ...(field.options || [])]) {
          const opt = document.createElement('option');
          opt.value = option;
          opt.textContent = option === '' ? '— 请选择 —' : option;
          if (value === option) opt.selected = true;
          el.appendChild(opt);
        }
        host.appendChild(el);
        break;
      }
      case 'radio': {
        const box = document.createElement('div');
        box.className = 'radio-row';
        for (const option of field.options || []) {
          const id = `${name}_${option}`;
          const wrap = document.createElement('label');
          wrap.htmlFor = id;
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = name;
          radio.id = id;
          radio.value = option;
          radio.dataset.fieldKey = key;
          if (value === option) radio.checked = true;
          wrap.appendChild(radio);
          wrap.appendChild(document.createTextNode(option));
          box.appendChild(wrap);
        }
        host.appendChild(box);
        break;
      }
      case 'multiselect': {
        const box = document.createElement('div');
        box.className = 'check-row';
        const selected = new Set(Array.isArray(value) ? value : []);
        for (const option of field.options || []) {
          const id = `${name}_${option}`;
          const wrap = document.createElement('label');
          const check = document.createElement('input');
          check.type = 'checkbox';
          check.value = option;
          check.id = id;
          check.dataset.fieldKey = key;
          check.dataset.multi = '1';
          if (selected.has(option)) check.checked = true;
          wrap.appendChild(check);
          wrap.appendChild(document.createTextNode(option));
          box.appendChild(wrap);
        }
        host.appendChild(box);
        break;
      }
      case 'checkbox':
      case 'boolean': {
        const wrap = document.createElement('label');
        wrap.className = 'check-row';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.dataset.fieldKey = key;
        check.checked = Boolean(value);
        wrap.appendChild(check);
        wrap.appendChild(document.createTextNode(field.type === 'boolean' ? '是 / 否' : field.checkboxLabel || '勾选'));
        host.appendChild(wrap);
        break;
      }
      case 'range': {
        const row = document.createElement('div');
        row.className = 'range-row';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = field.min ?? 0;
        range.max = field.max ?? 100;
        range.step = field.step ?? 1;
        range.dataset.fieldKey = key;
        range.value = value ?? field.default ?? range.min;
        const output = document.createElement('output');
        output.textContent = range.value;
        range.addEventListener('input', () => { output.textContent = range.value; });
        row.appendChild(range);
        row.appendChild(output);
        host.appendChild(row);
        break;
      }
      case 'json': {
        const el = document.createElement('textarea');
        el.rows = field.rows || 3;
        el.dataset.fieldKey = key;
        el.dataset.json = '1';
        el.value = JSON.stringify(value ?? {}, null, 2);
        host.appendChild(el);
        break;
      }
      default: {
        const el = document.createElement('input');
        el.type = ['text', 'email', 'number', 'tel', 'password', 'date', 'color', 'url'].includes(field.type)
          ? field.type : 'text';
        el.dataset.fieldKey = key;
        el.value = value ?? '';
        if (field.placeholder) el.placeholder = field.placeholder;
        if (field.min !== undefined) el.min = field.min;
        if (field.max !== undefined) el.max = field.max;
        if (field.step !== undefined) el.step = field.step;
        host.appendChild(el);
      }
    }
    return host;
  }

  bindChanges() {
    this.root.querySelectorAll('[data-field-key]').forEach((el) => {
      el.addEventListener('input', this._changeHandler);
      el.addEventListener('change', this._changeHandler);
    });
  }

  addRepeatRow(groupId) {
    const group = this.schema.groups.find((g) => g.id === groupId);
    const row = { __rowId: generateId('row') };
    for (const field of group.fields) row[field.id] = defaultForField(field);
    if (!Array.isArray(this.state.groups[groupId])) this.state.groups[groupId] = [];
    this.state.groups[groupId].push(row);
    this.rerenderPreserveFocus(this.schema, this.state);
    this.onDirty(this.collect());
  }

  markRowDeleted(groupId, rowId) {
    const rows = this.state.groups[groupId];
    const row = rows.find((r) => r.__rowId === rowId);
    if (!row) return;
    // Soft delete: the row stays in state with __deleted so snapshots retain it.
    row.__deleted = true;
    const removed = this.state.removed[groupId] || (this.state.removed[groupId] = {});
    if (!removed.deletedRows) removed.deletedRows = [];
    if (!removed.deletedRows.includes(rowId)) removed.deletedRows.push(rowId);
    this.rerenderPreserveFocus(this.schema, this.state);
    this.onDirty(this.collect());
  }

  restoreRow(groupId, rowId) {
    const rows = this.state.groups[groupId];
    const row = rows.find((r) => r.__rowId === rowId);
    if (row) delete row.__deleted;
    const removed = this.state.removed[groupId];
    if (removed?.deletedRows) {
      removed.deletedRows = removed.deletedRows.filter((id) => id !== rowId);
    }
    this.rerenderPreserveFocus(this.schema, this.state);
    this.onDirty(this.collect());
  }

  restoreField(groupId, fieldId) {
    // Restoring a parked field requires the field to exist in schema.
    const group = this.schema.groups.find((g) => g.id === groupId);
    if (!group) return;
    const field = group.fields.find((f) => f.id === fieldId);
    if (!field) return;
    const parked = this.state.removed[groupId]?.fields?.[fieldId];
    if (!parked) return;
    if (group.repeatable) return; // single groups only here
    this.state.groups[groupId][fieldId] = parked.value;
    delete this.state.removed[groupId].fields[fieldId];
    this.rerenderPreserveFocus(this.schema, this.state);
    this.onDirty(this.collect());
  }

  renderDeletedTray(group, removedData, rows) {
    const deletedIds = removedData?.deletedRows || [];
    const deletedRows = rows.filter((r) => r.__deleted || deletedIds.includes(r.__rowId));
    if (deletedRows.length === 0) return null;
    const tray = document.createElement('div');
    tray.className = 'tray';
    tray.innerHTML = `<div>已删除的行（数据仍保留在状态中，可恢复）：</div>`;
    for (const row of deletedRows) {
      const item = document.createElement('div');
      item.className = 'tray-item';
      const label = group.fields
        .map((f) => row[f.id])
        .filter((v) => v !== '' && v !== undefined && !(Array.isArray(v) && v.length === 0))
        .slice(0, 2)
        .map((v) => escapeHtml(Array.isArray(v) ? v.join('/') : String(v)))
        .join(' · ') || row.__rowId;
      item.innerHTML = `<span>#${escapeHtml(row.__rowId)} ${label}</span>`;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-small';
      restore.textContent = '恢复';
      restore.addEventListener('click', () => this.restoreRow(group.id, row.__rowId));
      item.appendChild(restore);
      tray.appendChild(item);
    }
    return tray;
  }

  renderRemovedFieldsTray(group, removedData) {
    const parked = removedData?.fields;
    const liveIds = new Set(group.fields.map((f) => f.id));
    const restorable = Object.entries(parked || {}).filter(([id]) => liveIds.has(id));
    const orphans = Object.entries(parked || {}).filter(([id]) => !liveIds.has(id));
    if (restorable.length === 0 && orphans.length === 0) return null;
    const tray = document.createElement('div');
    tray.className = 'tray';
    tray.innerHTML = `<div>已移除字段的数据（永不丢失）：</div>`;
    for (const [fieldId, entry] of restorable) {
      const item = document.createElement('div');
      item.className = 'tray-item';
      item.innerHTML = `<span>${escapeHtml(fieldId)} <small>(${escapeHtml(entry.type || '?')}): ${escapeHtml(this.preview(entry.value))}</small></span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = '还原到字段';
      btn.addEventListener('click', () => this.restoreField(group.id, fieldId));
      item.appendChild(btn);
      tray.appendChild(item);
    }
    for (const [fieldId, entry] of orphans) {
      const item = document.createElement('div');
      item.className = 'tray-item';
      item.innerHTML = `<span>${escapeHtml(fieldId)} <small>(${escapeHtml(entry.type || '?')}, 当前 schema 无此字段): ${escapeHtml(this.preview(entry.value))}</small></span>`;
      tray.appendChild(item);
    }
    return tray;
  }

  preview(value) {
    if (Array.isArray(value)) return value.length ? value.join('/') : '[]';
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value ?? '');
  }

  // Read every control back into a fresh state object, keeping __rowId,
  // __deleted and removed storage intact.
  collect() {
    if (!this.schema || !this.state) return null;
    const state = {
      ...this.state,
      groups: {},
    };
    for (const group of this.schema.groups) {
      if (group.repeatable) {
        const rows = [];
        const rowEls = this.root.querySelectorAll(`.repeater[data-group="${group.id}"] .repeat-row`);
        for (const rowEl of rowEls) {
          const rowId = rowEl.dataset.rowId;
          const source = (this.state.groups[group.id] || []).find((r) => r.__rowId === rowId) || {};
          const row = { __rowId: rowId };
          for (const field of group.fields) {
            row[field.id] = this.readField(field, group.id, rowId);
          }
          if (source.__deleted) row.__deleted = true;
          rows.push(row);
        }
        // Preserve soft-deleted rows that are not rendered.
        for (const source of this.state.groups[group.id] || []) {
          if (!rows.some((r) => r.__rowId === source.__rowId)) rows.push(deepCloneRow(source));
        }
        state.groups[group.id] = rows;
      } else {
        const source = this.state.groups[group.id] || {};
        const row = { __rowId: source.__rowId || generateId('row') };
        for (const field of group.fields) row[field.id] = this.readField(field, group.id, null);
        state.groups[group.id] = row;
      }
    }
    return state;
  }

  readField(field, groupId, rowId) {
    const key = this.fieldKey(groupId, rowId, field.id);
    if (field.type === 'radio') {
      const checked = this.root.querySelector(`input[data-field-key="${CSS.escape(key)}"]:checked`);
      return checked ? checked.value : '';
    }
    if (field.type === 'multiselect') {
      return [...this.root.querySelectorAll(`input[data-field-key="${CSS.escape(key)}"]:checked`)].map((el) => el.value);
    }
    if (field.type === 'checkbox' || field.type === 'boolean') {
      const el = this.root.querySelector(`input[data-field-key="${CSS.escape(key)}"]`);
      return Boolean(el?.checked);
    }
    const el = this.root.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
    if (!el) return defaultForField(field);
    if (field.type === 'number' || field.type === 'range') {
      if (el.value === '') return '';
      const n = Number(el.value);
      return Number.isFinite(n) ? n : el.value;
    }
    if (field.type === 'json') {
      try { return JSON.parse(el.value || '{}'); }
      catch { return { __invalidJson: el.value }; }
    }
    return el.value;
  }
}

function deepCloneRow(row) {
  return JSON.parse(JSON.stringify(row));
}
