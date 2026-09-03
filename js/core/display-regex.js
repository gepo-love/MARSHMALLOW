/**
 * 正则组 · 可在保存前永久替换，或仅作用于显示、模型上下文。
 *
 * 设计：一个导入包 = 一组（group），组下多条规则（rule）。
 * 每条规则可单独开关，并多选「用途」(targets) 决定作用于哪些页面与生成链路。
 *
 * 存储：settings.displayRegexGroups（数组）。不新增 store。
 * 应用：primeDisplayRegex() 预热缓存 → applyDisplayRegex(text, surface) 同步调用。
 */

import { get as dbGet, put as dbPut, onStoreWrite } from './db.js';
import { stripNamePrefix } from './regex-zip-import.js';

const STORE_KEY = 'displayRegexGroups';
const BUILTIN_DEGREE_CLEANUP_SEEDED_KEY = 'displayRegexBuiltinDegreeCleanupSeededV1';
const BUILTIN_CLICHE_CLEANUP_SEEDED_KEY = 'displayRegexBuiltinClicheCleanupSeededV1';
const BUILTIN_CLICHE_CLEANUP_DEFAULT_OFF_KEY = 'displayRegexBuiltinClicheCleanupDefaultOffV2';
const MAX_INPUT_LEN = 200000;

/** 渲染面登记表（用途）。新增渲染面在此追加即可。 */
export const REGEX_SURFACES = [
  { id: 'offline', label: '线下沉浸' },
  { id: 'storycard', label: '小剧场卡' },
  { id: 'autheater', label: '番外剧场' },
  { id: 'timemachine', label: '时光机' },
  { id: 'radio', label: '角色电台' },
  { id: 'chat', label: '聊天与心声' },
];

/** placement 作用范围 */
export const REGEX_PLACEMENTS = [
  { id: 1, label: '用户输入' },
  { id: 2, label: '角色消息' },
  { id: 3, label: '斜杠命令' },
  { id: 4, label: '世界书' },
  { id: 5, label: '推理内容' },
  { id: 6, label: '工具输出' },
];

/** Ephemerality（markdownOnly / promptOnly 的四种组合） */
export const REGEX_EXEC_MODES = [
  { id: 'permanent', label: '永久替换（显示和模型）' },
  { id: 'display', label: '仅改变显示' },
  { id: 'prompt', label: '仅改变模型上下文' },
  { id: 'ephemeral', label: '显示和模型（原文不变）' },
];

/** 参数替换 substituteRegex */
export const REGEX_SUBSTITUTE_MODES = [
  { id: 0, label: '不替换' },
  { id: 1, label: '替换' },
  { id: 2, label: '转义替换' },
];

export const DEFAULT_TARGETS = REGEX_SURFACES.map((surface) => surface.id);

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeTargets(list) {
  if (list == null) return [...DEFAULT_TARGETS];
  const valid = new Set(REGEX_SURFACES.map((s) => s.id));
  const out = (Array.isArray(list) ? list : []).map((x) => String(x)).filter((x) => valid.has(x));
  return [...new Set(out)];
}

function sanitizePlacement(list) {
  if (list == null) return [2];
  const valid = new Set(REGEX_PLACEMENTS.map((p) => p.id));
  const out = (Array.isArray(list) ? list : [list])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && valid.has(x));
  return [...new Set(out)];
}

function sanitizeTrimStrings(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => String(x ?? '')).filter(Boolean);
}

export function execModeFromRule(rule = {}) {
  if (rule.markdownOnly && rule.promptOnly) return 'ephemeral';
  if (rule.markdownOnly) return 'display';
  if (rule.promptOnly) return 'prompt';
  return 'permanent';
}

export function applyExecModeToRule(rule, modeId) {
  const mode = String(modeId || 'permanent');
  rule.markdownOnly = mode === 'display' || mode === 'ephemeral';
  rule.promptOnly = mode === 'prompt' || mode === 'ephemeral';
  return rule;
}

export function labelForPlacement(ids = []) {
  const set = new Set(sanitizePlacement(ids));
  const labels = REGEX_PLACEMENTS.filter((p) => set.has(p.id)).map((p) => p.label);
  return labels.length ? labels.join('、') : '未选择';
}

export function labelForExecMode(rule = {}) {
  return REGEX_EXEC_MODES.find((m) => m.id === execModeFromRule(rule))?.label || '永久替换（显示和模型）';
}

