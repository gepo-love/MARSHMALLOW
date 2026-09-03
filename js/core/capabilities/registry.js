import { assertCapabilityId, normalizeCapability } from './schema.js';

function normalizeProvider(provider = {}) {
  const id = String(provider.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)) {
    throw new TypeError(`Invalid capability provider id: ${String(provider.id || '')}`);
  }
  if (typeof provider.execute !== 'function') {
    throw new TypeError(`Capability provider ${id} must implement execute()`);
  }
  return Object.freeze({
    id,
    type: String(provider.type || 'builtin').trim().slice(0, 30),
    priority: Number.isFinite(Number(provider.priority)) ? Number(provider.priority) : 0,
    enabled: provider.enabled !== false,
    execute: provider.execute,
    close: typeof provider.close === 'function' ? provider.close : null,
    metadata: Object.freeze({ ...(provider.metadata || {}) }),
  });
}

export class CapabilityRegistry {
  #providers = new Map();

  #bindings = new Map();

  registerProvider(provider, capabilities = []) {
    const cleanProvider = normalizeProvider(provider);
    if (this.#providers.has(cleanProvider.id)) {
      throw new Error(`Capability provider already registered: ${cleanProvider.id}`);
    }
    this.#providers.set(cleanProvider.id, cleanProvider);
    try {
      for (const capability of capabilities) this.registerCapability(cleanProvider.id, capability);
    } catch (error) {
      this.unregisterProvider(cleanProvider.id);
      throw error;
    }
    return cleanProvider;
  }

  registerCapability(providerId, capability) {
    const provider = this.#providers.get(String(providerId || '').trim().toLowerCase());
    if (!provider) throw new Error(`Unknown capability provider: ${String(providerId || '')}`);
    const clean = normalizeCapability(capability);
    const rows = this.#bindings.get(clean.id) || [];
    if (rows.some((row) => row.provider.id === provider.id)) {
      throw new Error(`Capability ${clean.id} is already registered by ${provider.id}`);
    }
    rows.push(Object.freeze({ capability: clean, provider }));
    rows.sort((a, b) => b.provider.priority - a.provider.priority || a.provider.id.localeCompare(b.provider.id));
    this.#bindings.set(clean.id, rows);
    return clean;
  }

  unregisterProvider(providerId) {
    const id = String(providerId || '').trim().toLowerCase();
    const provider = this.#providers.get(id);
    if (!provider) return false;
    this.#providers.delete(id);
    for (const [capabilityId, rows] of this.#bindings) {
      const next = rows.filter((row) => row.provider.id !== id);
      if (next.length) this.#bindings.set(capabilityId, next);
      else this.#bindings.delete(capabilityId);
    }
    return true;
  }

  getProvider(providerId) {
    return this.#providers.get(String(providerId || '').trim().toLowerCase()) || null;
  }

  listProviders() {
    return [...this.#providers.values()];
  }

  list(options = {}) {
    const context = String(options.context || '').trim();
    const includeDisabled = options.includeDisabled === true;
    const providerId = String(options.providerId || '').trim().toLowerCase();
    const out = [];
    for (const rows of this.#bindings.values()) {
      const binding = rows.find((row) => (
        (!providerId || row.provider.id === providerId)
        && (includeDisabled || row.provider.enabled)
        && (!context || row.capability.contexts.includes(context))
      ));
      if (binding) out.push(binding.capability);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  resolve(capabilityId, options = {}) {
    const id = assertCapabilityId(capabilityId);
    const rows = this.#bindings.get(id) || [];
    const providerId = String(options.providerId || '').trim().toLowerCase();
    const context = String(options.context || '').trim();
    return rows.find((row) => (
      row.provider.enabled
      && (!providerId || row.provider.id === providerId)
      && (!context || row.capability.contexts.includes(context))
    )) || null;
  }

  candidates(capabilityId, options = {}) {
    const id = assertCapabilityId(capabilityId);
    const context = String(options.context || '').trim();
    const providerId = String(options.providerId || '').trim().toLowerCase();
    return (this.#bindings.get(id) || []).filter((row) => (
      row.provider.enabled
      && (!providerId || row.provider.id === providerId)
      && (!context || row.capability.contexts.includes(context))
    ));
  }

  async close() {
    const closers = [...this.#providers.values()]
      .filter((provider) => provider.close)
      .map((provider) => Promise.resolve().then(() => provider.close()).catch(() => {}));
    await Promise.all(closers);
    this.#providers.clear();
    this.#bindings.clear();
  }
}
