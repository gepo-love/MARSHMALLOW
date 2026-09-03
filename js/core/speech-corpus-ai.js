import { chatJsonGeneration } from './chat-json-generation.js';
import { isCharacterAiAvailable } from './character-ai-fill.js';
import {
  buildWorldBookContextBlock,
  normalizeWorldBookIds,
} from './world-book-store.js';
import {
  assessSpeechCorpusGuideDraft,
  normalizeSpeechCorpusGuideDraft,
} from './speech-corpus-guide.js';
import { normalizeTranslationProfile } from '../models/character.js';

function clean(value = '', max = 0) {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function compactCharacterSource(character = {}) {
  const translation = normalizeTranslationProfile(character.translationProfile);
  return {
    角色名: clean(character.name || character.realName, 120),
    身份与状态: clean([
      character.currentRole,
      character.currentStatus,
      character.userRelationStatus,
    ].filter(Boolean).join('；')),
    性格底色: clean(character.personality),
    说话风格: clean(character.speechStyle),
    语言模式: translation.mode,
    主要语言: clean(translation.language, 80),
    混合语言说明: clean(translation.dialectNote, 160),
    整段设定: clean(character.promptCorpus),
    已有语料: clean(character.speechCorpus),
  };
}

export function buildSpeechCorpusLanguageGuidance(character = {}) {
  const profile = normalizeTranslationProfile(character.translationProfile);
  const language = clean(profile.language, 80) || '角色资料明确的主要外语或方言';
  if (profile.mode === 'full') {
    return [
      `10. 该角色的语言模式是“全外语 / 方言”，主要使用${language}。examples 与 sequences 中每一句拟写台词都必须直接使用${language}，不能先写成中文，也不要在同一句后附中文翻译。`,
      '11. rhythm、emotion、situations、humor 可以用简体中文说明行为规律，方便用户编辑；但这些字段中凡是出现角色原话、口头禅或示例引号，原话仍必须使用上述主要语言。',
      '12. 工作台旧内容若含与当前语言模式冲突的中文拟写台词，应改写成主要语言；“保留已有内容”不能覆盖本条语言要求。',
    ].join('\n');
  }
  if (profile.mode === 'mixed') {
    const mixed = clean(profile.dialectNote, 160) || language;
    return [
      `10. 该角色的语言模式是“中文为主、偶尔混用”，混用习惯为：${mixed}。examples 与 sequences 应按这个比例自然拟写，不要全部写成中文，也不要擅自改成全外语。`,
      '11. 不要为每句混用台词追加括号翻译；保留角色真实的语码切换、口头词和标点习惯。',
    ].join('\n');
  }
  return '10. 角色没有开启外语模式；台词语言服从角色资料与已有语料，不要仅凭外文姓名擅自改成外语。';
}

export function buildSpeechCorpusDraftPrompt({
  character = {},
  currentDraft = {},
  worldBookContext = '',
} = {}) {
  const source = compactCharacterSource(character);
  const normalizedDraft = normalizeSpeechCorpusGuideDraft(currentDraft);
  return [
    '【背景】',
    '你正在协助用户整理一个聊天角色的行为语料。请从已有资料中提炼稳定口吻、断句习惯和不同情境下的反应方式，生成一份供用户继续手改的草稿。',
    '',
    '【角色资料】',
    JSON.stringify(source),
    '',
    '【工作台现有内容】',
    JSON.stringify(normalizedDraft),
    '',
    worldBookContext ? `【本次参考的世界书】\n${clean(worldBookContext, 30000)}` : '【本次参考的世界书】\n（没有命中可用条目）',
    '',
    '【整理要求】',
    '1. 优先写“遇到什么情况会怎么做、怎么说”，用肯定、可执行的行为描述；不要把禁词表当作主体。',
    '2. rhythm 写句长、分条发送、停顿、标点、语气词等稳定节奏。以“日常通常一句或一个完整气口一条”为基线，再根据资料判断该角色是否偏长串口语、书面长句、连续分析，以及句号、省略号、空格或不用标点等习惯；明确即时反应、解释、补充、改口或情绪加码何时会另起一条。',
    '3. emotion 写情绪阈值和表达分寸；不要把角色写得动辄暴怒、震惊或失控，除非资料明确如此。',
    '4. situations 每行使用“情境 → 反应”格式，至少 4 行；覆盖被调侃、对方低落、产生分歧、遇到陌生梗等资料支持的情境。',
    '5. humor 写接梗、玩笑、反击与不懂梗时的处理方式。',
    '6. examples 每行一句可供用户修改的拟写台词，保留自然断句和标点。资料没有原话时也可以拟写，但不要宣称它们是角色真实原话。',
    '7. sequences 写同一轮的连续气泡样本：每行是一次可独立发送的完整气口，同一组连续写，不同回合用空行分隔。优先展示角色真实的“反应 → 解释/补充 → 改口或情绪落点”发送边界；深谈、书面表达和紧密因果仍按完整逻辑段落保留。',
    '8. 不编造资料未支持的身份、经历、关系进展、专属称呼或重大事实。世界书与角色资料冲突时，以明确的角色专属规则为准。',
    '9. 已有工作台内容若具体有效就保留并润色，不要为了改写而丢失信息。',
    buildSpeechCorpusLanguageGuidance(character),
    '',
    '【输出】',
    '只输出一个严格合法的 JSON 对象，不要解释，不要 Markdown。必须包含以下字符串字段：',
    '{"rhythm":"","emotion":"","situations":"","humor":"","examples":"","sequences":""}',
  ].join('\n');
}

function isValidDraftPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['rhythm', 'emotion', 'situations', 'humor', 'examples', 'sequences'];
  return keys.every((key) => typeof value[key] === 'string')
    && keys.some((key) => value[key].trim());
}

