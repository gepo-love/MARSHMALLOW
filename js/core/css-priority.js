/**
 * 用户自定义 CSS 的选择器权重处理（无依赖，供 appearance-prefs / chat-appearance / 美化工作室共用）
 * - splitCssSelectorList：按顶层逗号拆选择器列表（括号 / 属性选择器 / 引号内的逗号不拆）
 * - expandChatAppearanceRootSelectors：聊天页专用，把 .chat-thread-page 扩成各主题复合根类
 * - boostCssPriority：通用权重提升，给每个选择器补 :not(#mm-lift)（凭空 +1 个 id 权重），
 *   让用户 CSS 稳压主题里的多层类选择器，而不必到处写 !important
 */

export function splitCssSelectorList(selectorText = '') {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let quote = '';
  const src = String(selectorText || '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') round += 1;
    else if (ch === ')') round = Math.max(0, round - 1);
    else if (ch === '[') square += 1;
    else if (ch === ']') square = Math.max(0, square - 1);
    else if (ch === ',' && round === 0 && square === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

/**
 * 把通用 `.chat-thread-page …` 逐个选择器扩成主题根类（含海/窗与 Ins 的复合根）。
 * 已显式限定主题的选择器保持原样；逗号列表、:is() 与 @media 内规则不会互相吞并。
 */
export function expandChatAppearanceRootSelectors(cssText = '') {
  const src = String(cssText || '');
  if (!src.trim()) return src;
  const replacements = [];
  let segmentStart = 0;
  let quote = '';
  let inComment = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1] || '';
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '}') {
      segmentStart = i + 1;
      continue;
    }
    if (ch !== '{') continue;
    const selectorText = src.slice(segmentStart, i);
    const inspect = selectorText.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    segmentStart = i + 1;
    if (!inspect || inspect.startsWith('@')) continue;
    const expanded = [];
    for (const rawSelector of splitCssSelectorList(selectorText)) {
      const selector = rawSelector.trim();
      if (!selector) continue;
      const hasBaseRoot = /\.chat-thread-page(?![a-zA-Z0-9_-])/.test(selector);
      const isThemed = /\.chat-thread-page--(?:ins|sea|window|anon)\b/.test(selector);
      if (!hasBaseRoot || isThemed) {
        expanded.push(selector);
        continue;
      }
      const roots = [
        '.chat-thread-page',
        '.chat-thread-page.scrapbook-page',
        '.chat-thread-page.chat-thread-page--ins',
        '.chat-thread-page.chat-thread-page--sea',
        '.chat-thread-page.chat-thread-page--sea.chat-thread-page--ins',
        '.chat-thread-page.chat-thread-page--window',
        '.chat-thread-page.chat-thread-page--window.chat-thread-page--ins',
        '.chat-thread-page.chat-thread-page--anon',
      ];
      for (const root of roots) {
        expanded.push(selector.replace(/\.chat-thread-page(?![a-zA-Z0-9_-])/, root));
      }
    }
    if (!expanded.length) continue;
    const leading = selectorText.match(/^\s*/)?.[0] || '';
    replacements.push({
      start: i - selectorText.length,
      end: i,
      value: `${leading}${expanded.join(',\n')}`,
    });
  }
  let output = src;
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const item = replacements[i];
    output = `${output.slice(0, item.start)}${item.value}${output.slice(item.end)}`;
  }
  return output;
}

/**
 * 通用选择器改写器：逐条规则把选择器列表交给 mapSelector 改写。
 * @media/@supports 内正常处理，@keyframes 的帧选择器（from/0%）跳过，
 * @import/@font-face 等无选择器语句不动。
 */
/** 逐条规则改写选择器列表；供气泡方向约束等业务层复用 */
export function mapCssRuleSelectors(cssText, mapSelector) {
  return transformRuleSelectors(cssText, mapSelector);
}

