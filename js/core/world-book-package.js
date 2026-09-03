export const WORLD_BOOK_PACKAGE_TYPE = 'marshmallow-worldbook';
export const WORLD_BOOK_PACKAGE_VERSION = 1;

function cloneRow(row) {
  const next = { ...row };
  delete next.vector;
  delete next.embedding;
  delete next.vectorUpdatedAt;
  return next;
}

export function buildWorldBookPackage(entries = [], targetId = '') {
  const rows = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const target = rows.find((row) => String(row.id) === String(targetId));
  if (!target) throw new Error('没有找到要导出的世界书内容');

  let selected = [];
  let scope = 'item';
  if (target.isCollection) {
    scope = 'collection';
    const bookIds = new Set(rows
      .filter((row) => row.isBookRoot && !row.isCollection && row.collectionId === target.id)
      .map((row) => row.id));
    selected = rows.filter((row) => row.id === target.id || bookIds.has(row.id) || bookIds.has(row.bookId));
  } else if (target.isBookRoot) {
    scope = 'book';
    selected = rows.filter((row) => row.id === target.id || row.bookId === target.id);
  } else if (target.kind === 'group') {
    scope = 'group';
    selected = rows.filter((row) => row.id === target.id || row.groupId === target.id);
  } else {
    selected = [target];
  }

  return {
    type: WORLD_BOOK_PACKAGE_TYPE,
    schemaVersion: WORLD_BOOK_PACKAGE_VERSION,
    scope,
    name: String(target.name || '未命名世界书').trim() || '未命名世界书',
    exportedAt: new Date().toISOString(),
    entries: selected.map(cloneRow),
  };
}

export function isWorldBookPackage(source) {
  return source?.type === WORLD_BOOK_PACKAGE_TYPE
    && Number(source?.schemaVersion) === WORLD_BOOK_PACKAGE_VERSION
    && Array.isArray(source?.entries);
}

export function prepareWorldBookPackageImport(source, options = {}) {
  if (!isWorldBookPackage(source)) throw new Error('不是可识别的棉花糖机世界书文件');
  if (!source.entries.length) throw new Error('世界书文件中没有内容');
  const stamp = String(options.stamp || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const idMap = new Map();
  source.entries.forEach((row, index) => {
    const oldId = String(row?.id || '').trim();
    if (oldId) idMap.set(oldId, `wb_import_${stamp}_${index + 1}`);
  });
  const mapId = (value) => idMap.get(String(value || '').trim()) || '';
  const now = Date.now();
  const entries = source.entries.map((row, index) => ({
    ...cloneRow(row),
    id: mapId(row.id) || `wb_import_${stamp}_${index + 1}`,
    bookId: mapId(row.bookId),
    collectionId: mapId(row.collectionId),
    groupId: mapId(row.groupId),
    parentGroupId: mapId(row.parentGroupId),
    category: String(row.category || 'custom'),
    system: 'worldbook',
    createdAt: now,
    updatedAt: now,
  }));
  return { entries, name: String(source.name || '世界书').trim() || '世界书' };
}

export function safeWorldBookFilename(name = '') {
  const safe = String(name || '世界书').replace(/[\\/:*?\"<>|]/g, '-').trim() || '世界书';
  return `${safe}.worldbook.json`;
}
