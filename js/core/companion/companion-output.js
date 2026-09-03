// 陪伴输出落地：生成短句 + 写气泡/聊天/音乐广场 + 播 TTS。
// 详见 docs/companion-architecture.md §6。
// 所有 AI 请求严格按 AGENTS.md 用单 role:user。

import { chatWithPreferredStream, resolveGenerationMaxTokens } from '../api.js';
import { createMessage } from '../../models/chat.js';
import { ensurePrivateChat, listMessagesForChat, saveMessage, updateChatPreview } from '../chat-store.js';
import { saveMusicPost } from '../music-library.js';
import { getCharacter } from '../character-store.js';
import {
  buildVoiceSpeechProfileOverride,
  isCharacterVoiceTtsEnabled,
  isVoiceToolEnabled,
  loadVoiceToolConfig,
  normalizeVoiceSpeechPlan,
  resolveVoiceToolConfigForProfile,
  synthesizeVoice,
} from '../voice-tools.js';
import {
  buildVoiceWorldBookPrompt,
  VOICE_WORLD_BOOK_SURFACES,
} from '../voice-worldbook.js';
import { ensureDefaultUser } from '../user-slot.js';
import { buildChatContext } from '../context/build-chat-context.js';
import { stripLeakedReasoning } from '../narration-sanitize.js';
import { stripTranslationMarks } from '../narration-translation.js';
import { splitSpokenTextSegments } from '../speech-segmentation.js';
import { sanitizeAiTranslation } from '../translation-utils.js';
import { normalizeTranslationProfile, resolveVoiceTranslationProfile } from '../../models/character.js';
import { extractCompanionText, sanitizeCompanionSpeechText } from './companion-values.js';

const SPEECH_MAX_CHARS = 48;
const CHAT_MAX_CHARS = 80;
const MUSIC_POST_MAX_CHARS = 120;
const MAX_BUBBLES = 4;
const MAX_PARSED_VOICE_SEGMENTS = 8;
const VOICE_MAX_CHARS = 420;
const STANDBY_MAX_LINES = 8;
const STANDBY_MAX_CHARS = 36;

