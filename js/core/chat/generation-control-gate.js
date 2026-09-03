/**
 * Foreground generation starts with several async preparation steps.  Keep a
 * synchronous intent gate in front of them so rapid taps cannot start sibling
 * rounds and Stop can cancel work before the transport AbortController is
 * registered.
 */
export function createGenerationIntentGate() {
  let currentIntent = null;
  let sequence = 0;

  function current() {
    if (currentIntent?.controller?.signal?.aborted) {
      currentIntent = null;
    }
    return currentIntent;
  }

  function claim(action = 'advance') {
    if (current()) return null;
    const intent = {
      id: ++sequence,
      action: String(action || 'advance'),
      controller: new AbortController(),
      startedAt: Date.now(),
    };
    currentIntent = intent;
    return intent;
  }

  function cancel(reason = 'user') {
    const intent = currentIntent;
    currentIntent = null;
    if (!intent) return null;
    try {
      intent.controller.signal.marshmallowAbortReason = reason;
      intent.controller.abort(reason);
    } catch (_) {}
    return intent;
  }

  function release(intent) {
    if (!intent || currentIntent?.id !== intent.id) return false;
    currentIntent = null;
    return true;
  }

  return { current, claim, cancel, release };
}

/**
 * A tri-state composer button may change from Stop to Advance during the same
 * physical tap. Capture the pointer-down action so a delayed synthetic click
 * cannot be reinterpreted using the button's new state.
 */
export function createControlGestureLatch({ ttlMs = 15000, now = () => Date.now() } = {}) {
  let currentGesture = null;

  function fresh() {
    if (currentGesture && now() - currentGesture.startedAt > ttlMs) {
      currentGesture = null;
    }
    return currentGesture;
  }

  function begin({ target, action, pointerId = null } = {}) {
    currentGesture = {
      target: target || null,
      action: String(action || ''),
      pointerId,
      handled: false,
      startedAt: now(),
    };
    return currentGesture;
  }

  function peek(target) {
    const gesture = fresh();
    if (!gesture || (target && gesture.target !== target)) return null;
    return gesture;
  }

  function markHandled(gesture) {
    if (!gesture || currentGesture !== gesture) return false;
    gesture.handled = true;
    return true;
  }

  function consume(target) {
    const gesture = peek(target);
    if (!gesture) return null;
    currentGesture = null;
    return gesture;
  }

  function cancel(pointerId = null) {
    const gesture = fresh();
    if (!gesture) return false;
    if (pointerId !== null && gesture.pointerId !== pointerId) return false;
    currentGesture = null;
    return true;
  }

  return { begin, peek, markHandled, consume, cancel };
}
