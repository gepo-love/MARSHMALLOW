/** 世界书条目（商业版 · 无赛季 / 战队字段依赖） */

export function createWorldBookEntry(overrides = {}) {
  const now = Date.now();
  const kind = overrides.kind === 'group' ? 'group' : 'item';
  const characterIds = Array.isArray(overrides.characterIds)
    ? [...new Set(overrides.characterIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  const scope = ['character', 'group'].includes(overrides.scope) ? overrides.scope : 'global';
  return {
    id: overrides.id || `wb_${now}_${Math.random().toString(36).slice(2, 6)}`,
    kind,
    isBookRoot: !!overrides.isBookRoot,
    isCollection: !!overrides.isCollection,
    name: String(overrides.name || '').trim(),
    category: String(overrides.category || 'custom').trim() || 'custom',
    content: String(overrides.content || ''),
    keys: Array.isArray(overrides.keys) ? overrides.keys.map((k) => String(k).trim()).filter(Boolean) : [],
    constant: !!overrides.constant,
    selective: !!overrides.selective,
    // 优先级：core=核心设定（必须遵守，排最前，正文加强提示前缀）；normal=默认；
    // hint=纯氛围点缀（排最后，提示「不必照搬」）。只影响注入顺序与措辞强度，不影响是否触发。
    // 注意：要求角色执行的行为规则（玩梗方式、口癖、禁忌）应标 core/normal，别放 hint。
    priority: ['core', 'normal', 'hint'].includes(overrides.priority) ? overrides.priority : 'normal',
    position: Number.isFinite(Number(overrides.position)) ? Number(overrides.position) : 100,
    depth: Number.isFinite(Number(overrides.depth)) ? Number(overrides.depth) : 4,
    enabled: overrides.enabled !== false,
    scope,
    characterIds,
    // scope='group' 时的分组绑定：contact=通讯录分组，relationship=关系网圈子
    groupType: ['contact', 'relationship'].includes(overrides.groupType) ? overrides.groupType : '',
    groupRefId: String(overrides.groupRefId || '').trim(),
    userId: overrides.userId || null,
    bookId: String(overrides.bookId || '').trim(),
    collectionId: String(overrides.collectionId || '').trim(),
    groupId: String(overrides.groupId || overrides.parentGroupId || '').trim(),
    parentGroupId: String(overrides.parentGroupId || overrides.groupId || '').trim(),
    // 子系统区分：worldbook=常规世界书（默认），miniwiki=小知识库/梗百科
    system: overrides.system === 'miniwiki' ? 'miniwiki' : 'worldbook',
    // miniwiki 条目来源：user=用户手写，ai_grown=搜索编排自动沉淀
    origin: overrides.origin === 'ai_grown' ? 'ai_grown' : 'user',
    // miniwiki 深浅档（light/deep），与注入深度数字 depth 无关
    wikiDepth: ['light', 'deep'].includes(overrides.wikiDepth) ? overrides.wikiDepth : '',
    sourceUrl: String(overrides.sourceUrl || '').trim(),
    createdAt: Number(overrides.createdAt) || now,
    updatedAt: Number(overrides.updatedAt) || now,
  };
}

export const WORLD_BOOK_PRIORITIES = {
  core: { label: '核心', hint: '必须遵守，排最前，注入时会强调优先级；行为规则（玩梗方式、口癖、禁忌）建议用核心或普通' },
  normal: { label: '普通', hint: '默认档位' },
  hint: { label: '参考', hint: '纯氛围点缀，排最后，提示「不必照搬」；别把要执行的规则放这档' },
};

export const WORLD_BOOK_CATEGORIES = {
  basics: { label: '基础', hint: '通用世界观与规则' },
  relationship: { label: '关系', hint: '人物关系与称呼' },
  scene: { label: '场景', hint: '地点、时代、氛围' },
  custom: { label: '自定义', hint: '导入或自建' },
};