export async function draftSpeechCorpusWithAi({
  character = {},
  user = null,
  worldBookIds = [],
  currentDraft = {},
  onProgress,
  signal,
} = {}) {
  if (!(await isCharacterAiAvailable())) {
    const error = new Error('请先在设置中配置聊天或工具 API');
    error.code = 'api-not-configured';
    throw error;
  }

  const selectedBookIds = normalizeWorldBookIds(worldBookIds);
  const characterId = clean(character.id, 160);
  const selectiveText = [
    character.name,
    character.realName,
    character.personality,
    character.speechStyle,
    character.promptCorpus,
    character.speechCorpus,
    character.translationProfile?.mode,
    character.translationProfile?.language,
    character.translationProfile?.dialectNote,
    ...Object.values(normalizeSpeechCorpusGuideDraft(currentDraft)),
  ].filter(Boolean).join('\n');

  onProgress?.('正在读取角色资料与世界书…');
  const worldBookContext = await buildWorldBookContextBlock(user, selectiveText, {
    characterIds: characterId ? [characterId] : [],
    worldBookMode: selectedBookIds.length ? 'full' : 'selective',
    ...(selectedBookIds.length ? { onlyBookIds: selectedBookIds } : {}),
  });

  onProgress?.('正在起草可编辑语料…');
  const result = await chatJsonGeneration({
    scope: 'speech-corpus-ai',
    task: 'characterFill',
    messages: [{
      role: 'system',
      content: buildSpeechCorpusDraftPrompt({
        character,
        currentDraft,
        worldBookContext,
      }),
    }, {
      role: 'user',
      content: '请按上述完整角色与世界书设定起草可编辑的语料 JSON。',
    }],
    temperature: 0.45,
    validate: isValidDraftPayload,
    onProgress,
    signal,
  });

  const draft = normalizeSpeechCorpusGuideDraft(result.data);
  if (!assessSpeechCorpusGuideDraft(draft).ready) {
    const error = new Error('AI 草稿信息太少，请补充角色设定或换一本口吻规则世界书后再试');
    error.code = 'speech-corpus-draft-too-thin';
    error.rawText = result.raw;
    throw error;
  }
  return {
    draft,
    usedWorldBookMode: selectedBookIds.length ? 'selected' : 'bound',
    selectedBookCount: selectedBookIds.length,
    usedWorldBookContext: !!worldBookContext,
  };
}
