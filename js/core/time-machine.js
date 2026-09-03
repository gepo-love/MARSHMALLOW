/**
 * 时光机 · 角色过往叙事生成（相遇模块子模式）
 *
 * 两种视角：
 * - observe（旁观回顾）：展开 TA 的一段过去，用户不在场 → ownership='character'。
 * - cocreate（一起创造）：用户参与共建一段过去 → ownership='shared'（镜像进记忆馆共同回忆）。
 *
 * 产物收纳为 collectible（生图位首版留空）。
 */

import { chat as apiChat, resolveChatPreferStream } from './api.js';
import { composeContextualGenerationMessages } from './chat-json-generation.js';
import { resolveSceneApiConfig } from './api-presets.js';
import { getCharacterAiContextName } from '../models/character.js';
import { saveCollectible } from './collectibles.js';
import { listChatsForUser, listMessagesForChat } from './chat-store.js';
import { buildChatContext } from './context/build-chat-context.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import { buildPresetFragmentContext } from './preset-store.js';
import {
  VARIED_SEGMENTATION_HINT,
  clampWordRange,
  resolveNarrationMaxTokens,
  wordRangeDirective,
} from './narration-settings.js';
import { archiveNarration } from './narration-archive.js';
import {
  extractNarrationEditorialAudits,
  sanitizeNarrationOutput,
} from './narration-sanitize.js';
import {
  acquireNarrationGenerationLease,
  narrationGenerationInFlightError,
} from './narration-generation-lease.js';
import { applyPermanentRegex, applyPromptRegex, primeRegex } from './display-regex.js';
import {
  generateRealisticImage,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
  persistGeneratedImageUrlLocally,
} from './image-generation-tools.js';

export const TIME_MACHINE_THEMES = [
  { id: 'childhood', label: '童年' },
  { id: 'family', label: '家人' },
  { id: 'debut', label: '入行 / 出道' },
  { id: 'highlight', label: '第一次高光' },
  { id: 'custom', label: '自定义' },
];

export const DEFAULT_TIME_MACHINE_IMAGE_STYLE = [
  'single small memory object vignette, centered composition, 1 to 3 simple objects only, app collectible icon, memory sticker sheet item, clean symbolic keepsake cluster',
  'flat pastel illustration, clean simple line art, crisp silhouette, low detail, matte colors, large blank warm paper background, minimal texture, bright warm cozy color palette, cheerful soft light, gentle cream, peach, lemon yellow, mint green and clear sky blue accents',
  'no full scene, no room, no street, no landscape, no complex perspective, no busy background, no realistic watercolor granulation, no dramatic lighting, no glow, no clutter, no vintage dirt, no grunge, no oil paint, no photorealism, no 3D render, no anime screenshot',
  'no humans, no people, no portraits, no faces, no hands, no body parts, no silhouettes, no words, no letters, no logo, no watermark',
].join(', ');

export function getThemeLabel(id, customText = '') {
  if (id === 'custom') return String(customText || '').trim() || '自定义';
  const hit = TIME_MACHINE_THEMES.find((t) => t.id === id);
  return hit ? hit.label : '过往';
}

