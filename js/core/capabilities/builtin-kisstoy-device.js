import {
  controlNativeToy,
  connectNativeToy,
  disconnectNativeToy,
  getNativeToyStatus,
  isNativeToyBleAvailable,
  scanNativeToys,
  subscribeNativeToyConnection,
} from '../native-toy-ble.js';
import {
  DEFAULT_INTIFACE_ENDPOINT,
  connectIntifaceServer,
  controlIntifaceToy,
  disconnectIntifaceServer,
  getIntifaceToyState,
  normalizeIntifaceEndpoint,
  scanIntifaceToys,
  selectIntifaceToy,
  stopIntifaceToy,
  subscribeIntifaceToy,
} from '../intiface-toy.js';
import { CAPABILITY_RISKS, normalizeCapability } from './schema.js';
import {
  findToyAdapterProfile,
} from '../toy-adapter-registry.js';

const SETTINGS_KEY = 'marshmallow:kisstoy-device:v1';
const DEFAULT_MAX_INTENSITY = 100;
const MAX_DURATION_MS = 5 * 60_000;
const DEFAULT_DURATION_MS = MAX_DURATION_MS;
const MIN_DURATION_MS = 30_000;
const NATIVE_PROFILE_VALUES = new Set(['unconfirmed', 'vibration', 'suction', 'both']);

function normalizeNativeProfile(value = 'both') {
  return NATIVE_PROFILE_VALUES.has(value) ? value : 'both';
}

function nativeOutputs(profile = 'both') {
  const normalized = normalizeNativeProfile(profile);
  return [
    ...(normalized !== 'suction' ? [{ id: 'native:vibration', type: 'Vibrate', label: '震动' }] : []),
    ...(normalized !== 'vibration' ? [{ id: 'native:suction', type: 'Suction', label: '吮吸' }] : []),
  ];
}

export const KISSTOY_STATUS_CAPABILITY = normalizeCapability({
  id: 'device.toy.status',
  name: '查看玩具状态',
  description: '查看当前玩具是否连接、可控功能、强度与剩余控制时间',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  risk: CAPABILITY_RISKS.READ,
  contexts: ['chat', 'voice', 'video', 'manual'],
  autoApproveRead: true,
  allowAutonomousUse: true,
  annotations: { readOnly: true, idempotent: true },
  source: { type: 'builtin-device' },
});

export const KISSTOY_SET_CAPABILITY = normalizeCapability({
  id: 'device.toy.set',
  name: '设置玩具强度',
  description: '设置当前玩具的震动、吸吮或状态中列出的其他功能，强度为 0 到 100。普通控制默认保持 5 分钟；停止时调用停止玩具',
  inputSchema: {
    type: 'object',
    properties: {
      vibration: { type: 'integer', minimum: 0, maximum: 100 },
      suction: { type: 'integer', minimum: 0, maximum: 100 },
      outputs: {
        type: 'array',
        maxItems: 12,
        description: '用于 Intiface 设备的通用功能；feature 必须使用玩具状态返回的功能 id',
        items: {
          type: 'object',
          properties: {
            feature: { type: 'string', minLength: 1, maxLength: 120 },
            intensity: { type: 'integer', minimum: 0, maximum: 100 },
          },
          required: ['feature', 'intensity'],
          additionalProperties: false,
        },
      },
      duration_seconds: {
        type: 'integer', minimum: 30, maximum: MAX_DURATION_MS / 1000,
        description: '仅在明确需要短时动作时填写，范围 30～300 秒；普通控制省略此项，默认保持 5 分钟',
      },
    },
    additionalProperties: false,
  },
  risk: CAPABILITY_RISKS.DEVICE,
  contexts: ['chat', 'voice', 'video', 'manual'],
  allowAutonomousUse: true,
  annotations: { idempotent: false },
  source: { type: 'builtin-device' },
});

export const KISSTOY_STOP_CAPABILITY = normalizeCapability({
  id: 'device.toy.stop',
  name: '停止玩具',
  description: '立即停止当前玩具的全部输出',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  risk: CAPABILITY_RISKS.DEVICE,
  contexts: ['chat', 'voice', 'video', 'manual'],
  allowAutonomousUse: true,
  annotations: { idempotent: true },
  source: { type: 'builtin-device' },
});