function genId(prefix = 'cmp_msg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function clean(value, max) {
  return extractCompanionText(value, { max }).replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanLine(value, max = SPEECH_MAX_CHARS, options = {}) {
  return sanitizeCompanionSpeechText(
    stripLeakedReasoning(extractCompanionText(value, { max: Math.max(max * 4, 400) }), {
      preserveLeadingLatin: options.preserveLeadingLatin === true,
    }),
    { max: Math.max(max * 2, 200) },
  )
    .replace(/^\s*(?:assistant|ai|回复|text|bubble|bubbles|voiceText|气泡|语音文本|正文)\s*[:：]\s*/i, '')
    .replace(/^["“”]+|["“”]+$/g, '')
    .trim()
    .slice(0, max);
}

// 思维链/英文协议泄漏过滤统一用 core/narration-sanitize.js 的 stripLeakedReasoning
// （线下、小剧场、时光机等叙事面共用的那套），不要在这里另存一份弱化版本——
// 之前这份本地副本没有 stripLeadingLatinReasoning，抓不住"英文前缀+中文正文同行"
// 或 "**Initiating Chat Protocol**" 这类不在固定词表里的英文标题泄漏。
// isReasoningOnly 仍留在本地：这里按行过滤气泡/短句，跟 narration-sanitize 内部同名的私有实现独立维护即可。
function isReasoningOnly(value = '') {
  const line = String(value || '').trim();
  if (!line) return true;
  if (/^(?:analysis|reasoning|thinking|thought|思考|推理|分析)\s*[:：]/i.test(line)) return true;
  if (/^(?:我|我们|现在)?(?:需要|要|应该|先|接下来|可以)(?:分析|推理|判断|构思|思考|生成|输出)/.test(line)) return true;
  if (/^(?:根据|结合)(?:用户|上下文|设定|歌词|场景|要求)/.test(line)) return true;
  if (/^(?:用户|角色|任务|要求|背景|格式)\s*[:：]/.test(line) && !/[“”"。！？!?]/.test(line)) return true;
  return false;
}

function formatMinutes(ms) {
  if (!ms || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m <= 0) return '不到一分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

function formatClock(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' });
  } catch (_) {
    return new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
  }
}

function buildSessionFlavor(session) {
  const now = Date.now();
  const lines = [];
  if (session?.scenarioTitle) lines.push(`场景：${clean(session.scenarioTitle, 40)}`);
  lines.push(`类型：${describeSessionType(session.type)}`);
  if (session?.mode === 'pomodoro' && session?.endsAt) {
    const remain = Math.max(0, session.endsAt - now);
    const total = (session.plannedDurationMin || 0) * 60_000;
    const elapsed = total - remain;
    lines.push(`番茄钟节奏：计划 ${session.plannedDurationMin || 0} 分钟，已陪 ${formatMinutes(elapsed)}，还剩 ${formatMinutes(remain)}`);
  } else if (session?.startedAt) {
    lines.push(`已陪伴 ${formatMinutes(now - session.startedAt)}`);
  }
  if (session?.context?.userActivity) lines.push(`用户在做：${clean(session.context.userActivity, 120)}`);
  if (session?.context?.focusGoal) lines.push(`专注目标：${clean(session.context.focusGoal, 60)}`);
  if (session?.context?.mood) lines.push(`氛围：${clean(session.context.mood, 40)}`);
  lines.push(`当前时间：${formatClock(now)}`);
  return lines.filter(Boolean).join('\n');
}

function buildRecentExchange(session, character, max = 5) {
  // 把最近的 outputs + userInputs 按时间排序，给 TA 看到自己刚说什么 / 用户回了什么。
  const charName = clean(character?.customNickname || character?.name || character?.id || '角色', 24);
  const outs = (session?.outputs || []).map((o) => ({ at: o.at, who: charName, text: o.text }));
  const ins = (session?.userInputs || []).map((u) => ({ at: u.at, who: '用户', text: u.text, kind: '输入' }));
  const merged = [...outs, ...ins].sort((a, b) => a.at - b.at).slice(-max);
  if (!merged.length) return '';
  return merged.map((e) => `- ${e.who}：${cleanLine(e.text, 80)}`).join('\n');
}

function collectCurrentPageSnapshot() {
  if (typeof document === 'undefined') return '';
  try {
    const hash = typeof window !== 'undefined' ? String(window.location?.hash || '') : '';
    const title = String(document.title || '').trim();
    const root = document.querySelector('main, [data-page], #app, body');
    const text = String(root?.innerText || '')
      .replace(/\s+/g, ' ')
      .replace(/陪伴设置|陪伴主页|让 TA 说一句|换一组待机|戳一下/g, '')
      .trim()
      .slice(0, 360);
    return [
      hash ? `路由 ${hash}` : '',
      title ? `标题 ${title}` : '',
      text ? `可见内容 ${text}` : '',
    ].filter(Boolean).join('；');
  } catch (_) {
    return '';
  }
}

function buildCompanionVoiceDirective({
  kind,
  character,
  session,
  track,
  lyricWindow,
  pageSnapshot = '',
  voiceWorldBookPrompt = '',
}) {
  const persona = clean(character?.personality || character?.summary || character?.description || '', 280);
  const charName = clean(character?.customNickname || character?.name || character?.id || '角色', 24);
  const translationProfile = normalizeTranslationProfile(character?.translationProfile);
  const voiceTranslation = resolveVoiceTranslationProfile(character?.translationProfile);

  const flavor = buildSessionFlavor(session);
  const recent = buildRecentExchange(session, character, 5);
  const lyricLines = Array.isArray(lyricWindow?.lines) && lyricWindow.lines.length
    ? [
        '附近歌词：',
        ...lyricWindow.lines.map((line) => {
          const label = line.current ? '当前' : (line.offset < 0 ? `前${Math.abs(line.offset)}句` : `后${line.offset}句`);
          return `- ${label}：${clean(line.text, 80)}`;
        }),
      ]
    : [
        lyricWindow?.before ? `上一句歌词：${clean(lyricWindow.before, 40)}` : '',
        lyricWindow?.current ? `当前歌词：${clean(lyricWindow.current, 40)}` : '',
        lyricWindow?.after ? `下一句歌词：${clean(lyricWindow.after, 40)}` : '',
      ].filter(Boolean);

  const bgParts = [
    `角色：${charName}`,
    persona ? `人设：${persona}` : '',
    flavor,
    track ? `当前在听：${clean(track.title, 32)}${track.artist ? ` - ${clean(track.artist, 24)}` : ''}` : '',
    ...lyricLines,
    pageSnapshot ? `当前页面：${clean(pageSnapshot, 360)}` : '',
  ].filter(Boolean);

  const sections = [`背景：\n${bgParts.join('\n')}`];
  if (recent) sections.push(`最近发生过：\n${recent}\n（不要重复上面已经说过的话，话题/语气要往前推）`);
  sections.push(`本次任务：\n${kindTaskHint(kind, session)}${session?.type === 'listen_together' ? ' 可以自然提一句想听的歌、想从歌单里换一首，或邀请用户一起听某首；但不要说自己已经切歌，除非用户明确操作了播放器。' : ''}`);
  sections.push('要求：把这当作一段正在持续的语音通话，沿用普通私聊里的关系、语气和刚才的话题；如果最近一条是用户发言，优先自然接住它，不要另起一段自说自话。用第一人称，像角色随口说话；允许按真实说话的气口拆成多段，但不要为了凑段数硬拆句。不鸡汤、不说教；不说「作为AI」「根据设定」等元话语；不要输出思考过程、推理、分析、草稿；不要使用括号动作；不要把场景描述当事实复述；不要写“角色：”“气泡：”“回复：”这类前缀。表演方式只写进 emotion 和 pace，text 中禁止出现 [soft chuckle]、[low voice] 等方括号声线/情绪标签。');
  if (voiceWorldBookPrompt) sections.push(voiceWorldBookPrompt);
  const voiceLimit = kind === 'standby' ? STANDBY_MAX_LINES : MAX_BUBBLES;
  const needsForeignVoice = voiceTranslation.active;
  const allowsInlineForeign = translationProfile.mode === 'mixed';
  if (needsForeignVoice || allowsInlineForeign) {
    const language = voiceTranslation.language || translationProfile.language || '角色设定里的外语';
    const scope = needsForeignVoice
      ? `每一段 text 必须完整使用${language}，不能混入中文`
      : `若 text 中实际出现${language}或其他非中文句子`;
    sections.push(`外语/方言翻译：${scope}，该段必须额外写 zh，内容为贴合原文的简体中文普通话（现代标准汉语）翻译；中文方言即使全是汉字也不能省略 zh，且不能只做繁简转换。zh 只给用户点按查看，绝不能写进 text 或朗读文本。没有外语或方言的段落 zh 留空。`);
  }
  sections.push(`输出严格 JSON：{"voices":[{"text":"第一段语音","zh":"这段的中文翻译（没有则留空）","emotion":"neutral","pace":"normal"}]}。emotion 使用 neutral|happy|sad|angry|fearful|surprised|disgusted，pace 使用 slow|normal|fast；按每段真实表演填写。只允许 voices 一个字段；voices 为 1-${voiceLimit} 段，每段都是一条要播放并显示的语音文本，每段 text 不超过 ${kindMaxChars(kind)} 字。JSON 外不要有任何文字，不要输出 voice、bubbles、analysis、reasoning、thinking、notes 等字段。`);

  return sections.join('\n\n');
}

async function buildGenerationMessages({ kind, character, session, track, lyricWindow, pageSnapshot = '', screenImageUrl = '' }) {
  const user = await ensureDefaultUser();
  const chat = await ensurePrivateChat(user.id, session.characterId, character?.customNickname || character?.name || '');
  const recentMessages = await listMessagesForChat(chat.id, 80, { deferHeavyImages: true }).catch(() => []);
  const globalVoiceConfig = await loadVoiceToolConfig().catch(() => null);
  const voiceConfig = globalVoiceConfig
    ? resolveVoiceToolConfigForProfile(globalVoiceConfig, character?.voiceProfile || {})
    : null;
  const companionVoiceKind = !['music_post', 'chat'].includes(kind);
  const voiceWorldBookPrompt = companionVoiceKind && voiceConfig?.styleBook?.enabled === true
    ? buildVoiceWorldBookPrompt(VOICE_WORLD_BOOK_SURFACES.COMPANION, {
      customText: voiceConfig.styleBook?.text || '',
      provider: voiceConfig.provider,
    })
    : '';
  const sceneDirective = buildCompanionVoiceDirective({
    kind, character, session, track, lyricWindow,
    pageSnapshot: pageSnapshot || collectCurrentPageSnapshot(),
    voiceWorldBookPrompt,
  });
  const built = await buildChatContext({
    chat,
    user,
    userId: user.id,
    messages: recentMessages,
    characters: { [session.characterId]: character },
    contextDepth: 40,
    sceneDirective,
  });
  let messages = built.messages && built.messages.length
    ? built.messages
    : [{ role: 'user', content: sceneDirective }];

  const imageUrl = String(screenImageUrl || '').trim();
  if (imageUrl) {
    const { buildImageUrlVisionParts } = await import('../chat/vision-context.js');
    const visionParts = await buildImageUrlVisionParts([imageUrl], { max: 1, prefix: '用户当前屏幕' });
    if (visionParts.length) {
      const last = messages[messages.length - 1];
      if (last?.role === 'user' && typeof last.content === 'string') {
        messages[messages.length - 1] = {
          role: 'user',
          content: [{ type: 'text', text: last.content }, ...visionParts],
        };
      } else if (last?.role === 'user' && Array.isArray(last.content)) {
        messages[messages.length - 1] = { role: 'user', content: [...last.content, ...visionParts] };
      } else {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: '请结合附带的屏幕截图，像陪在用户身边自然搭话。' },
            ...visionParts,
          ],
        });
      }
    }
  }
  return messages;
}

