import * as db from '../core/db.js';
import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { resolveGenerationMaxTokens } from '../core/api.js';
import { chatJsonGeneration } from '../core/chat-json-generation.js';
import { formatMessageForContext, isAnonymousChat } from '../core/chat-helpers.js';
import { getAnonymousDisplayProfile } from '../core/anonymous-chat.js';
import { listCharacters } from '../core/character-store.js';
import { buildWorldBookContextBlock } from '../core/world-book-store.js';
import { buildSurfacePresetBlock } from '../core/preset-store.js';
import { buildSocialFormatGuidancePrompt } from '../core/social-helpers.js';
import { appendDebugEvent } from '../core/debug-log.js';
import { loadingBtnContent } from '../components/generation-busy.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import { resolveActorDisplayLabel, stripLeakedCharacterCodes } from '../core/chat/character-code-fallback.js';
import { getUserDisplayName } from '../models/user.js';
import { filterNonGuidanceMessages } from '../core/guidance-memory.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from '../core/time-mode.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { isActiveWeiboPost } from '../core/weibo/weibo-post-store.js';
import { acquireNarrationGenerationLease } from '../core/narration-generation-lease.js';

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wallKey(userId = '') {
  return `anonymousWallPosts_${String(userId || '').trim() || 'guest'}`;
}