function loadSettings() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) || '{}');
    return {
      maxIntensity: Math.max(1, Math.min(100, Math.round(Number(value.maxIntensity) || DEFAULT_MAX_INTENSITY))),
      connectionMode: value.connectionMode === 'intiface' ? 'intiface' : 'native',
      intifaceEndpoint: normalizeIntifaceEndpoint(value.intifaceEndpoint || DEFAULT_INTIFACE_ENDPOINT),
      nativeProfiles: value.nativeProfiles && typeof value.nativeProfiles === 'object' ? value.nativeProfiles : {},
    };
  } catch (_) {
    return {
      maxIntensity: DEFAULT_MAX_INTENSITY,
      connectionMode: 'native',
      intifaceEndpoint: DEFAULT_INTIFACE_ENDPOINT,
      nativeProfiles: {},
    };
  }
}

let settings = loadSettings();
let timer = null;
let nativeReconnectWanted = false;
let nativeReconnectPromise = null;
let lastNativeDevice = null;
let desiredNativeOutput = null;
let state = {
  available: settings.connectionMode === 'intiface'
    ? getIntifaceToyState().available : isNativeToyBleAvailable(),
  connected: false,
  roleControl: false,
  autonomousControl: false,
  authorizedCharacterIds: [],
  backend: settings.connectionMode,
  deviceName: '',
  address: '',
  vibration: 0,
  suction: 0,
  nativeProfile: 'both',
  outputs: [],
  activeOutputs: [],
  expiresAt: 0,
};
const listeners = new Set();

function snapshot() {
  return Object.freeze({
    ...state,
    authorizedCharacterIds: Object.freeze([...state.authorizedCharacterIds]),
    outputs: Object.freeze(state.outputs.map((item) => Object.freeze({ ...item }))),
    activeOutputs: Object.freeze(state.activeOutputs.map((item) => Object.freeze({ ...item }))),
    maxIntensity: settings.maxIntensity,
    intifaceEndpoint: settings.intifaceEndpoint,
  });
}

function emit() {
  const value = snapshot();
  listeners.forEach((listener) => { try { listener(value); } catch (_) {} });
}

function clearStopTimer() {
  if (timer != null) clearTimeout(timer);
  timer = null;
}

function result(text) {
  return { content: [{ type: 'text', text }], structuredContent: snapshot() };
}

function saveSettings() {
  try { globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

function syncIntifaceState(remote = getIntifaceToyState()) {
  if (state.backend !== 'intiface') return snapshot();
  const connected = remote.connected === true;
  state = {
    ...state,
    available: remote.available === true,
    connected,
    roleControl: connected && state.roleControl,
    autonomousControl: connected && state.autonomousControl,
    authorizedCharacterIds: connected ? state.authorizedCharacterIds : [],
    deviceName: connected ? remote.deviceName : '',
    address: connected ? `intiface:${remote.deviceIndex}` : '',
    outputs: connected ? remote.outputs : [],
    ...(!connected ? { vibration: 0, suction: 0, activeOutputs: [], expiresAt: 0 } : {}),
  };
  emit();
  return snapshot();
}

export function normalizeKisstoyDurationMs(args = {}) {
  const seconds = Number(args.duration_seconds);
  const legacyMilliseconds = Number(args.duration_ms);
  const requested = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : (Number.isFinite(legacyMilliseconds) && legacyMilliseconds > 0
      ? legacyMilliseconds
      : DEFAULT_DURATION_MS);
  return Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, Math.round(requested)));
}

export function getKisstoyDeviceState() {
  if (state.backend === 'intiface') syncIntifaceState();
  else if (!state.available && isNativeToyBleAvailable()) state = { ...state, available: true };
  return snapshot();
}

