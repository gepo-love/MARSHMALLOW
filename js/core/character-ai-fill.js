import {
  createCharacterProfile,
  createEmptyLifeProfile,
  createEmptyResidenceAnchor,
  normalizeRoleTier,
} from '../models/character.js';
import { chatForTask, getConfig, getToolConfig } from './api.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';

const BLOCK_FIELD_KEYS = new Set(['personality', 'speechStyle', 'commonEmotes', 'speechCorpus', 'promptCorpus', 'notes']);

const TEXT_LABEL_RULES = [
  { key: 'name', patterns: [/^(?:备注名|通讯录备注|显示名|名字|姓名|名称|称呼|角色名|remarkName|name|displayName)\s*[:：=]\s*(.*)$/i] },
  { key: 'realName', patterns: [/^(?:真名|本名|realName|fullName)\s*[:：=]\s*(.*)$/i] },
  { key: 'aliases', patterns: [/^(?:别名|aliases)\s*[:：=]\s*(.*)$/i], aliases: true },
  { key: 'birthDate', patterns: [/^(?:出生日期|生日|birthDate)\s*[:：=]\s*(.*)$/i] },
  { key: 'currentRole', patterns: [/^(?:身份|定位|职业|角色定位|currentRole|occupation|identity)\s*[:：=]\s*(.*)$/i] },
  { key: 'userRelationStatus', patterns: [/^(?:与用户关系|和用户关系|当前关系|关系状态|用户关系|userRelationStatus|relationshipWithUser|relationWithUser)\s*[:：=]\s*(.*)$/i] },
  { key: 'currentStatus', patterns: [/^(?:当前状态|状态|currentStatus|status)\s*[:：=]\s*(.*)$/i] },
  { key: 'personality', patterns: [/^(?:性格|性格底色|人设|描述|personality|description|persona)\s*[:：=]\s*(.*)$/i] },
  { key: 'speechStyle', patterns: [/^(?:说话风格|口吻|语气|speechStyle|speaking_style)\s*[:：=]\s*(.*)$/i] },
  { key: 'commonEmotes', patterns: [/^(?:常用表情|常用emoji|emoji|颜文字|常用颜文字|commonEmotes|favoriteEmotes)\s*[:：=]\s*(.*)$/i] },
  { key: 'speechCorpus', patterns: [/^(?:语料库|对话示例|示例对话|口吻语料|speechCorpus|corpus|examples|mes_example)\s*[:：=]\s*(.*)$/i] },
  { key: 'promptCorpus', patterns: [/^(?:整段设定|角色设定|人物设定|promptCorpus)\s*[:：=]\s*(.*)$/i] },
  { key: 'notes', patterns: [/^(?:备注|notes|creator_notes)\s*[:：=]\s*(.*)$/i] },
  { key: 'roleTier', patterns: [/^(?:陪伴类型|roleTier)\s*[:：=]\s*(.*)$/i] },
];

const LIFE_LABEL_RULES = [
  { key: 'homeDetails', patterns: [/^(?:居家细节|homeDetails)\s*[:：=]\s*(.*)$/i] },
  { key: 'familyThreads', patterns: [/^(?:家庭线索|familyThreads)\s*[:：=]\s*(.*)$/i] },
  { key: 'socialAnchors', patterns: [/^(?:社交锚点|socialAnchors)\s*[:：=]\s*(.*)$/i] },
  { key: 'habits', patterns: [/^(?:习惯与小癖|习惯|habits)\s*[:：=]\s*(.*)$/i] },
  { key: 'activitySeeds', patterns: [/^(?:活动种子|activitySeeds)\s*[:：=]\s*(.*)$/i] },
];

const MAP_LABEL_RULES = [
  { key: 'city', patterns: [/^(?:所在城市|城市|city)\s*[:：=]\s*(.*)$/i] },
  { key: 'realCityMap', patterns: [/^(?:映射现实城市|现实城市|realCityMap)\s*[:：=]\s*(.*)$/i] },
  { key: 'weatherHint', patterns: [/^(?:天气描述|天气|weatherHint)\s*[:：=]\s*(.*)$/i] },
  { key: 'area', patterns: [/^(?:区域|片区|area)\s*[:：=]\s*(.*)$/i] },
  { key: 'label', patterns: [/^(?:住址标签|label)\s*[:：=]\s*(.*)$/i] },
  { key: 'mapQuery', patterns: [/^(?:地图检索词|mapQuery)\s*[:：=]\s*(.*)$/i] },
  { key: 'note', patterns: [/^(?:地图补充|补充说明|note)\s*[:：=]\s*(.*)$/i] },
];

const AI_OUTPUT_KEYS = [
  'name', 'realName', 'aliases', 'birthDate', 'notes',
  'currentRole', 'userRelationStatus', 'currentStatus', 'personality', 'speechStyle', 'speechCorpus', 'promptCorpus',
  'commonEmotes', 'appearancePrompt', 'roleTier', 'defaultEmoji',
  'lifeProfile', 'residenceAnchor',
];

const ACTIVE_AI_FILL_REQUESTS = new Map();
const MAX_AI_FILL_DIAGNOSTIC_CHARS = 250_000;

/**
 * 全部「可由 AI 补全」的字段定义（单一事实来源）。
 * group: top=顶层标量 / life=lifeProfile.* / anchor=residenceAnchor.*
 * desc 会写进提示词，告诉 AI 每个待补字段要什么。
 */