function clip(value = '', max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fullCharacterText(value = '') {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function normalizeForDedupe(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/bot好|bot你好|投稿|tg|递一下|递/g, '')
    .replace(/[\s，。！？、,.!?；;：:“”"'‘’（）()【】\[\]<>《》…—\-_/\\|~`]+/g, '')
    .trim();
}

function charBigrams(text = '') {
  const s = normalizeForDedupe(text);
  if (s.length <= 1) return s ? [s] : [];
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

function contentSimilarity(a = '', b = '') {
  const left = charBigrams(a);
  const right = charBigrams(b);
  if (!left.length || !right.length) return 0;
  const counts = new Map();
  right.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  let hit = 0;
  for (const x of left) {
    const n = counts.get(x) || 0;
    if (n <= 0) continue;
    hit += 1;
    counts.set(x, n - 1);
  }
  return (2 * hit) / (left.length + right.length);
}

function findSimilarPost(content = '', posts = [], threshold = 0.76) {
  const body = normalizeForDedupe(content);
  if (body.length < 10) return null;
  const recent = (Array.isArray(posts) ? posts : []).slice(0, 30);
  let best = null;
  for (const post of recent) {
    const prev = normalizeForDedupe(post?.content || '');
    if (!prev) continue;
    const directOverlap = body.includes(prev.slice(0, Math.min(prev.length, 18)))
      || prev.includes(body.slice(0, Math.min(body.length, 18)));
    const score = directOverlap ? 1 : contentSimilarity(body, prev);
    if (!best || score > best.score) best = { post, score };
  }
  return best && best.score >= threshold ? best : null;
}

function makeId(prefix = 'wall') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function safeAll(storeName) {
  try {
    return await db.getAllRecords(storeName);
  } catch (_) {
    return [];
  }
}

async function loadPosts(userId) {
  const row = await db.get(wallKey(userId));
  return Array.isArray(row?.value) ? row.value : [];
}

async function savePosts(userId, posts) {
  await db.put('settings', { key: wallKey(userId), value: (posts || []).slice(0, 120) });
}

function promptTextEditor(options = {}) {
  return new Promise((resolve) => {
    openTextEditorModal({
      ...options,
      onSave: (value) => resolve(value),
      onClosed: () => resolve(null),
    });
  });
}

function characterLabel(char = {}) {
  return String(char.customNickname || char.name || char.id || '').trim();
}

function renderActorOptions(chars = [], selectedId = '') {
  const rows = chars
    .map((char) => {
      const id = String(char.id || '').trim();
      if (!id) return '';
      const label = characterLabel(char) || id;
      return `<option value="${esc(id)}"${id === selectedId ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .filter(Boolean)
    .join('');
  return `<option value="">随机小号</option>${rows}`;
}

function characterBrief(char = {}) {
  const name = characterLabel(char) || char.id || '角色';
  const relationships = char.relationships && typeof char.relationships === 'object'
    ? Object.entries(char.relationships)
      .map(([id, rel]) => `${id}:${typeof rel === 'string' ? rel : JSON.stringify(rel)}`)
      .join('；')
    : '';
  const parts = [
    `id:${char.id || ''}`,
    `name:${name}`,
    char.realName ? `realName:${fullCharacterText(char.realName)}` : '',
    char.gender ? `gender:${fullCharacterText(char.gender)}` : '',
    char.currentRole ? `currentRole:${fullCharacterText(char.currentRole)}` : '',
    char.userRelationStatus ? `userRelationStatus:${fullCharacterText(char.userRelationStatus)}` : '',
    char.currentStatus ? `currentStatus:${fullCharacterText(char.currentStatus)}` : '',
    char.personality ? `personality:${fullCharacterText(char.personality)}` : '',
    char.speechStyle ? `speechStyle:${fullCharacterText(char.speechStyle)}` : '',
    char.commonEmotes ? `commonEmotes:${fullCharacterText(char.commonEmotes)}` : '',
    relationships ? `relationships:${fullCharacterText(relationships)}` : '',
    char.background ? `background:${fullCharacterText(char.background)}` : '',
    char.relationshipToUser ? `relationshipToUser:${fullCharacterText(char.relationshipToUser)}` : '',
    char.promptCorpus ? `promptCorpus（完整）:${fullCharacterText(char.promptCorpus)}` : '',
    char.speechCorpus ? `speechCorpus（完整）:${fullCharacterText(char.speechCorpus)}` : '',
    char.notes ? `notes:${fullCharacterText(char.notes)}` : '',
  ].filter(Boolean);
  return parts.join(' / ');
}

function openAiWallComposerModal(chars = []) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) {
      resolve(null);
      return;
    }
    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay anon-wall-compose-overlay" data-wall-compose-overlay>
        <div class="modal-sheet anon-modal-sheet anon-wall-compose-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>AI投稿</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-wall-compose-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="anon-wall-compose-body">
            <label class="anon-form-field">
              <span>投稿小号</span>
              <select class="form-input wall-ai-author">${renderActorOptions(chars)}</select>
            </label>
            <label class="anon-form-field">
              <span>方向</span>
              <textarea class="form-input wall-ai-seed" rows="5" maxlength="500" placeholder="可空。例如：最近有人想匿名投稿。"></textarea>
            </label>
            <button type="button" class="btn btn-primary btn-block wall-ai-run">生成投稿</button>
          </div>
        </div>
      </div>
    `;
    host.querySelector('[data-wall-compose-overlay]')?.addEventListener('click', () => close(null));
    host.querySelector('[data-wall-compose-close]')?.addEventListener('click', () => close(null));
    host.querySelector('.anon-wall-compose-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('.wall-ai-run')?.addEventListener('click', () => {
      close({
        authorActorId: String(host.querySelector('.wall-ai-author')?.value || '').trim(),
        seedText: String(host.querySelector('.wall-ai-seed')?.value || '').trim(),
      });
    });
    host.querySelector('.wall-ai-seed')?.focus();
  });
}

function normalizeComment(raw = {}, now = Date.now()) {
  const content = String(raw.content || raw.text || '').trim();
  if (!content) return null;
  const ts = Number(now) || Date.now();
  const translation = sanitizeAiTranslation(content, raw.zh || raw.translation || '');
  return {
    id: String(raw.id || makeId('wall_c')),
    author: String(raw.author || '匿名路人').trim() || '匿名路人',
    role: String(raw.role || '路人').trim() || '路人',
    content,
    likes: Math.max(0, Number(raw.likes || 0) || 0),
    timestamp: Number(raw.timestamp || ts) || ts,
    ...(translation ? { translation } : {}),
  };
}

function normalizePost(raw = {}, source = 'ai', now = Date.now()) {
  const base = raw.post && typeof raw.post === 'object' ? raw.post : raw;
  const content = String(base.content || base.text || '').trim();
  if (!content) return null;
  const ts = Number(now) || Date.now();
  const comments = (Array.isArray(raw.comments) ? raw.comments : Array.isArray(base.comments) ? base.comments : [])
    .map((c) => normalizeComment(c, ts))
    .filter(Boolean)
    .slice(0, 12);
  const translation = sanitizeAiTranslation(
    content,
    base.zh || base.translation || base.contentTranslation
      || raw.zh || raw.translation || raw.contentTranslation || '',
  );
  return {
    id: String(base.id || makeId('wall')),
    timestamp: Number(base.timestamp || ts) || ts,
    title: String(base.title || '').trim(),
    authorAlias: String(base.authorAlias || base.author || '匿').trim() || '匿',
    targetHint: String(base.targetHint || base.target || '对象不明').trim() || '对象不明',
    tone: String(base.tone || '隔空喊话').trim() || '隔空喊话',
    truthMode: String(base.truthMode || '').trim(),
    blurLevel: String(base.blurLevel || '模糊影射').trim() || '模糊影射',
    authorActorId: String(base.authorActorId || '').trim(),
    targetActorId: String(base.targetActorId || '').trim(),
    content,
    comments,
    source,
    ...(translation ? { translation } : {}),
  };
}

function wallTranslationSuffixHtml(source = '', translation = '') {
  const src = String(source || '').trim();
  if (!src) return '';
  const sanitized = sanitizeAiTranslation(src, translation);
  if (!sanitized && !messageLikelyNeedsTranslation(src)) return '';
  const escAttr = (v) => esc(v).replace(/"/g, '&quot;');
  return `<button type="button" class="chat-bubble-translate-btn" data-translation-toggle data-translation-source="${escAttr(src)}" aria-expanded="false">翻译</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(sanitized || '')}</div></div>`;
}

function formatWallTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function safeWallActorLabel(value, ctx = {}, fallback = '匿名路人') {
  return resolveActorDisplayLabel(value, { ...ctx, fallback });
}

function safeWallDisplayText(value, ctx = {}) {
  return stripLeakedCharacterCodes(String(value || ''), { ...ctx, fallbackLabel: '某位' });
}

async function resolveSender(chat, msg, user, charactersById) {
  const id = String(msg?.senderId || '').trim();
  if (id === 'user') return isAnonymousChat(chat)
    ? (getAnonymousDisplayProfile(chat, 'user', { userRow: user })?.anonymousId || '匿名用户')
    : getUserDisplayName(user);
  if (isAnonymousChat(chat)) {
    const profile = getAnonymousDisplayProfile(chat, id, { userRow: user });
    if (profile?.anonymousId) return profile.anonymousId;
  }
  return resolveActorDisplayLabel(
    charactersById[id]?.name || msg?.senderName || id,
    { user, characters: charactersById, fallback: '未知' },
  );
}

function collectWallActorIds(posts = []) {
  const ids = new Set();
  (Array.isArray(posts) ? posts : []).slice(0, 12).forEach((post) => {
    [post?.authorActorId, post?.targetActorId].forEach((id) => {
      const key = String(id || '').trim();
      if (key && key !== 'user') ids.add(key);
    });
  });
  return ids;
}

function wallSelectiveText(posts = []) {
  return (Array.isArray(posts) ? posts : []).slice(0, 8)
    .map((post) => [
      post?.authorAlias,
      post?.content,
      ...(Array.isArray(post?.comments) ? post.comments.slice(-4).map((c) => c?.content) : []),
    ].filter(Boolean).join(' '))
    .join('\n');
}

async function collectWallContext(user, charactersById, options = {}) {
  const userId = user?.id || '';
  const wallPosts = Array.isArray(options.wallPosts) ? options.wallPosts : [];
  const chats = userId ? await db.getAllByIndex('chats', 'userId', userId) : [];
  const recentChats = (Array.isArray(chats) ? chats : [])
    .filter((c) => c?.id)
    .filter((c) => isAnonymousChat(c) || (c.participants || []).some((id) => charactersById[id]))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 10);
  const chatLines = [];
  const relatedCharacterIds = collectWallActorIds(wallPosts);
  const forcedAuthorId = String(options.authorActorId || '').trim();
  if (forcedAuthorId && charactersById[forcedAuthorId]) relatedCharacterIds.add(forcedAuthorId);
  for (const chat of recentChats.slice(0, 7)) {
    for (const pid of chat.participants || []) {
      if (pid && charactersById[pid]) relatedCharacterIds.add(pid);
    }
    const msgs = filterNonGuidanceMessages(await db.getAllByIndex('messages', 'chatId', chat.id))
      .filter((m) => m && !m.deleted && !m.recalled && m.type !== 'system' && String(m.content || '').trim())
      .filter((m) => isAnonymousChat(chat) || m.senderId === 'user' || charactersById[m.senderId])
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 4)
      .reverse();
    if (!msgs.length) continue;
    const title = isAnonymousChat(chat)
      ? `匿名会话「${chat.groupSettings?.name || chat.metadata?.sourceAnonymousType || chat.id}」`
      : (chat.type === 'group' ? `群聊「${chat.groupSettings?.name || '群聊'}」` : '普通私聊');
    const lines = [];
    for (const msg of msgs) {
      const sender = await resolveSender(chat, msg, user, charactersById);
      lines.push(`${sender}: ${clip(formatMessageForContext(msg, user?.name || '用户', { characters: charactersById }), 90)}`);
    }
    chatLines.push(`【${title}】${lines.join(' / ')}`);
  }
  const characterProfiles = [...relatedCharacterIds]
    .map((id) => charactersById[id])
    .filter(Boolean)
    .slice(0, 14)
    .map(characterBrief)
    .filter(Boolean);

  const memories = (await safeAll('memories'))
    .filter((m) => m?.userId === userId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 18)
    .map((m) => clip(m.content || m.summary || '', 120))
    .filter(Boolean);
  const events = (await safeAll('eventMemories'))
    .filter((m) => m?.userId === userId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 10)
    .map((m) => clip(m.summary || m.title || '', 140))
    .filter(Boolean);
  const moments = (await safeAll('momentsPosts'))
    .filter((p) => String(p?.userId || '').trim() === userId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 8)
    .map((p) => `${resolveActorDisplayLabel(p.authorName || p.authorId, { user, characters: charactersById, fallback: '朋友' })}: ${clip(p.content || p.text, 110)}`);
  const weibo = (await safeAll('weiboPosts'))
    .filter((p) => String(p?.ownerUserId || '').trim() === userId && isActiveWeiboPost(p))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 8)
    .map((p) => `${resolveActorDisplayLabel(p.authorName || p.authorId, { user, characters: charactersById, fallback: '账号' })}: ${clip(p.content || p.text, 110)}`);
  const forum = (await safeAll('forumThreads'))
    .filter((t) => t?.userId === userId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 6)
    .map((t) => `${t.title || '公开内容'}: ${clip(t.content || t.summary, 110)}`);
  const selectiveText = [
    options.seedText || '',
    wallSelectiveText(wallPosts),
    chatLines.join('\n'),
    characterProfiles.join('\n'),
    memories.join('\n'),
    events.join('\n'),
  ].filter(Boolean).join('\n');
  const worldBook = await buildWorldBookContextBlock(user, selectiveText, {
    worldBookMode: 'selective',
    characterIds: [...relatedCharacterIds].filter((id) => charactersById[id]),
  }).catch(() => '');
  const presetBlock = await buildSurfacePresetBlock('anon_wall').catch(() => '');
  const formatGuidance = buildSocialFormatGuidancePrompt('anon_wall');
  return { chatLines, characterProfiles, memories, events, moments, weibo, forum, worldBook, presetBlock, formatGuidance };
}

function contextBlock(ctx) {
  const sections = [
    ['聊天近况', ctx.chatLines],
    ['相关角色人设', ctx.characterProfiles],
    ['沉淀记忆', ctx.memories],
    ['跨会话事件', ctx.events],
    ['朋友圈素材', ctx.moments],
    ['微博素材', ctx.weibo],
    ['公开内容素材', ctx.forum],
  ];
  return sections.map(([title, list]) => {
    const rows = (list || []).filter(Boolean);
    return rows.length ? `【${title}】\n${rows.map((x) => `- ${x}`).join('\n')}` : '';
  }).filter(Boolean)
    .concat(ctx.worldBook ? [ctx.worldBook] : [])
    .concat(ctx.formatGuidance ? [ctx.formatGuidance] : [])
    .concat(ctx.presetBlock ? [ctx.presetBlock] : [])
    .join('\n\n') || '暂无素材。可以生成一条轻量投稿。';
}

function wallHistoryBlock(posts = []) {
  const recent = (Array.isArray(posts) ? posts : []).slice(0, 8);
  if (!recent.length) return '【匿名墙已有喊话】\n暂无。';
  const rows = recent.map((post, idx) => {
    const comments = (post.comments || [])
      .slice(-4)
      .map((c) => `${c.author || '匿名'}:${clip(c.content || '', 54)}`)
      .filter(Boolean)
      .join(' / ');
    const label = idx === 0 ? '上一条喊话' : `近第${idx + 1}条`;
    return [
      `- ${label} id:${post.id}`,
      `  投稿人:${post.authorAlias || '匿'}；正文:${clip(post.content || '', 180)}`,
      comments ? `  评论:${comments}` : '',
    ].filter(Boolean).join('\n');
  });
  return [
    '【匿名墙已有喊话】',
    '这些是当前墙上已经出现的内容。新投稿要查重避开复读；如果上一条留下明显可接的钩子，可以像另一个路人/知情人/当事人小号那样补充喊话、接梗、纠偏或继续阴阳，但不要原文续写，也不要每次都硬接。',
    ...rows,
  ].join('\n');
}

function buildAiPostPrompt({ ctx, opts, authorActor, authorActorId, existingPosts, duplicateWarning = '', timeBlock = '' }) {
  const hasSeed = !!String(opts.seedText || '').trim();
  const previous = Array.isArray(existingPosts) && existingPosts[0] ? existingPosts[0] : null;
  const translationPrompt = authorActor
    ? buildJsonFieldTranslationPromptBlock(
      collectTranslationActors([authorActor]),
      { fields: 'content / comments[].content', exampleField: 'content' },
    )
    : '';
  return [
    '你是隔空喊话 bot，生成一条匿名投稿和评论。',
    '这是向 bot 投稿。常见入口可以参考“bot好”“bot你好”“投稿”“tg”“bot好，递……”等，但不要固定套模板，要像真实匿名投稿那样自由发挥。',
    '禁止扮演 user / 用户 / 玩家投稿。AI 投稿只能来自角色或匿名 NPC；user 的投稿只能由真实用户手写。',
    '角色本体知道自己是谁，也知道自己与用户的外部关系；但 bot 前台只显示匿名投稿，不能直接实名揭穿用户或角色。',
    '如果指定了投稿角色，正文必须贴合该角色的人设、语气、关系态度、信息差和欲望；如果未指定，可以从相关角色或匿名 NPC 中选一个。',
    '投稿人显示可以是随便编的网名、匿称或“匿”，不要用真实姓名。',
    '不要生成标题，不要把对象单独列出来。正文里可以半遮半掩、指桑骂槐、欲盖弥彰、装作路过，也可以递奇怪东西，但要像真实隔空喊话 bot 投稿。',
    '可以使用记忆和聊天素材，但要改写成匿名投稿的口吻；私聊内容不能原文公开。',
    '短句、口语，有人设语气，不写成长篇作文。',
    '必须查重：不要复述已有喊话的同一对象、同一事件、同一句式；如果接上一条，要给出新信息、新立场或另一个人的补充，而不是换皮重复。',
    '「今天、昨晚、周末、假期」等时间词一律按下方世界内时间锚点理解，禁止按现实日历臆断。',
    hasSeed
      ? '用户填写了投稿方向：以用户方向为主，上一条喊话只作为墙面语境和查重参考；如果能自然关联可以轻轻接上，不能关联就不要硬接。'
      : (previous
        ? '用户没有填写投稿方向：默认生成一条和“上一条喊话”有关联的新投稿，像另一个投稿人/知情人/当事人小号补充、接梗、反驳、递后续线索或拐弯回应。'
        : '用户没有填写投稿方向：墙上暂无上一条，可以生成一条自然开局的喊话。'),
    '',
    timeBlock,
    `指定投稿角色：${authorActor ? `${authorActorId} / ${characterLabel(authorActor)}` : '未指定，可随机角色或匿名 NPC；禁止选择 user'}`,
    `投稿方向：${opts.seedText || (previous ? '未指定，默认接上一条喊话' : '未指定')}`,
    wallHistoryBlock(existingPosts),
    contextBlock(ctx),
    translationPrompt,
    duplicateWarning ? `【上一次生成被查重拦截】\n${duplicateWarning}\n请换一个角度、投稿人、对象或补充信息。` : '',
    '',
    '只输出合法 JSON，不要解释，不要 Markdown。',
    'JSON 格式：{"post":{"authorAlias":"随便编的匿名网名","content":"投稿正文","zh":"外语正文才需要的中文翻译","authorActorId":""},"comments":[{"author":"匿名","role":"评论","content":"短评","zh":"外语评论才需要","likes":12}]}',
  ].filter(Boolean).join('\n\n');
}

function parsedSummary(value) {
  if (!value || typeof value !== 'object') return '';
  return JSON.stringify({
    keys: Object.keys(value),
    postKeys: value.post && typeof value.post === 'object' ? Object.keys(value.post) : [],
    comments: Array.isArray(value.comments) ? value.comments.length : 0,
    commentPatches: Array.isArray(value.commentPatches) ? value.commentPatches.length : 0,
  }, null, 2);
}

function errorDebugMeta(err) {
  if (!err) return '';
  return JSON.stringify({
    status: err.status || '',
    usedUrl: err.usedUrl || '',
    requestModel: err.requestModel || '',
    requestStream: err.requestStream ?? '',
  }, null, 2);
}

async function generateAiPost(user, charactersById, options = {}, existingPosts = [], onDebug = null) {
  const opts = typeof options === 'string' ? { seedText: options } : (options || {});
  const requestedAuthorActorId = String(opts.authorActorId || '').trim();
  const authorActorId = charactersById[requestedAuthorActorId] ? requestedAuthorActorId : '';
  const authorActor = authorActorId ? charactersById[authorActorId] : null;
  const maxTokens = await resolveGenerationMaxTokens();
  const nowTs = user?.id ? await getNowForUser(user.id).catch(() => Date.now()) : Date.now();
  const timeBlock = user?.id ? await buildTimeAndHolidayPromptBlock(user.id).catch(() => '') : '';
  const ctx = await collectWallContext(user, charactersById, {
    wallPosts: existingPosts,
    seedText: opts.seedText,
    authorActorId,
  });
  if (authorActor && !ctx.characterProfiles.some((line) => line.includes(`id:${authorActorId}`))) {
    ctx.characterProfiles.unshift(characterBrief(authorActor));
  }
  let duplicateWarning = '';
  let lastSimilar = null;
  let lastRaw = '';
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const prompt = buildAiPostPrompt({
      ctx,
      opts,
      authorActor,
      authorActorId,
      existingPosts,
      duplicateWarning,
      timeBlock,
    });
    onDebug?.({
      kind: 'AI投稿',
      phase: `attempt_${attempt + 1}_request`,
      prompt,
      raw: '',
      parsed: '',
      error: '',
      timestamp: Date.now(),
    });
    let raw = '';
    let parsed = null;
    try {
      const generated = await chatJsonGeneration({
        scope: 'anonymous-wall-post',
        retryOnInvalid: false,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: '请按上述完整背景生成本次匿名投稿 JSON。' },
        ],
        temperature: attempt ? 1.02 : 0.95,
        maxTokens,
        validate: (value) => value && typeof value === 'object' && !Array.isArray(value),
      });
      raw = generated.raw;
      lastRaw = raw;
      parsed = generated.data;
    } catch (err) {
      raw = String(err?.rawText || '');
      onDebug?.({
        kind: 'AI投稿',
        phase: `attempt_${attempt + 1}_api_error`,
        prompt,
        raw: raw || err?.responseText || '',
        parsed: errorDebugMeta(err),
        error: String(err?.message || err || 'API 请求失败'),
        timestamp: Date.now(),
      });
      throw err;
    }
    onDebug?.({
      kind: 'AI投稿',
      phase: `attempt_${attempt + 1}_raw`,
      prompt,
      raw,
      parsed: '',
      error: '',
      timestamp: Date.now(),
    });
    onDebug?.({
      kind: 'AI投稿',
      phase: `attempt_${attempt + 1}_parsed`,
      prompt,
      raw,
      parsed: parsedSummary(parsed),
      error: '',
      timestamp: Date.now(),
    });
    const post = normalizePost(parsed, 'ai', nowTs);
    if (!post) {
      const error = new Error('模型有返回，但没有生成可用的匿名投稿');
      error.reason = 'validation-failed';
      error.rawText = raw;
      throw error;
    }
    if (post.authorActorId === 'user' || !charactersById[post.authorActorId]) post.authorActorId = '';
    post.authorAlias = /user|用户|玩家/i.test(post.authorAlias) ? '匿' : (post.authorAlias || '匿');
    if (authorActorId && !post.authorActorId) post.authorActorId = authorActorId;
    const similar = findSimilarPost(post.content, existingPosts);
    if (!similar) return post;
    lastSimilar = similar;
    duplicateWarning = `生成内容与「${clip(similar.post?.content || '', 80)}」相似度过高（${Math.round(similar.score * 100)}%）。`;
    onDebug?.({
      kind: 'AI投稿',
      phase: `attempt_${attempt + 1}_duplicate`,
      prompt,
      raw,
      parsed: parsedSummary(parsed),
      error: duplicateWarning,
      timestamp: Date.now(),
    });
  }
  const error = new Error(lastSimilar ? 'AI 投稿和近期喊话太像，已拦截' : 'AI 投稿查重失败');
  error.reason = 'validation-failed';
  error.rawText = lastRaw;
  throw error;
}

