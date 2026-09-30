/* 表单渲染与状态读写（DOM <-> 可序列化状态） */
'use strict';

const FormUI = (() => {
  const formEl = document.getElementById('complexForm');
  let onChange = () => {};

  function fieldInputId(groupId, key, rowIdx) {
    return `f_${groupId}_${key}` + (rowIdx !== undefined ? `_${rowIdx}` : '');
  }

  function buildField(groupId, f, rowIdx) {
    const id = fieldInputId(groupId, f.key, rowIdx);
    const wrap = document.createElement('div');
    wrap.className = 'field-row';
    wrap.dataset.path = rowIdx !== undefined ? `${groupId}[${rowIdx}].${f.key}` : f.key;

    const label = document.createElement('label');
    label.className = 'fl';
    label.textContent = f.label;
    label.htmlFor = id;
    wrap.appendChild(label);

    let input;
    switch (f.type) {
      case 'textarea':
        input = document.createElement('textarea');
        input.id = id;
        break;
      case 'select':
        input = document.createElement('select');
        input.id = id;
        for (const o of f.options) {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          input.appendChild(opt);
        }
        break;
      case 'checkbox':
        input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        break;
      case 'radio': {
        const box = document.createElement('div');
        box.className = 'check-line';
        for (const o of f.options) {
          const l = document.createElement('label');
          const r = document.createElement('input');
          r.type = 'radio'; r.name = id; r.value = o;
          l.appendChild(r); l.appendChild(document.createTextNode(o));
          box.appendChild(l);
        }
        wrap.appendChild(box);
        return wrap;
      }
      case 'checkbox-group': {
        const box = document.createElement('div');
        box.className = 'check-line';
        for (const o of f.options) {
          const l = document.createElement('label');
          const c = document.createElement('input');
          c.type = 'checkbox'; c.name = id; c.value = o;
          l.appendChild(c); l.appendChild(document.createTextNode(o));
          box.appendChild(l);
        }
        wrap.appendChild(box);
        return wrap;
      }
      default:
        input = document.createElement('input');
        input.type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
        input.id = id;
    }
    wrap.appendChild(input);
    return wrap;
  }

  function buildRepeatGroup(g) {
    const fs = document.createElement('fieldset');
    fs.dataset.group = g.id;
    const lg = document.createElement('legend');
    lg.textContent = g.title;
    fs.appendChild(lg);
    const list = document.createElement('div');
    list.className = 'repeat-list';
    fs.appendChild(list);
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '＋ 添加成员';
    addBtn.addEventListener('click', () => { addRepeatRow(g, list); onChange(); });
    fs.appendChild(addBtn);
    return fs;
  }

  function addRepeatRow(g, listEl, values) {
    const idx = listEl.children.length;
    const item = document.createElement('div');
    item.className = 'repeat-item';
    for (const f of g.itemFields) item.appendChild(buildField(g.id, f, idx));
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm danger'; rm.textContent = '删除';
    rm.addEventListener('click', () => { item.remove(); onChange(); });
    item.appendChild(rm);
    listEl.appendChild(item);
    if (values) applyRowValues(g, item, idx, values);
  }

  function applyRowValues(g, itemEl, idx, row) {
    for (const f of g.itemFields) {
      const id = fieldInputId(g.id, f.key, idx);
      setControlValue(itemEl, id, f, row[f.key]);
    }
  }

  function setControlValue(scope, id, f, value) {
    if (f.type === 'radio') {
      const r = scope.querySelector(`input[name="${id}"][value="${CSS.escape(String(value))}"]`);
      if (r) r.checked = true;
      else { const first = scope.querySelector(`input[name="${id}"]`); if (first) first.checked = true; }
    } else if (f.type === 'checkbox-group') {
      const arr = Array.isArray(value) ? value : [];
      scope.querySelectorAll(`input[name="${id}"]`).forEach(c => { c.checked = arr.includes(c.value); });
    } else if (f.type === 'checkbox') {
      const el = scope.querySelector('#' + CSS.escape(id));
      if (el) el.checked = !!value;
    } else {
      const el = scope.querySelector('#' + CSS.escape(id));
      if (el) el.value = value == null ? '' : value;
    }
  }

  function getControlValue(scope, id, f) {
    if (f.type === 'radio') {
      const r = scope.querySelector(`input[name="${id}"]:checked`);
      return r ? r.value : f.options[0];
    }
    if (f.type === 'checkbox-group') {
      return [...scope.querySelectorAll(`input[name="${id}"]:checked`)].map(c => c.value);
    }
    if (f.type === 'checkbox') {
      const el = scope.querySelector('#' + CSS.escape(id));
      return el ? el.checked : false;
    }
    const el = scope.querySelector('#' + CSS.escape(id));
    if (!el) return defaultValue(f);
    return f.type === 'number' ? (parseFloat(el.value) || 0) : el.value;
  }

  function render() {
    formEl.innerHTML = '';
    for (const g of FORM_SCHEMA) {
      if (g.type === 'repeat') { formEl.appendChild(buildRepeatGroup(g)); continue; }
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = g.title;
      fs.appendChild(lg);
      for (const f of g.fields) fs.appendChild(buildField(g.id, f));
      formEl.appendChild(fs);
    }
    formEl.addEventListener('input', () => onChange());
    formEl.addEventListener('change', () => onChange());
  }

  /* DOM -> 状态 */
  function readState() {
    const s = { __v: SCHEMA_VERSION };
    for (const g of FORM_SCHEMA) {
      if (g.type === 'repeat') {
        const list = formEl.querySelector(`fieldset[data-group="${g.id}"] .repeat-list`);
        s[g.id] = [...list.children].map((itemEl, idx) => {
          const row = {};
          for (const f of g.itemFields) row[f.key] = getControlValue(itemEl, fieldInputId(g.id, f.key, idx), f);
          return row;
        });
        continue;
      }
      for (const f of g.fields) s[f.key] = getControlValue(formEl, fieldInputId(g.id, f.key), f);
    }
    // 保留遗留字段
    if (currentLegacy) s._legacy = JSON.parse(JSON.stringify(currentLegacy));
    return s;
  }

  let currentLegacy = null;

  /* 状态 -> DOM，changedPaths 用于回放时高亮 */
  function applyState(state, changedPaths) {
    const changed = new Set(changedPaths || []);
    for (const g of FORM_SCHEMA) {
      if (g.type === 'repeat') {
        const list = formEl.querySelector(`fieldset[data-group="${g.id}"] .repeat-list`);
        list.innerHTML = '';
        (state[g.id] || []).forEach((row, i) => addRepeatRow(g, list, row));
        continue;
      }
      for (const f of g.fields) {
        setControlValue(formEl, fieldInputId(g.id, f.key), f, state[f.key]);
        if (changed.has(f.key)) flash(formEl.querySelector('#' + CSS.escape(fieldInputId(g.id, f.key))));
      }
    }
    // 遗留字段展示
    currentLegacy = state._legacy || null;
    const sec = document.getElementById('legacySection');
    const box = document.getElementById('legacyFields');
    box.innerHTML = '';
    if (currentLegacy && Object.keys(currentLegacy).length) {
      sec.classList.remove('hidden');
      for (const [k, v] of Object.entries(currentLegacy)) {
        const row = document.createElement('div');
        row.className = 'field-row';
        row.innerHTML = `<label class="fl"></label><input type="text" disabled>`;
        row.querySelector('label').textContent = k;
        row.querySelector('input').value = typeof v === 'object' ? JSON.stringify(v) : String(v);
        box.appendChild(row);
      }
    } else {
      sec.classList.add('hidden');
    }
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  return {
    render,
    readState,
    applyState,
    setOnChange(fn) { onChange = fn; },
  };
})();
