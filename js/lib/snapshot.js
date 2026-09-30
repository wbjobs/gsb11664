// Snapshot graph model: create / name / compare / lineage / LCA / rollback.
//
// Snapshots form a directed tree (parentId). Rolling back to an older node
// creates a *new* branch commit — nothing is ever rewritten or deleted, so
// rollback cannot lose data. Conflicts with dirty working edits are surfaced
// through three-way merge against the LCA of the two commits.
import { generateId, nowIso, deepClone, deepEqual, crc32 } from './util.js';
import { canonicalStringify, encodeUtf8 } from './serialize.js';

export const SNAPSHOT_RECORD_VERSION = 1;
export const EXPORT_FORMAT = 'form-snapshot-bundle/1';

export function createSnapshot({
  name,
  state,
  schema,
  parentId = null,
  reason = 'manual',
  metrics = {},
  description = '',
  label = '',
}) {
  if (!state || typeof state !== 'object') throw new Error('snapshot requires a state object');
  const canonical = canonicalStringify(state);
  const bytes = encodeUtf8(canonical);
  const timestamp = nowIso();
  return {
    id: generateId('snap'),
    recordVersion: SNAPSHOT_RECORD_VERSION,
    name: name || defaultSnapshotName(reason, timestamp),
    description,
    label,
    createdAt: timestamp,
    schemaVersion: schema?.schemaVersion ?? state.schemaVersion,
    stateVersion: state.stateVersion,
    parentId,
    reason, // manual | auto | rollback | import | checkpoint
    stateChecksum: crc32(bytes),
    stateSize: bytes.length,
    compressedSize: metrics.compressedSize ?? null,
    compression: metrics.compression ?? null,
    // State is attached during transport; the DB layer stores it separately.
    state: deepClone(state),
  };
}

export function defaultSnapshotName(reason, iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const prefix = {
    manual: '快照',
    auto: '自动快照',
    rollback: '回滚快照',
    import: '导入快照',
    checkpoint: '检查点',
  }[reason] || '快照';
  return `${prefix} ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}:${ss}`;
}

export function renameSnapshot(snapshot, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('快照名称不能为空');
  return { ...snapshot, name: trimmed, renamedAt: nowIso() };
}

export function buildIndex(snapshots) {
  const byId = new Map();
  const children = new Map();
  for (const snap of snapshots) {
    byId.set(snap.id, snap);
    if (!children.has(snap.id)) children.set(snap.id, []);
  }
  for (const snap of snapshots) {
    if (snap.parentId && byId.has(snap.parentId)) {
      if (!children.has(snap.parentId)) children.set(snap.parentId, []);
      children.get(snap.parentId).push(snap);
    }
  }
  return { byId, children };
}

export function getRoots(snapshots) {
  const { byId } = buildIndex(snapshots);
  return snapshots.filter((s) => !s.parentId || !byId.has(s.parentId));
}

export function ancestorChain(snapshotId, byId) {
  const chain = [];
  let cur = byId.get(snapshotId);
  const guard = new Set();
  while (cur) {
    if (guard.has(cur.id)) break; // defensive against corrupted cycles
    guard.add(cur.id);
    chain.push(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain;
}

// Lowest common ancestor of two snapshot nodes in the commit tree.
export function findLCA(idA, idB, byId) {
  if (idA === idB) return idA;
  const chainA = new Set(ancestorChain(idA, byId));
  for (const id of ancestorChain(idB, byId)) {
    if (chainA.has(id)) return id;
  }
  return null;
}

// Heads = nodes that are nobody's parent. Current branch head is the node
// whose chain contains the latest snapshot the draft was based on.
export function findHeads(snapshots) {
  const { children } = buildIndex(snapshots);
  return snapshots.filter((s) => (children.get(s.id)?.length || 0) === 0);
}

export function isAncestor(maybeAncestorId, descendantId, byId) {
  return ancestorChain(descendantId, byId).includes(maybeAncestorId);
}

// Timeline ordering: topological then chronological, with branch lanes.
export function layoutTimeline(snapshots) {
  const { byId, children } = buildIndex(snapshots);
  const roots = getRoots(snapshots);
  const ordered = [];
  const visited = new Set();
  const walk = (node) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    const kids = [...(children.get(node.id) || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const kid of kids) walk(kid);
  };
  for (const root of [...roots].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) walk(root);
  return { ordered, byId, children, roots };
}

export function sameState(a, b) {
  return deepEqual(a, b);
}

// Plan a rollback. Detects dirty edits vs base and requires conflict handling.
// Returns instructions; the caller performs the merge via diff.js.
export function planRollback({ snapshots, targetId, workingState, baseId }) {
  const { byId } = buildIndex(snapshots);
  const target = byId.get(targetId);
  if (!target) throw new Error(`target snapshot ${targetId} not found`);
  const base = baseId ? byId.get(baseId) : null;
  const lcaId = baseId ? findLCA(baseId, targetId, byId) : targetId;
  const lca = lcaId ? byId.get(lcaId) : null;
  const dirty = base ? !deepEqual(workingState, base.state) : false;
  const sameAsTarget = deepEqual(workingState, target.state);
  return {
    target, base, lca, lcaId, dirty, sameAsTarget,
    onCurrentBranch: baseId ? isAncestor(targetId, baseId, byId) : false,
  };
}

// ---- export / import ------------------------------------------------------

export function buildExportBundle({
  snapshots,
  schemas,
  selectedIds = null,
  includeCompressed = true,
}) {
  const chosen = selectedIds
    ? snapshots.filter((s) => selectedIds.includes(s.id))
    : snapshots;
  const usedSchemaVersions = new Set(chosen.map((s) => s.schemaVersion));
  const schemaEntries = schemas.filter((s) => usedSchemaVersions.has(s.schemaVersion));
  const payload = {
    format: EXPORT_FORMAT,
    bundleVersion: 1,
    exportedAt: nowIso(),
    app: { name: 'form-snapshot-time-machine', minRecordVersion: 1 },
    schemas: schemaEntries.map((s) => deepClone(s)),
    snapshots: chosen.map((s) => ({
      ...deepClone(s),
      state: deepClone(s.state),
      ...(includeCompressed ? {} : { compressedBlob: undefined }),
    })),
  };
  const json = canonicalStringify(payload);
  return {
    filename: `snapshots-${new Date().toISOString().slice(0, 11)}.json`,
    json,
    checksum: crc32(encodeUtf8(json)),
    snapshotCount: chosen.length,
  };
}

export class ImportError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ImportError';
    this.details = details || {};
  }
}