const FIELD_DEFS = [
  { key: 'name', label: '备注名', desc: '通讯录里看到的名字', group: 'top' },
  { key: 'realName', label: '真名', desc: '真名 / 本名', group: 'top' },
  { key: 'aliases', label: '别名', desc: '别名（数组）', group: 'top', aliases: true },
  { key: 'birthDate', label: '出生日期', desc: 'YYYY-MM-DD；拿不准可留空', group: 'top' },
  { key: 'currentRole', label: '身份', desc: '职业 / 身份 / 一句话定位', group: 'top' },
  { key: 'userRelationStatus', label: '与用户关系状态', desc: '用户与角色的当前关系定位；须从角色资料、身份、口吻与已有关系线索推断，勿默认恋人或暧昧。可为家人/亲友/同事/邻居/师徒/刚认识/合作者等；仅当资料明确指向情感线时才写暧昧或恋人', group: 'top' },
  { key: 'currentStatus', label: '当前状态', desc: '最近在忙什么', group: 'top' },
  { key: 'personality', label: '性格底色', desc: '性格、反差、弱点、行动逻辑', group: 'top', multiline: true },
  { key: 'speechStyle', label: '说话风格', desc: '用词、语气、口头禅、对熟人 / 陌生人的差异', group: 'top', multiline: true },
  { key: 'speechCorpus', label: '语料库', desc: '示例句、口头禅、情绪触发时的反应、绝对不会说的话', group: 'top', multiline: true },
  { key: 'commonEmotes', label: '常用 Emoji / 颜文字', desc: '角色聊天时的表情与标点习惯；只从原始资料中的明确证据提取，勿根据年龄、职业、关系位置或性格标签擅自生成。资料未提及可以填「无」；仅当资料明确使用时才列 emoji、颜文字、标点或语气词', group: 'top', multiline: true },
  { key: 'appearancePrompt', label: '生图外观描述', desc: '外貌、发型、穿搭、气质（可作为生图提示词）', group: 'top', multiline: true },
  { key: 'promptCorpus', label: '整段设定', desc: '整段人物设定、外貌、背景、关系、性格调色盘等原始资料', group: 'top', multiline: true },
  { key: 'roleTier', label: '陪伴类型', desc: 'main / supporting / npc / background 四选一', group: 'top' },
  { key: 'defaultEmoji', label: '默认 Emoji', desc: '一个最能代表角色的 emoji', group: 'top' },
  { key: 'notes', label: '本地备注', desc: '给用户自己看的备忘（可留空）', group: 'top', multiline: true },
  { key: 'homeDetails', label: '居家细节', desc: '房间、宠物、常待的角落', group: 'life', multiline: true },
  { key: 'familyThreads', label: '家庭线索', desc: '家人、节日、未说出口的事', group: 'life', multiline: true },
  { key: 'socialAnchors', label: '社交锚点', desc: '常去的店、固定饭局、小圈子', group: 'life', multiline: true },
  { key: 'habits', label: '习惯与小癖', desc: '熬夜、收集、口头禅外的小动作', group: 'life', multiline: true },
  { key: 'activitySeeds', label: '活动种子', desc: '可一起做的活动，逗号或短句分隔', group: 'life', multiline: true },
  { key: 'city', label: '故事城市', desc: '可虚拟也可真实', group: 'anchor' },
  { key: 'realCityMap', label: '现实城市', desc: '用于天气 / 地图，如上海、杭州、成都', group: 'anchor' },
  { key: 'weatherHint', label: '天气描述', desc: '拿不准可留空', group: 'anchor' },
  { key: 'area', label: '活动片区', desc: '如老城区、大学城、河边', group: 'anchor' },
  { key: 'label', label: '住址标签', desc: '如合租公寓、工作室附近', group: 'anchor' },
  { key: 'mapQuery', label: '真实地点 / 地标', desc: '商圈、学校、车站、常去店铺等', group: 'anchor' },
  { key: 'note', label: '地图备注', desc: '出没半径、通勤偏好、常出现的路口', group: 'anchor', multiline: true },
];

function fieldId(def) {
  if (def.group === 'life') return `lifeProfile.${def.key}`;
  if (def.group === 'anchor') return `residenceAnchor.${def.key}`;
  return def.key;
}

const FIELD_LABELS = FIELD_DEFS.reduce((acc, def) => {
  acc[fieldId(def)] = def.label;
  return acc;
}, {});

const MULTILINE_FIELDS = new Set(
  FIELD_DEFS.filter((def) => def.multiline).map(fieldId),
);

const REVIEW_SCALAR_KEYS = FIELD_DEFS.filter((def) => def.group === 'top').map((def) => def.key);

function pickString(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const s = String(values[i] || '').trim();
    if (s) return s;
  }
  return '';
}

