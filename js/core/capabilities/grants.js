import { get, put, remove } from '../db.js';
import { CAPABILITY_RISKS } from './schema.js';

export const CAPABILITY_GRANTS_KEY = 'capabilityGrants';
const MAX_STORED_GRANTS = 200;
const ALLOWED_CONTEXTS = new Set(['*', 'chat', 'voice', 'video', 'manual']);

function clean(value = '', max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeCapabilityGrant(value = {}) {
  const capabilityId = clean(value.capabilityId, 128).toLowerCase();
  const providerId = clean(value.providerId, 160);
  const context = clean(value.context, 24);
  if (!capabilityId || !providerId || !ALLOWED_CONTEXTS.has(context)) return null;
  const expiresAt = Math.max(0, Number(value.expiresAt || 0) || 0);
  return Object.freeze({
    allow: value.allow === true,
    capabilityId,
    providerId,
    context,
    createdAt: Math.max(0, Number(value.createdAt || 0) || Date.now()),
    expiresAt,
  });
}

export function capabilityGrantFromApprovalRequest(request = {}) {
  const capability = request.capability || {};
  if (capability.risk !== CAPABILITY_RISKS.READ || capability.rememberApproval !== true) return null;
  return normalizeCapabilityGrant({
    allow: true,
    capabilityId: capability.id,
    providerId: request.provider?.id,
    context: '*',
    createdAt: Date.now(),
  });
}

function matchesFilter(grant, filter = {}) {
  if (filter.capabilityId && grant.capabilityId !== String(filter.capabilityId).trim().toLowerCase()) return false;
  if (filter.providerId && grant.providerId !== String(filter.providerId).trim()) return false;
  if (filter.context && grant.context !== '*' && grant.context !== String(filter.context).trim()) return false;
  return true;
}

async function readAllGrants() {
  const row = await get('settings', CAPABILITY_GRANTS_KEY).catch(() => null);
  const now = Date.now();
  return (Array.isArray(row?.value) ? row.value : [])
    .map(normalizeCapabilityGrant)
    .filter((grant) => grant?.allow === true && (!grant.expiresAt || grant.expiresAt > now));
}

export async function listCapabilityGrants(filter = {}) {
  return (await readAllGrants()).filter((grant) => matchesFilter(grant, filter));
}

export async function rememberCapabilityGrant(value = {}) {
  const next = value.capability
    ? capabilityGrantFromApprovalRequest(value)
    : normalizeCapabilityGrant({ ...value, allow: true });
  if (!next) throw new TypeError('该工具不支持持续授权');
  const rows = (await readAllGrants()).filter((grant) => !(
    grant.capabilityId === next.capabilityId
    && grant.providerId === next.providerId
    && grant.context === next.context
  ));
  rows.push(next);
  await put('settings', { key: CAPABILITY_GRANTS_KEY, value: rows.slice(-MAX_STORED_GRANTS) });
  return next;
}

export async function revokeCapabilityGrants(filter = {}) {
  const rows = await readAllGrants();
  const kept = rows.filter((grant) => !matchesFilter(grant, filter));
  if (kept.length === rows.length) return 0;
  if (kept.length) await put('settings', { key: CAPABILITY_GRANTS_KEY, value: kept });
  else await remove(CAPABILITY_GRANTS_KEY).catch(() => {});
  return rows.length - kept.length;
}
