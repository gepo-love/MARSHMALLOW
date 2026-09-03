function clean(value = '') {
  return String(value ?? '').trim();
}

export function createChatRoundReceipt(input = {}) {
  const status = clean(input.status || 'skipped') || 'skipped';
  const code = clean(input.code || 'unknown');
  return {
    code,
    status,
    stage: clean(input.stage || 'persist'),
    eventType: clean(input.eventType),
    reason: clean(input.reason || code),
    ...(input.chatId ? { chatId: clean(input.chatId) } : {}),
    ...(input.targetChatId ? { targetChatId: clean(input.targetChatId) } : {}),
    ...(input.context && typeof input.context === 'object' ? { context: { ...input.context } } : {}),
  };
}

export function createChatRoundReceiptCollector(initial = []) {
  const receipts = (Array.isArray(initial) ? initial : []).map(createChatRoundReceipt);
  return {
    add(input) {
      const receipt = createChatRoundReceipt(input);
      receipts.push(receipt);
      return receipt;
    },
    list() {
      return receipts.slice();
    },
  };
}

export function attachReceipts(target, receipts = []) {
  if (target && (typeof target === 'object' || typeof target === 'function')) {
    Object.defineProperty(target, 'receipts', {
      value: (Array.isArray(receipts) ? receipts : []).slice(),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }
  return target;
}