function normalizeAliases(value) {
  if (Array.isArray(value)) {
    return value.map((a) => String(a || '').trim()).filter(Boolean);
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw.split(/[/|、,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
}

function normalizePasteText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function cleanCharacterSourceText(text) {
  return normalizePasteText(text)
    .replace(/<\/?(?:Char|Character_Card|Character_[^>\s]+|sample_[^>\s]+)>/gi, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inferNameFromEnvelope(text) {
  const raw = normalizePasteText(text);
  const hit = raw.match(/<Character_([^>\n]+)>/i)
    || raw.match(/<Char(?:acter)?[^>]*>\s*<Character_([^>\n]+)>/i);
  return hit ? String(hit[1] || '').trim() : '';
}

function looksLikeRichCharacterText(text) {
  const raw = normalizePasteText(text).trim();
  if (raw.length < 120) return false;
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 8) return true;
  if (/<\/?(?:Char|Character_Card|Character_[^>\s]+|sample_[^>\s]+)>/i.test(raw)) return true;
  return /(?:角色档案|基本信息|外貌特征|背景设定|关系设定|性格调色盘|衣柜|示例对话|sample_|经历线|家庭成员)/.test(raw);
}

function mergePromptCorpus(existing, corpus) {
  const a = String(existing || '').trim();
  const b = cleanCharacterSourceText(corpus);
  if (!b) return a;
  if (!a) return b;
  if (a.includes(b) || b.includes(a)) return b.length > a.length ? b : a;
  return `${a}\n\n【原始角色资料】\n${b}`.trim();
}

function normalizeLabelLine(line) {
  let t = String(line || '').trim();
  if (!t) return t;
  t = t.replace(/^\d+[\.\)、]\s*/, '');
  t = t.replace(/^[-*•·▪]+\s*/, '');
  const bracket = t.match(/^【\s*([^】]+?)\s*】\s*[:：=]?\s*(.*)$/);
  if (bracket) return `${String(bracket[1] || '').trim()}：${String(bracket[2] || '').trim()}`;
  return t.replace(/\t/g, '：');
}

function relaxJsonText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

const LOOSE_JSON_TOP_KEYS = new Set(
  FIELD_DEFS.filter((def) => def.group === 'top').map((def) => def.key),
);
const LOOSE_JSON_LIFE_KEYS = new Set(
  FIELD_DEFS.filter((def) => def.group === 'life').map((def) => def.key),
);
const LOOSE_JSON_ANCHOR_KEYS = new Set(
  FIELD_DEFS.filter((def) => def.group === 'anchor').map((def) => def.key),
);
const LOOSE_JSON_SCAN_KEYS = [
  ...LOOSE_JSON_TOP_KEYS,
  'lifeProfile',
  'residenceAnchor',
  ...LOOSE_JSON_LIFE_KEYS,
  ...LOOSE_JSON_ANCHOR_KEYS,
];

function looksLikeLooseJsonFields(text) {
  return /"[\w.]+"\s*:/.test(String(text || ''));
}

function readLooseJsonValue(raw, start) {
  let i = start;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (i >= raw.length) return { value: null, nextIndex: i };

  const ch = raw[i];
  if (ch === '"') {
    let val = '';
    i += 1;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '\\' && i + 1 < raw.length) {
        val += raw[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        const tail = raw.slice(i + 1).replace(/^\s+/, '');
        if (!tail || tail.startsWith(',') || tail.startsWith('}') || tail.startsWith(']') || /^"[\w.]+"\s*:/.test(tail)) {
          i += 1;
          break;
        }
        val += c;
        i += 1;
        continue;
      }
      if (c === '\n' || c === '\r') {
        val += ' ';
        i += 1;
        continue;
      }
      val += c;
      i += 1;
    }
    while (i < raw.length && (/\s/.test(raw[i]) || raw[i] === ',')) i += 1;
    return { value: val.trim(), nextIndex: i };
  }

  if (ch === '[') {
    let depth = 0;
    const begin = i;
    while (i < raw.length) {
      if (raw[i] === '[') depth += 1;
      else if (raw[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          const slice = relaxJsonText(raw.slice(begin, i));
          try {
            const parsed = JSON.parse(slice);
            const value = Array.isArray(parsed)
              ? parsed.map((item) => String(item || '').trim()).filter(Boolean).join(' / ')
              : String(parsed || '').trim();
            while (i < raw.length && (/\s/.test(raw[i]) || raw[i] === ',')) i += 1;
            return { value, nextIndex: i };
          } catch (_) {
            const inner = slice.slice(1, -1);
            const value = inner
              .split(/[,，]/)
              .map((part) => part.replace(/^["'\s]+|["'\s]+$/g, '').trim())
              .filter(Boolean)
              .join(' / ');
            while (i < raw.length && (/\s/.test(raw[i]) || raw[i] === ',')) i += 1;
            return { value, nextIndex: i };
          }
        }
      }
      i += 1;
    }
    const partial = raw.slice(begin + 1).replace(/[\]"].*$/s, '').trim();
    return { value: partial, nextIndex: raw.length };
  }

  if (ch === '{') {
    let depth = 0;
    const begin = i;
    while (i < raw.length) {
      if (raw[i] === '{') depth += 1;
      else if (raw[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          try {
            const parsed = JSON.parse(relaxJsonText(raw.slice(begin, i)));
            while (i < raw.length && (/\s/.test(raw[i]) || raw[i] === ',')) i += 1;
            return { value: parsed, nextIndex: i, isObject: true };
          } catch (_) {
            return { value: null, nextIndex: i };
          }
        }
      }
      i += 1;
    }
    return { value: null, nextIndex: raw.length };
  }

  let val = '';
  while (i < raw.length && !/[\s,}\]]/.test(raw[i])) {
    val += raw[i];
    i += 1;
  }
  while (i < raw.length && (/\s/.test(raw[i]) || raw[i] === ',')) i += 1;
  return { value: val.replace(/^["']|["']$/g, '').trim(), nextIndex: i };
}

function findNextLooseJsonField(raw, fromIndex) {
  let bestIdx = -1;
  let bestKey = '';
  let bestTokenLen = 0;
  for (let i = 0; i < LOOSE_JSON_SCAN_KEYS.length; i += 1) {
    const key = LOOSE_JSON_SCAN_KEYS[i];
    const token = `"${key}"`;
    const idx = raw.indexOf(token, fromIndex);
    if (idx < 0) continue;
    const afterToken = raw.slice(idx + token.length).replace(/^\s+/, '');
    if (!afterToken.startsWith(':')) continue;
    if (bestIdx < 0 || idx < bestIdx) {
      bestIdx = idx;
      bestKey = key;
      bestTokenLen = token.length;
    }
  }
  if (bestIdx < 0) return null;
  const colonIdx = bestIdx + bestTokenLen + raw.slice(bestIdx + bestTokenLen).search(/:/);
  return { key: bestKey, valueStart: colonIdx + 1 };
}

function parseLooseJsonFields(text) {
  const raw = normalizePasteText(text);
  if (!looksLikeLooseJsonFields(raw)) return null;

  const record = {};
  const lifeProfile = {};
  const residenceAnchor = {};
  let pos = 0;

  while (pos < raw.length) {
    const hit = findNextLooseJsonField(raw, pos);
    if (!hit) break;
    const { value, nextIndex, isObject } = readLooseJsonValue(raw, hit.valueStart);
    pos = Math.max(nextIndex, hit.valueStart + 1);

    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;

    if (LOOSE_JSON_TOP_KEYS.has(hit.key)) {
      record[hit.key] = value;
      continue;
    }
    if (hit.key === 'lifeProfile' && isObject && value && typeof value === 'object') {
      record.lifeProfile = { ...(record.lifeProfile || {}), ...value };
      continue;
    }
    if (hit.key === 'residenceAnchor' && isObject && value && typeof value === 'object') {
      record.residenceAnchor = { ...(record.residenceAnchor || {}), ...value };
      continue;
    }
    if (LOOSE_JSON_LIFE_KEYS.has(hit.key)) {
      lifeProfile[hit.key] = String(value).trim();
      continue;
    }
    if (LOOSE_JSON_ANCHOR_KEYS.has(hit.key)) {
      residenceAnchor[hit.key] = String(value).trim();
    }
  }

  if (Object.keys(lifeProfile).length) {
    record.lifeProfile = { ...(record.lifeProfile || {}), ...lifeProfile };
  }
  if (Object.keys(residenceAnchor).length) {
    record.residenceAnchor = { ...(record.residenceAnchor || {}), ...residenceAnchor };
  }

  return Object.keys(record).length ? record : null;
}

function extractJsonObject(text) {
  const trimmed = normalizePasteText(text).trim();
  if (!trimmed) return null;
  const candidates = [trimmed, relaxJsonText(trimmed)];
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch (_) {
      /* continue */
    }
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = relaxJsonText(String(fence[1] || '').trim());
    try {
      return JSON.parse(inner);
    } catch (_) {
      const nested = extractFirstBalancedJsonObject(inner);
      if (nested) return nested;
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = relaxJsonText(trimmed.slice(start, end + 1));
    try {
      return JSON.parse(slice);
    } catch (_) {
      const nested = extractFirstBalancedJsonObject(slice);
      if (nested) return nested;
      return null;
    }
  }
  return null;
}

function extractFirstBalancedJsonObject(text = '') {
  const raw = normalizePasteText(text);
  let start = -1;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== '}') continue;
    if (depth > 0) depth -= 1;
    if (depth === 0 && start >= 0) {
      const slice = relaxJsonText(raw.slice(start, i + 1));
      try {
        return JSON.parse(slice);
      } catch (_) {
        start = -1;
      }
    }
  }
  return null;
}

function draftFromFieldMapObject(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const draft = {
    lifeProfile: createEmptyLifeProfile(),
    residenceAnchor: createEmptyResidenceAnchor(),
  };
  const assign = (id, value) => {
    if (value === undefined || value === null) return;
    if (id === 'aliases') {
      const list = normalizeAliases(value);
      if (list.length) draft.aliases = list;
      return;
    }
    const raw = Array.isArray(value) ? value.join(' / ') : String(value).trim();
    if (!raw) return;
    if (id.startsWith('lifeProfile.')) {
      draft.lifeProfile[id.slice('lifeProfile.'.length)] = raw;
      return;
    }
    if (id.startsWith('residenceAnchor.')) {
      draft.residenceAnchor[id.slice('residenceAnchor.'.length)] = raw;
      return;
    }
    draft[id] = raw;
  };
  FIELD_DEFS.forEach((def) => {
    const id = fieldId(def);
    if (Object.prototype.hasOwnProperty.call(data, id)) assign(id, data[id]);
    if (def.group !== 'top' && Object.prototype.hasOwnProperty.call(data, def.key)) assign(id, data[def.key]);
  });
  return compactDraft(draft);
}

function unwrapCharacterRecord(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] && typeof data[i] === 'object') return data[i];
    }
    return null;
  }
  if (Array.isArray(data.characters) && data.characters.length) {
    return data.characters[0];
  }
  if (data.spec === 'chara_card' || data.spec === 'chara_card_v2') {
    if (data.data && typeof data.data === 'object') return data.data;
  }
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    const inner = data.data;
    if (inner.name || inner.personality || inner.description || inner.realName) return inner;
  }
  if (data.id || data.name || data.realName || data.personality || data.description) return data;
  return null;
}