async function fermentComments(user, charactersById, targetPosts, onDebug = null) {
  const ctx = await collectWallContext(user, charactersById, { wallPosts: targetPosts });
  const timeBlock = user?.id ? await buildTimeAndHolidayPromptBlock(user.id).catch(() => '') : '';
  const authorActors = [...new Set(
    (Array.isArray(targetPosts) ? targetPosts : [])
      .map((p) => String(p?.authorActorId || '').trim())
      .filter((id) => id && id !== 'user'),
  )]
    .map((id) => charactersById[id])
    .filter(Boolean);
  const translationPrompt = authorActors.length
    ? buildJsonFieldTranslationPromptBlock(
      collectTranslationActors(authorActors),
      { fields: 'comments[].content', exampleField: 'content' },
    )
    : '';
  const prompt = [
    '你在给隔空喊话 bot 投稿补评论。评论短一点。',
    '可以有匿名评论、知情人、劝删、站队。不要实名揭穿，不要扮演 user。',
    '时间词一律按下方世界内时间锚点理解，禁止按现实日历臆断。',
    timeBlock,
    contextBlock(ctx),
    translationPrompt,
    '',
    '目标投稿：',
    targetPosts.map((p) => `postId:${p.id}\n正文:${p.content}\n现有评论:${(p.comments || []).map((c) => `${c.author}:${c.content}`).join(' / ') || '无'}`).join('\n\n'),
    '',
    '只输出合法 JSON，不要解释，不要 Markdown。',
    'JSON 格式：{"commentPatches":[{"postId":"...","comments":[{"author":"匿名","role":"评论|知情人|劝删|站队","content":"短评","zh":"外语评论才需要","likes":12}]}]}',
  ].filter(Boolean).join('\n\n');
  onDebug?.({ kind: '发酵评论', phase: 'request', prompt, raw: '', parsed: '', error: '', timestamp: Date.now() });
  let raw = '';
  let parsed = null;
  try {
    const generated = await chatJsonGeneration({
      scope: 'anonymous-wall-comments',
      retryOnInvalid: false,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: '请按上述背景为目标投稿生成本轮评论 JSON。' },
      ],
      temperature: 0.95,
      validate: (value) => value && typeof value === 'object' && !Array.isArray(value),
    });
    raw = generated.raw;
    parsed = generated.data;
  } catch (err) {
    raw = String(err?.rawText || '');
    onDebug?.({ kind: '发酵评论', phase: 'api_error', prompt, raw: raw || err?.responseText || '', parsed: errorDebugMeta(err), error: String(err?.message || err || 'API 请求失败'), timestamp: Date.now() });
    throw err;
  }
  onDebug?.({ kind: '发酵评论', phase: 'raw', prompt, raw, parsed: '', error: '', timestamp: Date.now() });
  onDebug?.({ kind: '发酵评论', phase: 'parsed', prompt, raw, parsed: parsedSummary(parsed), error: '', timestamp: Date.now() });
  return Array.isArray(parsed.commentPatches) ? parsed.commentPatches : [];
}