export function labelForSubstitute(value = 0) {
  const n = Number(value) || 0;
  return REGEX_SUBSTITUTE_MODES.find((m) => m.id === n)?.label || '不替换';
}

/** 把 findRegex（可能是 /body/flags 形式）拆成 {source, flags}。 */
function parseFindRegex(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const m = text.match(/^\/([\s\S]*)\/([a-z]*)$/i);
  if (m) {
    const flags = [...new Set(m[2].split(''))].join('');
    return { source: m[1], flags };
  }
  return { source: text, flags: '' };
}

/** replaceString：{{match}} → $&；其余 $1 等原样。 */
function normalizeReplace(raw) {
  return String(raw ?? '').replace(/\{\{match\}\}/gi, '$&');
}

function applyReplaceTemplate(replace, match, groups) {
  const tmpl = normalizeReplace(replace);
  // 单次扫描替换 $& / $n，函数返回值不会被再次当作 $ 模板解析，
  // 因此捕获内容里的 $ 不会污染输出（旧实现用 String.replace 字符串替换会出错）。
  return tmpl.replace(/\$(&|\d{1,2})/g, (whole, key) => {
    if (key === '&') return match;
    const idx = Number(key);
    if (idx >= 0 && idx < groups.length) return groups[idx] != null ? String(groups[idx]) : '';
    return whole;
  });
}

function trimMatchedText(match, trimStrings = []) {
  let out = match;
  for (const ts of trimStrings) {
    if (!ts) continue;
    out = out.split(String(ts)).join('');
  }
  return out;
}

/** 单条规则是否参与指定阶段。runOnEdit 仅控制永久规则在手动编辑后是否重跑。 */
export function ruleAppliesToPhase(rule = {}, phase = 'display', { onEdit = false, includePermanent = false } = {}) {
  if (rule.enabled === false) return false;
  if (phase === 'permanent') {
    if (rule.markdownOnly || rule.promptOnly) return false;
    return !onEdit || rule.runOnEdit === true;
  }
  if (phase === 'prompt') {
    return rule.promptOnly === true
      || (includePermanent && !rule.markdownOnly && !rule.promptOnly);
  }
  if (phase === 'display') {
    return rule.markdownOnly === true
      || (includePermanent && !rule.markdownOnly && !rule.promptOnly);
  }
  return false;
}

export function ruleAppliesToDisplay(rule = {}) {
  return ruleAppliesToPhase(rule, 'display');
}

export function createRegexRule(input = {}) {
  let source;
  let flags;
  if (typeof input.findRegex === 'string') {
    const parsed = parseFindRegex(input.findRegex) || { source: '', flags: '' };
    source = parsed.source;
    flags = parsed.flags;
  } else {
    source = String(input.find ?? '');
    flags = input.flags != null ? String(input.flags) : '';
  }
  const rule = {
    id: String(input.id || '').trim() || genId('rxr'),
    name: String(input.name || input.scriptName || '规则').trim() || '规则',
    find: source,
    flags,
    replace: normalizeReplace(input.replace ?? input.replaceString ?? ''),
    enabled: input.enabled !== false && input.disabled !== true,
    targets: sanitizeTargets(input.targets),
    trimStrings: sanitizeTrimStrings(input.trimStrings),
    placement: sanitizePlacement(input.placement),
    markdownOnly: !!input.markdownOnly,
    promptOnly: !!input.promptOnly,
    runOnEdit: !!input.runOnEdit,
    substituteRegex: Number.isFinite(Number(input.substituteRegex)) ? Number(input.substituteRegex) : 0,
    minDepth: input.minDepth == null || input.minDepth === '' ? null : Number(input.minDepth),
    maxDepth: input.maxDepth == null || input.maxDepth === '' ? null : Number(input.maxDepth),
  };
  if (Number.isNaN(rule.minDepth)) rule.minDepth = null;
  if (Number.isNaN(rule.maxDepth)) rule.maxDepth = null;
  return rule;
}

export function createRegexGroup(input = {}) {
  return {
    id: String(input.id || '').trim() || genId('rxg'),
    name: String(input.name || '正则组').trim() || '正则组',
    source: String(input.source || '').trim(),
    enabled: input.enabled !== false,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    rules: (Array.isArray(input.rules) ? input.rules : []).map((r) => createRegexRule(r)),
  };
}