function mapRecordToDraft(record) {
  if (!record || typeof record !== 'object') return {};
  const roleTier = pickString(record.roleTier, record.anonymousRoleTier, record.roleTierHint);
  const lifeSrc = record.lifeProfile && typeof record.lifeProfile === 'object'
    ? record.lifeProfile
    : record;
  const mapSrc = record.residenceAnchor && typeof record.residenceAnchor === 'object'
    ? record.residenceAnchor
    : record;

  const draft = {
    name: pickString(record.name, record.remarkName, record.char_name, record.displayName),
    realName: pickString(record.realName, record.fullName),
    aliases: normalizeAliases(record.aliases || record.alternate_greetings),
    birthDate: pickString(record.birthDate),
    notes: pickString(record.notes, record.creator_notes, record.comment),
    currentRole: pickString(record.currentRole, record.role, record.occupation, record.identity),
    userRelationStatus: pickString(
      record.userRelationStatus,
      record.relationshipWithUser,
      record.relationWithUser,
      record.userRelationship,
      record.currentRelationship,
    ),
    currentStatus: pickString(record.currentStatus, record.status),
    personality: pickString(
      record.personality,
      record.description,
      record.persona,
      record.char_persona,
      record.scenario,
    ),
    speechStyle: pickString(record.speechStyle, record.speaking_style),
    speechCorpus: pickString(
      record.speechCorpus,
      record.corpus,
      record.roleplayCorpus,
      record.mes_example,
      record.example_dialogue,
      record.examples,
    ),
    commonEmotes: pickString(record.commonEmotes, record.favoriteEmotes, record.emojiStyle, record.kaomoji),
    appearancePrompt: pickString(record.appearancePrompt, record.appearance, record.looks, record.visual, record.outfit),
    promptCorpus: pickString(record.promptCorpus),
    // normalizeRoleTier 会把空值默认成 npc。AI 没有返回该字段时不应
    // 凭空制造一个“已解析字段”，否则会阻断后续的兼容解析。
    roleTier: roleTier ? normalizeRoleTier(roleTier) : '',
    defaultEmoji: pickString(record.defaultEmoji),
    lifeProfile: {
      homeDetails: pickString(lifeSrc.homeDetails),
      familyThreads: pickString(lifeSrc.familyThreads),
      socialAnchors: pickString(lifeSrc.socialAnchors),
      habits: pickString(lifeSrc.habits),
      activitySeeds: pickString(lifeSrc.activitySeeds),
    },
    residenceAnchor: {
      city: pickString(mapSrc.city),
      realCityMap: pickString(mapSrc.realCityMap),
      weatherHint: pickString(mapSrc.weatherHint),
      area: pickString(mapSrc.area),
      label: pickString(mapSrc.label),
      mapQuery: pickString(mapSrc.mapQuery),
      note: pickString(mapSrc.note),
    },
  };

  if (record.avatar && typeof record.avatar === 'string' && /^data:image\//i.test(record.avatar)) {
    draft.avatar = record.avatar;
  }

  return draft;
}

function matchLabelRules(line, rules) {
  const trimmed = normalizeLabelLine(line);
  if (!trimmed) return null;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    for (let j = 0; j < rule.patterns.length; j += 1) {
      const hit = trimmed.match(rule.patterns[j]);
      if (!hit) continue;
      const value = String(hit[1] ?? '').trim();
      if (!value && !BLOCK_FIELD_KEYS.has(rule.key) && !rule.aliases) return null;
      return { key: rule.key, value, aliases: !!rule.aliases };
    }
  }
  return null;
}

