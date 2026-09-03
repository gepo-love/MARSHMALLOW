import { CAPABILITY_RISKS } from './schema.js';

export class CapabilityDeniedError extends Error {
  constructor(message, decision = {}) {
    super(message);
    this.name = 'CapabilityDeniedError';
    this.code = 'capability_denied';
    this.decision = decision;
  }
}

export class CapabilityApprovalRequiredError extends Error {
  constructor(request) {
    super(`Capability approval required: ${request?.capability?.name || request?.capability?.id || ''}`);
    this.name = 'CapabilityApprovalRequiredError';
    this.code = 'capability_approval_required';
    this.request = request;
  }
}

function grantMatches(grant, capability, providerId, context) {
  if (!grant || grant.allow !== true) return false;
  if (grant.expiresAt && Number(grant.expiresAt) <= Date.now()) return false;
  if (grant.capabilityId !== capability.id && grant.capabilityId !== '*') return false;
  if (grant.providerId && grant.providerId !== providerId) return false;
  if (grant.context && grant.context !== '*' && grant.context !== context) return false;
  return true;
}

export function evaluateCapabilityPolicy(capability, options = {}) {
  const mode = String(options.mode || 'foreground');
  const context = String(options.context || 'manual');
  const providerId = String(options.providerId || '');
  const risk = capability.risk;

  if (!capability.contexts.includes(context)) {
    return { action: 'deny', reason: 'context_not_allowed' };
  }
  if (capability.requiresForeground && mode !== 'foreground') {
    return { action: 'deny', reason: 'foreground_required' };
  }
  if (risk === CAPABILITY_RISKS.DEVICE && options.activeDeviceSession !== true) {
    return { action: 'deny', reason: 'active_device_session_required' };
  }
  if (risk === CAPABILITY_RISKS.DEVICE
    && String(options.deviceSessionProviderId || '') === providerId) {
    return { action: 'allow', reason: 'active_device_session_approval' };
  }
  if (risk === CAPABILITY_RISKS.TRANSACTION && options.userInitiated !== true) {
    return { action: 'deny', reason: 'user_initiated_required' };
  }
  const approved = options.approved === true;
  if (approved) return { action: 'allow', reason: 'single_call_approval' };
  if (risk === CAPABILITY_RISKS.READ && options.capabilityAutoApproveRead === true) {
    return { action: 'allow', reason: 'tool_read_permission' };
  }

  const grants = Array.isArray(options.grants) ? options.grants : [];
  const remembered = capability.rememberApproval
    && grants.some((grant) => grantMatches(grant, capability, providerId, context));
  if (remembered) return { action: 'allow', reason: 'remembered_grant' };

  return {
    action: 'approve',
    reason: risk === CAPABILITY_RISKS.READ ? 'untrusted_read_tool' : `${risk}_operation`,
    rememberAllowed: capability.rememberApproval,
  };
}

export function makeApprovalRequest({ callId, capability, provider, arguments: args, context = {} }) {
  const display = context.display && typeof context.display === 'object' ? context.display : {};
  return Object.freeze({
    callId,
    capability,
    provider: Object.freeze({
      id: provider.id,
      type: provider.type,
      metadata: provider.metadata,
    }),
    arguments: args && typeof args === 'object' ? args : {},
    context: Object.freeze({
      mode: String(context.mode || 'foreground'),
      context: String(context.context || 'manual'),
      userInitiated: context.userInitiated === true,
      actorName: String(display.actorName || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    }),
  });
}
