import { chatJsonGeneration } from './chat-json-generation.js';

function clean(value = '', max = 12000) {
  return String(value || '').trim().slice(0, max);
}

export async function runNarrativeExpertConsultation({
  sampleText = '',
  referenceContext = '',
  preserveFlavor = '',
  introduceFlavor = '',
  consultantLabel = '',
  configOverride = null,
  signal = null,
  onProgress = null,
} = {}) {
  const source = clean(sampleText);
  if (!source) throw new Error('没有可供会诊的原稿');
  if (!configOverride) throw new Error('请选择一个已保存的会诊 API 档位');
  const preserve = clean(preserveFlavor, 500);
  const introduce = clean(introduceFlavor, 500);
  if (!preserve || !introduce) throw new Error('请分别写明想保留和想引入的特点');

  const systemPrompt = [
    '【专家会诊 · 测试中】',
    '你是接手当前文本的跨模型叙事主笔。请在同一次调用里完成必要的内部审阅，并直接写出一版可以替换原稿的完整成稿；不要把修改任务转交给下一位模型，不模仿用户，也不输出思维链。',
    '逐段定位原稿的问题与可保留之处。区分人物事实、关系权限、剧情推进、情感浓度、对白口吻、心理细腻度、叙事节奏和句法风味；不得根据模型品牌刻板推断优缺点，只以用户偏好和实际文本为证据。',
    '改写必须守住既有事实、人物关系和用户权限，把两种优点融合进同一人物，而不是折中成平淡平均值。直接落实到动作、对白、心理、信息密度与节奏中；不要只写“更细腻、更自然、加强情感”等空话。',
    // 调用方传入的是与实际生成共用、已经按上下文预算筛选过的材料。
    // 这里不能再用很小的字符上限二次腰斩，否则世界书、预设或近期关系记录
    // 可能恰好落在截断线后，导致“专家”只看见原稿却没读到病历。
    referenceContext ? `人物、关系与已发生事实（只用于校验，不续写）：\n${clean(referenceContext, 120000)}` : '',
    '新稿应与原稿承担同一轮叙事功能和大致篇幅。禁止在新稿里提及会诊、模型品牌、审稿过程或修改说明。',
    '只输出严格 JSON：{"diagnosis":"给用户看的简短修改说明","preserve":["实际保留的具体优点或事实"],"repair":["本次已经修复的具体问题"],"rewrite":"可直接采用的完整替代正文"}',
  ].filter(Boolean).join('\n\n');
  const userPrompt = [
    `会诊模型档位：${clean(consultantLabel, 100) || '用户所选档位'}`,
    `用户希望保留：${preserve}`,
    `用户希望引入：${introduce}`,
    `当前原稿（待生成替代版本）：\n${source}`,
  ].filter(Boolean).join('\n\n');

  const result = await chatJsonGeneration({
    scope: 'narrative-expert-consultation',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    signal,
    onProgress,
    requestOptions: { configOverride },
    validate: (data) => (
      data && typeof data === 'object'
      && typeof data.diagnosis === 'string'
      && Array.isArray(data.preserve)
      && Array.isArray(data.repair)
      && typeof data.rewrite === 'string'
      && data.rewrite.trim().length >= 20
    ),
  });
  return {
    diagnosis: clean(result.data.diagnosis, 1200),
    preserve: result.data.preserve.map((row) => clean(row, 500)).filter(Boolean).slice(0, 10),
    repair: result.data.repair.map((row) => clean(row, 500)).filter(Boolean).slice(0, 12),
    rewrite: clean(result.data.rewrite, 60000),
  };
}
