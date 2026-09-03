// 桌面系统悬浮窗（桌宠置顶）桥接：仅 Android 原生壳生效，iOS/网页端 isOverlaySupported() 恒为 false。
// 原生实现见 android/app/src/main/java/com/marshmallow/machine/MarshmallowOverlayPlugin.java + MarshmallowOverlayService.java。
// 用户开启桌面置顶后，前后台都由同一个原生 Service 持有悬浮窗；网页圆球不再重复显示。

import { extractCompanionText, normalizeCompanionAvatarUrl, sanitizeCompanionSpeechText } from './companion/companion-values.js';

function plugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.MarshmallowOverlay || null;
}

let pendingListenerHandle = null;

export function isOverlaySupported() {
  return !!plugin();
}

export async function hasOverlayPermission() {
  const p = plugin();
  if (!p) return false;
  try {
    const res = await p.hasPermission();
    return res?.granted === true;
  } catch (_) {
    return false;
  }
}

export async function requestOverlayPermission() {
  const p = plugin();
  if (!p) return false;
  try {
    const res = await p.requestPermission();
    return res?.granted === true;
  } catch (_) {
    return false;
  }
}

export function buildNativeOverlaySegments(segments = [], maxAudioChars = 2700000) {
  let remainingAudioChars = Math.max(0, Number(maxAudioChars || 0) || 0);
  return (Array.isArray(segments) ? segments : [])
    .slice(-8)
    .map((item) => {
      const text = sanitizeCompanionSpeechText(item?.text, { max: 96 });
      const candidate = String(item?.audioDataUrl || '');
      const canIncludeAudio = /^data:audio\//i.test(candidate)
        && candidate.length > 0
        && candidate.length <= remainingAudioChars;
      if (canIncludeAudio) remainingAudioChars -= candidate.length;
      return {
        text,
        translation: extractCompanionText(item?.translation, { max: 240 }),
        audioMimeType: extractCompanionText(item?.audioMimeType, { max: 80 }),
        audioDataUrl: canIncludeAudio ? candidate : '',
      };
    })
    .filter((item) => item.text);
}

/**
 * @param {{label?:string, avatarUrl?:string, bubble?:string, bubbleTranslation?:string, chatId?:string, sessionId?:string, characterId?:string, windowStyle?:'chat'|'call', startedAt?:number, endsAt?:number, hasUnread?:boolean, autoPlay?:boolean, audioRevision?:number, modelName?:string, modelOptions?:string[], modelStatus?:string, modelBusy?:boolean, segments?:Array, recentLines?:Array, recentEvents?:Array}} payload
 */
export async function startOverlay(payload = {}) {
  const p = plugin();
  if (!p) return { ok: false, permissionRequired: false };
  try {
    return await p.start({
      label: extractCompanionText(payload.label, { max: 24 }) || '陪伴',
      avatarUrl: normalizeCompanionAvatarUrl(payload.avatarUrl),
      bubble: sanitizeCompanionSpeechText(payload.bubble, { max: 48 }) || '在呢。',
      bubbleTranslation: extractCompanionText(payload.bubbleTranslation, { max: 240 }),
      chatId: typeof payload.chatId === 'string' ? payload.chatId : '',
      sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
      characterId: typeof payload.characterId === 'string' ? payload.characterId : '',
      replyError: extractCompanionText(payload.replyError, { max: 160 }),
      videoBackground: normalizeCompanionAvatarUrl(payload.videoBackground),
      windowStyle: payload.windowStyle === 'video' ? 'video' : (payload.windowStyle === 'call' ? 'call' : 'chat'),
      startedAt: Math.max(0, Number(payload.startedAt || 0) || 0),
      endsAt: Math.max(0, Number(payload.endsAt || 0) || 0),
      hasUnread: !!payload.hasUnread,
      autoPlay: payload.autoPlay === true,
      audioRevision: Math.max(0, Number(payload.audioRevision || 0) || 0),
      modelName: extractCompanionText(payload.modelName, { max: 160 }),
      modelOptionsJson: JSON.stringify((Array.isArray(payload.modelOptions) ? payload.modelOptions : [])
        .map((item) => extractCompanionText(item, { max: 160 }))
        .filter(Boolean)
        .slice(0, 120)),
      modelStatus: extractCompanionText(payload.modelStatus, { max: 120 }),
      modelBusy: payload.modelBusy === true,
      // WebView→Java 桥一次传入数 MB 音频会在低内存设备上直接杀进程。
      // 只携带最近片段，并为整批 base64 设总预算；文字记录始终完整保留。
      segmentsJson: JSON.stringify(buildNativeOverlaySegments(payload.segments)),
      recentLinesJson: JSON.stringify((Array.isArray(payload.recentLines) ? payload.recentLines : [])
        .slice(-6)
        .map((item) => sanitizeCompanionSpeechText(item, { max: 96 }))
        .filter(Boolean)),
      recentEventsJson: JSON.stringify((Array.isArray(payload.recentEvents) ? payload.recentEvents : [])
        .slice(-100)
        .map((item) => ({
          role: item?.role === 'user' ? 'user' : 'ai',
          label: extractCompanionText(item?.label, { max: 24 }),
          text: sanitizeCompanionSpeechText(item?.text, { max: 200 }),
          translation: extractCompanionText(item?.translation, { max: 400 }),
          at: Math.max(0, Number(item?.at || 0) || 0),
        }))
        .filter((item) => item.text)),
      cursor: Math.max(0, Number(payload.cursor || 0) || 0),
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err || '') };
  }
}