const NORMAL_CHAT_BUBBLE_STRUCTURE_PATTERN = /\.(?:chat-bubble-row|chat-bubble-col|scrapbook-bubble)(?![\w-])|\.chat-bubble(?![\w-])/;

function anonymousBubbleSelectorAlias(selector = '') {
  const src = String(selector || '').trim();
  if (!src || !NORMAL_CHAT_BUBBLE_STRUCTURE_PATTERN.test(src)) return '';
  if (/\.chat-thread-page--anon(?![\w-])/.test(src)) return '';

  let alias = src
    .replace(/\.chat-bubble-row(?![\w-])/g, '.chat-msg-group')
    .replace(/\.chat-bubble-col(?![\w-])/g, '.chat-msg-group-col')
    .replace(/\.scrapbook-bubble(?![\w-])/g, '.chat-anon-bubble')
    .replace(/\.chat-bubble(?![\w-])/g, '.chat-anon-bubble');

  alias = alias.replace(
    /\.chat-thread-page(?:(?:\.scrapbook-page)|(?:\.chat-thread-page--(?:ins|sea|window)))*(?![\w-])/,
    '.chat-thread-page.chat-thread-page--anon',
  );
  // 匿名分组在列与气泡之间还有 stack / item 两层；普通聊天的直属子代写法
  // 需要放宽为后代选择器，才能命中同一个视觉气泡。
  alias = alias.replace(
    /\.chat-msg-group-col\s*>\s*\.chat-anon-bubble/g,
    '.chat-msg-group-col .chat-anon-bubble',
  );
  return alias === src ? '' : alias;
}

/**
 * 普通聊天与匿名聊天共用同一份消息美化，但匿名消息使用分组 DOM。
 * 为普通气泡选择器追加匿名结构别名，不改写或覆盖用户保存的原始 CSS。
 */
export function expandAnonymousBubbleCompatibility(cssText = '') {
  return mapCssRuleSelectors(String(cssText || ''), (selector) => {
    const alias = anonymousBubbleSelectorAlias(selector);
    return alias ? `${selector},\n${alias}` : selector;
  });
}

function transformRuleSelectors(cssText, mapSelector) {
  const src = String(cssText || '');
  if (!src.trim()) return src;
  const replacements = [];
  let segmentStart = 0;
  let quote = '';
  let inComment = false;
  let depth = 0;
  let keyframesDepth = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1] || '';
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (keyframesDepth >= 0 && depth <= keyframesDepth) keyframesDepth = -1;
      segmentStart = i + 1;
      continue;
    }
    if (ch === ';') {
      segmentStart = i + 1;
      continue;
    }
    if (ch !== '{') continue;
    const selectorText = src.slice(segmentStart, i);
    const inspect = selectorText.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    segmentStart = i + 1;
    const blockDepth = depth;
    depth += 1;
    if (keyframesDepth >= 0) continue;
    if (!inspect) continue;
    if (inspect.startsWith('@')) {
      if (/^@(-\w+-)?keyframes(?![\w-])/i.test(inspect)) keyframesDepth = blockDepth;
      continue;
    }
    const mapped = splitCssSelectorList(selectorText)
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map(mapSelector)
      .filter(Boolean)
      .join(',\n');
    if (!mapped) continue;
    const leading = selectorText.match(/^\s*/)?.[0] || '';
    replacements.push({
      start: i - selectorText.length,
      end: i,
      value: `${leading}${mapped}`,
    });
  }
  let output = src;
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const item = replacements[i];
    output = `${output.slice(0, item.start)}${item.value}${output.slice(item.end)}`;
  }
  return output;
}

/** :not(#…) 永远匹配（页面里没有这个 id），只为凭空加一级 id 权重 */
const BOOST_SELECTOR = ':not(#mm-lift)';