export const BUILTIN_DEGREE_CLEANUP_GROUP_ID = 'builtin_degree_cleanup_v1';
export const BUILTIN_CLICHE_CLEANUP_GROUP_ID = 'builtin_cliche_cleanup_v1';

/**
 * Gemini 等模型在长篇叙事中容易把“极其 / 极度 / 极为”当成无信息量的程度垫词。
 * 作为可见、可关闭的内置正则组投放，不碰用户输入、世界书、推理内容和普通聊天。
 */
export function createBuiltinDegreeCleanupGroup() {
  return createRegexGroup({
    id: BUILTIN_DEGREE_CLEANUP_GROUP_ID,
    name: '内置 · 程度词清理',
    source: 'builtin',
    enabled: true,
    order: -100,
    rules: [{
      id: 'builtin_remove_extreme_degree_adverbs_v1',
      name: '去除“极其 / 极度 / 极为”',
      findRegex: '/(?:极其|极度|极为)/g',
      replaceString: '',
      enabled: true,
      targets: ['offline', 'storycard', 'autheater', 'timemachine', 'radio'],
      placement: [2],
      runOnEdit: true,
    }],
  });
}

/**
 * 折叠叙事中常见的“先虚构一个反面，再用正面动作纠正”句式。
 * 规则有意保持保守：只处理同一句内结构明确的转折，不碰独立否定句和引号内对白。
 */
export function createBuiltinClicheCleanupGroup() {
  const narrativeTargets = ['offline', 'storycard', 'autheater', 'timemachine', 'radio'];
  const actionLead = '(?:径直|直接|转而|干脆|顺势|继续|随手|稍微|微微|选择|伸|抬|低|侧|转|收|走|看|望|盯|站|坐|靠|停|说|问|笑|拿|端|握|拎|穿|套|披|带|放|递|推|拉|开|关|绕|喝|吃|把|将|往|向|朝)';
  const sentenceLead = '(^|[。！？!?；\\n])([ \\t]*)(?![“”"\'‘’])([^，,。！？!?；：:\\n]{1,20}?)';
  return createRegexGroup({
    id: BUILTIN_CLICHE_CLEANUP_GROUP_ID,
    name: '内置 · 八股句式清理（激进）',
    source: 'builtin',
    enabled: false,
    order: -90,
    rules: [
      {
        id: 'builtin_collapse_double_negative_setup_v1',
        name: '折叠“没有…也没有…而是…”',
        findRegex: `/${sentenceLead}(?:(?:并|却|也|还|其实|原本|本来|甚至|完全|根本))?(?:没有|没)[^，,。！？!?；\\n]{1,100}[，,]\\s*(?:也)?(?:没有|没)[^，,。！？!?；\\n]{1,100}[，,]\\s*(?:而是|只是|反而)(?=\\S)/g`,
        replaceString: '$1$2$3',
        enabled: true,
        targets: narrativeTargets,
        placement: [2],
        runOnEdit: true,
      },
      {
        id: 'builtin_collapse_negative_setup_v1',
        name: '折叠“没有…而是 / 只是…”',
        findRegex: `/${sentenceLead}(?:(?:并|却|也|还|其实|原本|本来|甚至|完全|根本))?(?:没有|没)[^，,。！？!?；\\n]{1,100}[，,]\\s*(?:而是|只是|反而)(?=\\S)/g`,
        replaceString: '$1$2$3',
        enabled: true,
        targets: narrativeTargets,
        placement: [2],
        runOnEdit: true,
      },
      {
        id: 'builtin_collapse_negative_action_setup_v1',
        name: '折叠“没…，只做…”',
        findRegex: `/${sentenceLead}(?:(?:并|却|也|还|其实|原本|本来|甚至|完全|根本))?(?:没有|没)[^，,。！？!?；\\n]{1,100}[，,]\\s*只(?=${actionLead})/g`,
        replaceString: '$1$2$3',
        enabled: true,
        targets: narrativeTargets,
        placement: [2],
        runOnEdit: true,
      },
      {
        id: 'builtin_collapse_this_is_not_v1',
        name: '折叠“这 / 那不是…而是…”',
        findRegex: '/(^|[。！？!?；\\n])([ \\t]*)(?![“”"\'‘’])([这那])(?:并|却|也|还|其实|原本|本来)?(?:不是|并非)[^，,。！？!?；\\n]{1,100}[，,]\\s*(?:而是|只是)(?=\\S)/g',
        replaceString: '$1$2$3是',
        enabled: true,
        targets: narrativeTargets,
        placement: [2],
        runOnEdit: true,
      },
      {
        id: 'builtin_collapse_not_action_setup_v1',
        name: '折叠“不是…而是做…”',
        findRegex: `/${sentenceLead}(?:(?:并|却|也|还|其实|原本|本来))?(?:不是|并非)[^，,。！？!?；\\n]{1,100}[，,]\\s*(?:而是|反而)(?=${actionLead})/g`,
        replaceString: '$1$2$3',
        enabled: true,
        targets: narrativeTargets,
        placement: [2],
        runOnEdit: true,
      },
    ],
  });
}

