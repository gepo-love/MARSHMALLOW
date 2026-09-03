/** 单个 TXT / DOCX：整份文档 → 一本世界书 + 一条条目 */
export function importWorldBookFromDocumentText(text, options = {}) {
  const content = String(text || '').trim();
  if (!content) throw new Error('文档内容为空');
  const batchId = String(options?.batchId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const sourceName = String(options?.sourceName || `导入世界书_${batchId}`).trim() || `导入世界书_${batchId}`;
  const rootGroupId = `wb_book_${batchId}`;
  const itemName = String(options?.itemName || sourceName).trim() || sourceName;
  const collectionId = String(options?.collectionId || '').trim();
  return {
    entries: [
      {
        id: rootGroupId,
        kind: 'group',
        isBookRoot: true,
        name: sourceName,
        category: 'custom',
        keys: [],
        content: '',
        constant: false,
        selective: false,
        enabled: true,
        position: 0,
        depth: 1,
        collectionId,
      },
      {
        id: `wb_imp_${batchId}_0`,
        kind: 'item',
        name: itemName,
        category: 'custom',
        keys: [],
        content,
        constant: false,
        selective: false,
        enabled: true,
        position: 0,
        depth: 4,
        groupId: '',
        bookId: rootGroupId,
      },
    ],
    warnings: [],
  };
}