export async function stopOverlay() {
  const p = plugin();
  if (!p) return { ok: false, cursor: 0 };
  try { return await p.stop(); } catch (_) { return { ok: false, cursor: 0 }; }
}

/** 展开已经运行的系统悬浮窗；仅在原生 Service 接管会话后调用。 */
export async function expandOverlay() {
  const p = plugin();
  if (!p?.expand) return { ok: false };
  try { return await p.expand(); } catch (_) { return { ok: false }; }
}

/** App 从陪伴通话缩略窗唤起后，读一次待处理动作。 */
export async function consumePendingOverlayOpen() {
  const p = plugin();
  if (!p) return { chatId: '', at: 0, poke: false, expand: false };
  try {
    const res = await p.consumePendingOpen();
    return {
      chatId: String(res?.chatId || ''),
      at: Number(res?.at) || 0,
      poke: res?.poke === true,
      expand: res?.expand === true,
    };
  } catch (_) {
    return { chatId: '', at: 0, poke: false, expand: false };
  }
}

/** 读取当前会话的原生面板输入；成功写入会话后由调用方显式确认。 */
export async function consumePendingOverlayInputs(sessionId = '') {
  const p = plugin();
  if (!p?.consumePendingInputs) return [];
  try {
    const res = await p.consumePendingInputs({ sessionId: String(sessionId || '') });
    const parsed = JSON.parse(String(res?.inputsJson || '[]'));
    return (Array.isArray(parsed) ? parsed : []).map((item) => ({
      sessionId: String(item?.sessionId || ''),
      characterId: String(item?.characterId || ''),
      text: extractCompanionText(item?.text, { max: 200 }),
      at: Math.max(0, Number(item?.at || 0) || 0),
    })).filter((item) => item.sessionId && item.text);
  } catch (_) {
    return [];
  }
}

export async function acknowledgePendingOverlayInput(sessionId, throughAt) {
  const p = plugin();
  if (!p?.acknowledgePendingInputs) return { ok: false };
  try {
    return await p.acknowledgePendingInputs({
      sessionId: String(sessionId || ''),
      throughAt: Math.max(0, Number(throughAt || 0) || 0),
    });
  } catch (_) {
    return { ok: false };
  }
}

/** 读取当前会话的原生窗动作；执行成功后由调用方显式确认。 */
export async function consumePendingOverlayActions(sessionId = '') {
  const p = plugin();
  if (!p?.consumePendingActions) return [];
  try {
    const res = await p.consumePendingActions({ sessionId: String(sessionId || '') });
    const parsed = JSON.parse(String(res?.actionsJson || '[]'));
    return (Array.isArray(parsed) ? parsed : []).map((item) => ({
      sessionId: String(item?.sessionId || ''),
      characterId: String(item?.characterId || ''),
      action: String(item?.action || ''),
      at: Math.max(0, Number(item?.at || 0) || 0),
    })).filter((item) => item.sessionId && item.action);
  } catch (_) {
    return [];
  }
}

export async function acknowledgePendingOverlayAction(sessionId, throughAt) {
  const p = plugin();
  if (!p?.acknowledgePendingActions) return { ok: false };
  try {
    return await p.acknowledgePendingActions({
      sessionId: String(sessionId || ''),
      throughAt: Math.max(0, Number(throughAt || 0) || 0),
    });
  } catch (_) {
    return { ok: false };
  }
}

/** 原生面板提交输入时即时通知 WebView；定时轮询只作为 ROM 限制下的兜底。 */
export async function bindNativeOverlayPending(handler) {
  const p = plugin();
  if (!p?.addListener || typeof handler !== 'function') return () => {};
  try { await pendingListenerHandle?.remove?.(); } catch (_) {}
  pendingListenerHandle = await p.addListener('pendingChanged', (event = {}) => {
    Promise.resolve(handler(event)).catch(() => {});
  });
  return () => {
    const handle = pendingListenerHandle;
    pendingListenerHandle = null;
    handle?.remove?.().catch?.(() => {});
  };
}
