import {
  ButtplugBrowserWebsocketClientConnector,
  ButtplugClient,
  DeviceOutput,
  OutputType,
} from '../../vendor/buttplug/buttplug.mjs';

export const DEFAULT_INTIFACE_ENDPOINT = 'ws://127.0.0.1:12345';

const OUTPUT_LABELS = Object.freeze({
  [OutputType.Vibrate]: '震动',
  [OutputType.Rotate]: '旋转',
  [OutputType.Oscillate]: '往复',
  [OutputType.Constrict]: '收缩',
  [OutputType.Inflate]: '充气',
  [OutputType.Position]: '位置',
  [OutputType.HwPositionWithDuration]: '行程',
  [OutputType.Temperature]: '温度',
  [OutputType.Spray]: '喷洒',
  [OutputType.Led]: '灯光',
});

const SUCTION_DESCRIPTOR_RE = /suction|suck|pump|air|vacuum|吸|吮|气压|气泵/i;
const SAFE_PRIVATE_IPV4_RE = /^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/;

let client = null;
let selectedDeviceIndex = null;
let endpoint = DEFAULT_INTIFACE_ENDPOINT;
let disconnectedListener = null;
const listeners = new Set();

function emit() {
  const value = getIntifaceToyState();
  for (const listener of listeners) {
    try { listener(value); } catch (_) {}
  }
}

function outputConstructor(type) {
  const constructors = {
    [OutputType.Vibrate]: DeviceOutput.Vibrate,
    [OutputType.Rotate]: DeviceOutput.Rotate,
    [OutputType.Oscillate]: DeviceOutput.Oscillate,
    [OutputType.Constrict]: DeviceOutput.Constrict,
    [OutputType.Inflate]: DeviceOutput.Inflate,
    [OutputType.Position]: DeviceOutput.Position,
    [OutputType.Temperature]: DeviceOutput.Temperature,
    [OutputType.Spray]: DeviceOutput.Spray,
    [OutputType.Led]: DeviceOutput.Led,
  };
  return constructors[type] || null;
}

function selectedDevice() {
  if (!client?.connected || selectedDeviceIndex == null) return null;
  return client.devices.get(Number(selectedDeviceIndex)) || null;
}

function deviceRows() {
  if (!client?.connected) return [];
  return [...client.devices.values()].map((device) => ({
    address: `intiface:${device.index}`,
    index: device.index,
    name: device.displayName || device.name || `Intiface ${device.index}`,
    rssi: '',
    source: 'intiface',
    outputs: describeIntifaceDeviceOutputs(device),
  }));
}

