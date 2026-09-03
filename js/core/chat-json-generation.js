import {
  chat,
  chatForTask,
  chatWithPreferredStream,
  getConfig,
  resolveTaskApiConfig,
} from './api.js';
import { getNativeHttpTransport, isNativeAppShell } from './native-http.js';
import { recoverFinalOutputFromReasoning } from './narration-sanitize.js';
import { stripThinkingBlocks } from './marshmallow-protocol.js';
import { classifyUpstreamContentRefusal } from './generation-error-guide.js';

/**
 * 角色型生成在业务层统一保留消息层级：长期设定进入 system，既有上下文保持原 role，
 * 本次业务任务只放在最后一条 user。最终传输形态由业务显式需求和 API 兼容设置决定。
 */
export function composeContextualGenerationMessages({
  contextMessages = [],
  systemParts = [],
  userContent = '',
} = {}) {
  const rows = (Array.isArray(contextMessages) ? contextMessages : [])
    .filter((message) => message && message.content != null)
    .map((message) => ({ ...message }));
  const systemContent = (Array.isArray(systemParts) ? systemParts : [systemParts])
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const taskContent = String(userContent || '').trim();
  return [
    ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
    ...rows,
    ...(taskContent ? [{ role: 'user', content: taskContent }] : []),
  ];
}

const JSON_STRUCTURE_LOCK = [
  '[输出结构校验 · 最高优先级]',
  '本轮响应会直接交给程序解析。只输出一个完整、合法的 JSON 值；禁止 Markdown 代码块、前后解释、分析过程或其它纯文本。',
  '严格沿用本次任务给出的根结构、字段名与字段类型。不同字段的信息不得合并到同一个字符串，也不得改名或自创替代格式。',
  '可选内容缺失时使用任务约定的空字符串、空数组或省略规则。输出前检查引号与转义有效，逗号正确，所有对象和数组均已闭合。',
].join('\n');

function appendTextContent(content, suffix) {
  if (Array.isArray(content)) {
    return [
      ...content,
      { type: 'text', text: suffix },
    ];
  }
  const text = String(content || '').trim();
  return text ? `${text}\n\n${suffix}` : suffix;
}

/**
 * 可选的提示词级结构强化。不改变业务 schema，也不触发额外模型请求；
 * 这里只调整语义层级，不擅自改变最终网关的消息承载形态。
 */
export function applyJsonStructureStrengthening(messages = [], extraRules = '') {
  const rows = (Array.isArray(messages) ? messages : []).map((message) => ({ ...message }));
  const lock = [JSON_STRUCTURE_LOCK, String(extraRules || '').trim()].filter(Boolean).join('\n');
  let systemIndex = -1;
  let userIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const role = String(rows[index]?.role || '').toLowerCase();
    if (role === 'system' || role === 'developer') systemIndex = index;
    if (role === 'user') userIndex = index;
  }
  if (systemIndex >= 0) rows[systemIndex].content = appendTextContent(rows[systemIndex].content, lock);
  else rows.unshift({ role: 'system', content: lock });

  // 再把一句短锚点放到真正的生成点末尾，避免长背景把格式要求冲淡。
  const tail = '[输出前最后检查] 只返回任务规定的完整 JSON；不要解释，不要代码块。';
  if (userIndex >= 0) {
    const adjustedIndex = systemIndex < 0 ? userIndex + 1 : userIndex;
    rows[adjustedIndex].content = appendTextContent(rows[adjustedIndex].content, tail);
  } else {
    rows.push({ role: 'user', content: tail });
  }
  return rows;
}

