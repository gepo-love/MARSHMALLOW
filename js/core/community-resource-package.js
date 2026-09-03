export const COMMUNITY_PACKAGE_TYPE = 'marshmallow.community-resource';
export const COMMUNITY_PACKAGE_VERSION = 1;
export const COMMUNITY_PUBLICATION_POLICY_VERSION = '2026-08-11';

export const COMMUNITY_RESOURCE_TYPES = Object.freeze([
  'character-card',
  'beautify',
  'worldbook',
  'preset',
  'inner-voice',
  'thinking-prompt',
  'html-component',
]);

export const COMMUNITY_CONTENT_RATINGS = Object.freeze(['general', 'adult', 'intense']);
export const COMMUNITY_RESOURCE_SUBTYPES = Object.freeze([
  'theme',
  'home-style',
  'chat-style',
  'chat-bubble',
  'offline-style',
  'page-style',
  'home-widget',
  'prompt-general',
  'extra-scene',
  'special-setting',
  'radio-prompt',
]);

export const COMMUNITY_PROMPT_SUBTYPES = Object.freeze([
  'prompt-general', 'extra-scene', 'special-setting', 'radio-prompt',
]);

function validSubtype(resourceType, subtype) {
  if (resourceType === 'beautify') return [
    'theme', 'home-style', 'chat-style', 'chat-bubble', 'offline-style', 'page-style', 'home-widget',
  ].includes(subtype);
  if (resourceType === 'preset') return COMMUNITY_PROMPT_SUBTYPES.includes(subtype);
  return false;
}

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function cleanList(value, maxItems = 12, maxLength = 40) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean))].slice(0, maxItems);
}

function containsUnsafeCss(css) {
  const source = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /@import\b/i.test(source)
    || /expression\s*\(/i.test(source)
    || /(?:^|[;{])\s*(?:behavior|-moz-binding)\s*:/im.test(source)
    || /url\s*\(\s*['"]?\s*(?:http:|\/\/|javascript:)/i.test(source)
    || /<\s*\/\s*style\b/i.test(source);
}

function unsafeHtmlUrlAttributes(html) {
  const attributePattern = /\b(?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const tag of String(html || '').match(/<[^>]+>/g) || []) {
    attributePattern.lastIndex = 0;
    let match;
    while ((match = attributePattern.exec(tag))) {
      const value = String(match[1] ?? match[2] ?? match[3] ?? '')
        .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_, hex, decimal) => {
          const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
          return Number.isFinite(codePoint) && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : '';
        })
        .replace(/&colon;/gi, ':')
        .replace(/[\u0000-\u0020]+/g, '');
      if (/^(?:javascript:|data:text\/html)/i.test(value)) return true;
    }
  }
  return false;
}

function unsafeHtmlStyleAttributes(html) {
  const attributePattern = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const tag of String(html || '').match(/<[^>]+>/g) || []) {
    attributePattern.lastIndex = 0;
    let match;
    while ((match = attributePattern.exec(tag))) {
      if (containsUnsafeCss(match[1] ?? match[2] ?? match[3] ?? '')) return true;
    }
  }
  return false;
}

function containsUnsafeHtml(html) {
  if (/<\s*(?:script|iframe|object|embed|applet|base|meta|link|form)\b/i.test(html)
    || /<[^>]*(?:\s|\/)on[a-z]+\s*=[^>]*>/i.test(html)
    || unsafeHtmlUrlAttributes(html)
    || unsafeHtmlStyleAttributes(html)) return true;
  const openStylePattern = /<style\b[^>]*>/gi;
  let openMatch;
  while ((openMatch = openStylePattern.exec(html))) {
    const rest = html.slice(openStylePattern.lastIndex);
    const closeMatch = /<\/style\s*>/i.exec(rest);
    if (!closeMatch || containsUnsafeCss(rest.slice(0, closeMatch.index))) return true;
    openStylePattern.lastIndex += closeMatch.index + closeMatch[0].length;
  }
  return false;
}

function isHtmlPayloadPath(path) {
  return /(?:^|\.)(?:[^.[\]]*html)(?:$|[.[])/i.test(path);
}

function isCssPayloadPath(path) {
  return /(?:^|\.)(?:[^.[\]]*css(?:text)?)(?:$|[.[])/i.test(path);
}

function validEmbeddedDataUrl(path, value) {
  if (/\.customFont\.dataUrl$/i.test(path)) {
    return /^data:font\/(?:woff2?|otf|ttf)(?:[;,])/i.test(value);
  }
  return value.startsWith('data:image/');
}

function inspectPackagePayload(value, path = 'payload', errors = [], state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 2500) {
    if (!errors.includes('资源包结构过于复杂')) errors.push('资源包结构过于复杂');
    return errors;
  }
  if (errors.length >= 12 || value == null) return errors;
  if (typeof value === 'string') {
    if (/dataurl$/i.test(path) && value && !validEmbeddedDataUrl(path, value)) {
      errors.push(`${path} 只能使用内嵌图片或字体`);
    }
    if (isHtmlPayloadPath(path) && containsUnsafeHtml(value)) {
      errors.push(`${path} 包含禁止的 HTML 能力`);
    }
    if (isCssPayloadPath(path) && containsUnsafeCss(value)) {
      errors.push(`${path} 包含外部请求或危险 CSS`);
    }
    return errors;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) errors.push(`${path} 项目过多`);
    value.slice(0, 200).forEach((item, index) => inspectPackagePayload(item, `${path}[${index}]`, errors, state));
    return errors;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 300) errors.push(`${path} 字段过多`);
    entries.slice(0, 300).forEach(([key, item]) => inspectPackagePayload(item, `${path}.${cleanText(key, 60)}`, errors, state));
  }
  return errors;
}

