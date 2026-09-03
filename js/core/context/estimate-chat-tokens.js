/** 粗略 token 估算（中文偏保守）与输入分项统计 */

function cleanText(value = '') {
  return String(value || '').trim();
}

export function estimateTokensFromText(text = '') {
  const raw = cleanText(text);
  if (!raw) return 0;
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = raw.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.2 + other / 4));
}

export function estimateMessagesTokens(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let total = 0;
  for (const msg of list) {
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      total += estimateTokensFromText(msg.content);
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'text') total += estimateTokensFromText(part.text);
      }
    }
  }
  return total;
}

/** 把分层记忆正文按「=== 来源：… ===」拆成子项 */
export function splitMemorySourceSections(text = '') {
  const raw = String(text || '');
  if (!cleanText(raw)) return [];
  const chunks = raw.split(/\n(?==== 来源：)/);
  const out = [];
  for (const chunk of chunks) {
    const body = String(chunk || '').trim();
    if (!body) continue;
    const m = body.match(/^=== 来源：([^=\n]+?)===/);
    if (m) {
      out.push({
        id: `memory_src_${out.length}`,
        label: summarizeMemorySourceLabel(m[1]),
        text: body,
      });
    } else {
      out.push({
        id: `memory_meta_${out.length}`,
        label: '记忆说明',
        text: body,
      });
    }
  }
  return out;
}

export function summarizeMemorySourceLabel(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '记忆块';
  if (s.includes('当前 API 正在续写')) return '本窗记忆';
  if (s.includes('角色本体记忆')) return '角色本体记忆';
  if (s.includes('其它会话') || s.includes('其他会话')) return '相关窗口记忆';
  if (s.includes('结构化记忆')) return '结构化事实';
  if (s.includes('跨会话背景事件')) return '事件背景';
  if (s.includes('线下相遇')) return '线下总结';
  if (s.includes('共享事件知情')) return '共享知情';
  if (s.includes('小剧场')) return '小剧场阶段';
  if (s.includes('来源群')) return '匿名来源群';
  if (s.includes('其他匿名群') || s.includes('其它匿名群')) return '其它匿名群';
  if (s.includes('其他匿名私聊') || s.includes('其它匿名私聊')) return '其它匿名私聊';
  if (s.includes('匿名群成员相关')) return '成员相关匿名私聊';
  const short = s.replace(/（[^）]*）/g, '').replace(/\s+/g, ' ').trim();
  return short.slice(0, 28) || '记忆块';
}

function finalizeSegment(entry = {}) {
  const text = String(entry.text || '');
  const children = Array.isArray(entry.children)
    ? entry.children.map(finalizeSegment).filter((row) => row.tokens > 0)
    : [];
  const ownTokens = text ? estimateTokensFromText(text) : 0;
  const childTokens = children.reduce((sum, row) => sum + row.tokens, 0);
  return {
    id: String(entry.id || ''),
    label: String(entry.label || entry.id || '未命名'),
    tokens: ownTokens || childTokens,
    chars: text.length || children.reduce((sum, row) => sum + (row.chars || 0), 0),
    ...(children.length ? { children } : {}),
  };
}

/**
 * 将组装阶段回传的原始分段整理为 UI 可用的分项树。
 * 记忆大项会再按来源拆子项；内置提示词合并为一项（含协议等子项）。
 */