function describeSessionType(type) {
  switch (type) {
    case 'listen_together': return '正在和用户一起听歌，偶尔轻声评论一句';
    case 'focus': return '陪用户专注做事，只在需要时短促说一句';
    case 'co_work': return '陪用户工作/写东西，偶尔搭话';
    case 'cooking': return '在厨房里陪用户，可以提一句下厨的小事';
    case 'reading': return '陪用户读书，偶尔交流一句';
    case 'voice_live': return '正在和用户语音连麦，可以更口语';
    case 'sleep': return '正在哄用户入睡，轻声讲故事或安静陪伴，不要求用户持续回应';
    default: return '在用户身边陪着，偶尔说一句轻的话';
  }
}

function kindTaskHint(kind, session) {
  if (session?.type === 'sleep') {
    if (kind === 'opening') {
      return '哄睡陪伴刚接通。放轻语气安顿用户躺好，自然开始今晚的故事或舒缓话题；不要反复问“听得到吗/在吗”，也不要要求用户持续回应。';
    }
    if (kind === 'goodnight') {
      return '用户已经长时间没有回应，大概率睡着了。只留一小段符合你们关系的晚安话，不再提问，不解释规则，自然结束今晚的陪伴。';
    }
    if (kind === 'speech' || kind === 'bubble') {
      return '继续一小段舒缓、连贯的睡前故事或轻声陪伴。承接刚才的内容，不要每段都提问，不催用户回复，也不要突然切换成热闹话题。';
    }
  }
  switch (kind) {
    case 'opening': {
      const suggested = Array.isArray(session?.context?.scenarioOpeningLines)
        ? session.context.scenarioOpeningLines.map((line) => cleanLine(line, 48)).filter(Boolean).slice(0, 3)
        : [];
      const reference = suggested.length
        ? ` 场景提供的开场参考是「${suggested.join(' / ')}」，只取氛围和意图，不要逐字照抄。`
        : '';
      return `这段陪伴语音刚拨通，由你先自然开口。像真实连麦接通后的第一句话，先接住当前关系和场景，再抛出一个很短、方便用户回应的话头；不要假装用户已经说过话。${reference}`;
    }
    case 'music_post':
      return '写一条要发到「音乐广场」的网抑云式纯文本短动态，配的就是当前在听这首歌。不要写表情包、贴纸标签、emoji 占位或情绪小标题。';
    case 'chat':
      return '写一条要发进私聊的短消息，像主动找用户搭话。';
    case 'bubble':
      return '像正在连麦时自然接一句话；需要时可按气口分成几段，每段都会成为独立气泡和语音。';
    case 'speech':
      return '像正在连麦时自然说话；需要时按气口分段，避免书面长句。';
    case 'standby':
      return '假装你是这个角色的配音导演，生成一组可在陪伴空白期轮播的短台词。要像角色在旁边轻声互动、戳戳乐反馈、呼吸前后的小反应，但不要写舞台说明。';
    case 'screen_watch':
      return '用户刚截了一张屏幕图（已附在消息里）。像坐在旁边一起看书/看剧那样，根据画面自然搭一两句话；不要描述「截图里」「屏幕显示」这类元话语，直接聊内容本身。';
    default:
      return '写一句符合当下场景的短话。';
  }
}

