import { stripStickerTagsFromText } from '../moments/moments-stickers.js';
import { resolveWeiboCharacterPublicName } from './weibo-post-utils.js';

function cleanId(value = '') {
  return String(value || '').trim();
}

export function characterAllowsWeiboStickers(character = null) {
  return character?.weiboAllowStickers !== false;
}

export function buildWeiboCharacterStickerPolicyBlock(characters = []) {
  const disabled = (Array.isArray(characters) ? characters : [])
    .filter((character) => character?.id && !characterAllowsWeiboStickers(character))
    .map((character) => `${cleanId(character.id)}:${resolveWeiboCharacterPublicName(character, character.id)}`);
  if (!disabled.length) return '';
  return [
    '【角色级微博表情包权限 · 硬约束】',
    `以下角色已关闭微博表情包：${disabled.join('、')}。`,
    '这些角色作为微博作者或评论者时只能写普通文字/Unicode emoji；不得输出 [表情包:名称]、[贴纸:名称] 或 stickerNames。该限制高于本轮批量“允许表情包”选项。',
  ].join('\n');
}

function stripStickerPayload(row = {}) {
  const next = {
    ...row,
    content: stripStickerTagsFromText(row?.content || ''),
  };
  if (typeof row?.zh === 'string') next.zh = stripStickerTagsFromText(row.zh);
  if (typeof row?.translation === 'string') next.translation = stripStickerTagsFromText(row.translation);
  delete next.stickerNames;
  delete next.stickerImages;
  return next;
}

/** 模型漏遵守角色级开关时，在配图解析与落库前做确定性兜底。 */
export function applyWeiboCharacterStickerPolicy(posts = [], characters = []) {
  const disabledIds = new Set((Array.isArray(characters) ? characters : [])
    .filter((character) => character?.id && !characterAllowsWeiboStickers(character))
    .map((character) => cleanId(character.id)));
  if (!disabledIds.size) return Array.isArray(posts) ? posts : [];
  return (Array.isArray(posts) ? posts : []).map((post) => {
    const authorId = cleanId(post?.authorId || post?.author);
    const next = disabledIds.has(authorId) ? stripStickerPayload(post) : { ...post };
    const hotComments = Array.isArray(post?.hotComments)
      ? post.hotComments.map((comment) => (
        disabledIds.has(cleanId(comment?.authorId || comment?.author))
          ? stripStickerPayload(comment)
          : comment
      ))
      : post?.hotComments;
    return hotComments ? { ...next, hotComments } : next;
  });
}