function parseLabeledText(text) {
  const lines = normalizePasteText(text).split('\n');
  const draft = {
    lifeProfile: createEmptyLifeProfile(),
    residenceAnchor: createEmptyResidenceAnchor(),
  };
  const blocks = {
    personality: [],
    speechStyle: [],
    commonEmotes: [],
    speechCorpus: [],
    promptCorpus: [],
    notes: [],
  };
  let activeBlock = '';

  const flushBlock = () => {
    if (!activeBlock || !blocks[activeBlock]?.length) return;
    draft[activeBlock] = blocks[activeBlock].join('\n').trim();
    blocks[activeBlock] = [];
    activeBlock = '';
  };

  const startBlock = (key, seed = '') => {
    activeBlock = key;
    blocks[key] = seed ? [seed] : [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const top = matchLabelRules(line, TEXT_LABEL_RULES);
    if (top) {
      flushBlock();
      if (top.aliases) {
        if (top.value) draft.aliases = normalizeAliases(top.value);
        activeBlock = '';
      } else if (BLOCK_FIELD_KEYS.has(top.key)) {
        if (top.value) {
          draft[top.key] = top.value;
          startBlock(top.key, top.value);
        } else {
          startBlock(top.key);
        }
      } else if (top.value) {
        draft[top.key] = top.value;
        activeBlock = '';
      }
      continue;
    }
    const life = matchLabelRules(line, LIFE_LABEL_RULES);
    if (life) {
      flushBlock();
      if (life.value) draft.lifeProfile[life.key] = life.value;
      activeBlock = '';
      continue;
    }
    const map = matchLabelRules(line, MAP_LABEL_RULES);
    if (map) {
      flushBlock();
      if (map.value) draft.residenceAnchor[map.key] = map.value;
      activeBlock = '';
      continue;
    }
    if (activeBlock) blocks[activeBlock].push(line);
  }
  flushBlock();
  return draft;
}

function compactDraft(draft) {
  const next = {};
  const scalarKeys = [
    'name', 'realName', 'birthDate', 'notes',
    'currentRole', 'userRelationStatus', 'currentStatus', 'personality', 'speechStyle', 'speechCorpus', 'promptCorpus',
    'commonEmotes', 'appearancePrompt', 'roleTier', 'defaultEmoji', 'avatar',
  ];
  for (let i = 0; i < scalarKeys.length; i += 1) {
    const key = scalarKeys[i];
    const value = draft[key];
    if (Array.isArray(value)) {
      if (value.length) next[key] = value;
      continue;
    }
    const s = String(value || '').trim();
    if (s) next[key] = value;
  }
  if (draft.aliases?.length) next.aliases = draft.aliases;

  const life = draft.lifeProfile || {};
  const lifeOut = {};
  Object.keys(createEmptyLifeProfile()).forEach((key) => {
    const s = String(life[key] || '').trim();
    if (s) lifeOut[key] = s;
  });
  if (Object.keys(lifeOut).length) next.lifeProfile = lifeOut;

  const map = draft.residenceAnchor || {};
  const mapOut = {};
  Object.keys(createEmptyResidenceAnchor()).forEach((key) => {
    const s = String(map[key] || '').trim();
    if (s) mapOut[key] = s;
  });
  if (Object.keys(mapOut).length) next.residenceAnchor = mapOut;

  return next;
}

export function parseCharacterDraftText(text) {
  const raw = normalizePasteText(text).trim();
  if (!raw) return { draft: {}, source: 'empty' };

  const parsed = extractJsonObject(raw);
  const loose = parseLooseJsonFields(raw);
  const record = unwrapCharacterRecord(parsed) || loose;
  if (record) {
    const draft = compactDraft(mapRecordToDraft(record));
    if (looksLikeRichCharacterText(raw)) {
      draft.promptCorpus = mergePromptCorpus(draft.promptCorpus, raw);
    }
    if (!draft.name) {
      const envelopeName = inferNameFromEnvelope(raw);
      if (envelopeName) draft.name = envelopeName;
    }
    if (Object.keys(draft).length) return { draft, source: 'json' };
  }

  const labeled = parseLabeledText(raw);
  const compact = compactDraft(labeled);
  if (Object.keys(compact).length) {
    if (looksLikeRichCharacterText(raw)) {
      compact.promptCorpus = mergePromptCorpus(compact.promptCorpus, raw);
    }
    if (!compact.name) {
      const envelopeName = inferNameFromEnvelope(raw);
      if (envelopeName) compact.name = envelopeName;
    }
    return { draft: compactDraft(compact), source: compact.promptCorpus ? 'labels+corpus' : 'labels' };
  }

  if (raw.length >= 2) {
    const envelopeName = inferNameFromEnvelope(raw);
    const richText = looksLikeRichCharacterText(raw);
    const corpus = richText ? cleanCharacterSourceText(raw) : raw;
    return {
      draft: compactDraft({
        name: envelopeName,
        promptCorpus: corpus,
      }),
      source: richText ? 'corpus' : 'freeform',
    };
  }

  return { draft: {}, source: 'none' };
}

function scalarIsEmpty(char, key) {
  if (key === 'aliases') return !(char.aliases || []).length;
  return !String(char[key] || '').trim();
}

function nestedIsEmpty(char, prefix, key) {
  const nested = char[prefix];
  if (!nested || typeof nested !== 'object') return true;
  return !String(nested[key] || '').trim();
}

function countDraftFields(draft) {
  let n = 0;
  const scalarKeys = [
    'name', 'realName', 'birthDate', 'notes',
    'currentRole', 'userRelationStatus', 'currentStatus', 'personality', 'speechStyle', 'speechCorpus', 'promptCorpus',
    'commonEmotes', 'appearancePrompt', 'roleTier', 'defaultEmoji', 'avatar',
  ];
  for (let i = 0; i < scalarKeys.length; i += 1) {
    const key = scalarKeys[i];
    if (!scalarIsEmpty(draft, key) && key !== 'aliases') n += 1;
  }
  if (draft.aliases?.length) n += 1;
  if (draft.lifeProfile) {
    Object.keys(draft.lifeProfile).forEach((key) => {
      if (String(draft.lifeProfile[key] || '').trim()) n += 1;
    });
  }
  if (draft.residenceAnchor) {
    Object.keys(draft.residenceAnchor).forEach((key) => {
      if (String(draft.residenceAnchor[key] || '').trim()) n += 1;
    });
  }
  return n;
}

export function mergeCharacterDraft(base, incoming, options = {}) {
  const onlyEmpty = options.onlyEmpty === true;
  const next = createCharacterProfile(base);
  const draft = compactDraft(incoming || {});
  let changed = 0;

  const applyScalar = (key, value) => {
    if (value === undefined || value === null) return;
    if (key === 'aliases') {
      const list = normalizeAliases(value);
      if (!list.length) return;
      if (onlyEmpty && !scalarIsEmpty(next, 'aliases')) return;
      next.aliases = list;
      changed += 1;
      return;
    }
    const v = String(value || '').trim();
    if (!v) return;
    if (onlyEmpty && !scalarIsEmpty(next, key)) return;
    next[key] = v;
    changed += 1;
  };

  applyScalar('name', draft.name);
  applyScalar('realName', draft.realName);
  applyScalar('aliases', draft.aliases);
  applyScalar('birthDate', draft.birthDate);
  applyScalar('notes', draft.notes);
  applyScalar('currentRole', draft.currentRole);
  applyScalar('userRelationStatus', draft.userRelationStatus);
  applyScalar('currentStatus', draft.currentStatus);
  applyScalar('personality', draft.personality);
  applyScalar('speechStyle', draft.speechStyle);
  applyScalar('speechCorpus', draft.speechCorpus);
  applyScalar('commonEmotes', draft.commonEmotes);
  applyScalar('appearancePrompt', draft.appearancePrompt);
  applyScalar('promptCorpus', draft.promptCorpus);
  applyScalar('roleTier', draft.roleTier);
  applyScalar('defaultEmoji', draft.defaultEmoji);
  if (draft.avatar && (!onlyEmpty || !next.avatar)) {
    next.avatar = draft.avatar;
    changed += 1;
  }

  if (draft.lifeProfile) {
    Object.keys(draft.lifeProfile).forEach((key) => {
      const v = String(draft.lifeProfile[key] || '').trim();
      if (!v) return;
      if (onlyEmpty && !nestedIsEmpty(next, 'lifeProfile', key)) return;
      next.lifeProfile[key] = v;
      changed += 1;
    });
  }

  if (draft.residenceAnchor) {
    Object.keys(draft.residenceAnchor).forEach((key) => {
      const v = String(draft.residenceAnchor[key] || '').trim();
      if (!v) return;
      if (onlyEmpty && !nestedIsEmpty(next, 'residenceAnchor', key)) return;
      next.residenceAnchor[key] = v;
      changed += 1;
    });
  }

  return { profile: next, changed };
}

export function applyCharacterToForm(char, host, options = {}) {
  if (!host || !char) return;
  const esc = options.esc || ((v) => String(v || ''));
  host.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.getAttribute('data-key');
    if (!key) return;
    if (key === 'aliases') {
      el.value = (char.aliases || []).join(' / ');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(char, key)) {
      el.value = char[key] ?? '';
    }
  });
  host.querySelectorAll('[data-nested]').forEach((el) => {
    const path = el.getAttribute('data-nested');
    if (!path) return;
    const parts = path.split('.');
    if (parts.length !== 2) return;
    const [prefix, key] = parts;
    const nested = char[prefix];
    if (nested && typeof nested === 'object') {
      el.value = nested[key] || '';
    }
  });
  if (options.updateAvatar !== false) {
    const avatarBox = host.querySelector('.contacts-avatar-box');
    if (!avatarBox) return;
    avatarBox.innerHTML = characterAvatarHtml(char, { className: 'contacts-avatar-img' });
  }
}