export function normalizeCommunityResourcePackage(source = {}) {
  const resourceType = COMMUNITY_RESOURCE_TYPES.includes(source.resourceType)
    ? source.resourceType
    : '';
  const rating = COMMUNITY_CONTENT_RATINGS.includes(source.rating) ? source.rating : 'general';
  const sourcePayload = source.payload && typeof source.payload === 'object' ? source.payload : {};
  return {
    type: COMMUNITY_PACKAGE_TYPE,
    schemaVersion: COMMUNITY_PACKAGE_VERSION,
    resourceType,
    resourceSubtype: validSubtype(resourceType, source.resourceSubtype)
      ? source.resourceSubtype
      : '',
    id: cleanText(source.id, 80),
    version: cleanText(source.version, 30) || '1.0.0',
    minAppBuild: Math.max(0, Number.parseInt(source.minAppBuild, 10) || 0),
    title: cleanText(source.title, 80),
    summary: cleanText(source.summary, 500),
    rating,
    warnings: cleanList(source.warnings),
    tags: cleanList(source.tags),
    authorship: {
      kind: ['original', 'authorized', 'derivative', 'collaboration'].includes(source.authorship?.kind)
        ? source.authorship.kind
        : 'original',
      sourceResourceId: cleanText(source.authorship?.sourceResourceId, 80),
      credit: cleanText(source.authorship?.credit, 160),
    },
    payload: resourceType === 'worldbook'
      ? normalizeCommunityWorldBookPayload(sourcePayload, { title: source.title })
      : sourcePayload,
    assets: Array.isArray(source.assets) ? source.assets.slice(0, 80) : [],
  };
}

