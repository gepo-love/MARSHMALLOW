/** 朋友圈动态（角色 scoped 主页按 authorId 过滤） */

// 英文等拉丁语系同样长度的信息会占用更多字符；旧版二次硬切 120 字符时，
// 中文评论通常完整，外语评论却经常断在半句话。这里保留足够的单条评论空间。
export const MOMENT_COMMENT_TEXT_MAX = 600;

/**
 * AI、旧备份偶尔会把本应为 string 的字段写成对象。
 * 只提取已知文本键；未知对象宁可丢弃，也不能让 String(object) 污染为 [object Object]。
 */
export function coerceMomentText(value, { max = 0 } = {}) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else if (Array.isArray(value)) {
    text = value.map((item) => coerceMomentText(item)).filter(Boolean).join('\n');
  } else if (value && typeof value === 'object') {
    const candidate = value.text
      ?? value.content
      ?? value.message
      ?? value.body
      ?? value.line
      ?? value.caption
      ?? value.original
      ?? value.zh
      ?? value.translation
      ?? value.name
      ?? value.displayName
      ?? value.label
      ?? value.target
      ?? '';
    text = coerceMomentText(candidate);
  }
  const cleaned = String(text || '').trim();
  return max > 0 ? cleaned.slice(0, max) : cleaned;
}

export function isMomentObjectStringArtifact(value = '') {
  return /^\s*\[object(?:\s+[A-Za-z0-9_$.-]+)?\]\s*$/i.test(String(value || ''));
}

export function normalizeMomentComment(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawText = raw.text ?? raw.content ?? raw.message;
  const text = [raw.text, raw.content, raw.message]
    .map((value) => coerceMomentText(value, { max: MOMENT_COMMENT_TEXT_MAX }))
    .find((value) => value && !isMomentObjectStringArtifact(value)) || '';
  if (!text || isMomentObjectStringArtifact(text)) return null;
  const nestedTranslation = rawText && typeof rawText === 'object' && !Array.isArray(rawText)
    ? (rawText.zh ?? rawText.translation ?? rawText.zhText ?? '')
    : '';
  const translation = [raw.translation, raw.zh, raw.zhText, nestedTranslation]
    .map((value) => coerceMomentText(value, { max: MOMENT_COMMENT_TEXT_MAX }))
    .find((value) => value && !isMomentObjectStringArtifact(value)) || '';
  const rawReplyTo = [raw.replyTo, raw.replyToName, raw.replyTarget]
    .map((value) => coerceMomentText(value, { max: 48 }))
    .find((value) => value && !isMomentObjectStringArtifact(value)) || '';
  const replyTo = isMomentObjectStringArtifact(rawReplyTo) ? '' : rawReplyTo;
  return {
    ...raw,
    text,
    replyTo,
    ...(translation && translation !== text ? { translation } : { translation: '' }),
  };
}

export function coerceMomentChatLine(value, { max = 240 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return coerceMomentText(value, { max });
  }
  const who = coerceMomentText(
    value.speaker ?? value.from ?? value.name ?? value.author ?? value.role ?? '',
    { max: 48 },
  );
  const body = coerceMomentText(
    value.text ?? value.content ?? value.message ?? value.body ?? value.line ?? '',
    { max },
  );
  if (!body) return '';
  return (who ? `${who}：${body}` : body).slice(0, max);
}

/** 晒聊天行：兼容纯字符串，或 { text/content, zh/translation } */
export function normalizeMomentChatShareLine(value, { max = 240 } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = coerceMomentChatLine(value, { max });
    if (!text) return null;
    const translation = coerceMomentText(
      value.zh ?? value.translation ?? value.zhText ?? '',
      { max },
    );
    if (translation && translation !== text) return { text, translation };
    return text;
  }
  const text = coerceMomentText(value, { max });
  return text || null;
}

export function momentChatShareLineText(line) {
  if (line && typeof line === 'object' && !Array.isArray(line)) {
    return String(line.text || line.content || '').trim();
  }
  return String(line || '').trim();
}