/** 伪元素必须留在选择器末尾，boost 要插到它前面（含单冒号旧写法；:placeholder-shown 这类伪类不算） */
const PSEUDO_ELEMENT_PATTERN = /::|:(?=(?:before|after|first-line|first-letter|selection|placeholder|marker|backdrop)(?![\w-]))/i;

function boostSelector(selector) {
  const match = selector.match(PSEUDO_ELEMENT_PATTERN);
  if (match) return `${selector.slice(0, match.index)}${BOOST_SELECTOR}${selector.slice(match.index)}`;
  return `${selector}${BOOST_SELECTOR}`;
}

/** 给整段 CSS 的每个选择器提升权重，让用户 CSS 稳压主题规则。 */
export function boostCssPriority(cssText = '') {
  return transformRuleSelectors(cssText, boostSelector);
}

/**
 * 仅保留满足契约的规则选择器；不合规项改成永不命中的 :not(*)，保留原规则体和
 * @media/@supports 结构，避免用正则删块时破坏嵌套 CSS。
 */
export function constrainCssSelectors(cssText = '', allowSelector = null) {
  if (typeof allowSelector !== 'function') return String(cssText || '');
  return transformRuleSelectors(cssText, (selector) => (
    allowSelector(selector) ? selector : ':not(*)'
  ));
}

const CHAT_BUBBLE_SELECTOR_PATTERN = /\.(?:scrapbook-bubble|chat-anon-bubble|chat-bubble(?:-[\w-]+)?|chat-msg-(?:group|stack|bubble)(?:-[\w-]+)?|voice-msg(?:-[\w-]+)?|chat-speech-play-btn)(?![\w-])/;

/**
 * 只给气泡相关规则补 ID 级权重。整页聊天 CSS 不能再整体提权，否则其中的
 * composer / viewport 布局会重新压过 iOS 键盘兜底；但气泡视觉仍需压过旧主题
 * 存档里的高权重 `!important` 规则。
 */
export function boostChatBubbleCssPriority(cssText = '') {
  const constrained = constrainCssSelectors(cssText, (selector) => (
    CHAT_BUBBLE_SELECTOR_PATTERN.test(String(selector || ''))
  ));
  return boostCssPriority(constrained);
}

/**
 * 聊天主题中部分背景/边框规则本身带 !important，仅提升选择器仍无法覆盖。
 * 这里只提升纯视觉声明；position/height/overflow/transform 等布局属性保持原级，
 * 让 iOS 键盘、安全区与交互状态的强制规则继续兜底。
 */
export function promoteVisualCssPriority(cssText = '') {
  const visualProperty = [
    '(?:-webkit-)?backdrop-filter',
    '(?:-webkit-)?mask(?:-[\\w-]+)?',
    'background(?:-[\\w-]+)?',
    'border(?:-[\\w-]+)?',
    'box-shadow',
    'color',
    'content',
    'fill',
    'filter',
    'font(?:-[\\w-]+)?',
    'opacity',
    'outline(?:-[\\w-]+)?',
    'stroke(?:-[\\w-]+)?',
    'text-(?:decoration|emphasis|shadow|stroke|fill)(?:-[\\w-]+)?',
  ].join('|');
  const pattern = new RegExp(
    `((?:^|[;{])\\s*(?:${visualProperty})\\s*:\\s*)(?![^;{}]*!important)([^;{}]*)(;|(?=\\}))`,
    'gim',
  );
  let output = String(cssText || '');
  // 分隔符属于整次匹配，相邻声明在同一轮会隔一个命中；重复少量轮次即可覆盖整块，
  // 同时避免使用旧 Safari 不支持的 lookbehind。
  for (let i = 0; i < 4; i += 1) {
    const next = output.replace(pattern, '$1$2 !important$3');
    if (next === output) break;
    output = next;
  }
  return output;
}

/**
 * 聊天整页 CSS 保留普通级联，同时追加一份仅气泡规则的高权重副本。
 * 这样颜色、透明度、边框等能稳定覆盖海/窗及旧自定义主题，又不会把输入栏、
 * 页面高度或安全区布局一并提升到 ID 权重。
 */