function kindMaxChars(kind) {
  switch (kind) {
    case 'music_post': return MUSIC_POST_MAX_CHARS;
    case 'chat': return CHAT_MAX_CHARS;
    case 'standby': return STANDBY_MAX_CHARS;
    default: return SPEECH_MAX_CHARS;
  }
}

function extractJsonObject(text = '') {
  const body = String(text || '');
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : body;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function normalizeVoiceText(value = '') {
  // voices[].text 是严格 JSON 中已经定位出的可播放正文；保留合法拉丁字母开头的外语台词，
  // 显式 think / analysis 块仍由统一清洗器照常移除。
  return stripLeakedReasoning(extractCompanionText(value, { max: VOICE_MAX_CHARS * 4 }), {
    preserveLeadingLatin: true,
  })
    .replace(/^\s*(?:voice|speech|audio|say|line|text|语音|语音文本|台词|说话|回复|正文)\s*[:：]\s*/i, '')
    .replace(/^["“”]+|["“”]+$/g, '')
    .split(/\r?\n/)
    .map((line) => cleanLine(line, VOICE_MAX_CHARS, { preserveLeadingLatin: true }))
    .filter((line) => line && !isReasoningOnly(line))
    .join('\n')
    .trim()
    .slice(0, VOICE_MAX_CHARS);
}

function splitSpeechTextPreserving(value = '', kind = 'bubble') {
  const max = kindMaxChars(kind);
  const text = sanitizeCompanionSpeechText(value, { max: VOICE_MAX_CHARS })
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];
  return splitSpokenTextSegments(text, {
    maxChars: max,
    maxSegments: MAX_PARSED_VOICE_SEGMENTS,
    preserveParagraphIfFits: true,
    packSentences: true,
  });
}

