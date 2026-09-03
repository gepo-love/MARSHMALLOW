/**
 * 「社交互动」三项倾向强度（0～1）：持久化 + 注入微博/论坛等生成提示词。
 * 仅作模型取舍参考，非客户端随机数、不替代显式【发送】/chatShares。
 */
import * as db from '../db.js';

export const SOCIAL_LINK_KEY = 'socialLinkConfig';

export const DEFAULT_SOCIAL_LINK = {
  autoLinkChance: 0.35,
  wrongSendChance: 0.22,
  recallChance: 0.55,
  /** 是否把上方三项「活人感」偏好写入群聊/私聊续写 system（关闭则仅微博/论坛生成生效） */
  linkChatPromptWithSocial: true,
};

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function pct(x) {
  return `${Math.round(clamp01(x) * 100)}%`;
}

export async function loadSocialLinkConfig() {
  const row = await db.get('settings', SOCIAL_LINK_KEY);
  const v = { ...DEFAULT_SOCIAL_LINK, ...(row?.value || {}) };
  if (v.linkChatPromptWithSocial === undefined) v.linkChatPromptWithSocial = DEFAULT_SOCIAL_LINK.linkChatPromptWithSocial;
  return v;
}

/** 合并保存，避免只改概率时抹掉开关等字段 */
export async function saveSocialLinkConfig(partial = {}) {
  const prev = await loadSocialLinkConfig();
  const next = {
    ...DEFAULT_SOCIAL_LINK,
    ...prev,
    ...partial,
    autoLinkChance: clamp01(partial.autoLinkChance !== undefined ? partial.autoLinkChance : prev.autoLinkChance),
    wrongSendChance: clamp01(partial.wrongSendChance !== undefined ? partial.wrongSendChance : prev.wrongSendChance),
    recallChance: clamp01(partial.recallChance !== undefined ? partial.recallChance : prev.recallChance),
    linkChatPromptWithSocial:
      partial.linkChatPromptWithSocial !== undefined ? !!partial.linkChatPromptWithSocial : !!prev.linkChatPromptWithSocial,
  };
  await db.put('settings', { key: SOCIAL_LINK_KEY, value: next });
  return next;
}

/**
 * 群聊/私聊续写：按需拼接与微博同源的「社交互动」强度说明。
 */
export async function maybeBuildChatSocialLinkPrompt() {
  const cfg = await loadSocialLinkConfig();
  if (cfg.linkChatPromptWithSocial === false) return '';
  return `${buildSocialLinkPromptHint(cfg)}\n（以上同样可作群聊/私聊里描写错发、撤回、转动态进聊天等桥段的强度参考，勿每轮硬凑。）`;
}

/**
 * 供微博/论坛等生成 user 任务拼接：把设置里的概率转成对模型的说明。
 */
export function buildSocialLinkPromptHint(cfg = {}) {
  const a = clamp01(cfg.autoLinkChance ?? DEFAULT_SOCIAL_LINK.autoLinkChance);
  const w = clamp01(cfg.wrongSendChance ?? DEFAULT_SOCIAL_LINK.wrongSendChance);
  const r = clamp01(cfg.recallChance ?? DEFAULT_SOCIAL_LINK.recallChance);
  return [
    '【社交互动·用户偏好强度（写入 JSON 时参考，与剧情冲突时以剧情为准）】',
    `- 自动写入社交联动倾向强度约 ${pct(a)}：越高越适合在剧情需要时输出非空 chatShares，或补一个非空 momentsShares / 朋友圈联动副产物；与「生成后定向补推」无关（后者为第二次定向调用）。`,
    `- 错屏/错群桥段倾向强度约 ${pct(w)}：需要手滑感时可在 chatShares 使用 wrongSend:true + wrongGroupName。`,
    `- 错发后撤回桥段倾向强度约 ${pct(r)}：需要时可对链接转发使用 recallLink:true。`,
    '以上不是随机数指令；chatShares 路由进聊天后由客户端按会话设置执行（与【发送】协议一致）。勿为凑数每轮都填 chatShares。',
  ].join('\n');
}