function renderPost(post, busy = false, busyKind = '', fermentOneId = '', labelCtx = {}) {
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const disabled = busy ? 'disabled' : '';
  const isFermenting = busy && busyKind === 'ferment-one' && fermentOneId === post.id;
  const bodyTranslation = wallTranslationSuffixHtml(
    post.content,
    post.translation || post.contentTranslation || '',
  );
  return `
    <article class="anon-wall-post" data-post-id="${esc(post.id)}">
      <header class="anon-wall-post-head">
        <div>
          <div class="anon-wall-author">${esc(safeWallActorLabel(post.authorAlias, labelCtx, '匿名'))}</div>
          <div class="anon-wall-post-meta">${esc(formatWallTime(post.timestamp))}</div>
        </div>
      </header>
      <div class="anon-wall-post-body">${esc(safeWallDisplayText(post.content, labelCtx))}${bodyTranslation}</div>
      <div class="anon-wall-comments">
        ${comments.length ? comments.map((c) => `
          <div class="anon-wall-comment">
            <b>${esc(safeWallActorLabel(c.author, labelCtx))}</b>
            <span>${esc(safeWallActorLabel(c.role, labelCtx, '路人'))}</span>
            <em>${esc(safeWallDisplayText(c.content, labelCtx))}</em>
            ${wallTranslationSuffixHtml(c.content, c.translation || '')}
            <small>${Math.max(0, Number(c.likes || 0) || 0)}</small>
          </div>
        `).join('') : '<div class="anon-wall-no-comment">还没人敢在下面说话。</div>'}
      </div>
      <footer class="anon-wall-actions">
        <button type="button" class="btn btn-sm btn-outline${isFermenting ? ' is-loading' : ''}" data-ferment-one="${esc(post.id)}" ${disabled}>${isFermenting ? loadingBtnContent('发酵中…') : '发酵'}</button>
        <button type="button" class="btn btn-sm btn-outline" data-comment="${esc(post.id)}" ${disabled}>评论</button>
        <button type="button" class="btn btn-sm btn-outline" data-delete="${esc(post.id)}" ${disabled}>删除</button>
      </footer>
    </article>
  `;
}