function mergeOverflowSegments(items = [], limit = MAX_PARSED_VOICE_SEGMENTS) {
  if (items.length <= limit) return items;
  const head = items.slice(0, Math.max(0, limit - 1));
  const tail = items.slice(Math.max(0, limit - 1));
  const first = tail[0] || {};
  head.push({
    ...first,
    text: tail.map((item) => item.text).filter(Boolean).join(''),
    translation: tail.map((item) => item.translation).filter(Boolean).join('\n'),
  });
  return head;
}

function normalizeVoiceParts(value, kind = 'bubble', limit = MAX_PARSED_VOICE_SEGMENTS) {
  const arr = Array.isArray(value) ? value : [value];
  const parts = arr
    .flatMap((item) => {
      if (item && typeof item === 'object') {
        const sourceText = normalizeVoiceText(item.text || item.voice || item.voiceText || item.content || item.say || '');
        const texts = splitSpeechTextPreserving(sourceText, kind);
        const translation = sanitizeAiTranslation(sourceText, item.zh || item.translation || '');
        const speechPlan = normalizeVoiceSpeechPlan({
          text: sourceText,
          emotion: item.emotion,
          pace: item.pace,
        }, sourceText);
        return texts.map((text, index) => ({
          text,
          translation: index === 0 ? translation : '',
          emotion: speechPlan?.emotion || 'neutral',
          pace: speechPlan?.pace || 'normal',
        }));
      }
      return splitSpeechTextPreserving(normalizeVoiceText(item), kind).map((text) => ({
        text,
        translation: '',
        emotion: 'neutral',
        pace: 'normal',
      }));
    })
    .filter((line) => line.text && !isReasoningOnly(line.text));
  return mergeOverflowSegments(parts, limit);
}

function splitVoiceTextToBubbles(voiceText = '', kind = 'bubble', limit = MAX_PARSED_VOICE_SEGMENTS) {
  const parts = splitSpeechTextPreserving(normalizeVoiceText(voiceText), kind)
    .filter((line) => line && !isReasoningOnly(line))
    .map((text) => ({ text }));
  return mergeOverflowSegments(parts, limit).map((item) => item.text);
}

/** 陪伴 TTS 分段：只按文本长度合并，不擅自插入呼吸或停顿标签。 */
function buildCompanionTtsSegments(text = '') {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const segments = [];
  let buf = '';
  for (const line of lines) {
    const separator = buf && !/[。！？!?，,；;：:]$/.test(buf) ? '，' : '';
    const candidate = buf ? `${buf}${separator}${line}` : line;
    if (buf && candidate.length > 220) {
      segments.push(buf);
      buf = line;
    } else {
      buf = candidate;
    }
  }
  if (buf) segments.push(buf);
  return segments;
}

export function parseCompanionGeneratedReply(raw, kind = 'bubble') {
  const obj = extractJsonObject(raw);
  const voices = normalizeVoiceParts(obj?.voices || obj?.segments || obj?.lines || obj?.bubbles || [], kind);
  const fallbackVoice = normalizeVoiceText(obj?.voice || obj?.vioce || obj?.voiceText || obj?.text || obj?.speech || obj?.audio || obj?.say || obj || raw || '');
  const segments = voices.length
    ? voices
    : splitVoiceTextToBubbles(fallbackVoice, kind).map((text) => ({
      text,
      translation: '',
      emotion: 'neutral',
      pace: 'normal',
    }));
  const voice = voices.length ? voices.map((item) => item.text).join('\n') : fallbackVoice;
  if (!segments.length && !voice) return { bubbles: [], bubbleSegments: [], voiceText: '', text: '' };
  return {
    bubbles: segments.map((item) => item.text),
    bubbleSegments: segments,
    voiceText: voice,
    text: segments.map((item) => item.text).join('\n') || voice,
  };
}

