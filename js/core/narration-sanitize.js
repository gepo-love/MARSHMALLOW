import { stripThinkingBlocks } from './marshmallow-protocol.js';
import { stripNarrativeSpeechTags } from './narrative-voice-lines.js';

const CJK = /[\u3400-\u9fff\u3040-\u30ff]/;

function countLatin(str = '') {
  const m = String(str || '').match(/[A-Za-z]/g);
  return m ? m.length : 0;
}

/** 一行是不是「纯思维链 / 自我提示」（中英通吃） */
function isReasoningOnly(line = '') {
  if (!line) return true;
  if (/^(?:analysis|reasoning|thinking|thought|思考|推理|分析)\s*[:：]/i.test(line)) return true;
  if (/^(?:我|我们|现在)?(?:需要|要|应该|先|接下来|可以)(?:分析|推理|判断|构思|思考|生成|输出)/.test(line)) return true;
  if (/^(?:根据|结合)(?:用户|上下文|设定|歌词|场景|要求)/.test(line)) return true;
  if (/^(?:用户|角色|任务|要求|背景|格式)\s*[:：]/.test(line) && !/[“”"。！？!?]/.test(line)) return true;
  return false;
}

/** 一行是不是「英文思维链碎句」：在中文叙事里出现的纯拉丁文行，绝大多数是模型泄漏的 CoT */
function isLatinReasoningLine(line = '') {
  if (!line) return false;
  if (CJK.test(line)) return false;
  if (countLatin(line) < 3) return false;
  if (/^["'“”‘’*\-—·]/.test(line)) return false; // 引号/破折号开头多半是对白，保守保留
  return true;
}

const REASONING_SIGNAL = /(?:\bI\s|\bI['’]m\b|\bI\s+am\b|\bMy\s|\bWe['’]?(?:re|ll)?\b|\bLet['’]s\b|\bLet me\b|\bFirst,|\bNow,|\bHere['’]s\b|\bThe user\b|\bfocusing on\b|\bfleshing out\b|\brefining\b|\bestablish(?:ing)?\b|\bdeveloping\b|\bcrafting\b|\bplanning\b|analysis|reasoning|thinking)/i;
const LATIN_REASONING_PREFIX_SIGNAL = /(?:\b(?:analysis|reasoning|thinking|plan|requirements?|narrative|scene|response|story|character|user(?:'s)?|agency|emotional beat|final draft|prose)\b|\bfocusing on\b|\brespecting\b|\bflows logically\b)/i;

/**
 * 去掉「中文叙事正文之前」的英文思维链前缀。
 * 很多模型（尤其 Gemini / preview）会先吐一段英文思考，再接中文正文且不换行，
 * 现有按行/按标题剥离抓不住。这里：定位第一个 CJK 字符，若前缀是较长的拉丁文思考串，就整段砍掉。
 */
function stripLeadingLatinReasoning(text = '') {
  const idx = text.search(CJK);
  if (idx <= 0) return text;
  const prefix = text.slice(0, idx);
  if (countLatin(prefix) < 24) return text; // 短前缀可能是正常英文词，保守放过
  return text.slice(idx).replace(/^[\s).,:;"'”’*\-—]+/, '');
}

/**
 * 一行是不是「裸露的棉花糖协议 JSON」：{"t":"msg"/"voice"/"state"/"backstage",...}。
 * 叙事类生成的系统提示继承自聊天上下文，个别情况下模型会顺着协议惯性吐出这类 JSON
 * 而不是正文（比如摘要任务偶尔只回一条空 state 事件），必须当垃圾内容剥掉，不能当正文收录。
 */
export function isProtocolJsonLine(line = '') {
  const t = String(line || '').trim();
  if (t.length < 8 || t[0] !== '{' || t[t.length - 1] !== '}') return false;
  if (!/^\{\s*"t"\s*:\s*"(?:msg|voice|state|backstage)"/.test(t)) return false;
  try {
    const obj = JSON.parse(t);
    return !!(obj && typeof obj === 'object' && typeof obj.t === 'string');
  } catch (_) {
    return false;
  }
}

/** 剥离模型泄漏的思维链 / 分析段（线下、小剧场、时光机等叙事面共用） */
export function stripLeakedReasoning(raw = '', options = {}) {
  const preserveLeadingLatin = options.preserveLeadingLatin === true;
  let text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/<thinking>[\s\S]*$/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/g, '')
    .replace(/```(?:analysis|reasoning|思考)[\s\S]*?```/gi, '')
    .trim();
  // 加粗英文小标题（Developing… / Refining… / Analyzing… 等）几乎都是思考分节标记：中文叙事不会用英文加粗标题
  text = text
    .replace(/\*\*\s*[A-Za-z][^*\n]{0,80}\*\*/g, '\n')
    .replace(/^\s*(?:analysis|reasoning|thinking|thought|思考|推理|分析)\s*[:：][\s\S]*?(?=\n\s*(?:final(?:\s+(?:answer|response))?|answer|最终答案|最终回复|最终输出|最终正文|正式回复|正式正文|完整正文|回复|输出|正文|气泡|语音文本)\s*[:：]|$)/gi, '')
    .trim();
  // “回复 / 输出 / 正文”也是叙事里的普通词，不能在任意位置把它们当成最终答案边界。
  // 明确的最终成稿标题只认独立行；较弱的通用标题还必须位于可识别的思考前缀之后。
  // 否则长篇正文只要写到“她看见回复：……”就会在生成完成后丢掉此前全文。
  const explicitFinalMatch = text.match(
    /(?:^|\n)[ \t]*(?:最终答案|最终回复|最终输出|最终正文|正式回复|正式正文|完整正文|final answer|final response)[ \t]*[:：][ \t]*(?:\r?\n)?([\s\S]+)$/i,
  );
  if (explicitFinalMatch?.[1]) {
    text = explicitFinalMatch[1].trim();
  } else {
    const genericFinalPattern = /(?:^|\n)[ \t]*(?:answer|回复|输出|正文|气泡|语音文本)[ \t]*[:：][ \t]*(?:\r?\n)?/gi;
    let genericFinalMatch = null;
    for (const match of text.matchAll(genericFinalPattern)) {
      const prefix = text.slice(0, Number(match.index || 0));
      const startsOutput = Number(match.index || 0) === 0;
      const hasReasoningPrefix = startsOutput
        || /(?:^|\n)[ \t]*(?:analysis|reasoning|thinking|thought|思考|推理|分析)[ \t]*[:：]/i.test(prefix)
        || (countLatin(prefix) >= 24 && REASONING_SIGNAL.test(prefix));
      if (hasReasoningPrefix) genericFinalMatch = match;
    }
    if (genericFinalMatch) {
      text = text.slice(Number(genericFinalMatch.index || 0) + genericFinalMatch[0].length).trim();
    }
  }
  if (!preserveLeadingLatin) text = stripLeadingLatinReasoning(text).trim();
  const hasCjk = CJK.test(text);
  // 整段都是英文且带思考信号（多半是流式途中只到了思考、正文未来）：直接清空，让上层显示占位
  if (!preserveLeadingLatin && !hasCjk && countLatin(text) >= 24 && REASONING_SIGNAL.test(text)) return '';
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (isProtocolJsonLine(line)) return false;
      if (isReasoningOnly(line)) return false;
      if (hasCjk && isLatinReasoningLine(line)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

export function sanitizeNarrationOutput(raw = '') {
  let text = stripNarrativeSpeechTags(stripThinkingBlocks(String(raw || '')));
  // 部分兼容模型会沿用网页富文本习惯，用 <br>（或已经转义的 &lt;br&gt;）
  // 代替正文换行。它们是排版标记，不是叙事内容；先还原成普通换行，避免标签
  // 通过“正文非空”校验并在线下音声舞台里占成独立的一段旁白。
  text = text
    .replace(/<\s*\/?\s*br\s*\/?>/gi, '\n')
    .replace(/&lt;\s*\/?\s*br\s*\/?\s*&gt;/gi, '\n');
  // 有些兼容模型会把整段普通叙事包进 text / markdown 围栏。旧逻辑会把围栏连同
  // 正文整段删除，造成「上游已输出、线下却判空」。只救回完整包裹的纯文本围栏；
  // json / analysis 等代码块仍按协议或思维链处理，不把隐藏内容冒充正文。
  const wholeTextFence = text.match(
    /^\s*```(?:markdown|md|text|plaintext|txt)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i,
  );
  if (wholeTextFence) text = String(wholeTextFence[1] || '').trim();
  text = stripLeakedReasoning(text);
  text = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*```[^\n]*$/gm, '')
    .trim();
  return text;
}

/**
 * 提取“逐段编辑审稿”在同一次模型回复里生成的隐藏记录。
 * 只认专用前缀，不把普通 HTML 注释、思维链或第三方扩展误收为审稿记录。
 * 正文与审稿轨迹分开落库，展示、续写和摘要只使用移除注释后的定稿。
 */
export function extractNarrationEditorialAudits(raw = '') {
  const audits = [];
  const body = String(raw || '').replace(
    /<!--\s*editorial-audit\s*:\s*([\s\S]*?)-->/gi,
    (_whole, content) => {
      const value = String(content || '').trim();
      if (value) audits.push(value);
      return '\n';
    },
  );
  return { body, audits };
}

/**
 * 本地只核验“审稿有没有认真执行”，不替模型评价文学质量。
 * 这能抓出 Gemini 把明显违规草稿写成 PASS、或把 Audit 写成优点总结的情况。
 */
export function inspectNarrationEditorialAudit(raw = '', options = {}) {
  const record = String(raw || '').trim();
  const draft = String(record.match(/(?:^|\n)DRAFT\s*:\s*([\s\S]*?)(?=\n\s*AUDIT\s*:|$)/i)?.[1] || '').trim();
  const audit = String(record.match(/(?:^|\n)AUDIT\s*:\s*([\s\S]*)$/i)?.[1] || '').trim();
  const warnings = [];
  if (!draft) warnings.push('缺少可识别的 DRAFT 原稿');
  if (!audit) warnings.push('缺少可识别的 AUDIT 检查');
  if (!draft || !audit) return warnings;

  const hits = [];
  const addHit = (label, pattern) => {
    if (pattern.test(draft)) hits.push(label);
  };
  addHit('开头是残句或转折后半句', /^\s*(?:[…。，,；;：:]|——)*(?:[^。！？\n]{0,80}[，,])?\s*(?:而是|但是|只是|反而|却)/);
  addHit('“不是 / 并非……而是 / 只是……”负向垫句', /(?:不是|并非)[^。！？\n]{0,100}(?:而是|只是|反而)/);
  addHit('“不是……，是……”纠正式定性', /(?:不是|并非)[^。！？\n]{0,100}[，,；;]\s*(?:而)?是/);
  addHit('“没有 / 没……而是 / 只是……”负向垫句', /(?:没有|没)[^。！？\n]{0,100}(?:而是|只是|反而)/);
  addHit('连续缺席式描写', /(?:没有|没)[^。！？\n]{0,70}(?:也|又)(?:没有|没)/);
  addHit('缺席式动作描写', /(?:没有|没)(?:立刻|马上|多加|继续|再|丝毫|任何|一概)?(?:停顿|犹豫|迟疑|寒暄|解释|回应|回答|接话|接问题|理会|开口|说话|端起|摆出|坐下|站起)/);
  addHit('语气、目光或声音的旁白翻译', /(?:语气|声音|目光|眼神)[^。！？\n]{0,28}(?:像在|仿佛|似乎|带着|透出|显得|自带)/);
  addHit('空泛程度词', /(?:极其|极度|极为)/);
  addHit('“不存在的眼镜”式元叙事纠错', /(?:不存在的眼镜|没戴眼镜|没有戴眼镜|并未戴眼镜|才想起[^。！？\n]{0,18}(?:没|没有)戴眼镜|推[^。！？\n]{0,18}眼镜[^。！？\n]{0,24}(?:哦不对|才想起|但他|可他))/);
  const userName = String(options.userName || '').trim();
  if (options.blockUserSpeech === true && userName) {
    const escapedUserName = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const userAction = '(?:站|坐|走|跟|追|靠|退|抬|低|转|伸|拿|接|喝|吃|看|回答|回应|开口|点头|摇头|颤抖|发抖|脸红|心跳|沉默)';
    const directUserAction = new RegExp(`${escapedUserName}[^。！？\\n]{0,36}${userAction}`);
    const adjacentPronounAction = new RegExp(`${escapedUserName}[^。！？\\n]{0,48}[。！？]\\s*(?:她|他|TA|ta)[^。！？\\n]{0,48}${userAction}`, 'i');
    if (directUserAction.test(draft) || adjacentPronounAction.test(draft)) hits.push('防抢话开启时仍代写用户动作、反应或沉默');
  }
  const saysPass = /(?:^|\n|[。；;])\s*PASS(?:[。！!]|\s|$)/i.test(audit);
  if (saysPass && hits.length) warnings.push(`错误 PASS：仍命中${hits.join('、')}`);
  if (!saysPass && !/[“”`「」『』]/.test(audit)) warnings.push('AUDIT 没有引用任何实际原文子串');
  if (/(?:符合(?:人物|人设|设定|逻辑)|动作无缝|衔接无缝|自然流畅|写得很好|表现优秀|有效暗示|增强了|十分到位|处理合理|没有违规|无违规)/.test(audit)) {
    warnings.push('AUDIT 混入优点评价，没有保持纯找茬模式');
  }
  return warnings;
}

/**
 * “补审重写”使用的叙述硬命中。它比普通显示正则更激进，但只检查旁白，
 * 先遮掉中英文直接引语，避免把角色确实需要说出的否定句当成八股。
 */
export function collectNarrationSupplementalAuditHits(raw = '') {
  const source = String(raw || '');
  const narrationOnly = source
    .replace(/[“「『][\s\S]*?[”」』]/g, (quoted) => ' '.repeat(quoted.length))
    .replace(/(^|[\s（(])"[^"\n]{1,240}"/gm, (quoted) => ' '.repeat(quoted.length));
  const rules = [
    ['负向垫句', /(?:不是|并非|没有|没)[^。！？\n]{0,100}(?:而是|只是|反而)/g, '删除虚构的反面铺垫，直接写实际发生的画面'],
    ['纠正式定性', /(?:不是|并非)[^。！？\n]{0,100}[，,；;]\s*(?:而)?是/g, '删除“不是……，是……”的旁白判词，直接落到可见状态或人物自身判断'],
    ['连续缺席式描写', /(?:没有|没)[^。！？\n]{0,70}(?:也|又)(?:没有|没)/g, '不要连续清点未发生的动作，改写当前实际位置、行为或注意点'],
    ['缺席式动作', /(?:没有|没)(?:立刻|马上|继续|再|去|回头|开口|说话|解释|回应|回答|接话|理会|碰|喝|坐下|动作|动|看|死盯|盯着|盯|停留|移开|收回|抬|提)[^。！？\n]{0,36}/g, '改成角色实际做出的肯定动作、位置或注意点'],
    ['缺席式状态', /(?:没有|没)(?:乱|变|透出|露出|显出|停|散|松|紧)[^。！？\n]{0,32}/g, '改写为当前真实可见的肯定状态'],
    ['叙述回避', /(?:^|[。！？\n])[^。！？\n]{0,18}(?:不提|不问|不解释|不回应|不回头|不看|不碰)[^。！？\n]{0,40}/g, '不要列举角色回避了什么，直接写其注意点与下一步行为'],
    ['旁白免责声明', /(?:也)?(?:没有|没)(?:打算|试图|指望|准备|想要|想)[^。！？\n]{0,48}/g, '删除旁白免责声明，让后续行为自己成立'],
    ['解释连接词', /(?:顺理成章地|理所当然地|显而易见地|不言而喻地)/g, '直接写动作与结果，不替读者解释'],
    ['强权套话', /(?:不容置疑|不容拒绝|不容置喙)/g, '改成具体行为和现场实际反应'],
    ['空泛程度词', /(?:极其|极度|极为)/g, '删除空泛程度，或改写为可见后果'],
    ['虚假精确', /(?:精准|准确无误|零点[一二三四五六七八九\d]|\d+\.\d+秒)/g, '删除没有叙事必要的精确腔'],
  ];
  const hits = [];
  const seen = new Set();
  rules.forEach(([type, pattern, guidance]) => {
    for (const match of narrationOnly.matchAll(pattern)) {
      const index = Number(match.index || 0);
      const value = source.slice(index, index + String(match[0] || '').length).trim();
      if (!value) continue;
      const key = `${type}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ type, value, guidance, index });
    }
  });
  return hits.sort((a, b) => a.index - b.index).slice(0, 40);
}

function isLikelyRecoveredNarration(text = '') {
  const value = String(text || '').trim();
  if (value.length < 12) return false;
  const cjkCount = (value.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
  if (cjkCount >= 8) return true;
  return countLatin(value) >= 48 && /[.!?]["'’”)]?(?:\s|$)/.test(value);
}

function cleanRecoveredOutputCandidate(raw = '') {
  let candidate = String(raw || '')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*(?:\r?\n|$)/, '')
    .trim();
  if (!candidate) return '';
  const wholeFence = candidate.match(
    /^\s*```(?:markdown|md|text|plaintext|txt|json|jsonl)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i,
  );
  return String(wholeFence?.[1] ?? candidate).trim();
}

/**
 * 从 reasoning_content / thinking 中取出被模型放错字段的最终输出。
 * 只接受明确的「开始输出」边界、水平分隔线或完整围栏，不把整段分析直接冒充答案。
 */
export function recoverFinalOutputFromReasoning(raw = '', options = {}) {
  const text = String(raw || '')
    .replace(/<\/?(?:think|thinking)>/gi, '')
    .trim();
  if (!text) return '';
  const accept = typeof options.accept === 'function' ? options.accept : null;
  const acceptedCandidate = (candidate = '') => {
    const value = String(candidate || '').trim();
    if (!value) return '';
    return !accept || accept(value) ? value : '';
  };

  let boundaryEnd = -1;
  const markers = [
    /^(?:let me|i(?:['’]ll| will)|now(?: i(?:['’]ll| will))?)\s+(?:write|draft|provide|produce|give|compose|generate)\b[^\r\n]{0,120}\b(?:version|answer|response|scene|narrative|story|text|prose)\b[^\r\n]*[:：]\s*$/gim,
    /^(?:下面|以下|现在|接下来)[^\r\n]{0,30}(?:正文|成稿|回复|内容|叙事)[^\r\n]*[:：]?\s*$/gm,
    /^(?:最终答案|最终回复|最终输出|正式回复|正式正文|最终正文|完整正文|成稿)\s*[:：]\s*/gim,
  ];
  markers.forEach((pattern) => {
    for (const match of text.matchAll(pattern)) {
      const end = Number(match.index || 0) + match[0].length;
      if (end > boundaryEnd) boundaryEnd = end;
    }
  });

  // 很多模型用水平分隔线把分析和最终成稿隔开；取最后一条，避免前文结构线误判。
  const dividers = boundaryEnd < 0
    ? [...text.matchAll(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm)]
    : [];
  const lastDivider = dividers[dividers.length - 1];
  if (lastDivider && boundaryEnd < 0) {
    const end = Number(lastDivider.index || 0) + lastDivider[0].length;
    if (end > boundaryEnd) boundaryEnd = end;
  }

  if (boundaryEnd >= 0) {
    const recovered = cleanRecoveredOutputCandidate(text.slice(boundaryEnd));
    const accepted = acceptedCandidate(recovered);
    if (accepted) return accepted;
  }

  // 另一种常见错位是把最终输出单独包在 reasoning 的文本或 JSON 围栏中。
  const fenced = [...text.matchAll(
    /```(?:markdown|md|text|plaintext|txt|json|jsonl)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi,
  )];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const recovered = cleanRecoveredOutputCandidate(fenced[i]?.[1]);
    const accepted = acceptedCandidate(recovered);
    if (accepted) return accepted;
  }
  return '';
}

/**
 * 兼容部分推理模型把「英文分析 + 中文成稿」连续放进 reasoning_content，且没有 Final/正文边界。
 * 这条兜底故意比普通叙事校验严格：必须有足量英文分析信号、足量中文成稿与句末标点，
 * 并限制候选中的英文占比，避免把纯推理或夹带少量中文引用的分析误当成正文。
 */
function recoverNarrationAfterLatinReasoning(raw = '') {
  const text = String(raw || '')
    .replace(/<\/?(?:think|thinking)>/gi, '')
    .trim();
  const firstCjk = text.search(CJK);
  if (firstCjk <= 0) return '';

  const prefix = text.slice(0, firstCjk);
  if (countLatin(prefix) < 48 || !LATIN_REASONING_PREFIX_SIGNAL.test(prefix)) return '';

  const candidate = sanitizeNarrationOutput(text);
  if (!candidate || !isLikelyRecoveredNarration(candidate)) return '';
  const cjkCount = (candidate.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
  if (cjkCount < 24 || !/[。！？!?][”’"')）】》]?(?:\s|$)/.test(candidate)) return '';
  if (countLatin(candidate) > Math.max(24, Math.floor(cjkCount * 0.35))) return '';

  const firstLine = candidate.split(/\r?\n/, 1)[0].trim();
  if (isReasoningOnly(firstLine)) return '';
  if (/^(?:用户|角色|任务|要求|这段|本轮|故事|叙事|场景).{0,24}(?:想|希望|要求|需要|应该|应当|可以|必须)/.test(firstLine)) return '';
  return candidate;
}

/**
 * 叙事专用恢复：优先按明确边界提取最终输出；再兼容高置信的英文分析→中文成稿错位，
 * 最后继续走统一叙事清洗，并验证它确实像可展示成稿。
 */
export function recoverNarrationFromReasoning(raw = '') {
  // 有些兼容线路把 `<think>分析</think>正式正文` 整段错放进 reasoning_content。
  // 成对标签本身就是可靠边界，先直接取标签外内容；否则后续“英文分析→中文正文”
  // 兜底会看见思考区里预演的协议 JSON，并可能错过真正正文。
  if (/<\/(?:think|thinking)>/i.test(String(raw || ''))) {
    const outsideTaggedThinking = sanitizeNarrationOutput(raw);
    if (isLikelyRecoveredNarration(outsideTaggedThinking)) return outsideTaggedThinking;
  }
  const explicit = sanitizeNarrationOutput(recoverFinalOutputFromReasoning(raw));
  if (isLikelyRecoveredNarration(explicit)) return explicit;
  return recoverNarrationAfterLatinReasoning(raw);
}

/**
 * 叙事正文分段：优先按空行分段；若整段没有空行（模型只用单换行甚至不换行），
 * 退化为按单换行分段，避免渲染成一坨「豆腐块」。
 */
export function splitNarrationParagraphs(text = '') {
  const t = String(text || '').trim();
  if (!t) return [];
  const byBlank = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  return t.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
}