export function subscribeKisstoyDevice(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isKisstoyRoleAuthorized(session = {}, actorId = '', options = {}) {
  if (session?.connected !== true || session?.roleControl !== true) return false;
  const authorizedIds = Array.isArray(session.authorizedCharacterIds)
    ? session.authorizedCharacterIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const id = String(actorId || '').trim();
  if (id && !authorizedIds.includes(id)) return false;
  if (!id && !authorizedIds.length) return false;
  return options.autonomous !== true || session.autonomousControl === true;
}

export function isKisstoyRoleSessionActive(actorId = '', options = {}) {
  return isKisstoyRoleAuthorized(state, actorId, options);
}

export function setKisstoyMaxIntensity(value) {
  settings = {
    ...settings,
    maxIntensity: Math.max(1, Math.min(100, Math.round(Number(value) || DEFAULT_MAX_INTENSITY))),
  };
  saveSettings();
  emit();
  return snapshot();
}

export function setToyConnectionMode(value = 'native') {
  if (state.connected) throw new Error('请先断开当前玩具');
  const connectionMode = value === 'intiface' ? 'intiface' : 'native';
  settings = { ...settings, connectionMode };
  state = {
    ...state,
    backend: connectionMode,
    available: connectionMode === 'intiface'
      ? getIntifaceToyState().available : isNativeToyBleAvailable(),
    deviceName: '',
    address: '',
    outputs: [],
    activeOutputs: [],
    roleControl: false,
    autonomousControl: false,
    authorizedCharacterIds: [],
  };
  saveSettings();
  emit();
  return snapshot();
}

export function setToyIntifaceEndpoint(value = DEFAULT_INTIFACE_ENDPOINT) {
  if (state.connected) throw new Error('请先断开当前玩具');
  settings = { ...settings, intifaceEndpoint: normalizeIntifaceEndpoint(value) };
  saveSettings();
  emit();
  return snapshot();
}

export function setKisstoyRoleControl(enabled, characterIds = []) {
  if (enabled === true && state.backend === 'native' && state.nativeProfile === 'unconfirmed') {
    throw new Error('请先低强度测试并选择设备功能');
  }
  const authorizedCharacterIds = enabled === true
    ? [...new Set((Array.isArray(characterIds) ? characterIds : [characterIds])
      .map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  state = {
    ...state,
    roleControl: state.connected && authorizedCharacterIds.length > 0,
    autonomousControl: state.connected && authorizedCharacterIds.length > 0 && state.autonomousControl,
    authorizedCharacterIds: state.connected ? authorizedCharacterIds : [],
  };
  emit();
  return snapshot();
}

export function setKisstoyCharacterAuthorization(characterId = '', enabled = true) {
  const id = String(characterId || '').trim();
  if (!id) throw new TypeError('请选择要授权的角色');
  if (!state.connected) throw new Error('请先连接玩具');
  if (state.backend === 'native' && state.nativeProfile === 'unconfirmed') {
    throw new Error('请先低强度测试并选择设备功能');
  }
  const authorizedCharacterIds = new Set(state.authorizedCharacterIds);
  if (enabled === true) authorizedCharacterIds.add(id);
  else authorizedCharacterIds.delete(id);
  const nextIds = [...authorizedCharacterIds];
  state = {
    ...state,
    roleControl: nextIds.length > 0,
    autonomousControl: nextIds.length > 0 && state.autonomousControl,
    authorizedCharacterIds: nextIds,
  };
  emit();
  return snapshot();
}

export function setKisstoyAutonomousControl(enabled) {
  if (enabled === true && !isKisstoyRoleSessionActive()) {
    throw new Error('请先授权至少一个角色');
  }
  state = { ...state, autonomousControl: state.connected && enabled === true };
  emit();
  return snapshot();
}

export function setKisstoyNativeProfile(value = 'both') {
  if (state.backend !== 'native' || !state.connected) throw new Error('请先连接本机玩具');
  if (state.activeOutputs.some((item) => Number(item.intensity) > 0)) throw new Error('请先停止当前输出');
  const nativeProfile = normalizeNativeProfile(value);
  const profileKey = String(state.deviceName || '').trim().toUpperCase();
  settings = {
    ...settings,
    nativeProfiles: { ...settings.nativeProfiles, ...(profileKey ? { [profileKey]: nativeProfile } : {}) },
  };
  state = {
    ...state,
    nativeProfile,
    vibration: nativeProfile === 'suction' ? 0 : state.vibration,
    suction: nativeProfile === 'vibration' ? 0 : state.suction,
    outputs: nativeOutputs(nativeProfile),
    activeOutputs: state.activeOutputs.filter((item) => (
      nativeProfile === 'both'
      || (nativeProfile === 'vibration' && item.id === 'native:vibration')
      || (nativeProfile === 'suction' && item.id === 'native:suction')
    )),
  };
  saveSettings();
  emit();
  return snapshot();
}

export async function testKisstoyNativeOutput(feature = 'vibration') {
  if (state.backend !== 'native' || !state.connected) throw new Error('请先连接本机玩具');
  const mode = feature === 'suction' ? 'suction' : 'vibrate';
  const payload = mode === 'suction'
    ? { mode, vibration: 0, suction: 10 }
    : { mode, vibration: 10, suction: 0 };
  const response = await controlNativeToyWithRecovery(payload);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await controlNativeToy({ mode: 'stop' }).catch(() => {});
  return { queued: response?.queued === true, feature: mode === 'suction' ? 'suction' : 'vibration' };
}

export async function scanKisstoyDevices({ includeUnknown = false } = {}) {
  if (state.backend === 'intiface') {
    const scanned = await scanIntifaceToys({ endpoint: settings.intifaceEndpoint });
    syncIntifaceState(scanned.state);
    return scanned;
  }
  if (!isNativeToyBleAvailable()) throw new Error('请在 Android App 中使用本机直连');
  // Always ask native for the complete BLE result and classify it in the web
  // registry. This keeps OTA-added model names working with an older APK whose
  // native advertisement allowlist predates the model.
  const scanned = await scanNativeToys({ includeUnknown: true });
  if (includeUnknown) return scanned;
  return {
    ...scanned,
    devices: (Array.isArray(scanned?.devices) ? scanned.devices : []).filter((device) => (
      device.recognized === true || findToyAdapterProfile(device.name)
    )),
  };
}

export async function connectKisstoyDevice(device = {}) {
  if (state.backend === 'intiface' || String(device.address || '').startsWith('intiface:')) {
    await connectIntifaceServer(settings.intifaceEndpoint);
    const remote = selectIntifaceToy(device.address);
    state = {
      ...state,
      available: true,
      connected: remote.connected,
      roleControl: false,
      autonomousControl: false,
      authorizedCharacterIds: [],
      backend: 'intiface',
      deviceName: remote.deviceName,
      address: `intiface:${remote.deviceIndex}`,
      vibration: 0,
      suction: 0,
      outputs: remote.outputs,
      activeOutputs: [],
      expiresAt: 0,
    };
    emit();
    return { connected: remote.connected, state: snapshot() };
  }
  const nativeDevice = {
    address: String(device.address || '').trim(),
    name: String(device.name || 'KISSTOY 设备').trim() || 'KISSTOY 设备',
  };
  const normalizedName = nativeDevice.name.toUpperCase();
  const adapterProfile = findToyAdapterProfile(normalizedName);
  const verifiedDefault = adapterProfile?.nativeProfile
    || (adapterProfile?.outputs?.includes('vibration') && adapterProfile?.outputs?.includes('suction')
      ? 'both'
      : (adapterProfile?.outputs?.[0] || 'unconfirmed'));
  const savedProfile = normalizeNativeProfile(settings.nativeProfiles?.[normalizedName] || verifiedDefault);
  // 首次识别期间先不启动掉线自动重连。原生层在“找不到控制特征”时也会发送
  // disconnected 事件，若当成已连设备掉线，会与页面这次连接互相抢占 GATT。
  nativeReconnectWanted = false;
  lastNativeDevice = nativeDevice;
  let connection = await connectNativeToy(nativeDevice.address);
  const discoveredUuids = (Array.isArray(connection?.services) ? connection.services : []).flatMap((service) => [
    String(service?.uuid || '').toLowerCase(),
    ...(Array.isArray(service?.characteristics) ? service.characteristics : [])
      .map((characteristic) => String(characteristic?.uuid || '').toLowerCase()),
  ]);
  const alternateProtocol = discoveredUuids.includes('0000ae3a-0000-1000-8000-00805f9b34fb')
    || discoveredUuids.includes('0000ae3b-0000-1000-8000-00805f9b34fb');
  const retryableDiscoveryFailure = !alternateProtocol && [
    'control-characteristic-missing',
    'service-discovery-failed',
  ].includes(String(connection?.status || ''));
  if (connection?.connected !== true && retryableDiscoveryFailure) {
    await disconnectNativeToy().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 350));
    connection = await connectNativeToy(nativeDevice.address);
  }
  const connected = connection?.connected === true;
  nativeReconnectWanted = connected;
  state = {
    ...state,
    available: true,
    connected,
    roleControl: false,
    autonomousControl: false,
    authorizedCharacterIds: [],
    backend: 'native',
    deviceName: connected ? nativeDevice.name : '',
    address: connected ? nativeDevice.address : '',
    vibration: 0,
    suction: 0,
    nativeProfile: savedProfile,
    outputs: connected ? nativeOutputs(savedProfile) : [],
    activeOutputs: [],
    expiresAt: 0,
  };
  emit();
  return { ...connection, state: snapshot() };
}

export async function stopKisstoyDevice(options = {}) {
  clearStopTimer();
  desiredNativeOutput = null;
  if (state.connected) {
    if (state.backend === 'intiface') await stopIntifaceToy();
    else if (options.recover === false) await controlNativeToy({ mode: 'stop' });
    else await controlNativeToyWithRecovery({ mode: 'stop' });
  }
  state = { ...state, vibration: 0, suction: 0, activeOutputs: [], expiresAt: 0 };
  emit();
  return snapshot();
}

export async function disconnectKisstoyDevice() {
  nativeReconnectWanted = false;
  nativeReconnectPromise = null;
  lastNativeDevice = null;
  desiredNativeOutput = null;
  try {
    await stopKisstoyDevice({ recover: false }).catch(() => null);
  } finally {
    if (state.backend === 'intiface') await disconnectIntifaceServer();
    else await disconnectNativeToy();
  }
  state = {
    ...state,
    connected: false,
    roleControl: false,
    autonomousControl: false,
    authorizedCharacterIds: [],
    deviceName: '',
    address: '',
    outputs: [],
    activeOutputs: [],
  };
  emit();
  return snapshot();
}

function applyNativeConnection(connected) {
  if (state.backend !== 'native') return snapshot();
  const device = lastNativeDevice || { name: state.deviceName, address: state.address };
  state = {
    ...state,
    available: isNativeToyBleAvailable(),
    connected,
    deviceName: connected ? String(device?.name || 'KISSTOY 设备') : state.deviceName,
    address: connected ? String(device?.address || '') : state.address,
    outputs: connected ? nativeOutputs(state.nativeProfile) : [],
    ...(!connected ? { vibration: 0, suction: 0, activeOutputs: [], expiresAt: 0 } : {}),
  };
  emit();
  return snapshot();
}

async function reconnectNativeToy() {
  if (!nativeReconnectWanted || state.backend !== 'native' || !lastNativeDevice?.address) return false;
  if (nativeReconnectPromise) return nativeReconnectPromise;
  nativeReconnectPromise = (async () => {
    const delays = [0, 1200, 3500];
    for (const delay of delays) {
      if (!nativeReconnectWanted || (typeof document !== 'undefined' && document.hidden)) return false;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!nativeReconnectWanted) return false;
      try {
        const connection = await connectNativeToy(lastNativeDevice.address);
        if (connection?.connected === true) {
          applyNativeConnection(true);
          const desired = desiredNativeOutput;
          if (desired && desired.expiresAt > Date.now() && (desired.vibration > 0 || desired.suction > 0)) {
            const supportsVibration = state.nativeProfile !== 'suction';
            const supportsSuction = state.nativeProfile !== 'vibration';
            const vibration = supportsVibration ? desired.vibration : 0;
            const suction = supportsSuction ? desired.suction : 0;
            const restored = await controlNativeToy({
              mode: 'both',
              vibration,
              suction,
            });
            if (restored?.queued !== true) continue;
            state = {
              ...state,
              vibration,
              suction,
              activeOutputs: [
                ...(supportsVibration ? [{ id: 'native:vibration', label: '震动', intensity: vibration }] : []),
                ...(supportsSuction ? [{ id: 'native:suction', label: '吮吸', intensity: suction }] : []),
              ],
              expiresAt: desired.expiresAt,
            };
            emit();
          }
          return true;
        }
      } catch (_) {}
    }
    applyNativeConnection(false);
    return false;
  })().finally(() => { nativeReconnectPromise = null; });
  return nativeReconnectPromise;
}