export async function generateShortLine({ kind, character, session, track, lyricWindow, settings, screenImageUrl = '' }) {
  try {
    const messages = await buildGenerationMessages({
      kind, character, session, track, lyricWindow, settings, screenImageUrl,
    });
    const genMaxTokens = await resolveGenerationMaxTokens();
    const requestOptions = { maxTokens: genMaxTokens, temperature: 0.86 };
    let raw = '';
    await chatWithPreferredStream(messages, (_delta, acc) => {
      raw = typeof acc === 'string' ? acc : `${raw}${String(_delta || '')}`;
    }, requestOptions);
    if (!String(raw || '').trim()) {
      throw new Error('未抽到可用正文，未自动改用非流式重试');
    }
    const reply = parseCompanionGeneratedReply(raw, kind);
    if (!reply.text) {
      const err = new Error('API 没有返回可播放的 voices 字段');
      err.rawResponse = String(raw || '');
      throw err;
    }
    return reply;
  } catch (err) {
    console.warn('[companion-output] short-line gen failed', err?.message || err);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('companion-ai-error', {
        detail: { message: err?.message || String(err || ''), kind },
      }));
    }
    throw err;
  }
}

// 不论触发源是主动说话 tick、手动戳一下、待机台词还是（stage 3）窥屏评论——
// 只要用户开着「语音播报」总开关，任何 kind 产出的文本都统一走这里合成语音。
// 新增触发源时不要在别处再写一遍 allowSpeechTts 判断，都应该落到这一个函数上。
export function shouldSynthesizeVoiceFor(kind, settings) {
  return !!settings?.allowSpeechTts;
}

async function buildVoiceSegments({ voiceText, sourceSegments = [], kind = 'bubble', characterId, settings }) {
  const segmentLimit = kind === 'standby' ? STANDBY_MAX_LINES : MAX_PARSED_VOICE_SEGMENTS;
  const supplied = Array.isArray(sourceSegments)
    ? sourceSegments
      .map((item) => ({
        text: normalizeVoiceText(item?.text || ''),
        translation: sanitizeAiTranslation(item?.text || '', item?.translation || item?.zh || ''),
        emotion: String(item?.emotion || 'neutral').trim().toLowerCase() || 'neutral',
        pace: String(item?.pace || 'normal').trim().toLowerCase() || 'normal',
      }))
      .filter((item) => item.text)
      .slice(0, segmentLimit)
    : [];
  const displayLines = splitVoiceTextToBubbles(voiceText, kind, segmentLimit).filter(Boolean);
  const fallback = normalizeVoiceText(voiceText || '');
  const displayBase = supplied.length
    ? supplied
    : (displayLines.length ? displayLines : [fallback].filter(Boolean)).map((text) => ({
      text,
      translation: '',
      emotion: 'neutral',
      pace: 'normal',
    }));
  if (!displayBase.length) return [];
  const ttsTexts = shouldSynthesizeVoiceFor(kind, settings)
    ? (supplied.length
      ? supplied.map((item) => stripTranslationMarks(item.text))
      : buildCompanionTtsSegments(stripTranslationMarks(fallback || displayBase.map((item) => item.text).join('\n'))))
    : displayBase.map((item) => item.text);
  const synthBase = (ttsTexts.length ? ttsTexts : displayBase).slice(0, segmentLimit);
  if (!shouldSynthesizeVoiceFor(kind, settings)) return displayBase;
  const character = characterId ? await getCharacter(characterId).catch(() => null) : null;
  const globalCfg = await loadVoiceToolConfig().catch(() => null);
  const cfg = globalCfg
    ? resolveVoiceToolConfigForProfile(globalCfg, character?.voiceProfile || {})
    : null;
  if (!cfg || !isVoiceToolEnabled(cfg)) return displayBase;
  if (!isCharacterVoiceTtsEnabled(character?.voiceProfile || {}, cfg.provider)) {
    return displayBase;
  }
  const out = [];
  for (let index = 0; index < synthBase.length; index += 1) {
    const ttsText = typeof synthBase[index] === 'string' ? synthBase[index] : synthBase[index]?.text;
    const display = displayBase[index] || { text: ttsText, translation: '' };
    const speechPlan = normalizeVoiceSpeechPlan({
      text: ttsText,
      emotion: display.emotion,
      pace: display.pace,
    }, ttsText);
    const voiceProfileOverride = buildVoiceSpeechProfileOverride(
      character?.voiceProfile || {},
      speechPlan,
      cfg,
    );
    const visibleText = sanitizeCompanionSpeechText(String(ttsText || '')
      .replace(/\(breath\)<#[0-9.]+#>/gi, ''), { max: VOICE_MAX_CHARS })
      .replace(/\s+/g, ' ')
      .trim();
    try {
      const audio = await synthesizeVoice({
        text: stripTranslationMarks(ttsText),
        characterId,
        voiceProfileOverride,
        config: cfg,
      });
      out.push({
        text: visibleText || ttsText,
        translation: display.translation || '',
        emotion: speechPlan?.emotion || 'neutral',
        pace: speechPlan?.pace || 'normal',
        audioDataUrl: audio?.audioDataUrl || '',
        audioMimeType: audio?.mimeType || audio?.audioMimeType || '',
        audioCacheKey: audio?.cacheKey || '',
        audioFromCache: audio?.fromCache === true,
        ttsAttempts: 1,
      });
    } catch (err) {
      console.warn('[companion-output] tts segment failed', err?.message || err);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('companion-ai-error', {
          detail: {
            message: `语音合成失败：${err?.message || String(err || '')}`,
            kind: `${kind}-tts`,
            segmentIndex: index,
          },
        }));
      }
      out.push({ text: visibleText || ttsText, translation: display.translation || '', ttsError: err?.message || String(err || '') });
    }
  }
  return out.length ? out : displayBase;
}

