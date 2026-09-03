/**
 * 收集物（生图收集系统的基本单元）
 *
 * 归属（ownership）决定它的「家」：
 * - 'character'：关于 TA 自己（过往/生活碎片/物件）→ 收进「他的空间·收藏册」。
 * - 'shared'   ：你们共同的（约会纪念、一起编织的过去）→ 主家仍在他的空间，
 *               并镜像到记忆馆「共同回忆」（写一条引用记忆，不复制图）。
 *
 * image / iconAsset 是生图收集位：首版留空占位，生图接好后回填。
 */

export const COLLECTIBLE_SOURCES = {
  time_machine: '时光机',
  date: '约会探索',
  activity: '生活碎片',
  manual: '手动收藏',
  message_favorite: '聊天收藏',
  offline_favorite: '线下收藏',
};

export function createCollectible(overrides = {}) {
  const now = Date.now();
  const ownership = overrides.ownership === 'shared' ? 'shared' : 'character';
  return {
    id: overrides.id || `clt_${now}_${Math.random().toString(36).slice(2, 8)}`,
    userId: String(overrides.userId || '').trim(),
    characterId: String(overrides.characterId || '').trim(),
    ownership,
    source: String(overrides.source || 'manual').trim(),
    viewpoint: String(overrides.viewpoint || '').trim(),
    theme: String(overrides.theme || '').trim(),
    title: String(overrides.title || '').trim() || '一段收藏',
    summary: String(overrides.summary || '').trim(),
    body: String(overrides.body || '').trim(),
    image: String(overrides.image || '').trim(),
    imagePrompt: String(overrides.imagePrompt || '').trim(),
    albumNote: String(overrides.albumNote || '').trim(),
    albumFragments: Array.isArray(overrides.albumFragments)
      ? overrides.albumFragments.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [],
    iconAsset: String(overrides.iconAsset || '').trim(),
    linkedId: String(overrides.linkedId || '').trim(),
    sourceChatId: String(overrides.sourceChatId || '').trim(),
    sourceOfflineSessionId: String(overrides.sourceOfflineSessionId || '').trim(),
    sourceMessageIds: Array.isArray(overrides.sourceMessageIds)
      ? overrides.sourceMessageIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
    sourceBeatIds: Array.isArray(overrides.sourceBeatIds)
      ? overrides.sourceBeatIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
    characterIds: Array.isArray(overrides.characterIds)
      ? [...new Set(overrides.characterIds.map((id) => String(id || '').trim()).filter(Boolean))]
      : (String(overrides.characterId || '').trim() ? [String(overrides.characterId).trim()] : []),
    messages: Array.isArray(overrides.messages)
      ? overrides.messages.filter(Boolean).map((row) => ({
        id: String(row.id || '').trim(),
        senderId: String(row.senderId || '').trim(),
        senderName: String(row.senderName || '').trim(),
        type: String(row.type || 'text').trim() || 'text',
        content: String(row.content || ''),
        timestamp: Number(row.timestamp || 0) || 0,
        metadata: row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {},
      }))
      : [],
    appearance: overrides.appearance && typeof overrides.appearance === 'object'
      ? { ...overrides.appearance }
      : {},
    timestamp: Number(overrides.timestamp || now) || now,
  };
}