export function prepareChatVisualCssPriority(cssText = '') {
  const src = String(cssText || '');
  if (!src.trim()) return src;
  const regular = promoteVisualCssPriority(src);
  const bubbleOverride = prepareChatBubblePriorityOverride(src);
  return `${regular}\n/* bubble visual priority */\n${bubbleOverride}`;
}

/**
 * 只生成气泡相关规则的高权重副本。用于「主屏与全局」CSS：原稿仍按普通级联
 * 作用全站，仅聊天气泡得到与消息界面 CSS 相同的覆盖能力，避免连带提权顶栏、
 * 输入栏或其它页面。
 */
export function prepareChatBubblePriorityOverride(cssText = '') {
  const src = String(cssText || '');
  if (!src.trim()) return src;
  return promoteVisualCssPriority(boostChatBubbleCssPriority(src));
}

/**
 * 兼容旧调用名。聊天顶栏现由独立的 .chat-thread-safe-top flex 槽避让系统栏，
 * 不再分析或改写用户顶栏的 padding / margin。
 */
export function needsChatNavbarSafeMargin() {
  return false;
}

/** 自定义整页 CSS 重写输入栏 padding 时，检查是否把底部系统工具区避让一并覆盖掉了。 */
export function needsChatComposerSafePadding(cssText = '') {
  const src = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(src))) {
    const selector = String(match[1] || '');
    const body = String(match[2] || '');
    if (!selector.includes('.chat-thread-composer')) continue;
    const replacesBottomPadding = /(?:^|;)\s*padding(?:-bottom|-block(?:-end)?)?\s*:/i.test(body);
    const keepsSafeBottom = /var\(\s*--safe-bottom|var\(\s*--safe-area-inset-bottom|env\(\s*safe-area-inset-bottom/i.test(body);
    if (replacesBottomPadding && !keepsSafeBottom) return true;
  }
  return false;
}

/** 自定义输入栏若脱离文档流，工具面板展开时必须临时恢复相邻布局。 */
export function needsChatComposerFlowGuard(cssText = '') {
  const src = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(src))) {
    const selector = String(match[1] || '');
    const body = String(match[2] || '');
    if (!selector.includes('.chat-thread-composer')) continue;
    if (/(?:^|;)\s*(?:position|inset(?:-[a-z]+)?|top|right|bottom|left|translate|transform|margin(?:-[a-z]+)?)\s*:/i.test(body)) {
      return true;
    }
  }
  return false;
}

/** 为聊天整页 CSS 追加底部 chrome 保护；顶部由独立安全区槽负责。 */
export function buildChatChromeSafeAreaGuardCss(cssText = '') {
  const src = String(cssText || '');
  if (!src.trim()) return '';
  const guards = [];
  const composerNeedsSafePadding = needsChatComposerSafePadding(src);
  const composerNeedsFlowGuard = needsChatComposerFlowGuard(src);
  if (composerNeedsSafePadding) {
    guards.push([
      '/* chat composer safe-area guard */',
      '#app .chat-thread-page .chat-thread-composer,',
      '#page-container .chat-thread-page .chat-thread-composer,',
      '.chat-thread-page .chat-thread-composer{',
      '  margin-bottom:var(--safe-bottom, 0px) !important;',
      '}',
    ].join('\n'));
  }
  if (composerNeedsSafePadding || composerNeedsFlowGuard) {
    guards.push([
      '/* chat tools open flow guard */',
      '#app .chat-thread-page.has-chat-tools-open .chat-thread-composer,',
      '#app .chat-thread-page:has(.chat-tools-sheet.is-open) .chat-thread-composer,',
      '#page-container .chat-thread-page.has-chat-tools-open .chat-thread-composer,',
      '#page-container .chat-thread-page:has(.chat-tools-sheet.is-open) .chat-thread-composer,',
      '.chat-thread-page.has-chat-tools-open .chat-thread-composer,',
      '.chat-thread-page:has(.chat-tools-sheet.is-open) .chat-thread-composer{',
      '  position:relative !important;',
      '  inset:auto !important;',
      '  top:auto !important;',
      '  right:auto !important;',
      '  bottom:auto !important;',
      '  left:auto !important;',
      '  transform:none !important;',
      '  translate:none !important;',
      '  margin-bottom:0 !important;',
      '}',
      '#app .chat-thread-page.has-chat-tools-open .chat-tools-sheet.is-open,',
      '#page-container .chat-thread-page.has-chat-tools-open .chat-tools-sheet.is-open,',
      '.chat-thread-page.has-chat-tools-open .chat-tools-sheet.is-open{',
      '  position:relative !important;',
      '  inset:auto !important;',
      '  top:auto !important;',
      '  right:auto !important;',
      '  bottom:auto !important;',
      '  left:auto !important;',
      '  transform:none !important;',
      '  translate:none !important;',
      '  margin-top:0 !important;',
      '}',
    ].join('\n'));
  }
  return guards.join('\n');
}