export function inferCommunityUploadMetadata(source, fileName = '') {
  const name = cleanText(String(fileName || '').replace(/\.(?:json|css)$/i, ''), 80);
  if (typeof source === 'string') return { resourceType: 'beautify', resourceSubtype: 'home-style', title: name };
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { resourceType: '', title: name };
  if (source.type === COMMUNITY_PACKAGE_TYPE) {
    return {
      resourceType: source.resourceType || '',
      resourceSubtype: source.resourceSubtype || '',
      title: cleanText(source.title, 80) || name,
    };
  }
  const title = cleanText(
    source.title || source.name || source.themeName || source.displayName
      || source.component?.name || source.character?.name,
    80,
  ) || name;
  if (source.templateHtml || source.html
    || source.format === 'marshmallow-html-extensions'
    || source.items?.some?.((item) => item?.templateHtml || item?.html)) {
    return { resourceType: 'html-component', title };
  }
  if (source.type === 'marshmallow-appearance-theme' || source.theme || source.customTheme) {
    return { resourceType: 'beautify', resourceSubtype: 'theme', title };
  }
  if (source.type === 'marshmallow-beautify-component') {
    return { resourceType: 'beautify', resourceSubtype: 'home-widget', title };
  }
  if (source.css || source.cssText) {
    const target = String(source.target || '').trim();
    const resourceSubtype = target === 'offline'
      ? 'offline-style'
      : target === 'chat-thread'
        ? 'chat-style'
        : target && target !== 'home'
          ? 'page-style'
          : 'home-style';
    return { resourceType: 'beautify', resourceSubtype, title };
  }
  if (source.format === 'marshmallow-characters'
    || source.characters || source.character || source.characterCard || source.personality || source.speechStyle) {
    return { resourceType: 'character-card', title };
  }
  if (source.entries || source.worldbook || source.worldBook || source.worldbooks || source.worldBooks
    || source.stores?.worldBooks || source.stores?.worldbooks) {
    return { resourceType: 'worldbook', title };
  }
  if (source.type === 'marshmallow-preset' || source.presets || source.preset || source.prompts || source.apiPreset) {
    return { resourceType: 'preset', title };
  }
  if (source.type === 'marshmallow-inner-voice-card'
    || source.innerVoice || source.inner || source.stateTemplate) return { resourceType: 'inner-voice', title };
  if (source.type === 'marshmallow-thinking-prompt'
    || source.thinkingPrompt || source.chainOfThought || source.rules) return { resourceType: 'thinking-prompt', title };
  return { resourceType: '', title };
}

function worldBookRowsFromCompatiblePayload(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  const candidates = [
    source.entries,
    source.worldBooks,
    source.worldbooks,
    source.worldBook,
    source.worldbook,
    source.stores?.worldBooks,
    source.stores?.worldbooks,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((row) => row && typeof row === 'object');
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.entries)) {
      return candidate.entries.filter((row) => row && typeof row === 'object');
    }
  }
  return [];
}

/** 把完整备份、旧字段和标准导出统一收敛为商店可直接安装的世界书包。 */
export function normalizeCommunityWorldBookPayload(source = {}, options = {}) {
  const rows = worldBookRowsFromCompatiblePayload(source);
  return {
    type: 'marshmallow-worldbook',
    schemaVersion: 1,
    scope: String(source?.scope || '').trim() || 'compatible',
    name: cleanText(source?.name || source?.title || options.title || '世界书', 80) || '世界书',
    entries: rows,
  };
}

/** 商店主题不分发字体；兼容用户拿旧主题包直接发布，无需手工删字段。 */
export function stripCommunityThemeFont(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  let next = payload;
  if (payload.theme && typeof payload.theme === 'object' && !Array.isArray(payload.theme)) {
    const { customFont: _customFont, ...theme } = payload.theme;
    next = { ...payload, theme };
  }
  if (Object.prototype.hasOwnProperty.call(next, 'customFont')) {
    const { customFont: _customFont, ...withoutFont } = next;
    next = withoutFont;
  }
  return next;
}