async function controlNativeToyWithRecovery(payload) {
  let response;
  try { response = await controlNativeToy(payload); } catch (_) { response = null; }
  if (response?.queued === true) return response;
  applyNativeConnection(false);
  if (!await reconnectNativeToy()) throw new Error('玩具连接已断开，请重新连接');
  response = await controlNativeToy(payload);
  if (response?.queued !== true) throw new Error('玩具指令发送失败，请重新连接');
  return response;
}

function nativeGenericIntensity(args = {}, feature = '') {
  const aliases = feature === 'vibration'
    ? new Set(['native:vibration', 'vibration', 'vibrate'])
    : new Set(['native:suction', 'suction']);
  const row = (Array.isArray(args.outputs) ? args.outputs : []).find((item) => (
    aliases.has(String(item?.feature || '').trim().toLocaleLowerCase())
  ));
  return row ? row.intensity : undefined;
}

export function resolveNativeToyOutputRequest(args = {}, session = {}, maxIntensity = 100) {
  const cap = Math.max(1, Math.min(100, Math.round(Number(maxIntensity) || DEFAULT_MAX_INTENSITY)));
  const supportsVibration = session.nativeProfile !== 'suction';
  const supportsSuction = session.nativeProfile !== 'vibration';
  const vibrationArgument = Object.prototype.hasOwnProperty.call(args, 'vibration')
    ? args.vibration : nativeGenericIntensity(args, 'vibration');
  const suctionArgument = Object.prototype.hasOwnProperty.call(args, 'suction')
    ? args.suction : nativeGenericIntensity(args, 'suction');
  const requestedVibration = vibrationArgument !== undefined;
  const requestedSuction = suctionArgument !== undefined;
  const clampOutput = (value) => Math.max(0, Math.min(cap, Math.round(Number(value) || 0)));
  if (!supportsVibration && requestedVibration && clampOutput(vibrationArgument) > 0) {
    throw new Error('当前设备配置不支持震动');
  }
  if (!supportsSuction && requestedSuction && clampOutput(suctionArgument) > 0) {
    throw new Error('当前设备配置不支持吮吸');
  }
  const useVibration = supportsVibration && requestedVibration;
  const useSuction = supportsSuction && requestedSuction;
  if (!useVibration && !useSuction) throw new Error('请至少设置一个当前玩具支持的功能');
  const vibration = useVibration ? clampOutput(vibrationArgument) : clampOutput(session.vibration);
  const suction = useSuction ? clampOutput(suctionArgument) : clampOutput(session.suction);
  return {
    mode: useVibration && useSuction ? 'both' : (useVibration ? 'vibrate' : 'suction'),
    vibration,
    suction,
  };
}

