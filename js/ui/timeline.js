// Canvas timeline: commit-tree graph with branch lanes, hover tooltip and
// hit-tested clicks. Pure geometry is separated from drawing so tests can
// verify positions without a browser.
import { buildIndex, getRoots } from '../lib/snapshot.js';
import { formatTime } from '../lib/util.js';

export const PALETTE = ['#5b8cff', '#35d0ba', '#f0b429', '#ef5b6e', '#9d7bff', '#4fc3f7', '#8bc34a', '#ff8a65'];

// Assign (col, lane, colorIndex) to every snapshot.
// DFS preorder by time; branches keep a stable lane for their lifetime.
export function computeLayout(snapshots, options = {}) {
  const { byId, children } = buildIndex(snapshots);
  const roots = getRoots(snapshots).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const nodes = new Map();
  const edges = [];
  let col = 0;
  let nextColor = 0;
  const laneCount = () => options.maxLanes || 6;

  const visit = (node, lane, colorIndex, rootId) => {
    if (nodes.has(node.id)) return;
    nodes.set(node.id, {
      id: node.id, col, lane, colorIndex, rootId,
      snapshot: node,
    });
    col += 1;
    const kids = [...(children.get(node.id) || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (kids.length === 0) return;
    // First child continues the same lane; extra children fork into free lanes.
    const usedLanes = new Set([...nodes.values()].map((n) => n.lane));
    const freeLane = () => {
      for (let l = 0; l < laneCount(); l += 1) if (!usedLanes.has(l)) return l;
      return lane % laneCount();
    };
    kids.forEach((kid, i) => {
      let kidLane = lane;
      let kidColor = colorIndex;
      if (i > 0) {
        kidLane = freeLane();
        usedLanes.add(kidLane);
        nextColor = (nextColor + 1) % PALETTE.length;
        kidColor = nextColor;
      }
      edges.push({ from: node.id, to: kid.id });
      visit(kid, kidLane, kidColor, rootId);
    });
  };

  roots.forEach((root) => {
    const lane = 0;
    visit(root, lane, nextColor % PALETTE.length, root.id);
    nextColor = (nextColor + 1) % PALETTE.length;
  });

  return {
    nodes,
    edges,
    columns: Math.max(1, col),
    lanes: options.maxLanes || 6,
  };
}

const REASON_MARKER = {
  manual: { shape: 'circle', color: '#5b8cff' },
  auto: { shape: 'diamond', color: '#9aa3c7' },
  rollback: { shape: 'square', color: '#f0b429' },
  checkpoint: { shape: 'diamond', color: '#4fc3f7' },
  import: { shape: 'hex', color: '#9d7bff' },
};

export class TimelineCanvas {
  constructor(canvas, { onSelect, getTooltip }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect || (() => {});
    this.getTooltip = getTooltip || null;
    this.snapshots = [];
    this.layout = null;
    this.selectedId = null;
    this.baseId = null;
    this.replayId = null;
    this.scale = 1;
    this.hoverId = null;
    this.hitAreas = [];
    this.padX = 34;
    this.padY = 30;
    this.colGap = 118;
    this.laneGap = 64;
    this.radius = 9;
    this.offsetX = 0;

    this._onClick = (event) => this.handleClick(event);
    this._onMove = (event) => this.handleMove(event);
    this._onLeave = () => { this.hoverId = null; this.draw(); };
    canvas.addEventListener('click', this._onClick);
    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);
  }

  destroy() {
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.removeEventListener('mousemove', this._onMove);
    this.canvas.removeEventListener('mouseleave', this._onLeave);
  }

  setData(snapshots, { selectedId = null, baseId = null, replayId = null } = {}) {
    this.snapshots = snapshots;
    this.layout = computeLayout(snapshots);
    this.selectedId = selectedId;
    this.baseId = baseId;
    this.replayId = replayId;
    this.fitScale();
    this.draw();
  }

  setHighlight({ selectedId, baseId, replayId }) {
    if (selectedId !== undefined) this.selectedId = selectedId;
    if (baseId !== undefined) this.baseId = baseId;
    if (replayId !== undefined) this.replayId = replayId;
    this.draw();
  }

  fitScale() {
    const width = this.canvas.clientWidth || 820;
    const need = this.padX * 2 + Math.max(0, this.layout.columns - 1) * this.colGap;
    this.scale = Math.min(1, width / Math.max(need, 1));
  }

  nodePos(node) {
    return {
      x: this.padX + node.col * this.colGap * this.scale + this.offsetX,
      y: this.padY + node.lane * this.laneGap + 20,
    };
  }

  draw() {
    if (!this.layout) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 820;
    const cssH = this.canvas.clientHeight || 300;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    this.drawGrid(cssW, cssH);

    // Edges
    for (const edge of this.layout.edges) {
      const from = this.layout.nodes.get(edge.from);
      const to = this.layout.nodes.get(edge.to);
      if (!from || !to) continue;
      const p1 = this.nodePos(from);
      const p2 = this.nodePos(to);
      ctx.strokeStyle = PALETTE[to.colorIndex % PALETTE.length] + 'aa';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      const midX = (p1.x + p2.x) / 2;
      ctx.bezierCurveTo(midX, p1.y, midX, p2.y, p2.x, p2.y);
      ctx.stroke();
    }

    this.hitAreas = [];
    for (const node of this.layout.nodes.values()) {
      const pos = this.nodePos(node);
      this.drawNode(node, pos, cssW);
    }
  }

  drawGrid(width, height) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (let lane = 0; lane < this.layout.lanes; lane += 1) {
      const y = this.padY + lane * this.laneGap + 20;
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(width - 8, y);
      ctx.stroke();
    }
  }

  drawNode(node, pos, cssWidth) {
    const ctx = this.ctx;
    const snap = node.snapshot;
    const marker = REASON_MARKER[snap.reason] || REASON_MARKER.manual;
    const color = PALETTE[node.colorIndex % PALETTE.length];
    const isSelected = this.selectedId === snap.id;
    const isBase = this.baseId === snap.id;
    const isReplay = this.replayId === snap.id;
    const isHover = this.hoverId === snap.id;
    const r = isReplay ? this.radius + 3 : this.radius;

    if (isBase) {
      ctx.strokeStyle = '#35d0ba';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isSelected || isReplay) {
      ctx.shadowColor = isReplay ? '#f0b429' : color;
      ctx.shadowBlur = 16;
    }
    ctx.fillStyle = isHover || isSelected ? color : '#1a2040';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    this.traceMarker(marker.shape, pos.x, pos.y, r);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Label below the node (short name + time), clipped to reasonable width.
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isHover || isSelected ? '#ffffff' : '#9aa3c7';
    const label = snap.name.length > 12 ? `${snap.name.slice(0, 11)}…` : snap.name;
    if (pos.x > 50 && pos.x < cssWidth - 50) {
      ctx.fillText(label, pos.x, pos.y + r + 15);
      ctx.fillStyle = '#6f79a6';
      ctx.fillText(formatTime(snap.createdAt).slice(5), pos.x, pos.y + r + 28);
    }
    this.hitAreas.push({ id: snap.id, x: pos.x, y: pos.y, r: r + 8 });
  }

  traceMarker(shape, x, y, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (shape === 'circle') {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    } else if (shape === 'square') {
      ctx.rect(x - r, y - r, r * 2, r * 2);
    } else if (shape === 'diamond') {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    } else if (shape === 'hex') {
      for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }

  pick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let hit = null;
    for (const area of this.hitAreas) {
      const dx = x - area.x;
      const dy = y - area.y;
      if (dx * dx + dy * dy <= area.r * area.r) {
        hit = area;
        break;
      }
    }
    return hit ? hit.id : null;
  }

  handleClick(event) {
    const id = this.pick(event);
    if (id) this.onSelect(id);
  }

  handleMove(event) {
    const id = this.pick(event);
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.draw();
    }
    this.canvas.style.cursor = id ? 'pointer' : 'crosshair';
    if (this.getTooltip) this.getTooltip(id, event);
  }
}