export function momentChatShareLineTranslation(line) {
  if (line && typeof line === 'object' && !Array.isArray(line)) {
    return String(line.translation || line.zh || '').trim();
  }
  return '';
}

function normalizeChatShare(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lines = (Array.isArray(raw.lines) ? raw.lines : [])
    .map((line) => normalizeMomentChatShareLine(line))
    .filter(Boolean)
    .slice(0, 12);
  if (!lines.length) return null;
  return {
    ...raw,
    title: coerceMomentText(raw.title || '聊天记录', { max: 40 }) || '聊天记录',
    lines,
  };
}

function normalizeMomentComments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((comment) => normalizeMomentComment(comment))
    .filter(Boolean);
}

function normalizeStickerImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const url = typeof item === 'string'
      ? String(item || '').trim()
      : String(item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      name: typeof item === 'object' ? String(item?.name || '').trim() : '',
    });
    if (out.length >= 6) break;
  }
  return out;
}

export function createMomentPost(overrides = {}) {
  const now = Date.now();
  return {
    id: overrides.id || `moment_${now}_${Math.random().toString(36).slice(2, 6)}`,
    userId: String(overrides.userId || overrides.ownerUserId || ''),
    ownerUserId: String(overrides.userId || overrides.ownerUserId || ''),
    authorId: String(overrides.authorId || ''),
    authorName: String(overrides.authorName || ''),
    content: coerceMomentText(overrides.content),
    images: Array.isArray(overrides.images) ? overrides.images.filter(Boolean).slice(0, 9) : [],
    // 表情包单独存，渲染用 contain，避免塞进九宫格被 cover 裁切
    stickerImages: normalizeStickerImages(overrides.stickerImages),
    timestamp: Number(overrides.timestamp || now) || now,
    postKind: String(overrides.postKind || 'text'),
    visibility: String(overrides.visibility || 'all'),
    visibleGroupIds: Array.isArray(overrides.visibleGroupIds) ? overrides.visibleGroupIds : (
      Array.isArray(overrides.visibleGroups) ? overrides.visibleGroups : []
    ),
    hiddenFromIds: Array.isArray(overrides.hiddenFromIds) ? overrides.hiddenFromIds : [],
    mentionIds: Array.isArray(overrides.mentionIds) ? overrides.mentionIds : [],
    likes: Array.isArray(overrides.likes) ? overrides.likes : [],
    likesIds: Array.isArray(overrides.likesIds) ? overrides.likesIds : [],
    comments: normalizeMomentComments(overrides.comments),
    chatShare: normalizeChatShare(overrides.chatShare),
    avatar: String(overrides.avatar || ''),
    metadata: overrides.metadata && typeof overrides.metadata === 'object' ? { ...overrides.metadata } : {},
    // 配图元数据：生图失败时的文字图兜底、生图提示词，用于失败态展示与「重新生成配图」
    wantsImage: overrides.wantsImage === true,
    imageCharacterId: String(overrides.imageCharacterId || overrides.imageSubjectId || '').trim(),
    imagePrompt: String(overrides.imagePrompt || '').trim(),
    textImageCaption: coerceMomentText(overrides.textImageCaption || overrides.textImage || ''),
    textImage: coerceMomentText(overrides.textImage),
    imageKind: String(overrides.imageKind || '').trim(),
  };
}

export function normalizeMomentPost(raw = {}) {
  const userId = String(raw.userId || raw.ownerUserId || '').trim();
  return createMomentPost({
    ...raw,
    userId,
    ownerUserId: userId,
    likes: Array.isArray(raw.likes) ? raw.likes : [],
    likesIds: Array.isArray(raw.likesIds) ? raw.likesIds : [],
    comments: Array.isArray(raw.comments) ? raw.comments : [],
    chatShare: raw.chatShare || null,
  });
}

export function sanitizeMomentCommentText(text = '') {
  return coerceMomentText(text).replace(/\[表情包:[^\]]+\]/gi, '').replace(/\s+/g, ' ').trim();
}