async function setOutput(args = {}) {
  if (!state.connected) throw new Error('玩具尚未连接');
  if (!state.roleControl) throw new Error('当前设备会话尚未允许角色控制');
  clearStopTimer();
  const cap = settings.maxIntensity;
  const hasGenericOutputs = Array.isArray(args.outputs) && args.outputs.length > 0;
  const hasCommonOutput = Object.prototype.hasOwnProperty.call(args, 'vibration')
    || Object.prototype.hasOwnProperty.call(args, 'suction');
  if (!hasCommonOutput && !hasGenericOutputs) {
    throw new Error('请至少设置一个玩具功能');
  }
  const duration = normalizeKisstoyDurationMs(args);
  let vibration = Math.max(0, Math.min(cap, Math.round(Number(args.vibration) || 0)));
  let suction = Math.max(0, Math.min(cap, Math.round(Number(args.suction) || 0)));
  let activeOutputs = [];
  if (state.backend === 'intiface') {
    if (vibration === 0 && suction === 0 && !hasGenericOutputs) return stopKisstoyDevice();
    const controlled = await controlIntifaceToy(args, cap);
    activeOutputs = controlled.outputs.map((item) => ({
      id: item.id,
      label: item.label,
      intensity: Math.round(item.percent * 100),
    }));
  } else {
    const request = resolveNativeToyOutputRequest(args, state, cap);
    vibration = request.vibration;
    suction = request.suction;
    if (vibration === 0 && suction === 0) return stopKisstoyDevice();
    await controlNativeToyWithRecovery(request);
    desiredNativeOutput = { vibration, suction, expiresAt: Date.now() + duration };
    activeOutputs = [
      ...(state.nativeProfile !== 'suction' ? [{ id: 'native:vibration', label: '震动', intensity: vibration }] : []),
      ...(state.nativeProfile !== 'vibration' ? [{ id: 'native:suction', label: '吮吸', intensity: suction }] : []),
    ];
  }
  const expiresAt = desiredNativeOutput?.expiresAt || Date.now() + duration;
  state = { ...state, vibration, suction, activeOutputs, expiresAt };
  timer = setTimeout(() => { void stopKisstoyDevice().catch(() => {}); }, duration);
  emit();
  return snapshot();
}

