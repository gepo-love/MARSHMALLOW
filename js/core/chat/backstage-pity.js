/**
 * 秘密基地「保底出场」欠账计数：角色每次被纳入候选名册但当轮秘密基地事件里没有他/她，欠账 +1；
 * 一旦作为真实通讯录角色出现在某次秘密基地事件里，欠账清零。用于避免"从没触发过的角色一直不触发"。
 */
import { get, put } from '../db.js';

const BACKSTAGE_PITY_KEY = 'backstagePity';
export const BACKSTAGE_PITY_THRESHOLD = 6;

export async function loadBackstagePity() {
  const row = await get(BACKSTAGE_PITY_KEY);
  return (row?.value && typeof row.value === 'object') ? { ...row.value } : {};
}

async function saveBackstagePity(map) {
  await put({ key: BACKSTAGE_PITY_KEY, value: map });
}

/** 候选名册里的角色本轮被纳入但尚未确认出场，先记一笔欠账；真正出场后由 resetBackstagePity 清零。 */
export async function bumpBackstagePity(ids = []) {
  const clean = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!clean.length) return;
  const pity = await loadBackstagePity();
  for (const id of clean) pity[id] = (Number(pity[id]) || 0) + 1;
  await saveBackstagePity(pity);
}

/** 角色作为真实通讯录角色出现在某次秘密基地事件里，欠账清零。 */
export async function resetBackstagePity(ids = []) {
  const clean = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!clean.length) return;
  const pity = await loadBackstagePity();
  let changed = false;
  for (const id of clean) {
    if (pity[id]) {
      pity[id] = 0;
      changed = true;
    }
  }
  if (changed) await saveBackstagePity(pity);
}