function extractAiJson(text) {
  const parsed = extractJsonObject(text) || extractFirstBalancedJsonObject(text);
  if (parsed && typeof parsed === 'object') return parsed;
  return parseLooseJsonFields(text);
}

/** 当前为空、需要 AI 去补的字段定义列表（顺序与 FIELD_DEFS 一致）。 */
function emptyFieldDefsFor(existing) {
  const base = createCharacterProfile(existing || {});
  return FIELD_DEFS.filter((def) => {
    if (def.group === 'top') {
      if (def.aliases) return scalarIsEmpty(base, 'aliases');
      return scalarIsEmpty(base, def.key);
    }
    if (def.group === 'life') return nestedIsEmpty(base, 'lifeProfile', def.key);
    if (def.group === 'anchor') return nestedIsEmpty(base, 'residenceAnchor', def.key);
    return false;
  });
}

function describeFieldForPrompt(def) {
  const path = def.group === 'life'
    ? `lifeProfile.${def.key}`
    : def.group === 'anchor'
      ? `residenceAnchor.${def.key}`
      : def.key;
  return `- ${path}（${def.label}）：${def.desc}`;
}

function buildRelationshipHintForPrompt(existing = {}) {
  const rels = existing?.relationships;
  if (!rels || typeof rels !== 'object') return '';
  const entries = Object.entries(rels)
    .map(([id, label]) => [String(id || '').trim(), String(label || '').trim()])
    .filter(([id, label]) => id && label);
  if (!entries.length) return '';
  return [
    '【角色与其他人的已有关系（推断 userRelationStatus 时须参考，勿与之矛盾）】',
    entries.map(([id, label]) => `- ${id}：${label}`).join('\n'),
  ].join('\n');
}

function buildAiSystemPrompt(emptyDefs = []) {
  const defs = emptyDefs.length ? emptyDefs : FIELD_DEFS;
  const checklist = defs.map(describeFieldForPrompt);
  const needsUserRelation = defs.some((def) => def.key === 'userRelationStatus');
  const needsCommonEmotes = defs.some((def) => def.key === 'commonEmotes');
  const rules = [
    '1. 用户「已填字段」原样保留，绝不改写、润色、压缩或覆盖；输出里可以不重复它们。',
    '2. 下面「待补字段清单」里的每一个字段都要尽量给出内容——结合角色资料、身份、关系、口吻去合理推断与扩写，把人物补完整。宁可大胆补全，也不要只填一两个就交差，更不要大片留空。',
    '3. 只有当某字段真的无从推断（例如真实生日、真实地图坐标）时，才允许填空字符串；其余字段都应给出具体、自洽的内容。',
    '4. 所有补全内容彼此自洽，并与用户已填内容、原始资料不矛盾；嵌套对象用 lifeProfile / residenceAnchor，aliases 用字符串数组，roleTier 取 main|supporting|npc|background；有姓名、可持续互动的群像人物优先用 supporting，不要因为不是主角就降成 NPC。',
  ];
  let nextRule = 5;
  if (needsUserRelation) {
    rules.push(
      `${nextRule}. userRelationStatus 必须严格依据角色资料推断：不要默认或偏向恋人/暧昧。家人、朋友、同事、长辈晚辈、邻居、师徒、合作者等同样常见。若原设或「与其他人的已有关系」已写明角色有恋人/配偶/亲属等，须尊重原设，勿强行改成与 user 恋爱。`,
    );
    nextRule += 1;
  }
  if (needsCommonEmotes) {
    rules.push(
      `${nextRule}. commonEmotes 只能提取资料或 speechStyle 已经支持的表情、标点与语气词；不能因为角色年长、稳重、冷淡、寡言、活泼或网感强，就替 TA 发明「嗯」「嗯？」「……」、emoji、颜文字、www、草等口癖。没有明确证据时填「无」；有证据时保留 2–4 个真实习惯，勿堆砌。`,
    );
  }
  return [
    '你是角色资料整理与扩写助手。根据用户给的角色资料 / 简介 / 角色卡 JSON，产出一份可直接导入通讯录表单的 JSON。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要思考过程。',
    '【最重要的规则】',
    ...rules,
    '【待补字段清单（这些当前为空，请逐个都尽量填上）】',
    ...checklist,
  ].join('\n');
}

function collectFilledCharacterFields(existing = {}) {
  const snapshot = createCharacterProfile(existing || {});
  const filled = {};
  AI_OUTPUT_KEYS.forEach((key) => {
    if (key === 'aliases') {
      if (snapshot.aliases?.length) filled.aliases = snapshot.aliases;
      return;
    }
    if (key === 'lifeProfile' || key === 'residenceAnchor') {
      const nested = snapshot[key] || {};
      const out = {};
      Object.keys(nested).forEach((k) => {
        const v = String(nested[k] || '').trim();
        if (v) out[k] = v;
      });
      if (Object.keys(out).length) filled[key] = out;
      return;
    }
    const v = String(snapshot[key] || '').trim();
    if (v) filled[key] = v;
  });
  return filled;
}