export function buildTokenBreakdownTree(segments = []) {
  const list = Array.isArray(segments) ? segments : [];
  const byId = new Map();
  for (const seg of list) {
    if (!seg?.id) continue;
    const previous = byId.get(seg.id);
    if (!previous) {
      byId.set(seg.id, seg);
      continue;
    }
    byId.set(seg.id, {
      ...previous,
      label: seg.label || previous.label,
      text: [previous.text, seg.text].map(cleanText).filter(Boolean).join('\n\n'),
      children: [
        ...(Array.isArray(previous.children) ? previous.children : []),
        ...(Array.isArray(seg.children) ? seg.children : []),
      ],
    });
  }

  const out = [];
  const take = (id) => {
    const seg = byId.get(id);
    byId.delete(id);
    return seg;
  };

  const builtinChildren = [];
  const builtinSpecs = [
    ['builtin', '开场与边界 · 常驻'],
    ['runtime_status', '即时状态 · 本轮触发'],
    ['protocol', '棉花糖协议 · 常驻 + 本轮触发'],
    ['builtin_tail', '节奏与尾部锚定 · 常驻 + 本轮触发'],
  ];
  for (const [id, label] of builtinSpecs) {
    const seg = take(id);
    if (!seg) continue;
    const text = String(seg.text || '').trim();
    if (!text) continue;
    builtinChildren.push({ id, label, text });
  }
  if (builtinChildren.length) {
    out.push(finalizeSegment({
      id: 'builtin',
      label: '内置提示词',
      text: '',
      children: builtinChildren,
    }));
  }

  const orderedIds = [
    ['worldbook', '世界书'],
    ['preset', '叙事预设'],
    ['userCard', '用户档案'],
    ['characterCards', '角色卡'],
    ['chatDirectives', '会话设定'],
    ['time', '时间与流程'],
    ['memory', '记忆与近况'],
    ['other', '其它注入'],
    ['history', '上下文消息'],
    ['format_tail', '格式/场景引导'],
  ];

  for (const [id, defaultLabel] of orderedIds) {
    const seg = take(id);
    if (!seg) continue;
    if (id === 'memory' || id === 'memory_layered') {
      const children = [];
      if (Array.isArray(seg.children) && seg.children.length) {
        for (const child of seg.children) {
          if (child?.id === 'memory_layered' || /分层记忆|上下文记忆/.test(String(child.label || ''))) {
            const sourced = splitMemorySourceSections(child.text);
            if (sourced.length) {
              for (const row of sourced) children.push(row);
              continue;
            }
          }
          children.push(child);
        }
      } else if (seg.text) {
        const sourced = splitMemorySourceSections(seg.text);
        if (sourced.length) children.push(...sourced);
      }
      out.push(finalizeSegment({
        id: 'memory',
        label: seg.label || defaultLabel,
        text: '',
        children: children.length
          ? children
          : (seg.text ? [{ id: 'memory_body', label: defaultLabel, text: seg.text }] : []),
      }));
      continue;
    }
    if (id === 'preset' && Array.isArray(seg.children) && seg.children.length) {
      out.push(finalizeSegment({
        id: 'preset',
        label: seg.label || defaultLabel,
        text: '',
        children: seg.children,
      }));
      continue;
    }
    if (id === 'worldbook' && Array.isArray(seg.children) && seg.children.length > 1) {
      out.push(finalizeSegment({
        id: 'worldbook',
        label: seg.label || defaultLabel,
        text: '',
        children: seg.children,
      }));
      continue;
    }
    out.push(finalizeSegment({
      id,
      label: seg.label || defaultLabel,
      text: seg.text || '',
      children: seg.children,
    }));
  }

  for (const seg of byId.values()) {
    out.push(finalizeSegment(seg));
  }
  return out.filter((row) => row.tokens > 0);
}

export async function estimateChatInputTokens(options = {}) {
  const { buildChatContext } = await import('./build-chat-context.js');
  const built = await buildChatContext({
    ...options,
    collectTokenBreakdown: true,
    tokenEstimateMode: true,
  });
  const promptTokens = estimateMessagesTokens(built.messages || []);
  const breakdown = buildTokenBreakdownTree(built.tokenBreakdown || []);
  const breakdownSum = breakdown.reduce((sum, row) => sum + row.tokens, 0);
  return {
    promptTokens,
    systemChars: cleanText(built.system || '').length,
    messageCount: (built.messages || []).length,
    enabledLayers: built.enabledLayers || [],
    breakdown,
    breakdownSum,
  };
}