// Validate + remap an imported bundle into the local database space.
export function prepareImport({ bundleText, existingSnapshots, existingSchemas }) {
  let bundle;
  try {
    bundle = JSON.parse(bundleText);
  } catch (e) {
    throw new ImportError(`文件不是合法 JSON：${e.message}`);
  }
  const problems = [];
  if (!bundle || bundle.format !== EXPORT_FORMAT) {
    throw new ImportError(`不支持的文件格式（期望 ${EXPORT_FORMAT}）`);
  }
  if (!Array.isArray(bundle.snapshots) || bundle.snapshots.length === 0) {
    throw new ImportError('导出包中没有快照');
  }

  const idRemap = new Map();
  for (const s of bundle.snapshots) idRemap.set(s.id, generateId('snap'));

  const existingIds = new Set(existingSnapshots.map((s) => s.id));
  const snapshotById = new Map(bundle.snapshots.map((s) => [s.id, s]));
  const localSchemaByVersion = new Map(existingSchemas.map((s) => [s.schemaVersion, s]));
  const bundleSchemaByVersion = new Map((bundle.schemas || []).map((s) => [s.schemaVersion, s]));
  const schemaVersionRemap = new Map();

  // Determine schema mapping. Identical schema => reuse local version.
  for (const remoteSchema of bundle.schemas || []) {
    const key = canonicalKey(remoteSchema);
    const match = existingSchemas.find((s) => canonicalKey(s) === key);
    if (match) {
      schemaVersionRemap.set(remoteSchema.schemaVersion, match.schemaVersion);
    } else {
      const nextVersion = nextSchemaVersion(existingSchemas, schemaVersionRemap);
      schemaVersionRemap.set(remoteSchema.schemaVersion, nextVersion);
      const cloned = deepClone(remoteSchema);
      cloned.schemaVersion = nextVersion;
      cloned.importedFrom = remoteSchema.schemaVersion;
      existingSchemas.push(cloned);
      localSchemaByVersion.set(nextVersion, cloned);
      problems.push(`导入的 schema v${remoteSchema.schemaVersion} 在本地不存在，注册为新版本 v${nextVersion}`);
    }
  }

  const imported = [];
  const danglingParents = [];
  for (const snap0 of bundle.snapshots) {
    const snap = deepClone(snap0);
    const newId = idRemap.get(snap.id);
    if (existingIds.has(snap.id)) {
      // Should never happen after remap, but double-check.
      snap.id = newId;
    } else {
      snap.id = newId;
    }
    const newParent = snap.parentId ? idRemap.get(snap.parentId) : null;
    if (snap.parentId && !newParent) {
      danglingParents.push(snap.name || snap.id);
      snap.parentId = null; // detached root; data still preserved
    } else {
      snap.parentId = newParent;
    }
    if (snap.schemaVersion !== undefined && schemaVersionRemap.has(snap.schemaVersion)) {
      snap.schemaVersion = schemaVersionRemap.get(snap.schemaVersion);
    }
    // Validate embedded checksum: catches truncated / hand-edited bundles.
    let actualCrc = null;
    try {
      actualCrc = crc32(encodeUtf8(canonicalStringify(snap.state)));
    } catch (e) {
      throw new ImportError(`快照「${snap.name}」状态不可序列化：${e.message}`, { path: e.path });
    }
    if (typeof snap.stateChecksum === 'number' && snap.stateChecksum !== actualCrc) {
      problems.push(`快照「${snap.name}」校验和不匹配（记录 ${snap.stateChecksum}，实际 ${actualCrc}），已阻止导入`);
      continue;
    }
    if (!snap.state || typeof snap.state !== 'object') {
      problems.push(`快照「${snap.name}」缺少 state，已跳过`);
      continue;
    }
    snap.stateChecksum = actualCrc;
    snap.imported = true;
    imported.push(snap);
  }

  if (imported.length === 0) throw new ImportError('没有可导入的有效快照', { problems });
  return {
    imported,
    schemasToAdd: existingSchemas.filter((s) =>
      (bundle.schemas || []).some((b) => schemaVersionRemap.get(b.schemaVersion) === s.schemaVersion && s.importedFrom === b.schemaVersion)),
    problems,
    danglingParents,
  };
}

function canonicalKey(schema) {
  const clone = deepClone(schema);
  delete clone.releasedAt;
  delete clone.note;
  delete clone.importedFrom;
  return canonicalStringify(clone);
}

function nextSchemaVersion(existingSchemas, remap) {
  let max = existingSchemas.reduce((m, s) => Math.max(m, s.schemaVersion || 0), 0);
  for (const v of remap.values()) max = Math.max(max, v);
  return max + 1;
}