function buildAiUserPrompt(text, existing, emptyDefs = []) {
  const filled = collectFilledCharacterFields(existing);

  const emptyList = (emptyDefs.length ? emptyDefs : FIELD_DEFS).map(describeFieldForPrompt);
  const relationshipHint = buildRelationshipHintForPrompt(existing);

  return [
    '请基于下面的角色资料，把「待补字段」尽量逐个都填上合理内容（不要只填一两个），同时保持已填字段不变。',
    '【角色资料 / 用户输入】',
    String(text || '').trim() || '（用户没有额外粘贴文本，请完全依据已填字段推断扩写）',
    '【已填字段（保持原样，不要修改）】',
    JSON.stringify(filled, null, 0),
    relationshipHint,
    '【需要你补全的空白字段】',
    emptyList.join('\n'),
    '【输出】只输出一个 JSON 对象，键用上面给出的字段名；尽量覆盖所有待补字段。',
  ].filter(Boolean).join('\n\n');
}

export async function isCharacterAiAvailable() {
  const route = await resolveCharacterAiRoute();
  return route.available === true;
}

export async function resolveCharacterAiRoute(options = {}) {
  const [main, tool] = await Promise.all([getConfig(), getToolConfig()]);
  const forceMainApi = options.forceMainApi === true;
  const toolSelected = !forceMainApi
    && tool.enabled === true
    && !!String(tool.model || '').trim()
    && tool.tasks?.characterFill !== false;
  const config = toolSelected ? tool : main;
  const apiSection = toolSelected ? 'tool' : 'main';
  const model = String(config?.model || '').trim();
  return {
    apiSection,
    sourceLabel: apiSection === 'tool' ? '工具模型' : '主模型',
    model,
    requestStream: config?.preferStream === true,
    available: !!model,
  };
}

export function getCharacterAiFillTargetFields(existing = {}) {
  return emptyFieldDefsFor(existing).map((def) => fieldId(def));
}

function resolvedCharacterAiRoute(route = {}, requestStat = {}, error = null) {
  const stat = requestStat && typeof requestStat === 'object' ? requestStat : {};
  const apiSection = String(stat.audit?.apiSection || route.apiSection || '').trim() || 'main';
  const requestModel = String(stat.model || error?.requestModel || route.model || '').trim();
  return {
    apiSection,
    sourceLabel: apiSection === 'tool' ? '工具模型' : '主模型',
    model: requestModel,
    requestStream: typeof stat.requestStream === 'boolean'
      ? stat.requestStream
      : (typeof error?.requestStream === 'boolean' ? error.requestStream : route.requestStream === true),
    correlationId: String(stat.correlationId || error?.correlationId || '').trim(),
  };
}

function attachCharacterAiFillRoute(error, route = {}, requestStat = {}) {
  const err = error instanceof Error ? error : new Error(String(error || 'AI 补全失败'));
  if (!String(err.rawResponse || '').trim()) {
    const diagnostic = err.responseText
      || err.reasoningText
      || err.upstreamMeta?.reasoningText
      || '';
    if (String(diagnostic || '').trim()) err.rawResponse = String(diagnostic);
  }
  err.aiRoute = resolvedCharacterAiRoute(route, requestStat, err);
  return err;
}

export function createCharacterAiFillEmptyResponseError(route = {}, requestStat = {}, evidence = {}) {
  const resolved = resolvedCharacterAiRoute(route, requestStat);
  const modelLabel = resolved.model ? `「${resolved.model}」` : '';
  const reasoningOnly = String(requestStat?.errorKind || '') === 'reasoning_only';
  const err = new Error(reasoningOnly
    ? `${resolved.sourceLabel}${modelLabel}只返回了推理过程，没有返回可用正文`
    : `${resolved.sourceLabel}${modelLabel}已结束请求，但没有返回可用正文`);
  err.code = 'empty-api-response';
  err.emptyKind = String(requestStat?.errorKind || 'empty_content');
  const rawResponse = String(evidence?.rawResponse || evidence?.reasoningText || '').trim();
  if (rawResponse) err.rawResponse = rawResponse;
  err.aiRoute = resolved;
  return err;
}