export function appendChatChromeSafeAreaGuards(cssText = '') {
  const src = String(cssText || '');
  if (!src.trim()) return src;
  const guards = buildChatChromeSafeAreaGuardCss(src);
  return guards ? `${src}\n${guards}` : src;
}

/** 美化工作室各页面的根选择器：注入时用来把用户 CSS 圈在本页作用域内 */
export const BEAUTIFY_PAGE_ROOTS = {
  'chat-thread': ['.chat-thread-page'],
  offline: ['.offline-session-page'],
  home: ['.home-shell-page', '.home-sea-shell', '.home-window-shell'],
  'travel-char': ['.travel-char-page', '.travel-event-page'],
  'chat-hub': ['.chat-hub-page'],
  moments: ['.moments-page'],
  intercepts: ['.chat-intercepts-page'],
  backstage: ['.chat-backstage-page'],
};

/** 与页面根同节点的历史写法（如 .page.chat-thread-page），不能再套成后代 */
const DEFAULT_SELF_ALIASES = ['.page', '.scrapbook-page'];
/** 页面根的祖先容器：应插到祖先之后，而不是包在根里面 */
const DEFAULT_ANCESTOR_SCOPES = ['#page-container', '#app'];
/** 文档根可直接放变量；带后代选择器时仍需把页面根插到正确位置 */
const DEFAULT_DOCUMENT_SCOPES = [':root', 'html', 'body'];

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 拆出选择器第一段（到空格/组合符为止）与剩余 */
function splitSelectorHead(selector = '') {
  const src = String(selector || '');
  const match = src.match(/^([^\s>+~]+)([\s>+~].*)?$/);
  if (!match) return { head: src, tail: '' };
  return { head: match[1], tail: match[2] || '' };
}

function replaceSelfAliasHead(selector = '', prefix = '', selfAliases = []) {
  const { head, tail } = splitSelectorHead(selector);
  for (const alias of selfAliases) {
    const aliasPat = new RegExp(escapeRegExp(alias) + '(?![\\w-])');
    if (!aliasPat.test(head)) continue;
    return {
      matched: true,
      value: `${head.replace(new RegExp(escapeRegExp(alias), 'g'), prefix)}${tail}`,
    };
  }
  return { matched: false, value: selector };
}

function splitLeadingCombinator(tail = '') {
  const src = String(tail || '');
  const match = src.match(/^(\s*(?:[>+~]\s*)?)([\s\S]*)$/);
  return {
    joiner: match?.[1] || ' ',
    rest: String(match?.[2] || '').trimStart(),
  };
}

