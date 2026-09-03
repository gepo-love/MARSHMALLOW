import {
  GACHA_LOCATIONS,
  GACHA_TIMES,
  GACHA_ITEMS,
  GACHA_ACTIONS,
  GACHA_TWISTS,
  GACHA_CONNECTORS,
  GACHA_NPCS,
  GACHA_TILE_TYPES,
} from '../../data/event-gacha-pools.js';

const RELATION_LABEL_RULES = [
  [/上司|老板|领导|主管|经理|总监|mentor/i, '上司'],
  [/下属|实习生|新人|徒弟|部下/i, '下属'],
  [/老师|导师|教授|班主任|师父/i, '老师'],
  [/学生|弟子/i, '学生'],
  [/同事|同僚|搭档|组员|队友/i, '同事'],
  [/室友|舍友|合租/i, '室友'],
  [/朋友|好友|死党|闺蜜|兄弟|姐妹|发小/i, '朋友'],
  [/恋人|对象|男朋友|女朋友|暗恋|前任|伴侣/i, '恋人'],
  [/对手|宿敌|冤家|死对头/i, '对手'],
  [/家人|母亲|父亲|妈妈|爸爸|哥哥|姐姐|弟弟|妹妹|亲戚/i, '家人'],
];

function pick(list = []) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickWeighted(entries = []) {
  const usable = (entries || []).filter((e) => e && e.items && e.items.length);
  if (!usable.length) return '';
  const total = usable.reduce((sum, e) => sum + (e.weight || 1), 0);
  let roll = Math.random() * total;
  for (const entry of usable) {
    roll -= entry.weight || 1;
    if (roll <= 0) return pick(entry.items);
  }
  return pick(usable[usable.length - 1].items);
}

function flattenGrouped(grouped = {}) {
  return Object.values(grouped || {})
    .filter(Array.isArray)
    .flat()
    .filter(Boolean);
}

function displayName(char) {
  if (!char) return '';
  return String(char.customNickname || char.name || char.id || '').trim();
}

/** 从关系描述里提取短标签（老师 / 同事 / 上司…） */
export function extractRelationLabel(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '熟人';
  for (const [re, label] of RELATION_LABEL_RULES) {
    if (re.test(raw)) return label;
  }
  const first = raw.split(/[，,、；;|/\s]/)[0].trim();
  return first.slice(0, 6) || '熟人';
}

function buildRelationLinks(chars = [], nameById = new Map()) {
  const links = [];
  for (const char of chars) {
    const fromName = displayName(char);
    if (!fromName || !char?.relationships) continue;
    for (const [rid, relText] of Object.entries(char.relationships)) {
      const target = nameById.get(rid);
      const toName = displayName(target);
      if (!toName) continue;
      const label = extractRelationLabel(relText);
      links.push({
        fromId: char.id,
        fromName,
        toId: rid,
        toName,
        label,
        phrase: `${fromName}的${label}`,
      });
    }
  }
  return links;
}

/**
 * 构建角色候选：仅通讯录真实角色 + NPC；附带关系网短语供加权抽取。
 */
export async function buildGachaActorContext({ chat = null, userName = '用户' } = {}) {
  const name = String(userName || '用户').trim() || '用户';
  let memberNames = [];
  let contactNames = [];
  let relationLinks = [];
  let charsById = new Map();
  let nameToId = new Map();

  try {
    const { listCharacters } = await import('../character-store.js');
    const chars = await listCharacters({ excludeAnonNpc: true }).catch(() => []);
    charsById = new Map((chars || []).map((c) => [c.id, c]));
    contactNames = (chars || []).map((c) => displayName(c)).filter(Boolean);
    for (const c of chars || []) {
      const dn = displayName(c);
      if (dn) nameToId.set(dn, c.id);
    }
    relationLinks = buildRelationLinks(chars || [], charsById);

    const ids = Array.isArray(chat?.participants)
      ? chat.participants.filter((x) => x && x !== 'user')
      : [];
    memberNames = ids.map((id) => displayName(charsById.get(id))).filter(Boolean);
  } catch {
    /* 通讯录读取失败时仅保留 NPC */
  }

  const npcPool = [...GACHA_NPCS];
  const candidates = [...new Set([...memberNames, ...contactNames])].filter(Boolean);

  return {
    candidates,
    memberNames,
    contactNames,
    npcPool,
    relationLinks,
    userName: name,
    charsById,
    nameToId,
  };
}

