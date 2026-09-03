import * as db from './db.js';

/**
 * 动态认识账本：记录「两个角色已经认识了」这一事实，与用户手动维护的关系网互补。
 * - 规则层（source=rule）：同群聊互动、手机同窗聊天等事件自动写入，level=met。
 * - AI 层（source=ai）：聊天总结提取出的关系印象写入，level=familiar，带关系描述。
 * 账本只增加「认识」，不会取消用户手动建立的任何关系。
 */

const SETTINGS_KEY = 'acquaintanceLedger';
const SCOPE_MIGRATION_KEY = 'acquaintanceLedgerScopeMigrationV1';
const MAX_ENTRIES = 600;

const LEVELS = new Set(['met', 'familiar']);
const SOURCES = new Set(['rule', 'ai', 'manual']);

function cleanId(value = '') {
  return String(value || '').trim();
}

function scopedSettingsKey(userId = '') {
  const id = cleanId(userId);
  return id ? `${SETTINGS_KEY}:${encodeURIComponent(id)}` : SETTINGS_KEY;
}

async function resolveLedgerUserId(userId = '') {
  const explicit = cleanId(userId);
  if (explicit) return explicit;
  const current = await db.get('currentUserId').catch(() => null);
  return cleanId(current?.value);
}

export function acquaintancePairKey(a, b) {
  const x = cleanId(a);
  const y = cleanId(b);
  if (!x || !y || x === y) return '';
  return x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
}

function normalizeEntry(raw) {
  if (!raw) return null;
  const a = cleanId(raw.a);
  const b = cleanId(raw.b);
  if (!a || !b || a === b || a === 'user' || b === 'user') return null;
  const level = LEVELS.has(raw.level) ? raw.level : 'met';
  const source = SOURCES.has(raw.source) ? raw.source : 'rule';
  return {
    a: a < b ? a : b,
    b: a < b ? b : a,
    level,
    label: String(raw.label || '').trim().slice(0, 40),
    source,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function normalizeLedger(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const seen = new Map();
  for (const item of Array.isArray(base.entries) ? base.entries : []) {
    const entry = normalizeEntry(item);
    if (!entry) continue;
    const key = acquaintancePairKey(entry.a, entry.b);
    const prev = seen.get(key);
    if (!prev || (entry.updatedAt || 0) >= (prev.updatedAt || 0)) seen.set(key, entry);
  }
  const entries = [...seen.values()]
    .sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
    .slice(0, MAX_ENTRIES);
  return { version: 1, entries };
}

const cacheByKey = new Map();

db.onStoreWrite('settings', (key) => {
  if (key === undefined) {
    cacheByKey.clear();
    return;
  }
  cacheByKey.delete(String(key || ''));
});

export async function loadAcquaintanceLedger(userId = '') {
  const uid = await resolveLedgerUserId(userId);
  const scopedKey = scopedSettingsKey(uid);
  if (cacheByKey.has(scopedKey)) return normalizeLedger(cacheByKey.get(scopedKey));

  const scoped = await db.get(scopedKey);
  if (scoped) {
    cacheByKey.set(scopedKey, scoped.value || null);
    return normalizeLedger(scoped.value);
  }

  if (uid) {
    const migration = await db.get(SCOPE_MIGRATION_KEY).catch(() => null);
    if (!migration?.value?.ownerUserId) {
      const legacy = await db.get(SETTINGS_KEY).catch(() => null);
      if (legacy?.value) {
        const migrated = normalizeLedger(legacy.value);
        await db.put({ key: scopedKey, value: migrated });
        await db.put({
          key: SCOPE_MIGRATION_KEY,
          value: { ownerUserId: uid, migratedAt: Date.now() },
        });
        cacheByKey.set(scopedKey, migrated);
        return migrated;
      }
    }
  }

  const empty = normalizeLedger(null);
  cacheByKey.set(scopedKey, empty);
  return empty;
}

export async function saveAcquaintanceLedger(ledger, userId = '') {
  const next = normalizeLedger(ledger);
  const uid = await resolveLedgerUserId(userId);
  const key = scopedSettingsKey(uid);
  await db.put({ key, value: next });
  cacheByKey.set(key, next);
  return next;
}

/** 账本里的成对集合，供同步判定使用。 */
export function buildLedgerPairSet(ledger) {
  const out = new Set();
  for (const entry of ledger?.entries || []) {
    const key = acquaintancePairKey(entry.a, entry.b);
    if (key) out.add(key);
  }
  return out;
}

export function findLedgerEntry(ledger, a, b) {
  const key = acquaintancePairKey(a, b);
  if (!key) return null;
  return (ledger?.entries || []).find((e) => acquaintancePairKey(e.a, e.b) === key) || null;
}

/**
 * 记录一对角色认识。已有记录时只升级不降级：
 * met → familiar 可以，familiar 不会被 met 覆盖；AI 写的描述不被规则层的空描述冲掉。
 */
export async function recordAcquaintance(aId, bId, {
  level = 'met',
  label = '',
  source = 'rule',
  userId = '',
} = {}) {
  const entry = normalizeEntry({ a: aId, b: bId, level, label, source });
  if (!entry) return null;
  const ledger = await loadAcquaintanceLedger(userId);
  const existing = findLedgerEntry(ledger, entry.a, entry.b);
  if (existing) {
    const upgrade = existing.level === 'met' && entry.level === 'familiar';
    const labelUpdate = entry.label && (entry.source === 'ai' || entry.source === 'manual' || !existing.label);
    if (!upgrade && !labelUpdate) return existing;
    existing.level = upgrade ? 'familiar' : existing.level;
    if (labelUpdate) {
      existing.label = entry.label;
      existing.source = entry.source;
    }
    existing.updatedAt = Date.now();
    return (await saveAcquaintanceLedger(ledger, userId)).entries.find(
      (e) => acquaintancePairKey(e.a, e.b) === acquaintancePairKey(entry.a, entry.b),
    ) || existing;
  }
  ledger.entries.unshift(entry);
  await saveAcquaintanceLedger(ledger, userId);
  return entry;
}

/** 一组角色两两记为认识（规则层事件用，如同群聊互动过）。 */
export async function recordAcquaintancePairs(ids = [], {
  level = 'met',
  label = '',
  source = 'rule',
  userId = '',
} = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : [])
    .map(cleanId)
    .filter((id) => id && id !== 'user' && id !== 'system'))];
  if (list.length < 2) return 0;
  const ledger = await loadAcquaintanceLedger(userId);
  const known = buildLedgerPairSet(ledger);
  let added = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const key = acquaintancePairKey(list[i], list[j]);
      if (!key || known.has(key)) continue;
      const entry = normalizeEntry({ a: list[i], b: list[j], level, label, source });
      if (!entry) continue;
      ledger.entries.unshift(entry);
      known.add(key);
      added += 1;
    }
  }
  if (added) await saveAcquaintanceLedger(ledger, userId);
  return added;
}

export async function removeAcquaintance(aId, bId, userId = '') {
  const key = acquaintancePairKey(aId, bId);
  if (!key) return false;
  const ledger = await loadAcquaintanceLedger(userId);
  const before = ledger.entries.length;
  ledger.entries = ledger.entries.filter((e) => acquaintancePairKey(e.a, e.b) !== key);
  if (ledger.entries.length === before) return false;
  await saveAcquaintanceLedger(ledger, userId);
  return true;
}