function buildCharacterProfileText(character) {
  if (!character || typeof character !== 'object') return '';
  const lp = character.lifeProfile || {};
  const parts = [
    character.personality ? `性格：${character.personality}` : '',
    character.speechStyle ? `说话风格：${character.speechStyle}` : '',
    character.currentRole ? `身份：${character.currentRole}` : '',
    character.birthDate ? `生日：${character.birthDate}` : '',
    lp.familyThreads ? `家庭线索：${lp.familyThreads}` : '',
    lp.homeDetails ? `居所：${lp.homeDetails}` : '',
    lp.socialAnchors ? `社交圈：${lp.socialAnchors}` : '',
    lp.habits ? `习惯：${lp.habits}` : '',
    character.notes ? `补充：${character.notes}` : '',
    character.promptCorpus ? `完整角色设定：${character.promptCorpus}` : '',
    character.speechCorpus ? `完整语料：${character.speechCorpus}` : '',
    character.userRelationStatus ? `与用户关系：${character.userRelationStatus}` : '',
    character.gender ? `性别：${character.gender}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

const NARRATION_SYSTEM = '你是一个温柔的时光机叙事者，负责补全一个角色的过去。只输出叙事正文与必要的 JSON，不要输出聊天气泡、发送标签、群聊格式或额外解释。叙事要贴合角色人设，聚焦在「某一个具体事件」上把它讲透，细节具体可信，避免空泛套话与生平流水账。';

function buildPrompt({ character, name, viewpoint, themeLabel, userName, extra, wordMin, wordMax }) {
  const profile = buildCharacterProfileText(character);
  return [
    '[时光机 · 补全过往]',
    `对象：${name}`,
    profile ? `角色资料：\n${profile}` : '',
    `主题引子：${themeLabel}`,
    viewpoint === 'cocreate'
      ? `视角：一起创造——这件过往里 ${userName} 也在场，与 ${name} 一同经历。请把这一幕写成两人共同的回忆，${userName} 用第二人称「你」。`
      : `视角：旁观回顾（剧场流）——这是 ${name} 自己的一段过去，${userName} 并不在场，只是在时光机里旁观这一幕。请专注写 ${name} 自己，把镜头交给 TA。`,
    '请只挑「一个具体事件 / 一个场景 / 一个瞬间」来展开，像舞台上的一幕：有明确的起因、经过、一个关键的转折或细节、以及余韵。不要把童年到成名一路概述，也不要把多件事拼贴在一起——只把这一件事讲透、讲具体。',
    extra ? `补充要求：${extra}` : '',
    '写法：以旁白、动作、场景为主，可夹少量关键对白；写的是「过去发生过的那一幕」，不是当下。',
    `${wordRangeDirective(wordMin, wordMax)} 段落数量不限，跟随内容自然切分。`,
    VARIED_SEGMENTATION_HINT,
    '必须严格输出 1 个 JSON 对象，不要 markdown 解释。',
    'JSON 结构：{"title":"不超过16字，点出这一幕","summary":"1~2句不超过50字，适合收藏卡展示","paragraphs":["自然段1","自然段2","..."],"iconHint":"这一幕里一个可作收藏图标的具体小物（如 老照片/奖牌/旧球鞋/录音带），3~8字"}',
  ].filter(Boolean).join('\n');
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1).trim();
}

function safeJsonString(value = '') {
  const raw = String(value || '');
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch (_) {
    return raw
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }
}

function extractPartialJsonString(text = '', key = '') {
  const re = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)(?:"\\s*[,}]|$)`);
  const hit = String(text || '').match(re);
  return hit ? safeJsonString(hit[1]).trim() : '';
}