/** 解析磁贴上的角色文案，得到主角色名（含「张三的上司」这类短语） */
export function resolveActorAnchor(actorValue = '', actorContext = null) {
  const raw = String(actorValue || '').trim();
  if (!raw) return { phrase: '', anchorName: '', relatedName: '' };

  const links = actorContext?.relationLinks || [];
  const hit = links.find((l) => l.phrase === raw);
  if (hit) {
    return { phrase: raw, anchorName: hit.fromName, relatedName: hit.toName };
  }

  if (raw.endsWith('的') && raw.length > 1) {
    return { phrase: raw, anchorName: raw.slice(0, -1), relatedName: '' };
  }

  return { phrase: raw, anchorName: raw, relatedName: '' };
}

function namesToExclude(actorContext, roleAValue = '') {
  const exclude = new Set();
  const anchor = resolveActorAnchor(roleAValue, actorContext);
  if (anchor.anchorName) exclude.add(anchor.anchorName);
  if (anchor.relatedName) exclude.add(anchor.relatedName);
  if (anchor.phrase) exclude.add(anchor.phrase);
  return [...exclude];
}

function rollContactName(actorContext, exclude = []) {
  const { memberNames = [], candidates = [] } = actorContext || {};
  const ex = new Set(exclude.filter(Boolean));
  const members = memberNames.filter((n) => !ex.has(n));
  const contacts = candidates.filter((n) => !ex.has(n));
  return pickWeighted([
    { weight: 3, items: members },
    { weight: 2, items: contacts },
  ]) || pick(contacts) || pick(members) || '';
}

function rollRelationPhrase(actorContext, preferNames = [], exclude = []) {
  const ex = new Set(exclude.filter(Boolean));
  const prefer = new Set(preferNames.filter(Boolean));
  let pool = (actorContext?.relationLinks || []).filter(
    (l) => !ex.has(l.fromName) && !ex.has(l.toName) && !ex.has(l.phrase),
  );
  if (prefer.size) {
    const preferred = pool.filter((l) => prefer.has(l.fromName) || prefer.has(l.toName));
    if (preferred.length) pool = preferred;
  }
  const link = pick(pool);
  return link ? link.phrase : '';
}

function rollActorValue(actorContext, exclude = []) {
  const ex = new Set(exclude.filter(Boolean));
  const { memberNames = [], candidates = [], npcPool = [] } = actorContext || {};
  const members = memberNames.filter((n) => !ex.has(n));
  const contacts = candidates.filter((n) => !ex.has(n) && !members.includes(n));
  const npcs = npcPool.filter((n) => !ex.has(n));
  const relationPhrase = rollRelationPhrase(actorContext, members, [...ex]);

  const buckets = [
    { weight: 3, items: members },
    { weight: 2, items: contacts },
  ];
  if (relationPhrase) buckets.push({ weight: 2, items: [relationPhrase] });
  if (npcs.length) buckets.push({ weight: 1, items: npcs });

  return pickWeighted(buckets) || pick(members) || pick(contacts) || pick(npcs) || '某人';
}

function pickRelatedName(actorContext, roleAValue = '') {
  const anchor = resolveActorAnchor(roleAValue, actorContext);
  const exclude = namesToExclude(actorContext, roleAValue);
  const preferFrom = anchor.anchorName ? [anchor.anchorName] : [];
  const links = (actorContext?.relationLinks || []).filter(
    (l) => !exclude.includes(l.fromName) && !exclude.includes(l.toName),
  );
  const scoped = preferFrom.length
    ? links.filter((l) => preferFrom.includes(l.fromName) || preferFrom.includes(l.toName))
    : links;

  if (scoped.length && Math.random() < 0.68) {
    const link = pick(scoped);
    if (link.fromName === anchor.anchorName) return link.toName;
    if (link.toName === anchor.anchorName) return link.fromName;
    return link.toName;
  }
  return rollContactName(actorContext, exclude) || pick(actorContext?.npcPool || []) || '某人';
}

function fillPlaceholders(text, actorContext, roleAValue = '') {
  let out = String(text || '');
  if (out.includes('{B}')) {
    const b = pickRelatedName(actorContext, roleAValue);
    out = out.replace(/\{B\}/g, b || '某人');
  }
  return out;
}