export async function aiFillCharacterDraft(text, existing = {}, options = {}) {
  const rawText = String(text || '').trim();
  const filledInput = collectFilledCharacterFields(existing);
  if (!rawText && !Object.keys(filledInput).length) {
    const err = new Error('请先填写一点角色资料或粘贴简介');
    err.code = 'ai-fill-no-source';
    throw err;
  }

  const emptyDefs = emptyFieldDefsFor(existing);
  if (!emptyDefs.length) {
    const err = new Error('没有可补全的空白字段');
    err.code = 'ai-fill-no-empty-fields';
    throw err;
  }

  const requestKey = String(options.requestKey || '').trim();
  const requestToken = requestKey ? Symbol(requestKey) : null;
  if (requestKey && ACTIVE_AI_FILL_REQUESTS.has(requestKey)) {
    const err = new Error('这个角色正在补全，请等待当前请求结束');
    err.code = 'ai-fill-in-progress';
    throw err;
  }
  if (requestKey) ACTIVE_AI_FILL_REQUESTS.set(requestKey, requestToken);

  try {
    const route = await resolveCharacterAiRoute({ forceMainApi: options.forceMainApi === true });
    if (!route.available) {
      const err = new Error(options.forceMainApi === true
        ? '主模型尚未配置，无法改用主模型重试'
        : '请先在设置中配置聊天或工具 API');
      err.code = 'api-not-configured';
      err.aiRoute = route;
      throw err;
    }

    let response = '';
    let recoveredFromPartial = false;
    let requestError = null;
    let receivedText = '';
    let requestStat = null;
    let rawResponse = '';
    let completionMeta = null;
    const rememberRawResponse = (fragment, { append = false } = {}) => {
      const value = String(fragment || '');
      if (!value) return;
      rawResponse = append ? `${rawResponse}${value}` : value;
      if (rawResponse.length > MAX_AI_FILL_DIAGNOSTIC_CHARS) {
        rawResponse = rawResponse.slice(-MAX_AI_FILL_DIAGNOSTIC_CHARS);
      }
    };
    try {
      response = await chatForTask([
        { role: 'system', content: buildAiSystemPrompt(emptyDefs) },
        { role: 'user', content: buildAiUserPrompt(rawText, existing, emptyDefs) },
      ], {
        temperature: 0.5,
        stream: route.requestStream === true,
        signal: options.signal,
        ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
        ...(options.totalTimeoutMs != null ? { totalTimeoutMs: options.totalTimeoutMs } : {}),
        onChunk: (piece, fullText) => {
          receivedText = String(fullText ?? piece ?? '');
        },
        onRawResponse: (raw) => rememberRawResponse(raw),
        onRawSseFragment: (fragment) => rememberRawResponse(fragment, { append: true }),
        onCompletionMeta: (meta) => {
          completionMeta = meta && typeof meta === 'object' ? { ...meta } : null;
          if (typeof options.onCompletionMeta === 'function') options.onCompletionMeta(meta);
        },
        onRequestStat: (stat) => {
          requestStat = stat && typeof stat === 'object' ? { ...stat } : null;
          if (typeof options.onRequestStat === 'function') options.onRequestStat(stat);
        },
        forceMainApi: options.forceMainApi === true,
      }, 'characterFill');
    } catch (err) {
      const partial = String(err?.partialText || receivedText || '').trim();
      if (!partial) {
        if (!String(err?.rawResponse || '').trim() && rawResponse.trim()) err.rawResponse = rawResponse;
        throw attachCharacterAiFillRoute(err, route, requestStat);
      }
      response = partial;
      recoveredFromPartial = true;
      requestError = err;
    }

    const actualRoute = resolvedCharacterAiRoute(route, requestStat, requestError);
    if (!String(response || '').trim()) {
      throw createCharacterAiFillEmptyResponseError(actualRoute, requestStat || {}, {
        rawResponse,
        reasoningText: completionMeta?.reasoningText || '',
      });
    }
    const resultMeta = recoveredFromPartial
      ? { source: 'ai-partial', recoveredFromPartial: true, route: actualRoute }
      : { source: 'ai', route: actualRoute };
    const parsed = extractAiJson(response);
    if (!parsed) {
      const fallbackDraft = compactDraft(parseLabeledText(response));
      if (countDraftFields(fallbackDraft)) return { draft: fallbackDraft, ...resultMeta, raw: response };
      const err = new Error(recoveredFromPartial
        ? '连接中断，已保留收到的部分原文'
        : 'AI 返回格式无效，已保留返回原文');
      err.code = 'ai-fill-invalid-format';
      err.rawResponse = response;
      err.aiRoute = actualRoute;
      if (requestError) err.cause = requestError;
      throw err;
    }

    // 模型可能同时返回嵌套对象、点路径键（lifeProfile.homeDetails）
    // 或扁平短键（homeDetails）。两种解析结果必须逐字段合并，
    // 不能因为其中一种偶然解出一个其他字段就丢掉空白生活字段。
    const mappedDraft = compactDraft(mapRecordToDraft(parsed));
    const fieldMapDraft = compactDraft(draftFromFieldMapObject(parsed));
    let draft = compactDraft({
      ...fieldMapDraft,
      ...mappedDraft,
      lifeProfile: {
        ...(fieldMapDraft.lifeProfile || {}),
        ...(mappedDraft.lifeProfile || {}),
      },
      residenceAnchor: {
        ...(fieldMapDraft.residenceAnchor || {}),
        ...(mappedDraft.residenceAnchor || {}),
      },
    });
    if (!countDraftFields(draft)) {
      const fallbackDraft = compactDraft(parseLabeledText(response));
      if (countDraftFields(fallbackDraft)) return { draft: fallbackDraft, ...resultMeta, raw: response };
      const err = new Error(recoveredFromPartial
        ? '连接中断，已保留收到的部分原文'
        : 'AI 没有解析出可用字段，已保留返回原文');
      err.code = 'ai-fill-invalid-format';
      err.rawResponse = response;
      err.aiRoute = actualRoute;
      if (requestError) err.cause = requestError;
      throw err;
    }

    return { draft, ...resultMeta, raw: response };
  } finally {
    if (requestKey && ACTIVE_AI_FILL_REQUESTS.get(requestKey) === requestToken) {
      ACTIVE_AI_FILL_REQUESTS.delete(requestKey);
    }
  }
}

/**
 * 把 AI 草稿对比当前表单，列出「用户没填、且 AI 给了内容」的字段，供预览确认。
 * 只返回当前为空的字段——已填字段绝不进入候选，从源头避免覆盖用户输入。
 */
export function buildAiFillReviewFields(current, incoming) {
  const base = createCharacterProfile(current || {});
  const draft = compactDraft(incoming || {});
  const out = [];
  const labelOf = (id) => FIELD_LABELS[id] || id;

  REVIEW_SCALAR_KEYS.forEach((key) => {
    if (key === 'aliases') {
      const list = normalizeAliases(draft.aliases);
      if (!list.length || !scalarIsEmpty(base, 'aliases')) return;
      out.push({ id: 'aliases', label: labelOf('aliases'), value: list.join(' / '), multiline: false });
      return;
    }
    const v = String(draft[key] || '').trim();
    if (!v || !scalarIsEmpty(base, key)) return;
    out.push({ id: key, label: labelOf(key), value: v, multiline: MULTILINE_FIELDS.has(key) });
  });

  if (draft.lifeProfile) {
    Object.keys(draft.lifeProfile).forEach((key) => {
      const v = String(draft.lifeProfile[key] || '').trim();
      if (!v || !nestedIsEmpty(base, 'lifeProfile', key)) return;
      const id = `lifeProfile.${key}`;
      out.push({ id, label: labelOf(id), value: v, multiline: MULTILINE_FIELDS.has(id) });
    });
  }

  if (draft.residenceAnchor) {
    Object.keys(draft.residenceAnchor).forEach((key) => {
      const v = String(draft.residenceAnchor[key] || '').trim();
      if (!v || !nestedIsEmpty(base, 'residenceAnchor', key)) return;
      const id = `residenceAnchor.${key}`;
      out.push({ id, label: labelOf(id), value: v, multiline: MULTILINE_FIELDS.has(id) });
    });
  }

  return out;
}

/** 把用户在预览里勾选 / 编辑后的字段，组装回可交给 mergeCharacterDraft 的草稿对象。 */
export function draftFromSelectedFields(entries = []) {
  const draft = { lifeProfile: {}, residenceAnchor: {} };
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const id = String(entry?.id || '').trim();
    const value = String(entry?.value || '').trim();
    if (!id || !value) return;
    if (id.startsWith('lifeProfile.')) {
      draft.lifeProfile[id.slice('lifeProfile.'.length)] = value;
    } else if (id.startsWith('residenceAnchor.')) {
      draft.residenceAnchor[id.slice('residenceAnchor.'.length)] = value;
    } else if (id === 'aliases') {
      draft.aliases = normalizeAliases(value);
    } else {
      draft[id] = value;
    }
  });
  return draft;
}

export function summarizeDraftSource(source) {
  if (source === 'labels') return '字段文本';
  if (source === 'labels+corpus') return '字段文本与原始资料';
  if (source === 'json') return 'JSON';
  if (source === 'corpus') return '角色资料';
  if (source === 'freeform') return '简介';
  if (source === 'ai') return 'AI 补全';
  return '资料';
}