function extractPartialParagraphs(text = '') {
  const raw = String(text || '');
  const hit = raw.match(/"paragraphs"\s*:\s*\[/);
  if (!hit) return [];
  const start = (hit.index || 0) + hit[0].length;
  const end = raw.indexOf(']', start);
  const slice = raw.slice(start, end >= 0 ? end : raw.length);
  const out = [];
  let quote = false;
  let escaped = false;
  let buf = '';
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (!quote) {
      if (ch === '"') {
        quote = true;
        buf = '';
      }
      continue;
    }
    if (escaped) {
      buf += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      const text = safeJsonString(buf).trim();
      if (text) out.push(text);
      quote = false;
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (quote && buf.trim()) out.push(safeJsonString(buf).trim());
  return out;
}

function sanitizeTimeMachineText(raw = '', audits = null) {
  const editorial = extractNarrationEditorialAudits(String(raw || ''));
  if (Array.isArray(audits) && editorial.audits.length) audits.push(...editorial.audits);
  return sanitizeNarrationOutput(editorial.body).trim();
}

export function previewTimeMachineStream(raw = '', { themeLabel = '' } = {}) {
  const text = String(raw || '').trim();
  const title = sanitizeTimeMachineText(extractPartialJsonString(text, 'title')) || themeLabel || '时光机';
  const iconHint = sanitizeTimeMachineText(extractPartialJsonString(text, 'iconHint')).slice(0, 12);
  const partialParagraphs = extractPartialParagraphs(text);
  let paragraphs = partialParagraphs
    .map((paragraph) => sanitizeTimeMachineText(paragraph))
    .filter(Boolean);
  if (!paragraphs.length && !/"paragraphs"\s*:/.test(text)) {
    const cleaned = sanitizeTimeMachineText(text)
      .replace(/```(?:json)?/gi, '')
      .replace(/[{}[\]",]/g, ' ')
      .replace(/(?:title|summary|paragraphs|iconHint)\s*:/gi, ' ')
      .trim();
    if (cleaned) paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }
  const body = paragraphs.join('\n\n');
  const summary = String(sanitizeTimeMachineText(extractPartialJsonString(text, 'summary')) || paragraphs[0] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
  return { title, summary, paragraphs, body, iconHint };
}

export function parseTimeMachineResponse(text = '', { themeLabel = '' } = {}) {
  let title = themeLabel;
  let summary = '';
  let paragraphs = [];
  let iconHint = '';
  const editorialAudits = [];
  let parsedObject = null;
  const source = String(text || '');
  const withoutEditorialComments = source.replace(
    /<!--\s*editorial-audit\s*:[\s\S]*?-->/gi,
    '',
  );
  const candidates = [extractJsonObject(source), extractJsonObject(withoutEditorialComments)]
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  for (const jsonText of candidates) {
    try {
      parsedObject = JSON.parse(jsonText);
      break;
    } catch (_) { /* fall through */ }
  }
  if (parsedObject) {
    title = sanitizeTimeMachineText(parsedObject?.title || themeLabel, editorialAudits) || themeLabel;
    summary = sanitizeTimeMachineText(parsedObject?.summary || '', editorialAudits)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);
    paragraphs = Array.isArray(parsedObject?.paragraphs)
      ? parsedObject.paragraphs
        .map((paragraph) => sanitizeTimeMachineText(paragraph, editorialAudits))
        .filter(Boolean)
      : [];
    iconHint = sanitizeTimeMachineText(parsedObject?.iconHint || '', editorialAudits).slice(0, 12);
  }
  if (!paragraphs.length && !parsedObject) {
    const editorial = extractNarrationEditorialAudits(source);
    editorial.audits.forEach((audit) => {
      if (!editorialAudits.includes(audit)) editorialAudits.push(audit);
    });
    paragraphs = sanitizeTimeMachineText(editorial.body)
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    summary = String(paragraphs[0] || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  }
  return {
    title,
    summary,
    paragraphs,
    body: paragraphs.join('\n\n'),
    iconHint,
    editorialAudits,
  };
}

function buildTimeMachineImagePrompt({ fragment = {}, character = {}, stylePrompt = '' } = {}) {
  const name = getCharacterAiContextName(character, fragment.characterId);
  const body = String(fragment.body || (fragment.paragraphs || []).join('\n')).slice(0, 700);
  const style = String(stylePrompt || '').trim() || DEFAULT_TIME_MACHINE_IMAGE_STYLE;
  return [
    'A warm cute illustration for a mobile time-machine memory card.',
    `Style keywords: ${style}.`,
    'Composition: one square illustration, clear central motif, safe empty margins, no UI, no words, no letters, no logo, no watermark.',
    'Subject must be a single symbolic keepsake or a tiny cluster of 1 to 3 objects only. Do not draw a full scene, room, street, landscape, or complex background. Express the memory through simple objects such as a ticket, cup, ribbon, notebook, flower, charm, toy, plush object, tiny animal mascot, weather icon, or stationery detail.',
    `Character or memory owner: ${name || 'a character'}.`,
    `Memory title: ${fragment.title || fragment.themeLabel || 'a small memory'}.`,
    fragment.iconHint ? `Important object motif: ${fragment.iconHint}.` : '',
    body ? `Scene context: ${body}` : '',
  ].filter(Boolean).join('\n');
}

export async function generateTimeMachineIllustration({ fragment, character, stylePrompt = '', onImage = null } = {}) {
  if (!fragment) throw new Error('先生成一段过往');
  const cfg = await loadImageToolConfig();
  if (!isRealisticImageGenerationEnabled(cfg)) {
    throw new Error('请先在设置中开启兼容生图');
  }
  const prompt = buildTimeMachineImagePrompt({ fragment, character, stylePrompt });
  const result = await generateRealisticImage(prompt, {
    config: cfg,
    rawPrompt: true,
    size: cfg.realistic?.size || '1024x1024',
  });
  let image = String(result?.url || '').trim();
  if (!image) throw new Error('没有生成图片地址');
  if (typeof onImage === 'function') onImage(image);
  image = await persistGeneratedImageUrlLocally(image).catch(() => image);
  return { image, imagePrompt: prompt };
}

export function buildTimeMachineSelectiveQueryText({ themeLabel = '', extra = '' } = {}) {
  return [
    String(themeLabel || '').trim(),
    String(extra || '').trim(),
  ].filter(Boolean).join('\n');
}

async function buildTimeMachineWorldBookMessages({
  user,
  character,
  characterId,
  userName = '用户',
  selectiveQueryText = '',
} = {}) {
  const cid = String(characterId || character?.id || '').trim();
  if (!cid) return [];
  const name = getCharacterAiContextName(character, cid);
  const rawBlock = await buildWorldBookContextBlock(user, selectiveQueryText, {
    worldBookMode: 'selective',
    characterIds: [cid],
    sparseVectorMode: false,
  }).catch(() => '');
  const block = applyPromptRegex(rawBlock, {
    surface: 'timemachine',
    placement: 4,
    includePermanent: true,
    macros: { user: userName, char: name },
  });
  return block ? [{ role: 'system', content: block }] : [];
}

export async function buildTimeMachineContextMessages({
  user,
  userId,
  character,
  characterId,
  viewpoint = 'observe',
  userName = '用户',
  selectiveQueryText = '',
} = {}) {
  const uid = String(userId || user?.id || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!cid) return [];
  const worldBookFallback = () => buildTimeMachineWorldBookMessages({
    user,
    character,
    characterId: cid,
    userName,
    selectiveQueryText,
  });
  if (!uid) return worldBookFallback();
  const chats = await listChatsForUser(uid).catch(() => []);
  const chat = chats.find((c) => (
    c?.type === 'private'
    && Array.isArray(c.participants)
    && c.participants.includes('user')
    && c.participants.includes(cid)
  ));
  // 时光机可以先于普通私聊使用；此时仍要按当前角色和本次主题独立读取世界书。
  if (!chat) return worldBookFallback();
  const messages = await listMessagesForChat(chat.id, 80, { deferHeavyImages: true }).catch(() => []);
  const built = await buildChatContext({
    chat,
    chatId: chat.id,
    user,
    userId: uid,
    messages,
    characters: { [cid]: character },
    sceneDirective: '',
    selectiveQueryText,
    presetMode: 'offline',
    regexSurface: 'timemachine',
    // 旁观回顾：这是角色自己的独立过去，用户并不在场，防抢话/防转述/导演模式这套「用户在场互动」
    // 的叙事规则在这里没有意义，不注入；一起创造模式用户是在场共创的，正常生效。
    skipNarrativeModeDirectives: viewpoint === 'observe',
  }).catch(() => null);
  return Array.isArray(built?.messages) ? built.messages : worldBookFallback();
}

/**
 * 生成一段过往片段（不落库），返回 { title, summary, paragraphs, body, iconHint }。
 */
async function generateTimeMachineFragmentUnlocked({
  character,
  characterId,
  viewpoint = 'observe',
  themeId = 'childhood',
  customTheme = '',
  userName = '用户',
  user = null,
  userId = '',
  extra = '',
  wordMin,
  wordMax,
  onChunk = null,
}) {
  await primeRegex().catch(() => null);
  const name = getCharacterAiContextName(character, characterId);
  const themeLabel = getThemeLabel(themeId, customTheme);
  const range = clampWordRange({ wordMin, wordMax }, 200, 500);
  const permanentExtra = applyPermanentRegex(String(extra || '').trim(), {
    surface: 'timemachine',
    placement: 1,
    depth: 0,
    macros: { user: userName, char: name },
  });
  const promptExtra = applyPromptRegex(permanentExtra, {
    surface: 'timemachine',
    placement: 1,
    depth: 0,
    macros: { user: userName, char: name },
  });
  const prompt = buildPrompt({
    character,
    name,
    viewpoint,
    themeLabel,
    userName,
    extra: promptExtra,
    wordMin: range.wordMin,
    wordMax: range.wordMax,
  });
  const selectiveQueryText = buildTimeMachineSelectiveQueryText({
    themeLabel,
    extra: promptExtra,
  });

  const [presetBlock, contextMessages] = await Promise.all([
    buildPresetFragmentContext('offline'),
    buildTimeMachineContextMessages({
      user,
      userId,
      character,
      characterId,
      viewpoint,
      userName,
      selectiveQueryText,
    }),
  ]);
  const messages = composeContextualGenerationMessages({
    contextMessages,
    systemParts: [NARRATION_SYSTEM, presetBlock || ''],
    userContent: [
      '本次任务：',
      prompt,
      /<!--\s*editorial-audit\s*:/i.test(presetBlock || '')
        ? '编辑审稿格式补充：仍须保持整个回复是合法的单个 JSON 对象。只在 paragraphs 的字符串内部执行“审稿注释 → Print 定稿”；注释与换行按合法 JSON 字符串转义。title、summary、iconHint 只填写定稿，不得包含 DRAFT、AUDIT 或审稿注释。'
        : '',
    ].filter(Boolean).join('\n\n'),
  });
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const narrationMaxTokens = await resolveNarrationMaxTokens(apiOverride);
  const requestOptions = {
    temperature: 0.95,
    maxTokens: narrationMaxTokens,
    configOverride: apiOverride || undefined,
  };
  if (typeof onChunk === 'function') {
    const preferStream = await resolveChatPreferStream(apiOverride);
    if (preferStream) {
      requestOptions.stream = true;
      requestOptions.onChunk = (_piece, fullText) => {
        onChunk(fullText, previewTimeMachineStream(fullText, { themeLabel }));
      };
    }
  }

  const raw = await apiChat(messages, requestOptions);

  if (typeof onChunk === 'function' && String(raw || '').trim() && !requestOptions.stream) {
    onChunk(raw, previewTimeMachineStream(raw, { themeLabel }));
  }

  const text = String(raw || '').trim();
  const parsed = parseTimeMachineResponse(text, { themeLabel });
  const permanentContext = {
    surface: 'timemachine',
    placement: 2,
    depth: 0,
    macros: { user: userName, char: name },
  };
  const title = applyPermanentRegex(parsed.title, permanentContext);
  const summary = applyPermanentRegex(parsed.summary, permanentContext);
  const paragraphs = parsed.paragraphs.map((row) => applyPermanentRegex(row, permanentContext));
  const body = paragraphs.join('\n\n') || applyPermanentRegex(parsed.body, permanentContext);
  const iconHint = parsed.iconHint;
  if (!paragraphs.length) throw new Error('未生成内容，请重试');

  const archived = await archiveNarration({
    kind: 'time_machine',
    title: title || themeLabel,
    subtitle: [themeLabel, viewpoint === 'cocreate' ? '一起创造' : '旁观回顾'].filter(Boolean).join(' · '),
    text: body,
    characterId,
    characterName: name,
    meta: parsed.editorialAudits.length
      ? { editorialAudits: parsed.editorialAudits }
      : {},
  });

  return {
    title,
    summary,
    paragraphs,
    body,
    iconHint,
    themeId,
    themeLabel,
    viewpoint,
    characterId: String(characterId || character?.id || '').trim(),
    characterName: name,
    narrationArchiveId: archived?.id || '',
    editorialAudits: parsed.editorialAudits,
  };
}

export async function generateTimeMachineFragment(options = {}) {
  const leaseId = String(options.userId || options.characterId || options.character?.id || 'time-machine').trim();
  const lease = await acquireNarrationGenerationLease('time-machine', leaseId);
  if (!lease.acquired) throw narrationGenerationInFlightError();
  try {
    return await generateTimeMachineFragmentUnlocked(options);
  } finally {
    await lease.release();
  }
}

/**
 * 收纳：把片段存为 collectible（旁观→character / 共创→shared 并镜像记忆馆）。
 */
export async function collectTimeMachineFragment({ userId, characterId, fragment }) {
  const ownerId = String(fragment?.characterId || characterId || '').trim();
  if (!ownerId) throw new Error('缺少收藏归属角色');
  const ownership = fragment.viewpoint === 'cocreate' ? 'shared' : 'character';
  return saveCollectible({
    id: fragment.collectibleId || '',
    userId,
    characterId: ownerId,
    ownership,
    source: 'time_machine',
    viewpoint: fragment.viewpoint,
    theme: fragment.themeLabel || '',
    title: fragment.title,
    summary: fragment.summary,
    body: fragment.body,
    iconAsset: '',
    image: fragment.image || '',
    imagePrompt: fragment.imagePrompt || '',
  });
}