export default async function render(container) {
  const user = await ensureDefaultUser();
  let posts = await loadPosts(user.id);
  let busy = false;
  let busyText = '';
  let busyKind = '';
  let fermentOneId = '';
  let charsCache = null;
  let charactersByIdCache = null;
  let debugInfo = null;

  async function claimWallGeneration() {
    const lease = await acquireNarrationGenerationLease('anon-wall', user.id);
    if (!lease.acquired) showToast('匿名墙已有生成任务正在进行');
    return lease.acquired ? lease : null;
  }

  container.className = 'page anon-page anon-wall-page';

  function setDebugInfo(next = {}) {
    debugInfo = {
      ...(debugInfo || {}),
      ...next,
      timestamp: next.timestamp || Date.now(),
    };
    if (debugInfo.error || /api_error|parse_error|failed|duplicate/i.test(String(debugInfo.phase || ''))) {
      appendDebugEvent({
        type: 'anon_wall_debug',
        level: debugInfo.error ? 'error' : 'warn',
        message: `${debugInfo.kind || '匿名墙'} · ${debugInfo.phase || 'debug'}${debugInfo.error ? `：${debugInfo.error}` : ''}`,
        raw: debugInfo.raw || '',
        prompt: debugInfo.prompt || '',
        context: {
          kind: debugInfo.kind || '',
          phase: debugInfo.phase || '',
          parsed: debugInfo.parsed || '',
        },
      }).catch(() => {});
    }
  }

  function renderDebugPanel() {
    if (!debugInfo) return '';
    const time = debugInfo.timestamp ? new Date(debugInfo.timestamp).toLocaleString('zh-CN') : '';
    return `
      <details class="anon-wall-debug" open>
        <summary>${esc(debugInfo.kind || 'AI调试')} · ${esc(debugInfo.phase || '捕捉中')} ${time ? `· ${esc(time)}` : ''}</summary>
        ${debugInfo.error ? `<div class="anon-wall-debug-error">${esc(debugInfo.error)}</div>` : ''}
        ${debugInfo.parsed ? `
          <div class="anon-wall-debug-label">parsed</div>
          <pre>${esc(debugInfo.parsed)}</pre>
        ` : ''}
        <div class="anon-wall-debug-actions">
          <button type="button" class="btn btn-sm btn-outline" data-copy-debug="raw" ${debugInfo.raw ? '' : 'disabled'}>复制 raw</button>
          <button type="button" class="btn btn-sm btn-outline" data-copy-debug="prompt" ${debugInfo.prompt ? '' : 'disabled'}>复制 prompt</button>
          <button type="button" class="btn btn-sm btn-outline" data-clear-debug>清空</button>
        </div>
        <div class="anon-wall-debug-label">raw</div>
        <pre>${esc(debugInfo.raw || '暂无 raw')}</pre>
      </details>
    `;
  }

  async function getCharacterContext() {
    if (!charsCache || !charactersByIdCache) {
      charsCache = await listCharacters({
        excludeAnonNpc: true,
        userId: user.id,
        identityScoped: true,
      });
      charactersByIdCache = Object.fromEntries(charsCache.map((c) => [c.id, c]));
    }
    return { chars: charsCache, charactersById: charactersByIdCache };
  }

  async function persist(nextPosts) {
    posts = nextPosts.slice(0, 120);
    await savePosts(user.id, posts);
  }

  async function applyCommentPatches(patches) {
    if (!Array.isArray(patches) || !patches.length) return 0;
    const nowTs = await getNowForUser(user.id).catch(() => Date.now());
    let count = 0;
    posts = posts.map((post) => {
      const patch = patches.find((p) => String(p.postId || '') === post.id);
      if (!patch) return post;
      const comments = (Array.isArray(patch.comments) ? patch.comments : [])
        .map((c) => normalizeComment(c, nowTs))
        .filter(Boolean);
      count += comments.length;
      return { ...post, comments: [...(post.comments || []), ...comments].slice(-24) };
    });
    await savePosts(user.id, posts);
    return count;
  }

  function paint() {
    const prevScroll = captureScrollerTop(container, '.anon-scroll');
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">隔空喊话bot</h1>
        <button type="button" class="navbar-btn" data-compose aria-label="投稿">${icon('plus')}</button>
      </header>
      <main class="anon-scroll">
        <section class="anon-wall-hero">
          <div class="anon-hero-title">隔空喊话bot</div>
          <div class="anon-wall-toolbar">
            <button type="button" class="btn btn-primary" data-compose ${busy ? 'disabled' : ''}>写投稿</button>
            <button type="button" class="btn btn-outline${busy && busyKind === 'ai-post' ? ' is-loading' : ''}" data-ai-post ${busy ? 'disabled' : ''}>${busy && busyKind === 'ai-post' ? loadingBtnContent('生成中…') : 'AI投稿'}</button>
            <button type="button" class="btn btn-outline${busy && busyKind === 'ferment-all' ? ' is-loading' : ''}" data-ferment-all ${busy || !posts.length ? 'disabled' : ''}>${busy && busyKind === 'ferment-all' ? loadingBtnContent('发酵中…') : '发酵评论'}</button>
          </div>
          ${busyText ? `<div class="anon-wall-status is-active" role="status"><span class="social-gen-status-row"><span class="btn-loading-spinner social-gen-status-spinner" aria-hidden="true"></span><span>${esc(busyText)}</span></span></div>` : ''}
          ${renderDebugPanel()}
        </section>
        <section class="anon-card">
          <div class="anon-section-title">投稿</div>
          ${posts.length ? posts.map((post) => renderPost(post, busy, busyKind, fermentOneId, { user, characters: charactersByIdCache || {} })).join('') : '<div class="anon-empty">暂无投稿</div>'}
        </section>
      </main>
    `;
    restoreScrollerTop(container, '.anon-scroll', prevScroll);
    bindNarrationTranslationToggle(container, {
      onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
    });
    bind();
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelectorAll('[data-copy-debug]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-copy-debug');
        const value = key === 'prompt' ? debugInfo?.prompt : debugInfo?.raw;
        if (!value) return;
        await navigator.clipboard?.writeText(value);
        showToast(key === 'prompt' ? '已复制 prompt' : '已复制 raw');
      });
    });
    container.querySelector('[data-clear-debug]')?.addEventListener('click', () => {
      debugInfo = null;
      paint();
    });
    container.querySelectorAll('[data-compose]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = await promptTextEditor({
          title: '投稿',
          placeholder: '投稿 / tg / bot好，递……',
          confirmLabel: '投稿',
        });
        if (!text) return;
        const nowTs = await getNowForUser(user.id).catch(() => Date.now());
        const post = normalizePost({ content: String(text).trim(), authorAlias: '匿', comments: [] }, 'manual', nowTs);
        await persist([post, ...posts]);
        showToast('已投稿');
        paint();
      });
    });
    container.querySelector('[data-ai-post]')?.addEventListener('click', async () => {
      const { chars, charactersById } = await getCharacterContext();
      const options = await openAiWallComposerModal(chars);
      if (!options) return;
      const lease = await claimWallGeneration();
      if (!lease) return;
      busy = true;
      busyKind = 'ai-post';
      busyText = '正在生成匿名投稿…';
      setDebugInfo({ kind: 'AI投稿', phase: 'start', raw: '', parsed: '', error: '', prompt: '', timestamp: Date.now() });
      paint();
      try {
        const post = await generateAiPost(user, charactersById, options, posts, (info) => {
          setDebugInfo(info);
        });
        await persist([post, ...posts]);
        setDebugInfo({ ...(debugInfo || {}), phase: 'saved', error: '', timestamp: Date.now() });
        showToast('AI 已投稿');
      } catch (err) {
        setDebugInfo({ ...(debugInfo || {}), phase: 'failed', error: String(err?.message || err || 'AI 投稿失败'), timestamp: Date.now() });
        showGenerationErrorReport(generationErrorFromCatch(err, {
          scope: '匿名墙 / 投稿生成',
          title: '匿名投稿生成失败',
        }));
        showToast(err?.message || 'AI 投稿失败');
      } finally {
        busy = false;
        busyKind = '';
        busyText = '';
        await lease.release();
        paint();
      }
    });
    container.querySelector('[data-ferment-all]')?.addEventListener('click', async () => {
      const lease = await claimWallGeneration();
      if (!lease) return;
      busy = true;
      busyKind = 'ferment-all';
      busyText = '正在发酵评论…';
      setDebugInfo({ kind: '发酵评论', phase: 'start', raw: '', parsed: '', error: '', prompt: '', timestamp: Date.now() });
      paint();
      try {
        const { charactersById } = await getCharacterContext();
        const patches = await fermentComments(user, charactersById, posts.slice(0, 4), (info) => {
          setDebugInfo(info);
        });
        const count = await applyCommentPatches(patches);
        setDebugInfo({ ...(debugInfo || {}), phase: 'saved', error: count ? '' : '模型返回后没有新增可用评论', timestamp: Date.now() });
        showToast(count ? `新增 ${count} 条评论` : '暂时没人接话');
      } catch (err) {
        setDebugInfo({ ...(debugInfo || {}), phase: 'failed', error: String(err?.message || err || '发酵失败'), timestamp: Date.now() });
        showGenerationErrorReport(generationErrorFromCatch(err, {
          scope: '匿名墙 / 评论生成',
          title: '匿名评论生成失败',
        }));
        showToast(err?.message || '发酵失败');
      } finally {
        busy = false;
        busyKind = '';
        busyText = '';
        await lease.release();
        paint();
      }
    });
    container.querySelectorAll('[data-ferment-one]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const post = posts.find((p) => p.id === btn.getAttribute('data-ferment-one'));
        if (!post) return;
        const lease = await claimWallGeneration();
        if (!lease) return;
        busy = true;
        busyKind = 'ferment-one';
        fermentOneId = post.id;
        busyText = '正在给这条投稿发酵…';
        setDebugInfo({ kind: '单条发酵', phase: 'start', raw: '', parsed: '', error: '', prompt: '', timestamp: Date.now() });
        paint();
        try {
          const { charactersById } = await getCharacterContext();
          const patches = await fermentComments(user, charactersById, [post], (info) => {
            setDebugInfo({ ...info, kind: '单条发酵' });
          });
          const count = await applyCommentPatches(patches);
          setDebugInfo({ ...(debugInfo || {}), phase: 'saved', error: count ? '' : '模型返回后没有新增可用评论', timestamp: Date.now() });
          showToast(count ? `新增 ${count} 条评论` : '暂时没人接话');
        } catch (err) {
          setDebugInfo({ ...(debugInfo || {}), phase: 'failed', error: String(err?.message || err || '发酵失败'), timestamp: Date.now() });
          showGenerationErrorReport(generationErrorFromCatch(err, {
            scope: '匿名墙 / 单条评论生成',
            title: '匿名评论生成失败',
          }));
          showToast(err?.message || '发酵失败');
        } finally {
          busy = false;
          busyKind = '';
          fermentOneId = '';
          busyText = '';
          await lease.release();
          paint();
        }
      });
    });
    container.querySelectorAll('[data-comment]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-comment');
        const text = await promptTextEditor({ title: '匿名评论', placeholder: '像评论区路人一样短一点' });
        if (!text) return;
        const nowTs = await getNowForUser(user.id).catch(() => Date.now());
        posts = posts.map((p) => p.id === id
          ? { ...p, comments: [...(p.comments || []), normalizeComment({ content: text, author: '匿名路人', role: '路人', likes: 0 }, nowTs)].filter(Boolean) }
          : p);
        await savePosts(user.id, posts);
        paint();
      });
    });
    container.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('删除这条投稿？')) return;
        await persist(posts.filter((p) => p.id !== btn.getAttribute('data-delete')));
        showToast('已删除');
        paint();
      });
    });
  }

  paint();
}