/** 作者选择正常导出的 JSON / CSS；社区外壳只在提交前由 App 内部生成。 */
export function buildCommunityPackageFromUpload(source, metadata = {}) {
  const inferred = inferCommunityUploadMetadata(source, metadata.fileName);
  const existing = source?.type === COMMUNITY_PACKAGE_TYPE ? source : {};
  const resourceType = COMMUNITY_RESOURCE_TYPES.includes(metadata.resourceType)
    ? metadata.resourceType
    : inferred.resourceType;
  let payload = source?.type === COMMUNITY_PACKAGE_TYPE
    ? source.payload
    : (typeof source === 'string' ? { cssText: source } : source);
  if (resourceType === 'worldbook') {
    payload = normalizeCommunityWorldBookPayload(payload, {
      title: cleanText(metadata.title, 80) || inferred.title,
    });
  }
  const resourceSubtype = validSubtype(resourceType, metadata.resourceSubtype)
    ? metadata.resourceSubtype
    : (validSubtype(resourceType, inferred.resourceSubtype) ? inferred.resourceSubtype : '');
  if (resourceType === 'beautify' && resourceSubtype === 'theme') {
    payload = stripCommunityThemeFont(payload);
  }
  return normalizeCommunityResourcePackage({
    ...existing,
    ...metadata,
    resourceType,
    resourceSubtype,
    title: cleanText(metadata.title, 80) || inferred.title,
    payload: payload && typeof payload === 'object' ? payload : {},
  });
}

export function validateCommunityResourcePackage(source = {}) {
  const pkg = normalizeCommunityResourcePackage(source);
  const errors = [];
  if (source.type !== COMMUNITY_PACKAGE_TYPE) errors.push('不是棉花糖机社区资源包');
  if (Number(source.schemaVersion) !== COMMUNITY_PACKAGE_VERSION) errors.push('资源包版本暂不支持');
  if (!pkg.resourceType) errors.push('资源类型无效');
  if (!pkg.title) errors.push('资源名称不能为空');
  if (pkg.authorship.kind === 'derivative'
    && !pkg.authorship.sourceResourceId
    && !pkg.authorship.credit) {
    errors.push('二改资源必须填写原作来源或授权说明');
  }
  inspectPackagePayload(pkg.payload, 'payload', errors);
  inspectPackagePayload(pkg.assets, 'assets', errors);
  if (pkg.resourceType === 'beautify' && pkg.resourceSubtype === 'theme'
    && !(pkg.payload?.type === 'marshmallow-appearance-theme' || pkg.payload?.theme || pkg.payload?.customTheme)) {
    errors.push('完整主题必须使用棉花糖机主题 JSON');
  }
  if (pkg.resourceType === 'beautify' && pkg.resourceSubtype === 'home-widget'
    && pkg.payload?.type !== 'marshmallow-beautify-component') {
    errors.push('主屏组件必须使用棉花糖机组件 JSON');
  }
  if (pkg.resourceType === 'beautify' && pkg.resourceSubtype === 'home-widget'
    && Number(pkg.payload?.version) === 2
    && (!Array.isArray(pkg.payload?.items) || !pkg.payload.items.length)) {
    errors.push('主屏组件合集中没有组件内容');
  }
  if (pkg.resourceType === 'beautify'
    && ['home-style', 'chat-style', 'chat-bubble', 'offline-style', 'page-style'].includes(pkg.resourceSubtype)
    && !String(pkg.payload?.cssText || pkg.payload?.css || '').trim()) {
    errors.push('美化资源中没有 CSS');
  }
  if (pkg.resourceType === 'beautify' && pkg.resourceSubtype === 'page-style'
    && !String(pkg.payload?.target || '').trim()) {
    errors.push('其它页面美化缺少目标页面');
  }
  if (pkg.resourceType === 'html-component') {
    const templates = [pkg.payload?.templateHtml, pkg.payload?.html]
      .concat((Array.isArray(pkg.payload?.items) ? pkg.payload.items : []).flatMap((item) => [item?.templateHtml, item?.html]))
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (!templates.length) errors.push('HTML 组件缺少模板内容');
  }
  if (pkg.resourceType === 'worldbook'
    && (!Array.isArray(pkg.payload?.entries) || !pkg.payload.entries.length)) {
    errors.push('世界书文件中没有内容');
  }
  if (pkg.resourceType === 'preset' && COMMUNITY_PROMPT_SUBTYPES.includes(pkg.resourceSubtype)
    && !String(pkg.payload?.textContent || '').trim()) {
    errors.push('文字资源内容不能为空');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], package: pkg };
}
