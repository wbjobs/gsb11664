/* 快照管理：创建 / 校验 / 恢复 / 导入导出（含版本兼容与冲突检测） */
'use strict';

/* ---- Worker 客户端 ---- */
const WorkerClient = (() => {
  const worker = new Worker('js/worker.js');
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  function call(op, payload) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, payload });
    });
  }
  return {
    compress: (json) => call('compress', json),
    decompress: (payload) => call('decompress', payload),
    hash: (json) => call('hash', json),
  };
})();

/* 状态的规范序列化（key 排序，保证同一状态哈希稳定） */
function canonicalize(state) {
  const sortObj = (v) => {
    if (Array.isArray(v)) return v.map(sortObj);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sortObj(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(sortObj(state));
}

const SnapshotManager = {
  /* 创建快照（压缩 + 完整性校验） */
  async create(state, { name, kind = 'manual' } = {}) {
    const normalized = normalizeState(state);
    const json = canonicalize(normalized);
    const packed = await WorkerClient.compress(json);
    const snap = {
      id: 'snap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      name: name || ('快照 ' + new Date().toLocaleString()),
      kind, // manual | auto-backup | conflict-backup | imported
      createdAt: Date.now(),
      schemaVersion: normalized.__v,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      compressed: { algo: packed.algo, data: packed.data },
      hash: packed.hash,
      rawSize: packed.rawSize,
      size: packed.size,
    };
    await DB.putSnapshot(snap);
    return snap;
  },

  /* 解压并校验哈希，返回状态对象；损坏时抛错 */
  async load(snap) {
    const { json, hash } = await WorkerClient.decompress(snap.compressed);
    if (snap.hash && hash !== snap.hash) {
      throw new Error(`快照「${snap.name}」校验失败：数据已损坏，拒绝回滚`);
    }
    return normalizeState(JSON.parse(json));
  },

  async stateHash(state) {
    return (await WorkerClient.hash(canonicalize(normalizeState(state)))).hash;
  },

  /* 导出：全部快照解压为明文 JSON，附格式版本与整体校验 */
  async exportAll(snaps) {
    const items = [];
    for (const s of snaps) {
      const state = await this.load(s);
      items.push({
        id: s.id, name: s.name, kind: s.kind, createdAt: s.createdAt,
        schemaVersion: s.schemaVersion, hash: s.hash, state,
      });
    }
    const payload = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      app: 'form-snapshot-timetravel',
      exportedAt: new Date().toISOString(),
      snapshots: items,
    };
    const json = JSON.stringify(payload, null, 2);
    const { hash } = await WorkerClient.hash(json);
    payload.checksum = hash;
    return JSON.stringify(payload, null, 2);
  },

  /* 导入：版本兼容 + 校验 + 冲突检测。返回 {added, conflicts, migrated} */
  async importAll(fileText) {
    let payload;
    try { payload = JSON.parse(fileText); }
    catch { throw new Error('导入失败：不是合法的 JSON 文件'); }

    const fmt = Number(payload.formatVersion) || 1;
    if (fmt > SNAPSHOT_FORMAT_VERSION) {
      // 高版本文件：降级处理——尽力读取已知字段，并明确提示
      if (!Array.isArray(payload.snapshots)) {
        throw new Error(`文件格式版本 v${fmt} 高于当前支持的 v${SNAPSHOT_FORMAT_VERSION}，且无法识别内容`);
      }
    }
    if (!Array.isArray(payload.snapshots)) throw new Error('导入失败：缺少 snapshots 数组');

    // 整体校验（v2 格式带 checksum）
    if (payload.checksum) {
      const copy = JSON.parse(JSON.stringify(payload));
      delete copy.checksum;
      const { hash } = await WorkerClient.hash(JSON.stringify(copy, null, 2));
      if (hash !== payload.checksum) throw new Error('导入失败：文件校验和不匹配，内容可能被篡改');
    }

    const existing = await DB.allSnapshots();
    const byId = new Map(existing.map(s => [s.id, s]));
    const byHash = new Map(existing.map(s => [s.hash, s]));
    let added = 0, migrated = 0;
    const conflicts = [];

    for (const item of payload.snapshots) {
      // v1 文件可能缺少 kind/schemaVersion，迁移补齐
      const state = normalizeState(item.state);
      if ((Number(item.schemaVersion) || 1) < SCHEMA_VERSION) migrated++;
      const json = canonicalize(state);
      const packed = await WorkerClient.compress(json);

      if (byHash.has(packed.hash)) continue; // 内容完全相同的快照：跳过

      let id = item.id || ('snap_imp_' + Math.random().toString(36).slice(2, 10));
      let name = item.name || '导入快照';
      let kind = item.kind || 'imported';

      if (byId.has(id) && byId.get(id).hash !== packed.hash) {
        // 冲突：同 id 不同内容——双方都保留，导入方改名
        conflicts.push({ id, name });
        id = id + '_imp' + Math.random().toString(36).slice(2, 6);
        name = name + '（导入冲突副本）';
        kind = 'conflict-backup';
      }

      await DB.putSnapshot({
        id, name, kind,
        createdAt: Number(item.createdAt) || Date.now(),
        schemaVersion: state.__v,
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        compressed: { algo: packed.algo, data: packed.data },
        hash: packed.hash,
        rawSize: packed.rawSize,
        size: packed.size,
      });
      added++;
    }
    return { added, conflicts, migrated };
  },
};
