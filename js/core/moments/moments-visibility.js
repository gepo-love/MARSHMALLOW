import { resolveCharacterGroupId } from '../contact-groups.js';

function cleanId(value = '') {
  return String(value ?? '').trim();
}

function isPhoneLightContactId(id = '') {
  return /^phone-contact:/i.test(cleanId(id));
}

/** 某角色是否能看到这条朋友圈（用户主 feed 始终可见，由调用方决定） */
export function canCharacterSeeMomentPost(post = {}, characterId = '', charMap = null) {
  const cid = cleanId(characterId);
  if (!cid || cid === 'user') return true;

  const hidden = new Set(
    (Array.isArray(post.hiddenFromIds) ? post.hiddenFromIds : [])
      .map(cleanId)
      .filter(Boolean),
  );
  if (hidden.has(cid)) return false;

  // 手机轻量联系人不在主通讯录分组体系里；除非被点名屏蔽，否则都能看见并互动。
  if (isPhoneLightContactId(cid)) return true;

  const vis = cleanId(post.visibility) || 'all';
  if (vis === 'groups') {
    const allowed = new Set(
      (Array.isArray(post.visibleGroupIds) ? post.visibleGroupIds : (
        Array.isArray(post.visibleGroups) ? post.visibleGroups : []
      ))
        .map(cleanId)
        .filter(Boolean),
    );
    if (!allowed.size) return true;
    const char = charMap?.get?.(cid) || null;
    const groupId = resolveCharacterGroupId(char || {});
    return allowed.has(groupId);
  }
  return true;
}

export function filterMomentViewerIds(post = {}, candidateIds = [], charMap = null) {
  return (candidateIds || [])
    .map(cleanId)
    .filter(Boolean)
    .filter((id) => canCharacterSeeMomentPost(post, id, charMap));
}

export function normalizeMomentVisibility(raw = {}) {
  const visibility = cleanId(raw.visibility) || 'all';
  const visibleGroupIds = (Array.isArray(raw.visibleGroupIds) ? raw.visibleGroupIds : (
    Array.isArray(raw.visibleGroups) ? raw.visibleGroups : []
  ))
    .map(cleanId)
    .filter(Boolean);
  const hiddenFromIds = (Array.isArray(raw.hiddenFromIds) ? raw.hiddenFromIds : (
    Array.isArray(raw.hiddenFrom) ? raw.hiddenFrom : []
  ))
    .map(cleanId)
    .filter(Boolean);
  return {
    visibility: visibility === 'groups' ? 'groups' : 'all',
    visibleGroupIds: visibility === 'groups' ? visibleGroupIds : [],
    hiddenFromIds,
  };
}

export function buildMomentsVisibilityPromptBlock(groupLabels = [], authorIds = []) {
  const groupHint = groupLabels.length
    ? `通讯录分组 id 对照：${groupLabels.slice(0, 10).join('；')}`
    : 'visibleGroupIds 填通讯录分组 id（见上方对照）';
  const authorHint = authorIds.length
    ? `本批发圈 author：${authorIds.join('、')}。生成前先逐个想：TA 的社交圈里谁算上司/长辈/同事/密友/暧昧对象/死对头，谁会视奸、谁会拆台。`
    : '生成前先想每个发圈者的社交圈与角色分工。';
  return [
    '[AI 分组可见 · 角色内表演型分组 · 与用户手动发布设置无关]',
    '这是角色在朋友圈里的「表演型可见范围」剧情字段，不是用户在发布页勾选的分组 UI。',
    authorHint,
    '多数 posts：visibility=all，hiddenFromIds=[]。',
    '约 0～1 条可玩分组：觉得某些人看不见就敢乱发、分组漏选翻车、两幅面孔等。',
    'JSON 字段（必填语义）：',
    '- visibility: "all" | "groups"',
    '- visibleGroupIds: string[]（仅 visibility=groups；填通讯录分组 id，表示「以为只有这组能看见」）',
    '- hiddenFromIds: string[]（角色 id；如上司、妈妈、导师、暧昧对象正牌等）',
    '- visibilityNote: string（可选一行，模型自洽用，如「以为老板已屏蔽但漏了」；可不展示）',
    groupHint,
    '硬规则：likes/comments 的 author 必须能看见该条（不在 hiddenFromIds；groups 时须属 visibleGroupIds 对应分组）。',
    '剧情举例：工作日摸鱼发圈 hiddenFromIds 漏填上司 → 评论区上司出没；半夜发圈以为屏蔽长辈 → 被当场抓获。',
  ].join('\n');
}

export function momentVisibilityLabel(post = {}, groupNameMap = new Map()) {
  const vis = normalizeMomentVisibility(post);
  const parts = [];
  if (vis.visibility === 'groups' && vis.visibleGroupIds.length) {
    const names = vis.visibleGroupIds.map((id) => groupNameMap.get(id) || id).join('、');
    parts.push(`分组可见：${names}`);
  }
  if (vis.hiddenFromIds.length) {
    parts.push(`${vis.hiddenFromIds.length} 人不可见`);
  }
  return parts.join(' · ');
}