export async function generateCompanionStandbyPack(session, ctx = {}) {
  const settings = ctx.settings || {};
  const character = await getCharacter(session.characterId).catch(() => null);
  if (!character) throw new Error('没有找到当前陪伴角色');
  const messages = await buildGenerationMessages({
    kind: 'standby',
    character,
    session,
    track: ctx.track || null,
    lyricWindow: ctx.lyricWindow || null,
    pageSnapshot: ctx.pageSnapshot || collectCurrentPageSnapshot(),
  });
  const standbyMaxTokens = await resolveGenerationMaxTokens();
  const requestOptions = { maxTokens: standbyMaxTokens, temperature: 0.9 };
  let raw = '';
  await chatWithPreferredStream(messages, (_delta, acc) => {
    raw = typeof acc === 'string' ? acc : `${raw}${String(_delta || '')}`;
  }, requestOptions);
  if (!String(raw || '').trim()) {
    throw new Error('未抽到可用正文，未自动改用非流式重试');
  }
  const obj = extractJsonObject(raw);
  const voices = normalizeVoiceParts(obj?.voices || obj?.segments || obj?.lines || [], 'standby', STANDBY_MAX_LINES);
  const fallback = splitVoiceTextToBubbles(normalizeVoiceText(obj?.voice || obj?.speech || obj?.say || raw), 'standby', STANDBY_MAX_LINES)
    .slice(0, STANDBY_MAX_LINES);
  const lineSegments = voices.length
    ? voices
    : fallback.map((text) => ({
      text,
      translation: '',
      emotion: 'neutral',
      pace: 'normal',
    }));
  const lines = lineSegments.map((item) => item.text).filter(Boolean);
  if (!lines.length) throw new Error('API 没有返回可用的待机台词');
  const voiceSegments = await buildVoiceSegments({
    voiceText: lines.join('\n'),
    sourceSegments: lineSegments,
    kind: 'standby',
    characterId: session.characterId,
    settings,
  });
  return {
    kind: 'standby',
    text: lines.join('\n'),
    bubbles: lines,
    voiceText: lines.join('\n'),
    voiceSegments,
    generatedAt: Date.now(),
  };
}

function dispatchBubble({ session, character, text, segments = [], audioDataUrl = '' }) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('companion_bubble', {
    detail: {
      sessionId: session.id,
      characterId: session.characterId,
      characterName: character?.name || character?.customNickname || '',
      text,
      segments,
      voiceSegments: segments,
      audioDataUrl,
      at: Date.now(),
    },
  }));
}

async function writeToChat({ session, character, text, translation = '' }) {
  const userId = session.userId;
  const characterId = session.characterId;
  const linkedChat = session.linkedChatId
    ? await import('../chat-store.js').then((m) => m.getChat(session.linkedChatId)).catch(() => null)
    : null;
  const linkedParticipants = Array.isArray(linkedChat?.participants)
    ? linkedChat.participants.map((item) => String(item || ''))
    : [];
  const linkedMatchesCharacter = linkedChat
    && String(linkedChat.userId || '') === String(userId || '')
    && linkedChat.type !== 'group'
    && linkedParticipants.includes('user')
    && linkedParticipants.includes(String(characterId || ''));
  const finalChat = linkedMatchesCharacter
    ? linkedChat
    : await ensurePrivateChat(userId, characterId, character?.name || '');
  const ts = Date.now();
  const msg = createMessage({
    id: genId(),
    chatId: finalChat.id,
    senderId: characterId,
    senderName: character?.customNickname || character?.name || '',
    type: 'text',
    content: text,
    timestamp: ts,
    metadata: {
      generatedBy: 'companion',
      companionSessionId: session.id,
      companionKind: 'chat',
      ...(translation ? { translation } : {}),
    },
  });
  await saveMessage(msg);
  await updateChatPreview(finalChat.id, text.slice(0, 60), ts).catch(() => {});
  return { chatId: finalChat.id, message: msg };
}

