import { executeCapability } from './executor.js';
import { CapabilityRegistry } from './registry.js';
import { createBuiltinWebSearchProvider } from './builtin-search.js';
import { createBuiltinDeviceSimulatorProvider } from './builtin-device-simulator.js';
import { createBuiltinKisstoyDeviceProvider } from './builtin-kisstoy-device.js';
import { createBuiltinMeituanProvider } from './builtin-meituan.js';
import { loadEnabledMcpProviders } from './mcp-connections.js';

let registry = null;
let initialized = false;
let initializationPromise = null;

function buildRegistry() {
  const next = new CapabilityRegistry();
  const search = createBuiltinWebSearchProvider();
  next.registerProvider(search.provider, search.capabilities);
  const simulator = createBuiltinDeviceSimulatorProvider();
  next.registerProvider(simulator.provider, simulator.capabilities);
  const kisstoy = createBuiltinKisstoyDeviceProvider();
  next.registerProvider(kisstoy.provider, kisstoy.capabilities);
  const meituan = createBuiltinMeituanProvider();
  next.registerProvider(meituan.provider, meituan.capabilities);
  return next;
}

export function getCapabilityRegistry() {
  if (!registry) registry = buildRegistry();
  return registry;
}

export function listAppCapabilities(options = {}) {
  return getCapabilityRegistry().list(options);
}

export async function executeAppCapability(request = {}, options = {}) {
  return executeCapability(getCapabilityRegistry(), request, options);
}

export async function refreshMcpCapabilityProviders() {
  const current = getCapabilityRegistry();
  const stale = current.listProviders().filter((provider) => provider.type === 'mcp');
  await Promise.all(stale.map((provider) => Promise.resolve(provider.close?.()).catch(() => {})));
  stale.forEach((provider) => current.unregisterProvider(provider.id));
  const bindings = await loadEnabledMcpProviders();
  for (const binding of bindings) current.registerProvider(binding.provider, binding.capabilities);
  initialized = true;
  return bindings.length;
}

export async function initializeCapabilityRuntime() {
  if (initialized) return getCapabilityRegistry().listProviders().filter((provider) => provider.type === 'mcp').length;
  if (!initializationPromise) {
    initializationPromise = refreshMcpCapabilityProviders().finally(() => { initializationPromise = null; });
  }
  return initializationPromise;
}

export function resetCapabilityRegistryForTests() {
  registry = null;
  initialized = false;
  initializationPromise = null;
}
