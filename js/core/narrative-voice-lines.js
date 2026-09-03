import { normalizeVoiceSpeechPlan } from './voice-tools.js';
import {
  buildVoiceWorldBookPrompt,
  VOICE_WORLD_BOOK_SURFACES,
} from './voice-worldbook.js';
import {
  acceptsDeclaredWetSound,
  prioritizeNarrationSoundCategories,
} from './sound-cues.js';

export const NARRATIVE_VOICE_LINES_START = '<<<VOICE_LINES>>>';
export const NARRATIVE_VOICE_LINES_END = '<<<END_VOICE_LINES>>>';
const NARRATIVE_SPEECH_TAG_RE = /<<<SPEECH\s+actorId\s*=\s*["']([^"'<>\s]+)["']\s*>>>([\s\S]*?)<<<END_SPEECH>>>/giu;

function cleanActorRows(actors = []) {
  return (Array.isArray(actors) ? actors : [])
    .map((actor) => ({
      id: String(actor?.id || '').trim(),
      name: String(actor?.name || actor?.id || '').trim(),
    }))
    .filter((actor) => actor.id && actor.id !== 'user' && actor.id !== 'system');
}

function parseJsonObject(raw = '') {
  const text = String(raw || '').trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
}

function normalizeAvailableSoundCategorySpecs(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map((item) => {
    if (item && typeof item === 'object') {
      return {
        id: String(item.id || '').trim(),
        label: String(item.label || item.id || '').trim(),
        hint: String(item.hint || '').trim(),
        mode: String(item.mode || '').trim(),
      };
    }
    const id = String(item || '').trim();
    return { id, label: id, hint: '', mode: '' };
  }).filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function buildNarrativeVoiceLinesInstruction(actors = [], {
  surface = VOICE_WORLD_BOOK_SURFACES.OFFLINE,
  provider = 'minimax',
  customText = '',
  worldBookEnabled = false,
  audioStage = false,
  availableSoundCategories = [],
} = {}) {
  const rows = cleanActorRows(actors);
  if (!rows.length) return '';
  const actorDirectory = rows.map((actor) => `${actor.id}=${actor.name}`).join('；');
  const worldBook = worldBookEnabled
    ? buildVoiceWorldBookPrompt(surface, { provider, customText })
    : '';
  const soundCategorySpecs = normalizeAvailableSoundCategorySpecs(availableSoundCategories);
  const soundCategories = soundCategorySpecs.map((item) => item.id);
  const soundCategorySet = new Set(soundCategories);
  const customSoundCategories = soundCategorySpecs
    .filter((item) => /^user_(?:cue|texture|background)_/u.test(item.id));
  const stageSoundInstruction = audioStage && soundCategorySpecs.length
    ? [
      `音声舞台实际可用音效分类：${soundCategorySpecs.map((item) => {
        const detail = [item.label !== item.id ? item.label : '', item.hint, item.mode ? `混音=${item.mode}` : '']
          .filter(Boolean).join('；');
        return detail ? `${item.id}（${detail}）` : item.id;
      }).join('、')}。`,
      '同一隐藏结构还要输出 stageSound：background 只填适合覆盖整幕循环播放的环境/BGM分类；cues 只标本轮正文中确实发生的可闻动作。anchor 必须逐字复制正文里一小段旁白，不得引用角色对白，不得为了音效补写动作。',
      customSoundCategories.length
        ? 'user_* 自定义分类是可直接执行的音效，不是说明文字。逐段写完正文后必须按每类触发说明复查：user_cue_* 在动作发生的对应 anchor 调用一次；user_texture_* 在动作已开始并持续到随后对白时写入 cues；user_background_* 在环境已经成立时写入 background。有匹配素材且事件成立却全部留空，视为隐藏协议遗漏。'
        : '',
      soundCategorySet.has('kiss') || soundCategorySet.has('wet')
        ? '内置分类边界固定：亲吻、轻啄、唇瓣贴合与分开只用 kiss，不得因为“湿润的吻”或唇间水声附带 wet；wet 只表示另一套非接吻的持续湿润动作纹理。两种动作都真实发生时才可同时返回。'
        : '',
      ['wet', 'body_movement', 'body_impact', 'fabric'].some((id) => soundCategorySet.has(id))
        ? '内置分类的主纹理优先级：已经成立的 wet、持续身体接触/拍打 body_movement / body_impact 优先，fabric 只作偶发伴随层。只有 anchor 同时明确写到衣物/床品与可闻的摩擦、窸窣或响动时才可标 fabric；名额不足先删 fabric。'
        : '',
      '持续纹理会附着到 anchor 后紧邻的角色对白：动作在说话期间仍持续时，把 anchor 放在该对白前，并保留实际匹配的 texture 分类；允许覆盖较长的一个自然对白气口。动作已经停止或分开则不要继续附着。',
      soundCategorySet.has('wet')
        ? 'wet 只在非接吻的持续亲密动作已经明确成立时使用，并可附着到随后较长的一段自然对白直到动作停止；单纯接吻始终只用 kiss。雨水、洗澡、湿头发、喝水等普通水声也一律不得标 wet。'
        : '',
      '只有确实没有任何当前分类满足触发条件时，stageSound 才全部返回空数组。',
    ].join('\n')
    : '';
  return [
    worldBook,
    audioStage ? [
      '【音声正文对白标记｜必须执行】',
      '正文仍写自然旁白；只有角色此刻真正说出口的每一段直接对白，必须用 <<<SPEECH actorId="角色ID">>> 与 <<<END_SPEECH>>> 包住。标记内可保留自然引号，例如：<<<SPEECH actorId="char_a">>>“我知道了。”<<<END_SPEECH>>>。',
      '普通引号绝不等于现场对白。回忆、转述、用户说过的话、心里浮现的句子、书名与术语引用都不得加 SPEECH 标记。没有标记的内容会全部按旁白处理，不会根据引号猜测。',
      '标记只用于机器识别，页面显示前会自动移除；不得把标记写进旁白、解释标记或改造标记名称。',
    ].join('\n') : '',
    '【隐藏角色语音轨｜只供 TTS，不属于可见正文】',
    `可用角色：${actorDirectory}`,
    `正文写完后追加下面结构。lines 只收录本轮正文中由角色真正说出口的直接引语，按出现顺序填写；${audioStage ? '每条必须与正文 SPEECH 标记一一对应，没有 SPEECH 标记的引语不得收录；' : ''}旁白、动作、心理、用户台词和翻译一律不收录。没有角色直接对白时 lines 必须为空数组。`,
    '每条 text 必须逐字复制正文里对应的角色原话，不得概括、补写或改词；actorId 必须来自上面的可用角色。',
    'speech.text 只能在 text 原文中插入少量隐藏呼吸/停顿提示，去掉提示后必须与 text 完全一致。emotion 使用 neutral|happy|sad|angry|fearful|surprised|disgusted，pace 使用 slow|normal|fast，intensity 使用 0～1；Fish 可额外填写简短英文 direction。',
    stageSoundInstruction,
    NARRATIVE_VOICE_LINES_START,
    audioStage
      ? '{"lines":[{"actorId":"角色ID","text":"正文中逐字出现的角色台词","speech":{"text":"可带隐藏提示的同一句台词","emotion":"neutral","pace":"normal","intensity":0.2,"direction":""}}],"stageSound":{"background":[],"cues":[{"anchor":"正文中逐字出现的旁白片段","categories":[]}]}}'
      : '{"lines":[{"actorId":"角色ID","text":"正文中逐字出现的角色台词","speech":{"text":"可带隐藏提示的同一句台词","emotion":"neutral","pace":"normal","intensity":0.2,"direction":""}}]}',
    NARRATIVE_VOICE_LINES_END,
  ].filter(Boolean).join('\n');
}

export function stripNarrativeVoiceLinesTail(raw = '') {
  const text = String(raw || '');
  const index = text.indexOf(NARRATIVE_VOICE_LINES_START);
  return index >= 0 ? text.slice(0, index) : text;
}

/** 展示层保底：无论标记是完整、重复还是流式到一半，都不把协议文字露给用户。 */
export function stripNarrativeSpeechTags(raw = '') {
  return String(raw || '')
    .replace(/<<<SPEECH\s+actorId\s*=\s*["'][^"'<>\s]+["']\s*>>>/giu, '')
    .replace(/<<<END_SPEECH>>>/giu, '')
    .replace(/<<<(?:SPEECH|END_SPEECH)?[^>\n]*$/giu, '');
}

function extractNarrativeSpeechTags(raw = '', actorMap = new Map()) {
  const source = String(raw || '');
  const speeches = [];
  let body = '';
  let cursor = 0;
  NARRATIVE_SPEECH_TAG_RE.lastIndex = 0;
  let match;
  while ((match = NARRATIVE_SPEECH_TAG_RE.exec(source))) {
    body += source.slice(cursor, match.index);
    const actorId = String(match[1] || '').trim();
    const marked = String(match[2] || '');
    const actor = actorMap.get(actorId);
    const normalized = normalizeDialogueText(marked);
    const markedStart = body.length;
    body += marked;
    if (actor && normalized) {
      const localStart = Math.max(0, marked.indexOf(normalized));
      speeches.push({
        actorId,
        actorName: actor.name,
        text: normalized,
        sourceStart: markedStart + localStart,
      });
    }
    cursor = NARRATIVE_SPEECH_TAG_RE.lastIndex;
  }
  body += source.slice(cursor);
  return { body: stripNarrativeSpeechTags(body).trim(), speeches };
}

function normalizeDialogueText(value = '') {
  return String(value || '')
    .replace(/^[\s“”‘’「」『』"\[\]［］]+|[\s“”‘’「」『』"\[\]［］]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

const BRACKET_STAGE_LABEL_RE = /^(?:旁白|动作|场景|环境|镜头|转场|独白|心声|内心|状态|提示|说明|选项|选择|台词|对白|对话(?:内容)?|音效|环境音|背景音|声音|配乐|音乐|bgm|sfx|雨声|水声|风声|雷声|脚步声?|敲门声?|开门声?|关门声?|呼吸声?|喘息声?|笑声|哭声|衣料声?|摩擦声?|亲吻声?)\s*[：:]?$/iu;

function isBracketDialogueCandidate(value = '') {
  const text = String(value || '').trim();
  if (!text || BRACKET_STAGE_LABEL_RE.test(text)) return false;
  if (/^(?:https?:\/\/|\{[\s\S]*\}|[A-Z_]{3,})$/u.test(text)) return false;
  return /[\p{L}\p{N}\u3400-\u9fff\u3040-\u30ff]/u.test(text);
}

/**
 * 提取正文里的可见对白包络。除成对引号外，也兼容模型偶发输出的「角色：台词」行、
 * 跨行/长对白以及流式阶段尚未闭合的末尾引号，避免舞台解析时整段退化为旁白。
 */
export function extractNarrativeDialogueSpans(raw = '', {
  actors = [],
  allowBracketDialogue = false,
} = {}) {
  const body = String(raw || '');
  const spans = [];
  const closingByOpening = { '“': '”', '「': '」', '『': '』', '"': '"' };
  for (let index = 0; index < body.length; index += 1) {
    const opening = body[index];
    const closing = closingByOpening[opening];
    if (!closing) continue;
    const closingIndex = body.indexOf(closing, index + 1);
    // 若闭合前又出现同类左引号，当前这个左引号是协议剥离/流式截断留下的
    // 孤立残片。跳过它，让后一个左引号与自己的右引号正常配对。
    const nestedOpeningIndex = opening === '"' ? -1 : body.indexOf(opening, index + 1);
    if (nestedOpeningIndex >= 0 && (closingIndex < 0 || nestedOpeningIndex < closingIndex)) continue;
    const envelopeEnd = closingIndex >= 0 ? closingIndex + 1 : body.length;
    const rawText = body.slice(index + 1, closingIndex >= 0 ? closingIndex : body.length);
    const leading = rawText.search(/\S/u);
    if (leading < 0) continue;
    const trailing = rawText.length - rawText.trimEnd().length;
    const text = rawText.trim();
    if (!text) continue;
    spans.push({
      text,
      start: index + 1 + leading,
      end: (closingIndex >= 0 ? closingIndex : body.length) - trailing,
      envelopeStart: index,
      envelopeEnd,
      closed: closingIndex >= 0,
    });
    index = Math.max(index, envelopeEnd - 1);
  }

  if (allowBracketDialogue) {
    const bracketPattern = /[\[［]([^\]］\n]{1,700})[\]］]/gu;
    for (const match of body.matchAll(bracketPattern)) {
      const whole = String(match[0] || '');
      const rawText = String(match[1] || '');
      const text = normalizeDialogueText(rawText);
      const envelopeStart = Number(match.index || 0);
      const envelopeEnd = envelopeStart + whole.length;
      if (!text || !isBracketDialogueCandidate(text)) continue;
      if (body.slice(envelopeEnd).trimStart().startsWith('(')) continue;
      if (spans.some((span) => envelopeStart < span.envelopeEnd && envelopeEnd > span.envelopeStart)) continue;
      const leading = rawText.search(/\S/u);
      const trailing = rawText.length - rawText.trimEnd().length;
      spans.push({
        text,
        start: envelopeStart + 1 + Math.max(0, leading),
        end: envelopeEnd - 1 - trailing,
        envelopeStart,
        envelopeEnd,
        closed: true,
        bracketed: true,
      });
    }
  }

  const actorNames = new Set(cleanActorRows(actors).map((actor) => actor.name));
  if (actorNames.size) {
    const linePattern = /(^|\n)([^\n]{1,700})/gu;
    for (const match of body.matchAll(linePattern)) {
      const line = String(match[2] || '');
      const labelled = line.match(/^\s*(?:[-*>]\s*)?(?:【([^】\n]{1,24})】|([\p{L}][\p{L}\p{N}_· ]{0,23}))\s*[：:]\s*(.+?)\s*$/u);
      if (!labelled) continue;
      const actorName = String(labelled[1] || labelled[2] || '').trim();
      if (!actorNames.has(actorName)) continue;
      const rawText = String(labelled[3] || '');
      const text = normalizeDialogueText(rawText);
      if (!text) continue;
      const textOffset = line.indexOf(text);
      if (textOffset < 0) continue;
      const lineStart = Number(match.index || 0) + String(match[1] || '').length;
      const start = lineStart + textOffset;
      const end = start + text.length;
      if (spans.some((span) => start < span.envelopeEnd && end > span.envelopeStart)) continue;
      spans.push({
        text,
        actorName,
        start,
        end,
        envelopeStart: lineStart,
        envelopeEnd: lineStart + line.length,
        closed: true,
        labelled: true,
      });
    }
  }
  return spans.sort((left, right) => left.envelopeStart - right.envelopeStart);
}

/**
 * 音声协议降级：只有独占一行的完整引号段才可在缺少 SPEECH 标记时视为对白。
 * 这样能救回模型漏标的真实台词，同时不会把旁白里的回忆、转述或术语引用误读。
 */
export function isStandaloneNarrativeDialogueSpan(raw = '', span = {}) {
  const body = String(raw || '');
  const envelopeStart = Number(span?.envelopeStart);
  const envelopeEnd = Number(span?.envelopeEnd);
  if (!Number.isFinite(envelopeStart) || !Number.isFinite(envelopeEnd)
    || envelopeStart < 0 || envelopeEnd <= envelopeStart || envelopeEnd > body.length) return false;
  const lineStart = body.lastIndexOf('\n', Math.max(0, envelopeStart - 1)) + 1;
  const nextBreak = body.indexOf('\n', envelopeEnd);
  const lineEnd = nextBreak >= 0 ? nextBreak : body.length;
  if (body.slice(lineStart, envelopeStart).trim()) return false;
  const suffix = body.slice(envelopeEnd, lineEnd).trim();
  return !suffix || /^〔[^〕\n]{1,260}〕$/u.test(suffix);
}

/**
 * 把候选音轨严格对齐到最终可见正文里的直接对白。
 * 不允许退回整份模型原始输出搜索：那里可能仍含心声、状态数字和其它隐藏协议，
 * 一旦命中就会出现“前台已剥离，后台却拿去合成”的隐形误读。
 */
export function alignNarrativeVoiceLinesToDialogueSpans(raw = '', inputLines = [], {
  actors = [],
  withLocations = false,
  allowBracketDialogue = false,
} = {}) {
  const body = String(raw || '');
  const rows = cleanActorRows(actors);
  const lineActors = (Array.isArray(inputLines) ? inputLines : [])
    .map((line) => ({
      id: String(line?.actorId || '').trim(),
      name: String(line?.actorName || '').trim(),
    }))
    .filter((actor) => actor.id && actor.name);
  const actorDirectory = rows.length ? rows : lineActors;
  const spans = extractNarrativeDialogueSpans(body, {
    actors: actorDirectory,
    allowBracketDialogue,
  });
  const usedSpanIndexes = new Set();
  const aligned = [];
  for (const line of Array.isArray(inputLines) ? inputLines : []) {
    const rawText = String(line?.text || '').trim();
    const normalized = normalizeDialogueText(rawText);
    if (!normalized) continue;
    const matchingSpanIndexes = spans
      .map((span, index) => ({ span, index }))
      .filter(({ span, index }) => (
        !usedSpanIndexes.has(index)
        && normalizeDialogueText(span.text) === normalized
      ));
    const sourceHint = Number(line?.sourceStart);
    if (Number.isFinite(sourceHint)) {
      matchingSpanIndexes.sort((left, right) => (
        Math.abs(left.span.start - sourceHint) - Math.abs(right.span.start - sourceHint)
      ));
    }
    const matched = matchingSpanIndexes[0] || null;
    let span = matched?.span || null;
    if (!span && line?.explicitSpeech === true) {
      const start = body.indexOf(normalized, Number.isFinite(sourceHint) ? Math.max(0, sourceHint - 3) : 0);
      if (start >= 0) {
        span = {
          text: normalized,
          start,
          end: start + normalized.length,
          envelopeStart: start,
          envelopeEnd: start + normalized.length,
          closed: true,
          explicitlyMarked: true,
        };
      }
    }
    if (!span) continue;
    const speechPlan = normalizeVoiceSpeechPlan(
      line?.speechPlan && typeof line.speechPlan === 'object'
        ? line.speechPlan
        : { text: rawText },
      span.text,
    );
    if (!speechPlan) continue;
    if (matched) usedSpanIndexes.add(matched.index);
    aligned.push({
      ...line,
      text: span.text,
      speechPlan,
      ...(withLocations ? {
        sourceStart: span.start,
        start: span.start,
        end: span.end,
        envelopeStart: span.envelopeStart,
        envelopeEnd: span.envelopeEnd,
      } : {}),
    });
  }
  return aligned.sort((left, right) => (
    Number(left?.sourceStart || 0) - Number(right?.sourceStart || 0)
  ));
}

export function extractNarrativeVoiceLines(raw = '', {
  actors = [],
  availableSoundCategories = [],
  fallbackQuotedDialogue = false,
  requireSpeechTags = false,
} = {}) {
  const source = String(raw || '');
  const rows = cleanActorRows(actors);
  const actorMap = new Map(rows.map((actor) => [actor.id, actor]));
  const pattern = new RegExp(
    `${NARRATIVE_VOICE_LINES_START}\\s*([\\s\\S]*?)\\s*${NARRATIVE_VOICE_LINES_END}`,
    'gi',
  );
  const matches = [...source.matchAll(pattern)];
  // 兼容模型偶发把完整隐藏轨重复输出两次：所有隐藏块都必须从可见正文剥离，
  // 只采用第一份可解析结构。否则第二块 JSON 里的引号文本会被单角色兜底当成
  // 又一组可见对白，造成四句对白实际发出八次 TTS 请求。
  const visibleSource = stripNarrativeVoiceLinesTail(source.replace(pattern, '')).trim();
  const tagged = extractNarrativeSpeechTags(visibleSource, actorMap);
  const body = tagged.body;
  const parsed = matches
    .map((entry) => parseJsonObject(entry[1]))
    .find((entry) => entry && typeof entry === 'object') || null;
  const allowBracketDialogue = fallbackQuotedDialogue && rows.length === 1;
  const dialogueSpans = extractNarrativeDialogueSpans(body, {
    actors: rows,
    allowBracketDialogue,
  });
  const parsedCandidates = (Array.isArray(parsed?.lines) ? parsed.lines : [])
    .slice(0, 8)
    .map((row) => {
      const actorId = String(row?.actorId || row?.actor || '').trim();
      const actor = actorMap.get(actorId);
      const text = String(row?.text || '').trim();
      if (!actor || !text) return null;
      return {
        actorId,
        actorName: actor.name,
        text,
        speechPlan: row?.speech && typeof row.speech === 'object' ? row.speech : { text },
      };
    })
    .filter(Boolean);
  const lineEntries = [];
  const usedParsedIndexes = new Set();
  if (tagged.speeches.length) {
    tagged.speeches.slice(0, 8).forEach((speech) => {
      const parsedIndex = parsedCandidates.findIndex((candidate, index) => (
        !usedParsedIndexes.has(index)
        && candidate.actorId === speech.actorId
        && normalizeDialogueText(candidate.text) === speech.text
      ));
      const parsedLine = parsedIndex >= 0 ? parsedCandidates[parsedIndex] : null;
      if (parsedIndex >= 0) usedParsedIndexes.add(parsedIndex);
      const speechPlan = normalizeVoiceSpeechPlan(parsedLine?.speechPlan || { text: speech.text }, speech.text);
      if (!speechPlan) return;
      lineEntries.push({
        sourceStart: speech.sourceStart,
        line: {
          ...(parsedLine || {}),
          actorId: speech.actorId,
          actorName: speech.actorName,
          text: speech.text,
          speechPlan,
          sourceStart: speech.sourceStart,
          explicitSpeech: true,
        },
      });
    });
    // 部分模型在长幕里只给前几句补 SPEECH 标记，却仍会把其余真实对白
    // 正确写进隐藏 lines。不能因为已经识别到一条标记，就把剩余精确匹配的
    // 音轨全部丢掉；严格模式下仍只接受独占一行的对白，避免朗读旁白内引用。
    const claimedSourceStarts = new Set(lineEntries.map((entry) => entry.sourceStart));
    alignNarrativeVoiceLinesToDialogueSpans(body, parsedCandidates, {
      actors: rows,
      withLocations: true,
      allowBracketDialogue,
    }).filter((line) => (
      (!requireSpeechTags || isStandaloneNarrativeDialogueSpan(body, line))
      && !claimedSourceStarts.has(line.sourceStart)
    )).forEach(({ sourceStart, start: _start, end: _end, envelopeStart: _envelopeStart, envelopeEnd: _envelopeEnd, ...line }) => {
      claimedSourceStarts.add(sourceStart);
      lineEntries.push({ sourceStart, line });
    });
  } else {
    const alignedCandidates = alignNarrativeVoiceLinesToDialogueSpans(body, parsedCandidates, {
      actors: rows,
      withLocations: true,
      allowBracketDialogue,
    }).filter((line) => (
      !requireSpeechTags || isStandaloneNarrativeDialogueSpan(body, line)
    ));
    alignedCandidates.forEach(({ sourceStart, start: _start, end: _end, envelopeStart: _envelopeStart, envelopeEnd: _envelopeEnd, ...line }) => {
      lineEntries.push({ sourceStart, line });
    });
  }
  // 单角色音声可安全恢复模型完全漏标的独立对白行。严格模式只放行独占
  // 一行的完整引号段；嵌在旁白里的回忆、转述与术语引用仍保持静音。
  if (fallbackQuotedDialogue && rows.length === 1) {
    const usedSourceStarts = new Set(lineEntries.map((entry) => entry.sourceStart));
    for (const span of dialogueSpans) {
      const text = String(span.text || '').trim();
      if (!text
        || usedSourceStarts.has(span.start)
        || lineEntries.length >= 8
        || (requireSpeechTags && !isStandaloneNarrativeDialogueSpan(body, span))) continue;
      const speechPlan = normalizeVoiceSpeechPlan({ text }, text);
      if (!speechPlan) continue;
      usedSourceStarts.add(span.start);
      lineEntries.push({
        sourceStart: span.start,
        line: {
          actorId: rows[0].id,
          actorName: rows[0].name,
          text,
          speechPlan,
        },
      });
    }
  }
  const lines = lineEntries
    .sort((left, right) => left.sourceStart - right.sourceStart)
    .map((entry) => entry.line);
  const allowedSounds = new Set(normalizeAvailableSoundCategorySpecs(availableSoundCategories)
    .map((category) => category.id));
  const background = [...new Set((Array.isArray(parsed?.stageSound?.background)
    ? parsed.stageSound.background
    : [])
    .map((category) => String(category || '').trim())
    .filter((category) => (
      allowedSounds.has(category)
      && (/^(?:bgm|ambience_)/u.test(category) || /^user_background_/u.test(category))
    )))]
    .slice(0, 2);
  const cues = (Array.isArray(parsed?.stageSound?.cues) ? parsed.stageSound.cues : [])
    .slice(0, 8)
    .map((cue) => {
      const anchor = String(cue?.anchor || '').trim();
      if (!anchor || !body.includes(anchor)) return null;
      const categories = prioritizeNarrationSoundCategories((Array.isArray(cue?.categories) ? cue.categories : [])
        .map((category) => String(category || '').trim())
        .filter((category) => allowedSounds.has(category))
        .filter((category) => category !== 'wet' || acceptsDeclaredWetSound(anchor)), { max: 3 });
      return categories.length ? { anchor, categories } : null;
    })
    .filter(Boolean);
  return { body, lines, stageSound: { background, cues } };
}