async function writeMusicPost({ session, character, text, translation = '', track }) {
  if (!track?.id) return null;
  const post = await saveMusicPost({
    id: genId('cmp_post'),
    characterId: session.characterId,
    authorId: session.characterId,
    authorName: character?.name || '',
    trackId: track.id,
    content: text,
    translation,
    mood: '陪伴',
    createdAt: Date.now(),
    visibility: 'square',
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('music-library-changed', { detail: { reason: 'companion-post' } }));
  }
  return post?.id || null;
}

/**
 * 把 intent 真正落地。
 * @param {object} session
 * @param {{kind:string}} intent
 * @param {{settings, track?, lyricWindow?}} ctx
 * @returns {Promise<{kind:string, text:string, trackId?:string, chatId?:string} | null>}
 */
export async function runCompanionOutput(session, intent, ctx = {}) {
  const settings = session?.type === 'sleep' || ['call', 'video'].includes(session?.windowStyle)
    ? { ...(ctx.settings || {}), allowSpeechTts: true }
    : (ctx.settings || {});
  const kind = intent.kind;
  const character = await getCharacter(session.characterId).catch(() => null);
  if (!character) throw new Error('没有找到当前陪伴角色');

  let text = '';
  let bubbles = [];
  let bubbleSegments = [];
  let voiceText = '';
  try {
    const reply = await generateShortLine({
      kind, character, session,
      track: ctx.track || null,
      lyricWindow: ctx.lyricWindow || null,
      settings,
      screenImageUrl: intent.screenImageUrl || ctx.screenImageUrl || '',
    });
    text = reply.text;
    bubbles = reply.bubbles || [];
    bubbleSegments = reply.bubbleSegments || bubbles.map((line) => ({ text: line, translation: '' }));
    voiceText = reply.voiceText || text;
  } catch (err) {
    console.warn('[companion-output] generate failed', err?.message || err);
    throw err;
  }
  if (!text) return null;
  if (typeof ctx.isSessionCurrent === 'function' && !(await ctx.isSessionCurrent())) return null;

  const voiceSegments = await buildVoiceSegments({
    voiceText,
    sourceSegments: bubbleSegments,
    kind,
    characterId: session.characterId,
    settings,
  });
  if (typeof ctx.isSessionCurrent === 'function' && !(await ctx.isSessionCurrent())) return null;
  const audioDataUrl = voiceSegments.find((item) => item.audioDataUrl)?.audioDataUrl || '';
  const out = {
    kind,
    text,
    bubbles: voiceSegments.length ? voiceSegments.map((item) => item.text).filter(Boolean) : bubbles,
    bubbleSegments: voiceSegments.map((item) => ({ text: item.text, translation: item.translation || '' })),
    voiceText,
    voiceSegments,
    trackId: ctx.track?.id || '',
    audioDataUrl,
    audioMimeType: voiceSegments.find((item) => item.audioMimeType)?.audioMimeType || '',
  };

  if (kind === 'speech') {
    if (settings.allowBubble !== false) dispatchBubble({ session, character, text, segments: voiceSegments, audioDataUrl });
  } else if (kind === 'bubble' || kind === 'screen_watch') {
    dispatchBubble({ session, character, text, segments: voiceSegments, audioDataUrl });
  } else if (kind === 'chat') {
    if (session.type === 'listen_together') {
      dispatchBubble({ session, character, text, segments: voiceSegments, audioDataUrl });
    } else {
      const written = await writeToChat({
        session,
        character,
        text,
        translation: voiceSegments.map((item) => item.translation || '').filter(Boolean).join('\n'),
      }).catch(() => null);
      out.chatId = written?.chatId || '';
      out.messages = written?.message ? [written.message] : [];
      if (settings.allowBubble !== false) {
        dispatchBubble({ session, character, text: `（发来一条消息）${text.slice(0, 24)}`, segments: voiceSegments, audioDataUrl });
      }
    }
  } else if (kind === 'music_post') {
    const postId = await writeMusicPost({
      session,
      character,
      text,
      translation: voiceSegments.map((item) => item.translation || '').filter(Boolean).join('\n'),
      track: ctx.track,
    });
    out.postId = postId;
    if (settings.allowBubble !== false) {
      dispatchBubble({ session, character, text: `（发了一条网抑云）${text.slice(0, 24)}`, segments: voiceSegments, audioDataUrl });
    }
  }

  return out;
}
