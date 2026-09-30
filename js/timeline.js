/* Canvas 时间线可视化：节点=快照，横轴=时间，半径=压缩率，颜色=类型 */
'use strict';

const Timeline = (() => {
  const canvas = document.getElementById('timeline');
  const tip = document.getElementById('timelineTip');
  const ctx = canvas.getContext('2d');
  let snaps = [];
  let selectedId = null;
  let replayId = null;
  let nodePos = []; // {id,x,y,r}
  let onSelect = () => {};

  const COLORS = {
    manual: '#2f6fed',
    'auto-backup': '#e67e22',
    'conflict-backup': '#c0392b',
    imported: '#8e44ad',
  };

  function layout() {
    const w = canvas.clientWidth, h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    nodePos = [];
    if (!snaps.length) return { w, h };
    const t0 = snaps[0].createdAt;
    const t1 = Math.max(snaps[snaps.length - 1].createdAt, t0 + 60000);
    const pad = 24, axisY = h - 34;
    snaps.forEach((s, i) => {
      const x = pad + (w - pad * 2) * ((s.createdAt - t0) / (t1 - t0));
      const ratio = s.rawSize ? Math.min(1, s.size / s.rawSize) : 1;
      const r = 5 + (1 - ratio) * 5; // 压缩越好点越大
      nodePos.push({ id: s.id, x, y: axisY, r, snap: s });
    });
    return { w, h, axisY, t0, t1, pad };
  }

  function draw() {
    const { w, h, axisY, t0, t1, pad } = layout();
    ctx.clearRect(0, 0, w, h);
    if (!snaps.length) {
      ctx.fillStyle = '#8a94a6';
      ctx.font = '12px sans-serif';
      ctx.fillText('暂无快照，点击「创建快照」开始', 14, 30);
      return;
    }
    // 时间轴
    ctx.strokeStyle = '#c8d0dc';
    ctx.beginPath(); ctx.moveTo(pad - 8, axisY); ctx.lineTo(w - pad + 8, axisY); ctx.stroke();
    // 刻度（起止时间）
    ctx.fillStyle = '#8a94a6';
    ctx.font = '10px sans-serif';
    ctx.fillText(new Date(t0).toLocaleTimeString(), pad - 8, axisY + 22);
    const endLabel = new Date(t1).toLocaleTimeString();
    ctx.fillText(endLabel, w - pad + 8 - ctx.measureText(endLabel).width, axisY + 22);
    // 连接线
    ctx.strokeStyle = '#dfe5ee';
    ctx.beginPath();
    nodePos.forEach((n, i) => { i === 0 ? ctx.moveTo(n.x, n.y) : ctx.lineTo(n.x, n.y); });
    ctx.stroke();
    // 节点
    for (const n of nodePos) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[n.snap.kind] || COLORS.manual;
      ctx.fill();
      if (n.id === replayId) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (n.id === selectedId) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#1e2a3a';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    // 图例
    const legend = [['手动', COLORS.manual], ['自动备份', COLORS['auto-backup']], ['冲突', COLORS['conflict-backup']], ['导入', COLORS.imported]];
    let lx = 10;
    ctx.font = '10px sans-serif';
    for (const [label, color] of legend) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(lx + 4, 12, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a5568';
      ctx.fillText(label, lx + 12, 15);
      lx += 12 + ctx.measureText(label).width + 14;
    }
  }

  function nodeAt(mx, my) {
    return nodePos.find(n => Math.hypot(n.x - mx, n.y - my) <= n.r + 4) || null;
  }

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (n) { selectedId = n.id; draw(); onSelect(n.id); }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (n) {
      const s = n.snap;
      tip.innerHTML = `<b></b><br>${new Date(s.createdAt).toLocaleString()}<br>${s.rawSize}B → ${s.size}B`;
      tip.querySelector('b').textContent = s.name;
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top = (e.clientY + 12) + 'px';
      tip.classList.remove('hidden');
      canvas.style.cursor = 'pointer';
    } else {
      tip.classList.add('hidden');
      canvas.style.cursor = 'default';
    }
  });
  canvas.addEventListener('mouseleave', () => tip.classList.add('hidden'));

  window.addEventListener('resize', draw);

  return {
    setData(list) { snaps = list; draw(); },
    setSelected(id) { selectedId = id; draw(); },
    setReplay(id) { replayId = id; draw(); },
    setOnSelect(fn) { onSelect = fn; },
    redraw: draw,
  };
})();
