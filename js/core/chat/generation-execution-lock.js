/** Cross-tab guard for one chat generation. Web Locks are atomic across same-origin tabs. */
export async function acquireGenerationExecutionLock(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (typeof locks?.request !== 'function') {
    return { acquired: true, release() {} };
  }
  let resolveAcquired;
  let releaseHold = null;
  const acquiredPromise = new Promise((resolve) => { resolveAcquired = resolve; });
  const requestPromise = locks.request(
    `marshmallow:chat-generation:${id}`,
    { mode: 'exclusive', ifAvailable: true },
    (lock) => {
      if (!lock) {
        resolveAcquired(false);
        return undefined;
      }
      resolveAcquired(true);
      return new Promise((resolve) => { releaseHold = resolve; });
    },
  ).catch(() => {
    resolveAcquired(false);
  });
  const acquired = await acquiredPromise;
  if (!acquired) return null;
  let released = false;
  return {
    acquired: true,
    release() {
      if (released) return;
      released = true;
      releaseHold?.();
      void requestPromise;
    },
  };
}
