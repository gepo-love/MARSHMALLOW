const GUIDE_START = '<行为语料>';
const GUIDE_END = '</行为语料>';

const GUIDE_SECTIONS = [
  ['rhythm', '节奏与标点'],
  ['emotion', '情绪与分寸'],
  ['situations', '情境反应'],
  ['humor', '梗与玩笑'],
  ['examples', '台词样本'],
  ['sequences', '连续气泡样本'],
];

function clean(value = '', max = 1600) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 线下叙事只学习角色的口吻、标点和情境反应，不读取线上发送容器。
 * 连续气泡样本属于 msg 边界示范，带进线下会与“只输出叙事正文”冲突。
 */
export function speechCorpusForSurface(value = '', surface = 'online') {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!text || surface !== 'offline') return text;
  return text
    .replace(
      /(?:^|\n)连续气泡样本中，同一回合的每一行都是一次真实发送边界；生成时用多个 msg 依次发送，不得合并回一个 body。\s*/g,
      '\n',
    )
    .replace(
      /(?:^|\n)【连续气泡样本】[\s\S]*?(?=\n【[^】\n]+】|\n<\/行为语料>|$)/g,
      '\n',
    )
    .replace(
      /<行为语料>\s*按当前情境选择匹配样本，学习句长、断句、标点与反应方式；不要照抄样本事件。\s*<\/行为语料>/g,
      '',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeSpeechCorpusGuideDraft(raw = {}) {
  return {
    rhythm: clean(raw.rhythm, 500),
    emotion: clean(raw.emotion, 500),
    situations: clean(raw.situations, 1200),
    humor: clean(raw.humor, 500),
    examples: clean(raw.examples, 1600),
    sequences: clean(raw.sequences, 2400),
  };
}

function usefulConditionCount(value = '') {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const parts = line.split(/\s*(?:→|->|=>|：)\s*/, 2);
      return parts.length === 2 && parts[0].length >= 2 && parts[1].length >= 4;
    }).length;
}

function usefulExampleCount(value = '') {
  return String(value || '')
    .split('\n')
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter((line) => line.length >= 4)
    .length;
}

function usefulSequenceGroupCount(value = '') {
  return String(value || '')
    .split(/\n\s*\n+/)
    .map((group) => group.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length >= 2)
    .length;
}

export function assessSpeechCorpusGuideDraft(raw = {}) {
  const draft = normalizeSpeechCorpusGuideDraft(raw);
  const situationCount = usefulConditionCount(draft.situations);
  const exampleCount = usefulExampleCount(draft.examples);
  const sequenceGroupCount = usefulSequenceGroupCount(draft.sequences);
  const detailedFields = [
    draft.rhythm.length >= 8,
    draft.emotion.length >= 8,
    draft.humor.length >= 8,
    situationCount >= 1,
    exampleCount >= 2,
    sequenceGroupCount >= 1,
  ].filter(Boolean).length;
  return {
    ready: detailedFields >= 1,
    detailedFields,
    situationCount,
    exampleCount,
    sequenceGroupCount,
    question: detailedFields
      ? ''
      : '至少写清一种“什么情况下 → 会怎么做或怎么说”，贴两句台词，或填写一组连续气泡。',
  };
}

function normalizeConditionLines(value = '') {
  return clean(value, 1200)
    .split('\n')
    .map((line) => line.trim().replace(/\s*(?:->|=>)\s*/, ' → '))
    .filter(Boolean)
    .map((line) => (/^[-•]/.test(line) ? line : `- ${line}`))
    .join('\n');
}

function normalizeExampleLines(value = '') {
  return clean(value, 1600)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^[-•]/.test(line) ? line : `- ${line}`))
    .join('\n');
}

function normalizeSequenceGroups(value = '') {
  const groups = clean(value, 2400)
    .split(/\n\s*\n+/)
    .map((group) => group
      .split('\n')
      .map((line) => line.replace(/^[-•]\s*/, '').trim())
      .filter(Boolean))
    .filter((lines) => lines.length);
  return groups.map((lines, index) => [
    `〔样本回合 ${index + 1}〕`,
    ...lines.map((line) => `- ${line}`),
  ].join('\n')).join('\n\n');
}

export function buildSpeechCorpusGuideBlock(raw = {}) {
  const draft = normalizeSpeechCorpusGuideDraft(raw);
  const rows = [];
  if (draft.rhythm) rows.push(`【节奏与标点】\n${draft.rhythm}`);
  if (draft.emotion) rows.push(`【情绪与分寸】\n${draft.emotion}`);
  if (draft.situations) rows.push(`【情境反应】\n${normalizeConditionLines(draft.situations)}`);
  if (draft.humor) rows.push(`【梗与玩笑】\n${draft.humor}`);
  if (draft.examples) rows.push(`【台词样本】\n${normalizeExampleLines(draft.examples)}`);
  if (draft.sequences) rows.push(`【连续气泡样本】\n${normalizeSequenceGroups(draft.sequences)}`);
  if (!rows.length) return '';
  return [
    GUIDE_START,
    '按当前情境选择匹配样本，学习句长、断句、标点与反应方式；不要照抄样本事件。',
    '连续气泡样本中，同一回合的每一行都是一次真实发送边界；生成时用多个 msg 依次发送，不得合并回一个 body。',
    ...rows,
    GUIDE_END,
  ].join('\n');
}

export function replaceSpeechCorpusGuideBlock(existing = '', raw = {}) {
  const current = clean(existing, 20000);
  const block = buildSpeechCorpusGuideBlock(raw);
  if (!block) return current;
  const pattern = new RegExp(
    `${escapeRegExp(GUIDE_START)}[\\s\\S]*?${escapeRegExp(GUIDE_END)}`,
    'i',
  );
  if (pattern.test(current)) return current.replace(pattern, block).trim();
  return [block, current].filter(Boolean).join('\n\n').trim();
}

export function parseSpeechCorpusGuideBlock(existing = '') {
  const text = clean(existing, 20000);
  const match = text.match(new RegExp(
    `${escapeRegExp(GUIDE_START)}([\\s\\S]*?)${escapeRegExp(GUIDE_END)}`,
    'i',
  ));
  if (!match) return normalizeSpeechCorpusGuideDraft();
  const body = String(match[1] || '');
  const result = {};
  const headingPattern = [
    ...GUIDE_SECTIONS.map(([, label]) => label),
    '原话样本',
  ].map(escapeRegExp).join('|');
  GUIDE_SECTIONS.forEach(([key, label]) => {
    const labels = key === 'examples' ? [label, '原话样本'] : [label];
    const section = body.match(new RegExp(
      `【(?:${labels.map(escapeRegExp).join('|')})】\\s*([\\s\\S]*?)(?=【(?:${headingPattern})】|$)`,
    ));
    let value = String(section?.[1] || '').trim();
    if (key === 'situations' || key === 'examples') {
      value = value.replace(/^[-•]\s*/gm, '').trim();
    }
    if (key === 'sequences') {
      value = value
        .replace(/^〔样本回合\s*\d+〕\s*$/gm, '')
        .replace(/^[-•]\s*/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    result[key] = value;
  });
  return normalizeSpeechCorpusGuideDraft(result);
}

export function hasSpeechCorpusGuideBlock(existing = '') {
  const text = String(existing || '');
  return text.includes(GUIDE_START) && text.includes(GUIDE_END);
}