function fencedJsonBody(raw = '') {
  const text = String(raw || '').trim();
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function fencedJsonBodies(raw = '') {
  const text = String(raw || '');
  const bodies = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = pattern.exec(text);
  while (match) {
    const body = String(match[1] || '').trim();
    if (body) bodies.push(body);
    match = pattern.exec(text);
  }
  return bodies;
}

function balancedJsonBodies(raw = '') {
  const text = String(raw || '');
  const bodies = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const closing = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === '{') closing.push('}');
      else if (char === '[') closing.push(']');
      else if (char === '}' || char === ']') {
        if (closing[closing.length - 1] !== char) break;
        closing.pop();
        if (!closing.length) {
          bodies.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return bodies;
}

export function inspectLooseChatJson(raw = '', validate = () => true) {
  // JSON 业务同样只能解析可见输出。否则 think / thinking 中一份结构完整的
  // 草稿 JSON 可能先于正式答案通过宽松校验，或与正式 JSON 拼成解析失败。
  const text = stripThinkingBlocks(String(raw || '')).trim();
  if (!text) return {
    data: null,
    jsonFound: false,
    parsedAny: false,
    invalidData: null,
  };
  const fencedBodies = fencedJsonBodies(text);
  const balancedBodies = balancedJsonBodies(text);
  const fallbackBody = fencedJsonBody(text);
  const candidates = [...fencedBodies, fallbackBody, ...balancedBodies].filter(Boolean);
  const jsonFound = fencedBodies.length > 0
    || balancedBodies.length > 0
    || /^[\[{]/u.test(fallbackBody);
  let matched = null;
  let parsedAny = false;
  let invalidData = null;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      parsedAny = true;
      if (validate(parsed)) matched = parsed;
      else invalidData = parsed;
    } catch (_) {
      // Try the next extraction strategy.
    }
  }
  return { data: matched, jsonFound: jsonFound || parsedAny, parsedAny, invalidData };
}

export function parseLooseChatJson(raw = '', validate = () => true) {
  return inspectLooseChatJson(raw, validate).data;
}

export function shouldPreferIncrementalJson(options = {}) {
  if (typeof options.preferStream === 'boolean') return options.preferStream;
  if (typeof options.requestOptions?.stream === 'boolean') return options.requestOptions.stream;
  const pageVisible = typeof document === 'undefined' || document.hidden !== true;
  return pageVisible
    && isNativeAppShell()
    && getNativeHttpTransport() === 'marshmallow-http';
}

async function requestJsonText(messages, options = {}) {
  let completionMeta = null;
  const inheritedAudit = options.requestOptions?.auditContext
    && typeof options.requestOptions.auditContext === 'object'
    ? options.requestOptions.auditContext
    : {};
  const explicitAudit = options.auditContext && typeof options.auditContext === 'object'
    ? options.auditContext
    : {};
  const auditContext = {
    ...inheritedAudit,
    ...explicitAudit,
    operation: String(
      explicitAudit.operation
      || inheritedAudit.operation
      || options.scope
      || options.task
      || 'json-generation',
    ).trim(),
    initiator: String(
      explicitAudit.initiator
      || inheritedAudit.initiator
      || options.initiator
      || 'feature',
    ).trim(),
  };
  const requestOptions = {
    ...(options.requestOptions || {}),
    temperature: options.temperature ?? options.requestOptions?.temperature,
    maxTokens: options.maxTokens ?? options.requestOptions?.maxTokens,
    signal: options.signal ?? options.requestOptions?.signal,
    auditContext,
    allowToolFallback: options.allowToolFallback
      ?? options.requestOptions?.allowToolFallback
      ?? (options.retryOnInvalid === false ? false : undefined),
    onCompletionMeta: (meta) => {
      completionMeta = meta && typeof meta === 'object' ? meta : null;
      options.requestOptions?.onCompletionMeta?.(meta);
    },
  };
  const request = typeof options.request === 'function' ? options.request : null;
  const preferIncremental = shouldPreferIncrementalJson(options);
  let raw;
  if (request) raw = await request(messages, requestOptions, options.task || '');
  else if (options.task) raw = await chatForTask(messages, {
    ...requestOptions,
    ...(preferIncremental ? { stream: true } : {}),
  }, options.task);
  else if (preferIncremental) raw = await chatWithPreferredStream(messages, null, { ...requestOptions, stream: true });
  else raw = await chat(messages, { ...requestOptions, stream: false });
  return { raw, completionMeta };
}

function validParsedValue(data, validate) {
  return data != null && validate(data);
}

/**
 * Shared JSON generation. Exactly one model request is made. Empty, truncated,
 * or malformed output is returned as an explicit error for the caller to show.
 */
export async function chatJsonGeneration(options = {}) {
  const customParser = typeof options.parse === 'function' ? options.parse : null;
  const parser = customParser || parseLooseChatJson;
  const validate = typeof options.validate === 'function' ? options.validate : (value) => value != null;
  const route = options.task
    ? await resolveTaskApiConfig(options.task, options.requestOptions || {}).catch(() => null)
    : null;
  const config = route?.config || await getConfig().catch(() => ({}));
  const structureApiSection = route?.apiSection || 'main';
  const structureStrengthening = options.structureStrengthening
    ?? config.structureStrengthening
    ?? false;
  const originalMessages = Array.isArray(options.messages) ? options.messages : [];
  const baseMessages = structureStrengthening
    ? applyJsonStructureStrengthening(originalMessages, options.structureRules)
    : originalMessages;
  let response = null;
  let transportError = null;
  try {
    response = await requestJsonText(baseMessages, {
      ...options,
      allowToolFallback: false,
    });
  } catch (error) {
    error.structureApiSection = structureApiSection;
    const partialText = String(error?.partialText || '').trim();
    if (!partialText) throw error;
    transportError = error;
    response = {
      raw: partialText,
      completionMeta: error?.upstreamMeta && typeof error.upstreamMeta === 'object'
        ? error.upstreamMeta
        : null,
    };
  }
  let raw = String(response.raw || '');
  const finishReason = String(response.completionMeta?.finishReason || '').trim();

  let data = null;
  let inspection = null;
  try {
    if (customParser) data = parser(raw, validate);
    else {
      inspection = inspectLooseChatJson(raw, validate);
      data = inspection.data;
    }
  } catch (_) {
    data = null;
  }

  let recoveredFromReasoning = false;
  if (!validParsedValue(data, validate)) {
    const recovered = recoverFinalOutputFromReasoning(response.completionMeta?.reasoningText);
    if (recovered) {
      try {
        const recoveredInspection = customParser ? null : inspectLooseChatJson(recovered, validate);
        const recoveredData = customParser
          ? parser(recovered, validate)
          : recoveredInspection.data;
        if (validParsedValue(recoveredData, validate)) {
          raw = recovered;
          data = recoveredData;
          inspection = recoveredInspection;
          recoveredFromReasoning = true;
        } else if (recoveredInspection && !String(raw || '').trim()) {
          raw = recovered;
          inspection = recoveredInspection;
        }
      } catch (_) {
        // 保留原始失败证据，由下方统一报错。
      }
    }
  }

  if (finishReason === 'length' || !validParsedValue(data, validate)) {
    // 某些 Google 兼容中转会用 HTTP 200 + 普通正文返回输入安全拦截，甚至同时
    // 错标 finish_reason=length。它不是 JSON 写坏或 Max Tokens 截断，必须优先
    // 归到上游拒收，否则会误导用户开启结构强化、反复重试同一份提示词。
    const refusal = !validParsedValue(data, validate)
      ? classifyUpstreamContentRefusal(raw)
      : null;
    if (refusal) {
      const error = new Error(refusal.provider === 'google'
        ? 'Google / Gemini 在生成前拒收了本次输入'
        : '上游模型或渠道拒绝了本次输入');
      error.reason = 'upstream-content-refusal';
      error.refusalProvider = refusal.provider;
      error.refusalKind = refusal.kind;
      error.rawText = String(raw || '').slice(0, 120000);
      error.extraRequestCount = 0;
      error.finishReason = finishReason;
      error.upstreamMeta = response.completionMeta;
      error.reasoningText = String(response.completionMeta?.reasoningText || '');
      error.structureApiSection = structureApiSection;
      throw error;
    }
    if (transportError) {
      transportError.rawText = String(raw || '').slice(0, 120000);
      throw transportError;
    }
    const hasText = !!String(raw || '').trim();
    const validationMessage = inspection?.parsedAny && typeof options.describeValidationError === 'function'
      ? String(options.describeValidationError(inspection.invalidData) || '').trim()
      : '';
    const jsonFailureKind = finishReason === 'length'
      ? 'truncated'
      : (!hasText
        ? 'empty'
        : (inspection && !inspection.jsonFound
          ? 'missing-json'
          : (inspection?.parsedAny ? 'schema-invalid' : 'syntax-invalid')));
    const message = finishReason === 'length'
      ? '模型输出因长度限制被截断'
      : (!hasText
        ? '模型返回正文为空'
        : (jsonFailureKind === 'missing-json'
          ? '模型返回了普通文本，没有按要求输出 JSON'
          : (jsonFailureKind === 'schema-invalid'
            ? (validationMessage || '模型返回的 JSON 缺少必需字段或字段类型不正确')
            : '模型返回的 JSON 语法损坏')));
    const error = new Error(message);
    error.reason = finishReason === 'length'
      ? 'output-truncated'
      : (hasText ? 'json-parse-failed' : 'empty-api-response');
    error.jsonFailureKind = jsonFailureKind;
    error.invalidData = inspection?.invalidData ?? null;
    error.rawText = String(raw || '').slice(0, 120000);
    error.extraRequestCount = 0;
    error.finishReason = finishReason;
    error.upstreamMeta = response.completionMeta;
    error.reasoningText = String(response.completionMeta?.reasoningText || '');
    error.structureApiSection = structureApiSection;
    throw error;
  }

  return {
    data,
    raw: String(raw || ''),
    extraRequestCount: 0,
    repaired: false,
    recoveredFromReasoning,
    recoveredFromTransportPartial: !!transportError,
    finishReason,
  };
}
