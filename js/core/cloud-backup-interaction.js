const CLOUD_BACKUP_INTERACTION_KEY = '__mm_cloud_backup_interaction_v1__';
const CLOUD_BACKUP_DRAFT_KEY = '__mm_cloud_backup_draft_v1__';
const GITHUB_AUTH_PENDING_KEY = '__mm_cloud_backup_github_auth_v1__';
export const CLOUD_BACKUP_INTERACTION_TTL_MS = 60 * 60 * 1000;

function localStore() {
  try { return globalThis.localStorage; } catch (_) { return null; }
}

function sessionStore() {
  try { return globalThis.sessionStorage; } catch (_) { return null; }
}

function normalizeDraft(value = {}) {
  return {
    provider: value.provider === 'webdav' ? 'webdav' : 'github',
    url: String(value.url || ''),
    username: String(value.username || ''),
    password: String(value.password || ''),
    encryptionPassword: String(value.encryptionPassword || ''),
    retention: Math.max(1, Math.min(30, Math.round(Number(value.retention) || 5))),
    intervalHours: Math.max(6, Math.min(168, Number(value.intervalHours) || 24)),
    autoEnabled: value.autoEnabled === true,
  };
}

function clearStoredInteraction() {
  try { localStore()?.removeItem(CLOUD_BACKUP_INTERACTION_KEY); } catch (_) {}
  try { sessionStore()?.removeItem(CLOUD_BACKUP_DRAFT_KEY); } catch (_) {}
}

export function readCloudBackupInteraction() {
  try {
    const marker = JSON.parse(localStore()?.getItem(CLOUD_BACKUP_INTERACTION_KEY) || 'null');
    const updatedAt = Number(marker?.updatedAt || 0);
    if (!marker?.active || !updatedAt || Date.now() - updatedAt > CLOUD_BACKUP_INTERACTION_TTL_MS) {
      clearStoredInteraction();
      return null;
    }
    let draft = null;
    try {
      const rawDraft = JSON.parse(sessionStore()?.getItem(CLOUD_BACKUP_DRAFT_KEY) || 'null');
      if (rawDraft && typeof rawDraft === 'object') draft = normalizeDraft(rawDraft);
    } catch (_) {}
    return { active: true, updatedAt, draft };
  } catch (_) {
    clearStoredInteraction();
    return null;
  }
}

export function keepCloudBackupInteraction(draft = null) {
  const now = Date.now();
  try {
    localStore()?.setItem(CLOUD_BACKUP_INTERACTION_KEY, JSON.stringify({ active: true, updatedAt: now }));
  } catch (_) {}
  if (draft && typeof draft === 'object') {
    try { sessionStore()?.setItem(CLOUD_BACKUP_DRAFT_KEY, JSON.stringify(normalizeDraft(draft))); } catch (_) {}
  }
  return now;
}

export function clearCloudBackupInteraction() {
  clearStoredInteraction();
}

export function hasPendingCloudBackupInteraction() {
  return !!readCloudBackupInteraction();
}

function clearStoredGitHubAuthorization() {
  try { localStore()?.removeItem(GITHUB_AUTH_PENDING_KEY); } catch (_) {}
}

function normalizePendingGitHubAuthorization(value = {}, now = Date.now()) {
  const deviceCode = String(value.deviceCode || '').trim();
  const userCode = String(value.userCode || '').trim();
  const verificationUri = String(value.verificationUri || '').trim();
  const expiresAt = Number(value.expiresAt || 0);
  const interval = Math.max(5, Math.min(30, Number(value.interval) || 5));
  if (!deviceCode || !userCode
    || !/^https:\/\/github\.com\/login\/device\/?(?:\?.*)?$/i.test(verificationUri)
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || expiresAt > now + CLOUD_BACKUP_INTERACTION_TTL_MS) {
    return null;
  }
  return { deviceCode, userCode, verificationUri, expiresAt, interval };
}

/** GitHub 设备授权页离开 App 时，短时保留轮询所需的验证码。 */
export function savePendingGitHubAuthorization(value = {}) {
  const now = Date.now();
  const normalized = normalizePendingGitHubAuthorization({
    ...value,
    expiresAt: Number(value.expiresAt || 0)
      || now + Math.max(60, Math.min(3600, Number(value.expiresIn) || 900)) * 1000,
  }, now);
  if (!normalized) {
    clearStoredGitHubAuthorization();
    return null;
  }
  try { localStore()?.setItem(GITHUB_AUTH_PENDING_KEY, JSON.stringify(normalized)); } catch (_) {}
  return normalized;
}

export function readPendingGitHubAuthorization() {
  try {
    const value = JSON.parse(localStore()?.getItem(GITHUB_AUTH_PENDING_KEY) || 'null');
    const normalized = normalizePendingGitHubAuthorization(value);
    if (!normalized) clearStoredGitHubAuthorization();
    return normalized;
  } catch (_) {
    clearStoredGitHubAuthorization();
    return null;
  }
}

export function clearPendingGitHubAuthorization() {
  clearStoredGitHubAuthorization();
}
