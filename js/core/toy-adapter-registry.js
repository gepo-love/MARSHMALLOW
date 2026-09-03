const STORAGE_KEY = 'marshmallow:toy-compat-profiles:v1';
const REPORT_SCHEMA = 'marshmallow.toy-compat-report/v1';
const GALAKU_SERVICE = '00001000-0000-1000-8000-00805f9b34fb';
const GALAKU_WRITE = '00001001-0000-1000-8000-00805f9b34fb';

const BUILTIN_PROFILES = Object.freeze([
  Object.freeze({
    id: 'kisstoy-lost-kst082',
    adapter: 'native-kisstoy-galaku-v1',
    brand: 'KISSTOY',
    model: 'Lost KST-082',
    names: Object.freeze(['QCPW']),
    outputs: Object.freeze(['vibration', 'suction']),
    status: 'verified',
  }),
  Object.freeze({
    id: 'kisstoy-polly-max',
    adapter: 'native-kisstoy-galaku-v1',
    brand: 'KISSTOY',
    model: 'Polly Max',
    names: Object.freeze(['PLMX']),
    outputs: Object.freeze(['vibration', 'suction']),
    status: 'verified',
  }),
]);

function normalizeName(value = '') {
  return String(value || '').trim().toUpperCase();
}

function outputProfile(outputs = []) {
  const values = new Set(outputs);
  if (values.has('vibration') && values.has('suction')) return 'both';
  if (values.has('suction')) return 'suction';
  if (values.has('vibration')) return 'vibration';
  return 'unconfirmed';
}

function readImportedProfiles() {
  try {
    const rows = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  } catch (_) {
    return [];
  }
}

function hasGalakuSignature(connection = {}) {
  const service = String(connection.service || '').toLowerCase();
  const write = String(connection.write || '').toLowerCase();
  if (service === GALAKU_SERVICE && write === GALAKU_WRITE) return true;
  return (Array.isArray(connection.services) ? connection.services : []).some((item) => (
    String(item?.uuid || '').toLowerCase() === GALAKU_SERVICE
    && (Array.isArray(item?.characteristics) ? item.characteristics : []).some((characteristic) => (
      String(characteristic?.uuid || '').toLowerCase() === GALAKU_WRITE
    ))
  ));
}

export function listToyAdapterProfiles() {
  return [...BUILTIN_PROFILES, ...readImportedProfiles()].map((row) => ({
    ...row,
    names: [...(Array.isArray(row.names) ? row.names : [])],
    outputs: [...(Array.isArray(row.outputs) ? row.outputs : [])],
  }));
}

export function findToyAdapterProfile(name = '') {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return listToyAdapterProfiles().reverse()
    .find((row) => row.names.some((item) => normalizeName(item) === normalized)) || null;
}

export function describeToyCandidate(device = {}) {
  if (device.source === 'intiface') return {
    status: 'intiface',
    label: 'Intiface 已识别',
    profile: null,
  };
  const profile = findToyAdapterProfile(device.name);
  if (profile) return {
    status: profile.status === 'verified' ? 'verified' : 'compatible',
    label: profile.status === 'verified'
      ? `${profile.model} · 已验证`
      : `${profile.model || device.name} · 报告已导入`,
    profile,
  };
  return { status: 'unknown', label: '兼容协议候选 · 连接后确认', profile: null };
}

export function parseToyCompatibilityReport(value) {
  const report = typeof value === 'string' ? JSON.parse(value) : value;
  if (!report || report.schema !== REPORT_SCHEMA) throw new Error('不是受支持的兼容报告');
  if (report.connection?.connected !== true || !hasGalakuSignature(report.connection)) {
    throw new Error('报告没有匹配 KISSTOY 本地协议');
  }
  const name = normalizeName(report.device?.name);
  if (!name) throw new Error('报告缺少设备广播名');
  const observations = report.observations || {};
  if (observations.stop !== 'works') throw new Error('停止功能尚未确认，不能导入');
  const outputs = [
    ...(observations.vibrate === 'works' ? ['vibration'] : []),
    ...(observations.suction === 'works' ? ['suction'] : []),
  ];
  if (!outputs.length) throw new Error('报告没有确认可用功能');
  return {
    id: `report:${name.toLowerCase()}`,
    adapter: 'native-kisstoy-galaku-v1',
    brand: String(report.product?.brand || 'KISSTOY').trim() || 'KISSTOY',
    model: String(report.product?.model || name).trim() || name,
    names: [name],
    outputs,
    nativeProfile: outputProfile(outputs),
    status: 'compatible',
    reportFingerprint: String(report.device?.addressFingerprint || '').slice(0, 64),
    verifiedAt: String(report.createdAt || new Date().toISOString()),
  };
}

export function importToyCompatibilityReport(value) {
  const profile = parseToyCompatibilityReport(value);
  const existing = readImportedProfiles().filter((row) => (
    !row.names?.some((name) => normalizeName(name) === profile.names[0])
  ));
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...existing, profile]));
  } catch (_) {
    throw new Error('无法保存兼容报告');
  }
  return profile;
}

export function hasImportedToyProfiles() {
  return readImportedProfiles().length > 0;
}
