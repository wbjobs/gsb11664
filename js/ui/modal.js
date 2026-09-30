// Tiny imperative modal + toast system built directly on the DOM.
import { escapeHtml } from '../lib/util.js';

export function modal({ title, body, footer = [], wide = false, onClose }) {
  const root = document.getElementById('modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const box = document.createElement('div');
  box.className = `modal${wide ? ' wide' : ''}`;
  box.innerHTML = `
    <div class="modal-head">
      <h3>${escapeHtml(title)}</h3>
      <button class="modal-close" aria-label="关闭">×</button>
    </div>
    <div class="modal-body"></div>
    ${footer.length ? '<div class="modal-foot"></div>' : ''}
  `;
  const bodyEl = box.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);
  backdrop.appendChild(box);
  root.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
    if (onClose) onClose();
  };
  box.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape' && backdrop.isConnected) { close(); document.removeEventListener('keydown', esc); }
  });

  const foot = box.querySelector('.modal-foot');
  for (const button of footer) {
    const btn = document.createElement('button');
    btn.className = `btn ${button.variant ? `btn-${button.variant}` : ''}`;
    btn.textContent = button.text;
    btn.disabled = Boolean(button.disabled);
    btn.addEventListener('click', () => button.onClick?.({ close, bodyEl, btn }));
    foot?.appendChild(btn);
  }
  return { close, bodyEl, box };
}

export function confirmModal({ title, message, confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p>${escapeHtml(message)}</p>`,
      footer: [
        { text: '取消', onClick: ({ close }) => { close(); resolve(false); } },
        {
          text: confirmText,
          variant: danger ? 'danger' : 'primary',
          onClick: ({ close }) => { close(); resolve(true); },
        },
      ],
    });
    void m;
  });
}

export function promptModal({ title, label = '名称', initialValue = '', placeholder = '' }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `
        <div class="form-row">
          <label>${escapeHtml(label)}</label>
          <input class="input" id="promptInput" value="${escapeHtml(initialValue)}" placeholder="${escapeHtml(placeholder)}" />
        </div>`,
      footer: [
        { text: '取消', onClick: ({ close }) => { close(); resolve(null); } },
        { text: '确定', variant: 'primary', onClick: ({ close, bodyEl }) => {
          const value = bodyEl.querySelector('#promptInput').value;
          close();
          resolve(value);
        } },
      ],
    });
    const input = m.bodyEl.querySelector('#promptInput');
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const value = input.value;
        m.close();
        resolve(value);
      }
    });
  });
}

export function toast(message, type = 'info', duration = 3200) {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, duration);
  return el;
}