export async function listRegexGroups() {
  const [row, degreeSeededRow, clicheSeededRow, clicheDefaultOffRow] = await Promise.all([
    dbGet(STORE_KEY),
    dbGet(BUILTIN_DEGREE_CLEANUP_SEEDED_KEY),
    dbGet(BUILTIN_CLICHE_CLEANUP_SEEDED_KEY),
    dbGet(BUILTIN_CLICHE_CLEANUP_DEFAULT_OFF_KEY),
  ]);
  const list = Array.isArray(row?.value) ? [...row.value] : [];
  let changed = false;
  if (degreeSeededRow?.value !== true) {
    if (!list.some((group) => String(group?.id || '') === BUILTIN_DEGREE_CLEANUP_GROUP_ID)) {
      list.push(createBuiltinDegreeCleanupGroup());
      changed = true;
    }
    await dbPut({ key: BUILTIN_DEGREE_CLEANUP_SEEDED_KEY, value: true });
  }
  if (clicheSeededRow?.value !== true) {
    if (!list.some((group) => String(group?.id || '') === BUILTIN_CLICHE_CLEANUP_GROUP_ID)) {
      list.push(createBuiltinClicheCleanupGroup());
      changed = true;
    }
    await dbPut({ key: BUILTIN_CLICHE_CLEANUP_SEEDED_KEY, value: true });
  }
  // 旧版本曾把激进句式替换默认打开。它会在否定半句携带主语或宾语时
  // 生成“搭在了扶手上”一类残句，因此统一迁移为默认关闭；用户之后仍可手动开启。
  if (clicheDefaultOffRow?.value !== true) {
    const builtin = list.find((group) => String(group?.id || '') === BUILTIN_CLICHE_CLEANUP_GROUP_ID);
    if (builtin?.enabled !== false) {
      builtin.enabled = false;
      changed = true;
    }
    await dbPut({ key: BUILTIN_CLICHE_CLEANUP_DEFAULT_OFF_KEY, value: true });
  }
  if (changed) await dbPut({ key: STORE_KEY, value: list });
  return list.map((g) => createRegexGroup(g)).sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function getRegexGroup(groupId) {
  const id = String(groupId || '').trim();
  if (!id) return null;
  const groups = await listRegexGroups();
  return groups.find((g) => g.id === id) || null;
}

export async function saveRegexGroups(groups) {
  const clean = (Array.isArray(groups) ? groups : []).map((g, i) => ({
    ...createRegexGroup(g),
    order: Number.isFinite(Number(g.order)) ? Number(g.order) : i,
  }));
  await dbPut({ key: STORE_KEY, value: clean });
  refreshCache(clean);
  return clean;
}

export async function upsertRegexGroup(group) {
  const next = createRegexGroup(group);
  const groups = await listRegexGroups();
  const idx = groups.findIndex((g) => g.id === next.id);
  if (idx >= 0) groups[idx] = next;
  else {
    next.order = groups.length;
    groups.push(next);
  }
  return saveRegexGroups(groups);
}

export async function upsertRegexRule(groupId, ruleInput) {
  const gid = String(groupId || '').trim();
  if (!gid) throw new Error('缺少正则组');
  const groups = await listRegexGroups();
  let group = groups.find((g) => g.id === gid);
  if (!group) {
    group = createRegexGroup({ id: gid, name: '新建正则组', rules: [] });
    group.order = groups.length;
    groups.push(group);
  }
  const rule = createRegexRule(ruleInput);
  const idx = (group.rules || []).findIndex((r) => r.id === rule.id);
  if (idx >= 0) group.rules[idx] = rule;
  else group.rules.push(rule);
  await saveRegexGroups(groups);
  return { group, rule };
}

export async function deleteRegexRule(groupId, ruleId) {
  const gid = String(groupId || '').trim();
  const rid = String(ruleId || '').trim();
  const groups = await listRegexGroups();
  const group = groups.find((g) => g.id === gid);
  if (!group) return groups;
  group.rules = (group.rules || []).filter((r) => r.id !== rid);
  await saveRegexGroups(groups);
  return groups;
}

export async function deleteRegexGroup(groupId) {
  const gid = String(groupId || '').trim();
  const groups = (await listRegexGroups()).filter((g) => g.id !== gid);
  return saveRegexGroups(groups);
}

function extractRawRules(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rules)) return data.rules;
  if (Array.isArray(data?.regex)) return data.regex;
  if (Array.isArray(data?.regexScripts)) return data.regexScripts;
  if (Array.isArray(data?.scripts)) return data.scripts;
  if (data && (data.findRegex || data.find)) return [data];
  return null;
}

