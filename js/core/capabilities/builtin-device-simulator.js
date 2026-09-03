import { CAPABILITY_RISKS, normalizeCapability } from './schema.js';

export const SIMULATED_DEVICE_ID = 'simulator-vibrator-1';

export const DEVICE_VIBRATION_STATUS_CAPABILITY = normalizeCapability({
  id: 'device.vibration.status',
  name: '查看虚拟震动设备',
  description: '查看棉花糖机内置虚拟设备的连接状态和当前强度，仅用于硬件接入前测试',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  risk: CAPABILITY_RISKS.READ,
  contexts: ['manual'],
  autoApproveRead: true,
  annotations: { readOnly: true, idempotent: true },
  source: { type: 'builtin' },
});

export const DEVICE_VIBRATION_SET_CAPABILITY = normalizeCapability({
  id: 'device.vibration.set',
  name: '设置虚拟震动强度',
  description: '设置虚拟设备的归一化强度，并在限定时间后自动停止；以后真实硬件适配器复用同一能力接口',
  inputSchema: {
    type: 'object',
    properties: {
      device_id: { type: 'string', minLength: 1, maxLength: 80 },
      intensity: { type: 'number', minimum: 0, maximum: 1 },
      duration_ms: { type: 'integer', minimum: 100, maximum: 30000 },
    },
    required: ['device_id', 'intensity', 'duration_ms'],
    additionalProperties: false,
  },
  risk: CAPABILITY_RISKS.DEVICE,
  contexts: ['manual'],
  annotations: { idempotent: false },
  source: { type: 'builtin' },
});

export const DEVICE_VIBRATION_STOP_CAPABILITY = normalizeCapability({
  id: 'device.vibration.stop',
  name: '停止虚拟震动设备',
  description: '立即停止虚拟设备；真实设备适配器必须实现同名的紧急停止语义',
  inputSchema: {
    type: 'object',
    properties: { device_id: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['device_id'],
    additionalProperties: false,
  },
  risk: CAPABILITY_RISKS.DEVICE,
  contexts: ['manual'],
  annotations: { idempotent: true },
  source: { type: 'builtin' },
});

function textResult(text, state) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ...state },
  };
}

/**
 * 无硬件阶段的统一设备契约。它不调用蓝牙，也不会产生真实输出；后续 Intiface/Kistoy
 * 适配器只需实现相同 capability id 与 structuredContent 形状，即可替换这个 provider。
 */
export function createBuiltinDeviceSimulatorProvider(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : globalThis.setTimeout;
  const cancel = typeof options.clearTimeout === 'function' ? options.clearTimeout : globalThis.clearTimeout;
  let timer = null;
  let state = {
    device_id: SIMULATED_DEVICE_ID,
    name: '虚拟震动设备',
    connected: true,
    simulated: true,
    intensity: 0,
    expires_at: 0,
    updated_at: now(),
  };

  const stop = () => {
    if (timer != null) cancel(timer);
    timer = null;
    state = { ...state, intensity: 0, expires_at: 0, updated_at: now() };
    return state;
  };

  const assertDevice = (deviceId) => {
    if (String(deviceId || '') !== SIMULATED_DEVICE_ID) {
      throw new Error(`设备不存在：${String(deviceId || '')}`);
    }
  };

  return {
    provider: {
      id: 'builtin.device-simulator',
      type: 'builtin',
      priority: -100,
      metadata: { label: '内置设备模拟器', simulated: true },
      async execute(capability, args) {
        if (capability.id === DEVICE_VIBRATION_STATUS_CAPABILITY.id) {
          return textResult(`虚拟设备已连接，当前强度 ${Math.round(state.intensity * 100)}%。`, state);
        }
        assertDevice(args.device_id);
        if (capability.id === DEVICE_VIBRATION_STOP_CAPABILITY.id || Number(args.intensity) === 0) {
          return textResult('虚拟设备已停止。', stop());
        }
        if (capability.id !== DEVICE_VIBRATION_SET_CAPABILITY.id) {
          throw new Error(`不支持的虚拟设备能力：${capability.id}`);
        }
        if (timer != null) cancel(timer);
        const duration = Math.max(100, Math.min(30000, Number(args.duration_ms) || 0));
        const intensity = Math.max(0, Math.min(1, Number(args.intensity) || 0));
        state = {
          ...state,
          intensity,
          expires_at: now() + duration,
          updated_at: now(),
        };
        timer = schedule(() => stop(), duration);
        return textResult(`虚拟设备强度已设为 ${Math.round(intensity * 100)}%，${duration} 毫秒后自动停止。`, state);
      },
      close: async () => { stop(); },
    },
    capabilities: [
      DEVICE_VIBRATION_STATUS_CAPABILITY,
      DEVICE_VIBRATION_SET_CAPABILITY,
      DEVICE_VIBRATION_STOP_CAPABILITY,
    ],
    getState: () => ({ ...state }),
  };
}