function resolvePool(poolKey, actorContext, roleAValue) {
  switch (poolKey) {
    case 'ACTORS':
      return rollActorValue(actorContext, namesToExclude(actorContext, roleAValue));
    case 'LOCATIONS':
      return pick(GACHA_LOCATIONS);
    case 'TIMES':
      return pick(GACHA_TIMES);
    case 'ITEMS':
      return pick(flattenGrouped(GACHA_ITEMS));
    case 'ACTIONS':
      return fillPlaceholders(pick(flattenGrouped(GACHA_ACTIONS)), actorContext, roleAValue);
    case 'TWISTS':
      return fillPlaceholders(pick(flattenGrouped(GACHA_TWISTS)), actorContext, roleAValue);
    default:
      return '';
  }
}

export function rollGachaTile(typeId, ctx = {}) {
  const meta = GACHA_TILE_TYPES.find((t) => t.id === typeId) || GACHA_TILE_TYPES[0];
  const roleAValue = ctx.roleAValue || '';
  return {
    typeId: meta.id,
    label: meta.label,
    value: resolvePool(meta.pool, ctx.actorContext || null, typeId === 'actor' ? '' : roleAValue),
  };
}

export function rollAllGachaTiles(ctx = {}) {
  const actorContext = ctx.actorContext || null;
  let roleAValue = '';
  return GACHA_TILE_TYPES.map((t) => {
    const tile = rollGachaTile(t.id, { actorContext, roleAValue });
    if (t.id === 'actor' && tile.value) roleAValue = tile.value;
    return tile;
  });
}

function actionNeedsItem(action = '') {
  const a = String(action || '');
  return /^(不见了|消失了|凭空出现了|拿错了|穿反了|穿错了|戴歪了|踩到了|被绊倒了|点赞了|转发了|收藏了|被发现了|被翻出来了|被公开了)/.test(a)
    || /不见了$|消失了$|出现了$|被发现了$|被翻出来了$/.test(a);
}

function composeActionClause(actor, action, item) {
  const a = String(action || '').trim();
  const it = String(item || '').trim();
  const who = String(actor || '某人').trim() || '某人';

  if (!a) {
    return it ? `${who}遇上了与「${it}」有关的怪事` : `${who}遇到了一件怪事`;
  }
  if (/^(在|突然|不小心|深夜|手滑|本来|正要|刚刚|所有人)/.test(a)) {
    return `${who}${a}`;
  }
  if (a.startsWith('把')) {
    return it ? `${who}${a}${it}` : `${who}${a}某样东西`;
  }
  if (a.startsWith('被') || a.startsWith('给') || a.startsWith('跟') || a.startsWith('对')) {
    return it ? `${who}${a}${it}` : `${who}${a}`;
  }
  if (it && actionNeedsItem(a)) {
    return `${who}的${it}${a}`;
  }
  if (it && !a.includes(it)) {
    const passiveItem = /被|不见|消失|出现|发现|翻出来|公开|拿走|看到|截图|转发/.test(a);
    if (passiveItem) return `${who}的${it}${a}`;
    return `${who}${a}，手里还拿着${it}`;
  }
  return `${who}${a}`;
}

function joinTwist(twist = '') {
  const t = String(twist || '').trim();
  if (!t) return '';
  if (/^[，。！？]/.test(t)) return t.replace(/^[，]+/, '');
  if (/^(结果|但|然而|偏偏|没想到|于是|然后|更离谱的是|最要命的是)/.test(t)) return t;
  const conn = pick(GACHA_CONNECTORS.转折) || '然后';
  return `${conn}${t}`;
}

export function buildSentenceFromTiles(tiles = []) {
  const map = Object.fromEntries((tiles || []).map((t) => [t.typeId, String(t.value || '').trim()]));
  const actor = map.actor || '某人';
  const location = map.location || '';
  const time = map.time || '';
  const item = map.item || '';
  const action = map.action || '';
  const twist = map.twist || '';

  const sceneParts = [];
  if (time && location) sceneParts.push(`${time}，在${location}`);
  else if (time) sceneParts.push(time);
  else if (location) sceneParts.push(`在${location}`);

  const core = composeActionClause(actor, action, item);
  const twistPart = joinTwist(twist);

  const chunks = [];
  if (sceneParts.length) chunks.push(sceneParts.join(''));
  chunks.push(core);
  if (twistPart) chunks.push(twistPart);

  const sentence = chunks.filter(Boolean).join('，').replace(/，+/g, '，').trim();
  if (sentence) return sentence;

  return (tiles || []).map((t) => t.value).filter(Boolean).join('，') || '一件尚未揭晓的特殊事件';
}