/**
 * 把不带页面根类的选择器圈进页面作用域：提权后的裸选择器（如 .navbar、button）
 * 否则会泄漏到全站。裸 :root/html/body 保持原样（通常只是定义变量）；
 * 已带任一根类的选择器不重复包。
 *
 * 同节点别名（.page / .scrapbook-page）替换成页面根，避免
 * `.page .navbar` → `.chat-thread-page .page .navbar` 永远匹配不到。
 * 外层容器（#page-container / #app）插到祖先后：
 * `#page-container .navbar` → `#page-container .chat-thread-page .navbar`。
 */
export function scopeCssToPage(cssText, roots = [], options = {}) {
  const list = (Array.isArray(roots) ? roots : [roots]).map((r) => String(r || '').trim()).filter(Boolean);
  if (!list.length) return String(cssText || '');
  const prefix = list.length > 1 ? `:is(${list.join(', ')})` : list[0];
  const rootPattern = new RegExp(list.map((r) => `${escapeRegExp(r)}(?![\\w-])`).join('|'));
  const selfAliases = (Array.isArray(options.selfAliases) ? options.selfAliases : DEFAULT_SELF_ALIASES)
    .map((a) => String(a || '').trim())
    .filter(Boolean);
  const ancestorScopes = (Array.isArray(options.ancestorScopes) ? options.ancestorScopes : DEFAULT_ANCESTOR_SCOPES)
    .map((a) => String(a || '').trim())
    .filter(Boolean);
  const documentScopes = (Array.isArray(options.documentScopes) ? options.documentScopes : DEFAULT_DOCUMENT_SCOPES)
    .map((a) => String(a || '').trim())
    .filter(Boolean);
  const outerScopes = [...ancestorScopes, ...documentScopes];
  const matchesOuterScopeHead = (head) => outerScopes.some((scope) => (
    head === scope
    || head.startsWith(`${scope}[`)
    || head.startsWith(`${scope}.`)
    || head.startsWith(`${scope}#`)
    || head.startsWith(`${scope}:`)
  ));
  const matchesDocumentScopeHead = (head) => documentScopes.some((scope) => (
    head === scope
    || head.startsWith(`${scope}[`)
    || head.startsWith(`${scope}.`)
    || head.startsWith(`${scope}#`)
    || head.startsWith(`${scope}:`)
  ));

  const scopeSelector = (selector) => {
    if (rootPattern.test(selector)) return selector;

    const { head, tail } = splitSelectorHead(selector);
    const selfAlias = replaceSelfAliasHead(selector, prefix, selfAliases);
    if (selfAlias.matched) return selfAlias.value;

    if (matchesOuterScopeHead(head)) {
      // 裸文档根只定义变量时不改目标；#app/#page-container 自身规则则收进当前页。
      if (!tail) return matchesDocumentScopeHead(head) ? selector : `${head} ${prefix}`;

      const { joiner, rest } = splitLeadingCombinator(tail);
      if (!rest) return matchesDocumentScopeHead(head) ? selector : `${head}${joiner}${prefix}`;

      // #app .page .navbar / body .scrapbook-page .navbar：
      // .page 与页面根是同一个节点，直接替换，不能再额外嵌套一层。
      const nestedAlias = replaceSelfAliasHead(rest, prefix, selfAliases);
      if (nestedAlias.matched) return `${head}${joiner}${nestedAlias.value}`;

      // 兼容 html body .page…、body #app .page… 这类多层祖先链。
      const nestedHead = splitSelectorHead(rest).head;
      if (matchesOuterScopeHead(nestedHead)) {
        return `${head}${joiner}${scopeSelector(rest)}`;
      }

      // #page-container > .navbar 应变成
      // #page-container > .chat-thread-page .navbar，而不是把祖先套到页面根里面。
      return `${head}${joiner}${prefix} ${rest}`;
    }

    return `${prefix} ${selector}`;
  };

  return transformRuleSelectors(cssText, scopeSelector);
}