export function createBuiltinKisstoyDeviceProvider() {
  return {
    provider: {
      id: 'builtin.kisstoy-device',
      type: 'builtin',
      priority: 200,
      metadata: { label: '小玩具', local: true, adapters: ['native-kisstoy', 'intiface'] },
      async execute(capability, args) {
        if (capability.id === KISSTOY_STATUS_CAPABILITY.id) {
          const controls = state.outputs.map((item) => `${item.label || item.type}（${item.id}）`).join('、');
          return result(state.connected
            ? `玩具已连接，震动 ${state.vibration}，吸吮 ${state.suction}${controls ? `，可控功能：${controls}` : ''}。`
            : '玩具尚未连接。');
        }
        if (capability.id === KISSTOY_STOP_CAPABILITY.id) {
          await stopKisstoyDevice();
          return result('玩具停止指令已发送。');
        }
        if (capability.id !== KISSTOY_SET_CAPABILITY.id) {
          throw new Error(`不支持的设备能力：${capability.id}`);
        }
        const next = await setOutput(args);
        return result(`玩具控制指令已发送，震动 ${next.vibration}、吸吮 ${next.suction}，将在限定时间后自动停止。`);
      },
      close: async () => { await disconnectKisstoyDevice().catch(() => {}); },
    },
    capabilities: [KISSTOY_STATUS_CAPABILITY, KISSTOY_SET_CAPABILITY, KISSTOY_STOP_CAPABILITY],
  };
}

subscribeIntifaceToy((remote) => {
  if (state.backend === 'intiface') syncIntifaceState(remote);
});

subscribeNativeToyConnection((event = {}) => {
  if (state.backend !== 'native' || !nativeReconnectWanted) return;
  const connected = event.connected === true && event.ready !== false;
  applyNativeConnection(connected);
  if (!connected && (typeof document === 'undefined' || !document.hidden)) {
    void reconnectNativeToy();
  }
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.backend !== 'native' || !nativeReconnectWanted) return;
    void getNativeToyStatus().then((status) => {
      if (!status) return;
      if (status.connected === true && status.ready !== false) applyNativeConnection(true);
      else {
        applyNativeConnection(false);
        void reconnectNativeToy();
      }
    }).catch(() => {});
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('marshmallow-native-resume', () => {
    if (state.backend !== 'native' || !nativeReconnectWanted) return;
    void getNativeToyStatus().then((status) => {
      if (!status) return;
      if (status.connected === true && status.ready !== false) applyNativeConnection(true);
      else {
        applyNativeConnection(false);
        void reconnectNativeToy();
      }
    }).catch(() => {});
  });
}
