export class SnapshotTimeline {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.items = [];
    this.selectedId = null;
    this.playingId = null;
    this.hitRegions = [];
    this.layout = null;
    this.handleClick = this.handleClick.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.canvas.addEventListener('click', this.handleClick);
    window.addEventListener('resize', this.handleResize);
  }

  render(items, selectedId = null, playingId = null) {
    this.items = items;
    this.selectedId = selectedId;
    this.playingId = playingId;
    this.draw();
  }

  destroy() {
    this.canvas.removeEventListener('click', this.handleClick);
    window.removeEventListener('resize', this.handleResize);
  }

  handleResize() {
    this.draw();
  }

  handleClick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = this.hitRegions.find((region) =>
      x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height
    );
    if (hit) this.onSelect(hit.id);
  }

  draw() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const probableLanes = Math.max(1, new Set(this.items.filter((item) => item.record?.parentId).map((item) => item.record.parentId)).size + 1);
    const height = Math.max(230, 76 + probableLanes * 48);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, Math.floor(rect.width * dpr));
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, height);

    const layout = this.computeLayout(rect.width);
    this.layout = layout;
    this.hitRegions = [];
    drawBackground(ctx, rect.width, height);
    drawEdges(ctx, layout);
    drawLaneLabels(ctx, layout);
    for (const node of layout.nodes) {
      drawNode(ctx, node, this.hitRegions, this.selectedId, this.playingId);
    }
    drawAxis(ctx, layout);
  }

  computeLayout(width) {
    const valid = this.items.filter((item) => item.record);
    const ordered = [...valid].sort((a, b) =>
      (a.record.createdAt || 0) - (b.record.createdAt || 0) ||
      a.record.id.localeCompare(b.record.id)
    );
    const lanes = [];
    const laneOccupiedUntil = [];
    const nodes = [];

    for (const item of ordered) {
      const time = item.record.createdAt || 0;
      const parentId = item.record.parentId;
      const parentNode = parentId ? nodes.find((node) => node.id === parentId) : null;
      const parentLane = parentNode?.lane ?? 0;
      let lane = parentLane;
      while ((laneOccupiedUntil[lane] || 0) > time) {
        lane += 1;
      }
      laneOccupiedUntil[lane] = time + 45 * 60 * 1000;
      while (lanes.length <= lane) {
        lanes.push(`分支 ${lanes.length + 1}`);
        laneOccupiedUntil.push(0);
      }
      nodes.push({ item, id: item.record.id, lane, time });
    }
    if (lanes[0]) lanes[0] = '主线';

    const times = nodes.map((node) => node.time);
    const minTime = Math.min(...times, Date.now());
    const maxTime = Math.max(...times, Date.now());
    const span = Math.max(1, maxTime - minTime);
    const margin = 64;
    const innerWidth = Math.max(1, width - margin * 2);

    for (const node of nodes) {
      node.x = margin + ((node.time - minTime) / span) * innerWidth;
      node.y = 54 + node.lane * 48;
      node.radius = 8;
    }

    const edges = nodes
      .filter((node) => node.item.record.parentId)
      .map((node) => ({ from: nodes.find((candidate) => candidate.id === node.item.record.parentId), to: node }))
      .filter((edge) => edge.from);

    return { nodes, edges, lanes, width, minTime, maxTime };
  }

}

function drawBackground(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 230);
  gradient.addColorStop(0, '#f8fafc');
  gradient.addColorStop(1, '#eef2ff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawLaneLabels(ctx, layout) {
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  layout.lanes.forEach((label, lane) => {
    ctx.fillText(label, 12, 58 + lane * 48);
  });
}

function drawEdges(ctx, layout) {
  for (const edge of layout.edges) {
    ctx.beginPath();
    ctx.moveTo(edge.from.x, edge.from.y);
    const midpointX = (edge.from.x + edge.to.x) / 2;
    ctx.bezierCurveTo(midpointX, edge.from.y, midpointX, edge.to.y, edge.to.x, edge.to.y);
    const sameLane = edge.from.lane === edge.to.lane;
    ctx.strokeStyle = sameLane ? '#94a3b8' : '#f59e0b';
    ctx.lineWidth = sameLane ? 2 : 2.5;
    ctx.setLineDash(sameLane ? [] : [6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawNode(ctx, node, hitRegions, selectedId, playingId) {
  const item = node.item;
  const selected = item.record.id === selectedId;
  const playing = item.record.id === playingId;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
  if (!item.ok) ctx.fillStyle = '#dc2626';
  else if (playing) ctx.fillStyle = '#7c3aed';
  else if (selected) ctx.fillStyle = '#2563eb';
  else if (item.matchesCurrent) ctx.fillStyle = '#16a34a';
  else ctx.fillStyle = '#475569';
  ctx.fill();
  ctx.lineWidth = playing ? 3 : 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0f172a';
  const title = truncate(item.record.name || '未命名快照', 13);
  ctx.fillText(title, node.x, node.y - 14);
  ctx.fillStyle = '#64748b';
  ctx.fillText(new Date(node.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), node.x, node.y + 23);
  ctx.textAlign = 'left';

  if (!item.ok) {
    ctx.fillStyle = '#dc2626';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('损坏', node.x, node.y + 36);
  }
  hitRegions.push({ id: node.id, x: node.x - 48, y: node.y - 28, width: 96, height: 56 });
}

function drawAxis(ctx, layout) {
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const axisY = Math.max(204, 36 + layout.lanes.length * 48);
  ctx.moveTo(32, axisY);
  ctx.lineTo(layout.width - 20, axisY);
  ctx.stroke();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(new Date(layout.minTime).toLocaleDateString('zh-CN'), 36, axisY + 16);
  ctx.fillText(new Date(layout.maxTime).toLocaleDateString('zh-CN'), layout.width - 110, axisY + 16);
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
