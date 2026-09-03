import { resultToText, CAPABILITY_RISKS, normalizeCapabilityArguments } from './schema.js';
import {
  CapabilityApprovalRequiredError,
  CapabilityDeniedError,
  evaluateCapabilityPolicy,
  makeApprovalRequest,
} from './policy.js';

function makeCallId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function timeoutSignal(source, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(source?.reason);
  if (source?.aborted) onAbort();
  else source?.addEventListener?.('abort', onAbort, { once: true });
  const timer = Number(timeoutMs) > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Number(timeoutMs))
    : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timer) clearTimeout(timer);
      source?.removeEventListener?.('abort', onAbort);
    },
  };
}

function approvalAccepted(value) {
  return value === true || value?.approved === true || value?.action === 'approve';
}

export async function executeCapability(registry, request = {}, options = {}) {
  const capabilityId = String(request.capabilityId || '').trim();
  const executionContext = {
    mode: String(options.mode || request.context?.mode || 'foreground'),
    context: String(options.context || request.context?.context || 'manual'),
    userInitiated: options.userInitiated === true || request.context?.userInitiated === true,
    activeDeviceSession: options.activeDeviceSession === true || request.context?.activeDeviceSession === true,
    deviceSessionProviderId: String(options.deviceSessionProviderId || request.context?.deviceSessionProviderId || ''),
    grants: options.grants || request.context?.grants || [],
    metadata: options.metadata || request.context?.metadata || {},
    display: options.display || request.context?.display || {},
  };
  const candidates = registry.candidates(capabilityId, {
    providerId: request.providerId,
    context: executionContext.context,
  });
  if (!candidates.length) throw new Error(`Capability is not available: ${capabilityId}`);

  const callId = String(request.callId || makeCallId());
  const primary = candidates[0];
  const args = normalizeCapabilityArguments(request.arguments || {}, primary.capability.inputSchema);
  let decision = evaluateCapabilityPolicy(primary.capability, {
    ...executionContext,
    providerId: primary.provider.id,
    capabilityAutoApproveRead: primary.capability.autoApproveRead === true,
    approved: request.approved === true,
    deviceSessionProviderId: executionContext.deviceSessionProviderId,
  });
  if (decision.action === 'deny') {
    throw new CapabilityDeniedError(`Capability denied: ${decision.reason}`, decision);
  }
  if (decision.action === 'approve') {
    const approvalRequest = makeApprovalRequest({
      callId,
      capability: primary.capability,
      provider: primary.provider,
      arguments: args,
      context: executionContext,
    });
    if (typeof options.approvalHandler !== 'function') {
      throw new CapabilityApprovalRequiredError(approvalRequest);
    }
    const approval = await options.approvalHandler(approvalRequest);
    if (!approvalAccepted(approval)) {
      throw new CapabilityDeniedError('Capability approval was declined', {
        action: 'deny',
        reason: 'approval_declined',
      });
    }
    decision = { action: 'allow', reason: 'interactive_approval' };
  }

  const allowFallback = options.allowProviderFallback === true
    && primary.capability.risk === CAPABILITY_RISKS.READ;
  const attempts = allowFallback ? candidates : candidates.slice(0, 1);
  let lastError = null;
  for (const binding of attempts) {
    const startedAt = Date.now();
    const timeout = timeoutSignal(options.signal, options.timeoutMs || 60_000);
    try {
      const raw = await binding.provider.execute(binding.capability, args, {
        ...executionContext,
        callId,
        signal: timeout.signal,
      });
      const isError = raw?.isError === true;
      const text = resultToText(raw, options.maxResultChars || 24000);
      return Object.freeze({
        ok: !isError,
        callId,
        capabilityId: binding.capability.id,
        providerId: binding.provider.id,
        risk: binding.capability.risk,
        approvalReason: decision.reason,
        durationMs: Date.now() - startedAt,
        text,
        providerName: String(binding.provider.metadata?.label || binding.provider.id),
        capabilityName: binding.capability.name,
        errorCode: isError ? 'tool_result_error' : '',
        errorStage: isError ? 'tool' : '',
        errorMessage: isError ? (text || '工具返回失败') : '',
        structuredContent: raw?.structuredContent ?? null,
        content: Array.isArray(raw?.content) ? raw.content : null,
        raw,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (timeout.timedOut()) {
        const wrapped = new Error(`Capability timed out: ${binding.capability.id}`);
        wrapped.name = 'TimeoutError';
        wrapped.code = 'capability_timeout';
        wrapped.reason = 'capability_timeout';
        wrapped.timeoutMs = Number(options.timeoutMs || 60_000);
        wrapped.elapsedMs = Date.now() - startedAt;
        wrapped.cause = error;
        lastError = wrapped;
      } else if (error?.name === 'AbortError') {
        throw error;
      } else {
        lastError = error;
      }
    } finally {
      timeout.cleanup();
    }
  }
  throw lastError || new Error(`Capability failed: ${capabilityId}`);
}
