import { loadWeiboMetaCompat } from '../weibo/weibo-meta-store.js';

export const FORUM_TOPIC_SOURCE = Object.freeze({
  SECTION: 'section',
  INTEREST: 'interest',
  MAINLINE: 'mainline',
  AMBIENT: 'ambient',
  WEIBO: 'weibo',
  CHAT_INTENT: 'chat_intent',
});

const WEIBO_FRESH_MS = 48 * 60 * 60 * 1000;
const WEIBO_COOLDOWN_THREADS = 4;
const WEIBO_RECENT_WINDOW = 10;
const WEIBO_RECENT_MAX = 2;

function clean(value = '') {
  return String(value || '').trim();
}

function stableHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function forumThreadTopicSource(thread = {}) {
  const source = clean(thread?.topicSource || thread?.metadata?.topicSource).toLowerCase();
  return Object.values(FORUM_TOPIC_SOURCE).includes(source) ? source : '';
}

export async function hasFreshForumWeiboMaterial(userId, { now = Date.now() } = {}) {
  const uid = clean(userId);
  if (!uid) return false;
  const meta = await loadWeiboMetaCompat(uid).catch(() => null);
  return (Array.isArray(meta?.globalWeiboBatches) ? meta.globalWeiboBatches : [])
    .some((batch) => {
      const ts = Number(batch?.ts || 0);
      if (!ts || now - ts < 0 || now - ts >= WEIBO_FRESH_MS) return false;
      return (Array.isArray(batch?.trending) && batch.trending.length > 0)
        || (Array.isArray(batch?.news) && batch.news.length > 0)
        || (Array.isArray(batch?.postHeadlines) && batch.postHeadlines.length > 0);
    });
}

/**
 * 代码先决定每篇帖子的主来源。微博仍作为环境认知常驻，但只有计划明确选中时才能成为主话题。
 */
export function buildForumTopicPlan({
  count = 1,
  recentThreads = [],
  allowPrivateContext = false,
  weiboAvailable = false,
  seed = '',
} = {}) {
  const size = Math.max(1, Math.min(8, Math.round(Number(count) || 1)));
  const recent = (Array.isArray(recentThreads) ? recentThreads : [])
    .slice()
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));
  const recentSources = recent.map(forumThreadTopicSource).filter(Boolean);
  const weiboCoolingDown = recentSources.slice(0, WEIBO_COOLDOWN_THREADS).includes(FORUM_TOPIC_SOURCE.WEIBO)
    || recentSources.slice(0, WEIBO_RECENT_WINDOW).filter((source) => source === FORUM_TOPIC_SOURCE.WEIBO).length >= WEIBO_RECENT_MAX;
  const base = [
    FORUM_TOPIC_SOURCE.SECTION,
    FORUM_TOPIC_SOURCE.INTEREST,
    FORUM_TOPIC_SOURCE.AMBIENT,
    ...(allowPrivateContext ? [FORUM_TOPIC_SOURCE.MAINLINE] : []),
    ...(weiboAvailable && !weiboCoolingDown ? [FORUM_TOPIC_SOURCE.WEIBO] : []),
  ];
  const plan = [];
  for (let index = 0; index < size; index += 1) {
    const unused = base.filter((source) => !plan.includes(source));
    const pool = unused.length ? unused : base.filter((source) => source !== plan[plan.length - 1]);
    const candidates = pool.length ? pool : base;
    const source = candidates[stableHash(`${seed}|${index}|${recentSources.slice(0, 6).join(',')}`) % candidates.length]
      || FORUM_TOPIC_SOURCE.SECTION;
    plan.push(source);
  }
  return plan;
}

const SOURCE_RULES = Object.freeze({
  [FORUM_TOPIC_SOURCE.SECTION]: '围绕当前版块自身主题另开新切口；微博只作为已知背景，不得成为主帖主题。',
  [FORUM_TOPIC_SOURCE.INTEREST]: '从作者兴趣、职业碎片或长期关注点开题；不得为了利用已注入素材而改写成微博讨论帖。',
  [FORUM_TOPIC_SOURCE.MAINLINE]: '仅由有权读取对应私有记忆包的角色作者，从自己的近期剧情或长期记忆自然转化出话题；路人不得使用。',
  [FORUM_TOPIC_SOURCE.AMBIENT]: '从天气、通勤、城市生活、社区见闻或普通公共话题开题，不依赖微博是否更新。',
  [FORUM_TOPIC_SOURCE.WEIBO]: '本篇才允许把 48 小时内微博公共素材作为主话题；只选一件展开，不得复述整份热搜。',
  [FORUM_TOPIC_SOURCE.CHAT_INTENT]: '围绕当前聊天里明确产生的发帖意图展开，不把其他微博素材抢成主话题。',
});

export function buildForumTopicPlanPrompt(plan = []) {
  const rows = (Array.isArray(plan) ? plan : []).filter((source) => SOURCE_RULES[source]);
  if (!rows.length) return '';
  return [
    '【本轮主话题来源｜由代码决定】',
    '微博公共素材始终只是世界认知，不是生成任务。每篇主帖必须服从下面对应来源；未标为 weibo 的帖子不得以微博、热搜或微博原帖为主线，最多允许一个楼层自然顺带提一句。',
    ...rows.map((source, index) => `${index + 1}. topicSource=${source}：${SOURCE_RULES[source]}`),
    '输出顺序必须与上述编号一致。不得自行交换、合并或把所有帖子收束到同一公共事件。',
  ].join('\n');
}
