import { loadResolvedCharacterAutonomyPolicy } from './character-autonomy-settings.js';

function clean(value) {
  return String(value ?? '').trim();
}

export async function getCharacterApiBudgetStatus(userId, characterId, now = Date.now(), options = {}) {
  const uid = clean(userId);
  const cid = clean(characterId);
  if (!uid || !cid) return { enabled: false, unlimited: true, limit: null, used: 0, remaining: null };
  const loadPolicy = options.loadPolicy || loadResolvedCharacterAutonomyPolicy;
  const policy = options.policy || await loadPolicy(uid, cid, options.chatId || '').catch(() => null);
  return {
    enabled: policy?.realPersonMode?.enabled === true,
    unlimited: true,
    limit: null,
    used: 0,
    remaining: null,
  };
}

/**
 * 兼容旧调用入口：每日 API 预算已取消，只保留真人感模式启用状态检查。
 */
export async function consumeCharacterApiBudget({
  userId,
  characterId,
  chatId = '',
  policy = null,
  loadPolicy = loadResolvedCharacterAutonomyPolicy,
} = {}) {
  const uid = clean(userId);
  const cid = clean(characterId);
  if (!uid || !cid) return { ok: false, reason: 'missing-identity' };
  const status = await getCharacterApiBudgetStatus(uid, cid, Date.now(), {
    policy,
    chatId,
    loadPolicy,
  });
  if (!status.enabled) return { ok: false, reason: 'real-person-disabled', ...status };
  return { ok: true, ...status };
}