export function normalizeIntifaceEndpoint(value = DEFAULT_INTIFACE_ENDPOINT) {
  let url;
  try { url = new URL(String(value || DEFAULT_INTIFACE_ENDPOINT).trim()); }
  catch (_) { throw new TypeError('Intiface 服务器地址格式不正确'); }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('Intiface 地址必须使用 ws:// 或 wss://');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '::1' || SAFE_PRIVATE_IPV4_RE.test(host);
  if (!local) throw new TypeError('Intiface 仅允许连接本机或局域网地址');
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function describeIntifaceDeviceOutputs(device) {
  const rows = [];
  if (!device?.features) return rows;
  for (const feature of device.features.values()) {
    for (const [type] of feature.outputs || []) {
      if (!outputConstructor(type)) continue;
      const descriptor = String(feature.descriptor || '').trim();
      rows.push(Object.freeze({
        id: `${device.index}:${feature.index}:${type}`,
        deviceIndex: device.index,
        featureIndex: feature.index,
        type,
        descriptor,
        label: descriptor || OUTPUT_LABELS[type] || type,
      }));
    }
  }
  return rows;
}

export function getIntifaceToyState() {
  const device = selectedDevice();
  return Object.freeze({
    available: typeof globalThis.WebSocket === 'function',
    serverConnected: client?.connected === true,
    connected: Boolean(device),
    endpoint,
    deviceName: device ? (device.displayName || device.name || 'Intiface 设备') : '',
    deviceIndex: device?.index ?? null,
    devices: deviceRows(),
    outputs: device ? describeIntifaceDeviceOutputs(device) : [],
  });
}

export function subscribeIntifaceToy(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function connectIntifaceServer(value = DEFAULT_INTIFACE_ENDPOINT) {
  const nextEndpoint = normalizeIntifaceEndpoint(value);
  if (client?.connected && endpoint === nextEndpoint) return getIntifaceToyState();
  await disconnectIntifaceServer();
  endpoint = nextEndpoint;
  const next = new ButtplugClient('棉花糖机');
  const onDevicesChanged = () => emit();
  disconnectedListener = () => {
    selectedDeviceIndex = null;
    emit();
  };
  next.addListener('deviceadded', onDevicesChanged);
  next.addListener('deviceremoved', (device) => {
    if (Number(device?.index) === Number(selectedDeviceIndex)) selectedDeviceIndex = null;
    onDevicesChanged();
  });
  next.addListener('disconnect', disconnectedListener);
  await next.connect(new ButtplugBrowserWebsocketClientConnector(endpoint));
  client = next;
  emit();
  return getIntifaceToyState();
}

export async function scanIntifaceToys(options = {}) {
  await connectIntifaceServer(options.endpoint || endpoint);
  if (!client.isScanning) await client.startScanning();
  const waitMs = Math.max(0, Math.min(8000, Number(options.waitMs) || 3500));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return { devices: deviceRows(), state: getIntifaceToyState() };
}

export function selectIntifaceToy(address = '') {
  const match = String(address).match(/^intiface:(\d+)$/);
  const index = match ? Number(match[1]) : Number(address);
  if (!Number.isInteger(index) || !client?.devices.has(index)) {
    throw new Error('Intiface 设备已断开或不存在');
  }
  selectedDeviceIndex = index;
  emit();
  return getIntifaceToyState();
}

function normalizePercent(value, maxIntensity = 100) {
  const cap = Math.max(1, Math.min(100, Number(maxIntensity) || 100));
  return Math.max(0, Math.min(cap, Number(value) || 0)) / 100;
}

export function planIntifaceOutputs(device, args = {}, maxIntensity = 100) {
  const available = describeIntifaceDeviceOutputs(device);
  const planned = new Map();
  const vibration = normalizePercent(args.vibration, maxIntensity);
  const suction = normalizePercent(args.suction, maxIntensity);

  if (Object.prototype.hasOwnProperty.call(args, 'vibration')) {
    for (const row of available) {
      if (row.type === OutputType.Vibrate && !SUCTION_DESCRIPTOR_RE.test(row.descriptor)) {
        planned.set(row.id, { ...row, percent: vibration });
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(args, 'suction')) {
    for (const row of available) {
      if (SUCTION_DESCRIPTOR_RE.test(row.descriptor)
        || row.type === OutputType.Constrict || row.type === OutputType.Inflate) {
        planned.set(row.id, { ...row, percent: suction });
      }
    }
  }
  for (const request of Array.isArray(args.outputs) ? args.outputs : []) {
    const row = available.find((item) => item.id === String(request?.feature || ''));
    if (row) planned.set(row.id, { ...row, percent: normalizePercent(request.intensity, maxIntensity) });
  }
  return [...planned.values()];
}

export async function controlIntifaceToy(args = {}, maxIntensity = 100) {
  const device = selectedDevice();
  if (!device) throw new Error('Intiface 玩具尚未连接');
  const planned = planIntifaceOutputs(device, args, maxIntensity);
  if (!planned.length) throw new Error('当前设备没有匹配到可控功能，请先查看玩具状态中的功能列表');
  await Promise.all(planned.map(async (row) => {
    const feature = device.features.get(row.featureIndex);
    const constructor = outputConstructor(row.type);
    if (!feature || !constructor) return;
    await feature.runOutput(constructor.percent(row.percent));
  }));
  return { outputs: planned };
}

export async function stopIntifaceToy() {
  const device = selectedDevice();
  if (device) await device.stop();
  return getIntifaceToyState();
}

export async function disconnectIntifaceServer() {
  const stale = client;
  client = null;
  selectedDeviceIndex = null;
  if (stale?.connected) {
    try { await stale.disconnect(); } catch (_) {}
  }
  emit();
  return getIntifaceToyState();
}
