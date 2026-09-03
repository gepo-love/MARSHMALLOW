export const PRESET_PACKAGE_TYPE = 'marshmallow-preset';
export const PRESET_PACKAGE_VERSION = 1;

function cleanPreset(record) {
  const next = { ...record };
  delete next.enabled;
  return next;
}

export function buildPresetPackage(records = [], options = {}) {
  const presets = (Array.isArray(records) ? records : []).filter(Boolean).map(cleanPreset);
  if (!presets.length) throw new Error('没有可导出的预设');
  const kind = options.kind === 'bundle' || presets.length > 1 ? 'bundle' : 'preset';
  const name = String(options.name || presets[0]?.bundleName || presets[0]?.name || '预设').trim() || '预设';
  return {
    type: PRESET_PACKAGE_TYPE,
    schemaVersion: PRESET_PACKAGE_VERSION,
    kind,
    name,
    exportedAt: new Date().toISOString(),
    presets,
  };
}

export function isPresetPackage(source) {
  return source?.type === PRESET_PACKAGE_TYPE
    && Number(source?.schemaVersion) === PRESET_PACKAGE_VERSION
    && Array.isArray(source?.presets);
}

export function preparePresetPackageImport(source, options = {}) {
  if (!isPresetPackage(source)) throw new Error('不是可识别的棉花糖机预设文件');
  if (!source.presets.length) throw new Error('预设文件中没有内容');
  const stamp = String(options.stamp || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const bundleId = source.kind === 'bundle' || source.presets.length > 1 ? `bundle_import_${stamp}` : '';
  const bundleName = String(source.name || '导入预设').trim() || '导入预设';
  const bundleOrder = Date.now();
  const presets = source.presets.map((record, index) => ({
    ...cleanPreset(record),
    id: `custom_import_${stamp}_${index + 1}`,
    name: String(record?.name || `${bundleName} ${index + 1}`).trim(),
    category: 'custom',
    bundleId,
    bundleName: bundleId ? bundleName : '',
    bundleOrder: bundleId ? bundleOrder : 0,
    order: index + 1,
    source: 'import',
  }));
  return { presets, name: bundleName, kind: bundleId ? 'bundle' : 'preset' };
}

export function safePresetFilename(name = '') {
  const safe = String(name || '预设').replace(/[\\/:*?\"<>|]/g, '-').trim() || '预设';
  return `${safe}.preset.json`;
}