/** 从 JSON 文本导入为一组（保序）。 */
export function parseRegexImport(text, sourceName = '') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message || e}`);
  }

  const rawRules = extractRawRules(data);
  if (!rawRules) {
    throw new Error('未识别的正则格式：需要 regex / rules 数组，或单条正则对象');
  }

  const rules = rawRules
    .map((r) => createRegexRule(r))
    .filter((r) => r.find);
  if (!rules.length) throw new Error('未找到可用的正则规则');

  const name = String(data?.name || sourceName || '导入正则组')
    .replace(/\.json$/i, '')
    .trim() || '导入正则组';
  return createRegexGroup({ name, source: 'import', rules });
}

/** 从多条 { name, text } 文件条目合并为一组。 */
export function parseRegexImportEntries(entries = [], groupName = '') {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new Error('没有可导入的文件');

  const rules = [];
  for (const entry of list) {
    const text = String(entry?.text || '').trim();
    if (!text) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      continue;
    }
    const rawRules = extractRawRules(data);
    if (!rawRules) continue;
    for (const raw of rawRules) {
      const rule = createRegexRule({
        ...raw,
        name: raw?.scriptName || raw?.name || stripNamePrefix(entry?.name || '') || '规则',
      });
      if (rule.find) rules.push(rule);
    }
  }
  if (!rules.length) throw new Error('文件中未找到可用的正则规则');

  const fallbackName = stripNamePrefix(list[0]?.name || '') || '导入正则组';
  const name = String(groupName || fallbackName).replace(/\.(json|zip)$/i, '').trim() || '导入正则组';
  return createRegexGroup({ name, source: 'import', rules });
}

export async function importRegexGroup(text, sourceName = '') {
  const group = parseRegexImport(text, sourceName);
  const groups = await listRegexGroups();
  group.order = groups.length;
  groups.push(group);
  await saveRegexGroups(groups);
  return group;
}

export async function importRegexGroupFromEntries(entries, groupName = '') {
  const group = parseRegexImportEntries(entries, groupName);
  const groups = await listRegexGroups();
  group.order = groups.length;
  groups.push(group);
  await saveRegexGroups(groups);
  return group;
}

/* ---------- 编译缓存 + 应用 ---------- */

let _cache = null;

onStoreWrite('settings', (key) => {
  if (key === undefined || [
    STORE_KEY,
    BUILTIN_DEGREE_CLEANUP_SEEDED_KEY,
    BUILTIN_CLICHE_CLEANUP_SEEDED_KEY,
    BUILTIN_CLICHE_CLEANUP_DEFAULT_OFF_KEY,
  ].includes(String(key || ''))) {
    _cache = null;
  }
});

function compileGroups(groups) {
  const compiled = [];
  for (const g of groups) {
    if (g.enabled === false) continue;
    for (const r of g.rules || []) {
      if (r.enabled === false || !r.find) continue;
      const flags = [...new Set(String(r.flags || '').split(''))].join('');
      let regex = null;
      if (!r.substituteRegex) {
        try {
          regex = new RegExp(r.find, flags);
        } catch (_) {
          continue;
        }
      }
      compiled.push({
        ...r,
        source: r.find,
        flags,
        regex,
        replace: r.replace ?? '',
        trimStrings: sanitizeTrimStrings(r.trimStrings),
        targets: new Set(r.targets || DEFAULT_TARGETS),
        placementSet: new Set(r.placement || [2]),
      });
    }
  }
  return compiled;
}

function refreshCache(groups) {
  _cache = { compiled: compileGroups(groups || []), primed: true };
}

/** 页面渲染前调用一次，载入并编译当前正则组。 */
export async function primeDisplayRegex() {
  if (_cache?.primed) return _cache;
  const groups = await listRegexGroups();
  refreshCache(groups);
  return _cache;
}

export const primeRegex = primeDisplayRegex;

function escapeRegexText(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function substituteFindMacros(source, mode, macros = {}) {
  if (!mode) return source;
  return String(source || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(macros, key)) return whole;
    const value = String(macros[key] ?? '');
    return Number(mode) === 2 ? escapeRegexText(value) : value;
  });
}

function contextMatchesRule(rule, context = {}) {
  if (context.surface && !rule.targets.has(String(context.surface))) return false;
  const placements = Array.isArray(context.placement) ? context.placement : [context.placement];
  const validPlacements = placements.map(Number).filter(Number.isFinite);
  if (validPlacements.length && !validPlacements.some((id) => rule.placementSet.has(id))) return false;
  const depth = Number(context.depth);
  if (context.depth != null && Number.isFinite(depth)) {
    if (rule.minDepth != null && Number(rule.minDepth) >= 0 && depth < Number(rule.minDepth)) return false;
    if (rule.maxDepth != null && Number(rule.maxDepth) >= 0 && depth > Number(rule.maxDepth)) return false;
  }
  return true;
}

function regexForRule(rule, macros = {}) {
  if (!rule.substituteRegex) {
    rule.regex.lastIndex = 0;
    return rule.regex;
  }
  const source = substituteFindMacros(rule.source, rule.substituteRegex, macros);
  try {
    return new RegExp(source, rule.flags);
  } catch (_) {
    return null;
  }
}

function applyCompiledRules(text, compiled, context = {}) {
  const input = String(text ?? '');
  if (input.length > MAX_INPUT_LEN) return input;
  const phase = String(context.phase || 'display');
  let out = input;
  for (const rule of compiled || []) {
    if (!ruleAppliesToPhase(rule, phase, {
      onEdit: context.onEdit === true,
      includePermanent: context.includePermanent === true,
    })) continue;
    if (!contextMatchesRule(rule, context)) continue;
    const regex = regexForRule(rule, context.macros || {});
    if (!regex) continue;
    try {
      out = out.replace(regex, (...args) => {
        const match = args[0];
        const hasNamedGroups = args.length >= 4 && typeof args[args.length - 1] === 'object';
        const captures = args.slice(1, hasNamedGroups ? -3 : -2);
        const groups = [match, ...captures];
        const trimmed = trimMatchedText(match, rule.trimStrings);
        return applyReplaceTemplate(rule.replace, trimmed, groups);
      });
    } catch (_) { /* 单条失败不影响其它 */ }
    if (out.length > MAX_INPUT_LEN) break;
  }
  return out;
}

/** 纯函数入口，供测试、预览和尚未预热的局部规则使用。 */
export function applyRegexWithRules(text, rules = [], context = {}) {
  const group = createRegexGroup({ name: 'preview', rules });
  return applyCompiledRules(text, compileGroups([group]), context);
}

/** 同步统一入口；页面/生成链路需先 primeRegex()。 */
export function applyRegex(text, context = {}) {
  const input = String(text ?? '');
  if (!_cache || !_cache.compiled.length) return input;
  return applyCompiledRules(input, _cache.compiled, context);
}

export function applyDisplayRegex(text, surface, context = {}) {
  return applyRegex(text, {
    placement: context.placement ?? 2,
    ...context,
    includePermanent: true,
    phase: 'display',
    surface,
  });
}

export function applyPromptRegex(text, context = {}) {
  return applyRegex(text, { ...context, includePermanent: true, phase: 'prompt' });
}

export function applyPermanentRegex(text, context = {}) {
  return applyRegex(text, { ...context, phase: 'permanent' });
}

export function applyEditRegex(text, context = {}) {
  return applyPermanentRegex(text, { ...context, onEdit: true });
}

export function hasPrimedRegex() {
  return !!(_cache && _cache.compiled.length);
}
