// 语音输入抽象层（STT）。
// 默认两种 provider：
//   - 'browser'：浏览器 Web Speech API（iOS Safari 兼容不可依赖，作为实验）
//   - 'custom' ：OpenAI 兼容 /audio/transcriptions（用户自配 endpoint+apiKey）
// 默认 confirmBeforeSend = true：转写后让用户编辑确认再发送，不自动发。

import { get as dbGet, put as dbPut } from '../db.js';
import { beginAudioCaptureSession } from '../media-playback.js';

const KEY = 'voiceInputConfig';

export const DEFAULT_VOICE_INPUT_CONFIG = Object.freeze({
  provider: 'browser',
  endpoint: '',
  apiKey: '',
  model: 'whisper-1',
  language: 'zh',
  autoSend: false,
  confirmBeforeSend: true,
});

function normalize(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  return {
    provider: ['browser', 'custom'].includes(src.provider) ? src.provider : DEFAULT_VOICE_INPUT_CONFIG.provider,
    endpoint: String(src.endpoint || '').trim(),
    apiKey: String(src.apiKey || '').trim(),
    model: String(src.model || DEFAULT_VOICE_INPUT_CONFIG.model).trim() || DEFAULT_VOICE_INPUT_CONFIG.model,
    language: String(src.language || 'zh').trim() || 'zh',
    autoSend: src.autoSend === true,
    confirmBeforeSend: src.confirmBeforeSend !== false,
  };
}

async function resolveCustomConfig(config) {
  const cfg = normalize(config || await loadVoiceInputConfig());
  return { ...cfg, customHeaders: {} };
}

async function hasCustomTranscriptionFallback(config) {
  const cfg = normalize(config || await loadVoiceInputConfig());
  return !!cfg.endpoint;
}

export function formatVoiceInputError(err, config = {}) {
  const msg = String(err?.message || err || '').trim();
  if (/主屏/.test(msg)) return msg;
  if (/network|google|语音服务/i.test(msg)) return msg;
  if (/service-not-allowed|https/i.test(msg)) return msg;
  if (/不支持原生语音识别|SpeechRecognition/i.test(msg)) {
    return '听写转文字未启动：当前浏览器不支持原生听写。可换 Chrome/Edge，或配置 OpenAI 兼容 STT。';
  }
  if (/not-allowed|permission|denied|麦克风权限|权限/i.test(msg)) {
    return '听写转文字未启动：麦克风权限被拒绝，请允许麦克风后重试。';
  }
  if (/no-speech|aborted|没有听到/i.test(msg)) {
    return '没有听到可用文字';
  }
  if (/请先.*STT|endpoint|api key|接口与 Key/i.test(msg)) {
    return '听写转文字需要先配置专门的 OpenAI 兼容 STT 接口；普通聊天模型接口通常不支持音频转写。';
  }
  if (/STT 请求失败/i.test(msg)) {
    return msg.replace(/^STT 请求失败/, '听写转文字请求失败');
  }
  if (String(config?.provider || '') === 'browser' && !msg) {
    return '听写转文字失败：浏览器原生听写没有返回结果。';
  }
  return msg || '语音转写失败';
}

export async function loadVoiceInputConfig() {
  const row = await dbGet('settings', KEY).catch(() => null);
  return normalize(row?.value);
}

export async function saveVoiceInputConfig(patch = {}) {
  const cur = await loadVoiceInputConfig();
  const next = normalize({ ...cur, ...patch });
  await dbPut('settings', { key: KEY, value: next });
  return next;
}

// ---- Web Speech API（浏览器原生） ----

// iOS 主屏 PWA（standalone）里 SpeechRecognition 对象存在但被系统禁用：
// start() 后立刻 aborted / 无回调。这里直接判定为不支持，让上层走录音转写兜底。
function isIosStandalonePwa() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos = /iP(hone|ad|od)/.test(ua)
    || (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 2);
  if (!isIos) return false;
  const standalone = navigator.standalone === true
    || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return standalone;
}

// Edge/Opera/Brave 等 Chromium 系浏览器带着 webkitSpeechRecognition 接口，但没有
// Google 语音服务密钥：start() 不报错、麦克风也在录，识别却永远不返回结果（或报
// network）。挂不挂代理都一样，只能当作不支持，让上层走录音+转写接口兜底。
function isChromiumCloneWithoutSpeechService() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Edg(e|A|iOS)?\//.test(ua)) return true;
  if (/OPR\/|Opera/.test(ua)) return true;
  if (/SamsungBrowser/i.test(ua)) return true;
  if (navigator.brave) return true;
  return false;
}

export function isBrowserSpeechSupported() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext !== true) return false;
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return false;
  if (isIosStandalonePwa()) return false;
  if (isChromiumCloneWithoutSpeechService()) return false;
  return true;
}

export function normalizeSpeechLanguage(raw = '') {
  const lang = String(raw || '').trim() || 'zh-CN';
  const lower = lang.toLowerCase();
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'cmn' || lower === 'mandarin') return 'zh-CN';
  if (lower === 'zh-tw' || lower === 'zh-hk') return 'zh-TW';
  if (lower === 'en' || lower === 'en-us') return 'en-US';
  return lang;
}

function mapSpeechRecognitionError(ev) {
  const code = String(ev?.error || ev?.message || '').trim().toLowerCase();
  if (code === 'no-speech') return new Error('no-speech');
  if (code === 'aborted') return new Error('aborted');
  if (code === 'not-allowed') return new Error('麦克风权限被拒绝，请允许麦克风后重试。');
  if (code === 'service-not-allowed') {
    return new Error('当前页面无法使用浏览器原生听写，请用 HTTPS 打开，或改用录音+转写接口。');
  }
  if (code === 'network') {
    return new Error('浏览器原生听写需要访问 Google 语音服务，当前网络不可用；国内网络请改用录音+转写接口。');
  }
  if (code === 'audio-capture') return new Error('无法访问麦克风，请检查权限或设备。');
  return new Error(code || '语音识别失败');
}

function resolvesBrowserSpeechPath(cfg, options = {}) {
  if (options.preferCustom === true && cfg.endpoint) return false;
  return cfg.provider === 'browser' && isBrowserSpeechSupported();
}

export function createBrowserSpeechSession({ language = 'zh-CN', continuous = false } = {}) {
  if (!isBrowserSpeechSupported()) throw new Error('当前浏览器不支持原生语音识别');
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.lang = normalizeSpeechLanguage(language);
  rec.interimResults = true;
  rec.continuous = !!continuous;

  const handle = {
    rec,
    transcript: '',
    isInterim: true,
    onPartial: null,
    onFinal: null,
    onError: null,
    start() { rec.start(); },
    stop() { try { rec.stop(); } catch (_) {} },
    abort() { try { rec.abort(); } catch (_) {} },
  };

  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const r = ev.results[i];
      const piece = String(r?.[0]?.transcript || '');
      if (!piece) continue;
      if (r.isFinal) {
        handle.transcript = `${handle.transcript || ''}${piece}`.trim();
        handle.isInterim = false;
        handle.onFinal?.(piece);
      } else {
        interim += piece;
      }
    }
    if (interim) {
      handle.isInterim = true;
      handle.onPartial?.(interim);
    }
  };
  rec.onerror = (ev) => handle.onError?.(ev);
  return handle;
}

// ---- Custom OpenAI 兼容 /audio/transcriptions ----

function stopMediaStream(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch (_) {}
}

/** 主动申请麦克风权限（getUserMedia 会弹出系统授权框；APK WebView 里 SpeechRecognition 不会代劳）。 */
export async function requestMicrophonePermission() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风录音');
  }
  const audioSession = beginAudioCaptureSession();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = String(err?.name || '').toLowerCase();
    if (name === 'notallowederror' || name === 'permissiondeniederror') {
      throw new Error('麦克风权限被拒绝，请在系统设置中允许麦克风后重试。');
    }
    if (name === 'notfounderror' || name === 'devicesnotfounderror') {
      throw new Error('未检测到可用麦克风');
    }
    throw err;
  } finally {
    stopMediaStream(stream);
    audioSession.release();
  }
  return true;
}

async function startAudioRecorderSession({ maxMs = 30_000, onState } = {}) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风录音');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('当前环境不支持麦克风录音');
  }
  const audioSession = beginAudioCaptureSession();
  let stream = null;
  let mr = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mr = new MediaRecorder(stream);
  } catch (err) {
    stopMediaStream(stream);
    audioSession.release();
    throw err;
  }
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  let timer = null;
  let settled = false;
  let cancelReason = null;
  const releaseCapture = () => {
    stopMediaStream(stream);
    audioSession.release();
  };
  const finishReject = (reject, err) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    releaseCapture();
    reject(err);
  };
  const promise = new Promise((resolve, reject) => {
    mr.onstop = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      releaseCapture();
      if (cancelReason) {
        reject(cancelReason);
        return;
      }
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      resolve(blob);
    };
    mr.onerror = (ev) => finishReject(reject, ev.error || new Error('录音失败'));
    try {
      mr.start();
    } catch (err) {
      finishReject(reject, err);
      return;
    }
    onState?.('recording');
    timer = setTimeout(() => {
      try {
        mr.stop();
      } catch (err) {
        finishReject(reject, err);
      }
    }, Math.max(1000, Number(maxMs || 30_000) || 30_000));
  });
  const stop = () => {
    if (settled) return;
    try {
      if (mr.state !== 'inactive') mr.stop();
    } catch (_) {}
  };
  const cancel = () => {
    if (settled) return;
    cancelReason = new Error('aborted');
    stop();
  };
  return { promise, stop, cancel, recorder: mr, stream };
}

async function recordOnce({ maxMs = 30_000 } = {}) {
  const session = await startAudioRecorderSession({ maxMs });
  return session.promise;
}

function createBrowserVoiceInputSession({ config, maxMs = 30_000, onPartial, onState } = {}) {
  const cfg = normalize(config);
  const audioSession = beginAudioCaptureSession();
  let session = null;
  let done = false;
  let timer = null;
  let settleTimer = null;
  let latest = '';
  let interimHint = '';
  let resolvePromise = null;
  let rejectPromise = null;
  let stopping = false;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const mergedText = () => {
    const finals = String(latest || session?.transcript || '').trim();
    const interim = String(interimHint || '').trim();
    if (finals && interim) return `${finals} ${interim}`.trim();
    return finals || interim;
  };

  const finish = (text = '') => {
    if (done) return;
    done = true;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (settleTimer) clearTimeout(settleTimer);
    audioSession.release();
    resolvePromise(String(text || mergedText() || '').trim());
  };

  const fail = (err) => {
    if (done) return;
    done = true;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (settleTimer) clearTimeout(settleTimer);
    audioSession.release();
    rejectPromise(err);
  };

  const restartListening = () => {
    if (done || stopping || !session?.rec) return;
    try {
      session.rec.start();
    } catch (_) {
      // InvalidStateError: already started — ignore
    }
  };

  try {
    session = createBrowserSpeechSession({
      language: cfg.language || 'zh-CN',
      continuous: true,
    });
    session.onPartial = (partial) => {
      const chunk = String(partial || '').trim();
      if (!chunk) return;
      interimHint = chunk;
      onPartial?.(chunk);
    };
    session.onFinal = (final) => {
      const chunk = String(final || '').trim();
      if (!chunk) return;
      interimHint = '';
      latest = latest ? `${latest} ${chunk}`.trim() : chunk;
      onPartial?.(latest);
    };
    session.onError = (ev) => {
      if (done) return;
      const code = String(ev?.error || ev?.message || '').trim().toLowerCase();
      // Edge/Chrome 常在首段静音时抛 no-speech 并立刻 onend；窗口未结束则忽略，继续听。
      if (code === 'no-speech' || code === 'aborted') return;
      fail(mapSpeechRecognitionError(ev));
    };
    session.rec.onend = () => {
      if (done || stopping) return;
      const text = mergedText();
      if (text) latest = text;
      restartListening();
    };
    session.start();
    onState?.('recording');
    // 并行预热麦克风权限，不阻塞 start() 的用户手势；部分 Windows/Edge 环境需要。
    void requestMicrophonePermission().catch(() => {});
    timer = setTimeout(() => {
      stopping = true;
      onState?.('transcribing');
      try { session?.stop?.(); } catch (_) {}
      settleTimer = setTimeout(() => {
        const text = mergedText();
        if (text) finish(text);
        else fail(new Error('no-speech'));
      }, 1500);
    }, Math.max(1000, Number(maxMs || 30_000) || 30_000));
  } catch (err) {
    fail(err);
  }

  return {
    promise,
    stop() {
      if (done) return;
      stopping = true;
      onState?.('transcribing');
      try { session?.stop?.(); } catch (_) {}
      settleTimer = setTimeout(() => {
        const text = mergedText();
        if (text) finish(text);
        else fail(new Error('no-speech'));
      }, 1500);
    },
    cancel() {
      if (done) return;
      try { session?.abort?.(); } catch (_) {}
      fail(new Error('aborted'));
    },
  };
}

async function createCustomVoiceInputSession({ config, maxMs = 30_000, onState } = {}) {
  const recording = await startAudioRecorderSession({ maxMs, onState });
  const promise = recording.promise.then((blob) => {
    onState?.('transcribing');
    return transcribeWithCustom(blob, { config });
  });
  return {
    ...recording,
    promise,
  };
}

function browserSpeechUnavailableError() {
  if (isIosStandalonePwa()) {
    return new Error('主屏 App 里系统不开放原生听写；请在「API 管理 → 语音」配置语音输入接口，或改在浏览器里打开。');
  }
  if (isChromiumCloneWithoutSpeechService()) {
    return new Error('Edge 等浏览器带着听写接口但没有识别服务（永远不出结果）；请改用 Chrome，或在下方配置录音+转写接口。');
  }
  return new Error('当前浏览器不支持原生语音识别');
}

export async function startVoiceInputSession(options = {}) {
  const cfg = normalize(options.config || await loadVoiceInputConfig());
  const maxMs = Math.max(1000, Number(options.maxMs || 30_000) || 30_000);
  const browserPath = resolvesBrowserSpeechPath(cfg, options);
  // 浏览器原生听写要在用户手势里同步 start()；先 await getUserMedia 会丢激活态导致 Chrome 空回。
  if (options.skipMicWarmup !== true && !browserPath) {
    await requestMicrophonePermission();
  }
  if (options.preferCustom === true && await hasCustomTranscriptionFallback(cfg)) {
    return createCustomVoiceInputSession({ ...options, config: cfg, maxMs });
  }
  if (cfg.provider === 'browser') {
    if (isBrowserSpeechSupported()) {
      return createBrowserVoiceInputSession({ ...options, config: cfg, maxMs });
    }
    if (await hasCustomTranscriptionFallback(cfg)) {
      return createCustomVoiceInputSession({ ...options, config: cfg, maxMs });
    }
    throw browserSpeechUnavailableError();
  }
  return createCustomVoiceInputSession({ ...options, config: cfg, maxMs });
}

// iOS Safari 的 MediaRecorder 录出来是 audio/mp4，不是 webm；
// 文件名后缀跟真实 mime 走，避免部分 Whisper 后端按后缀解码失败。
function sttFileNameForBlob(blob) {
  const type = String(blob?.type || '').toLowerCase();
  if (/(mp4|m4a|aac)/.test(type)) return 'audio.m4a';
  if (/(mpeg|mp3)/.test(type)) return 'audio.mp3';
  if (/ogg/.test(type)) return 'audio.ogg';
  if (/wav/.test(type)) return 'audio.wav';
  return 'audio.webm';
}

// 允许像其它 API 面板一样填根地址；也接受直接粘贴完整转写端点。
export function resolveSttEndpoint(raw = '') {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (/\/audio\/transcriptions$/i.test(text)) return text;
  if (/\/v\d+$/i.test(text)) return `${text}/audio/transcriptions`;
  return `${text}/v1/audio/transcriptions`;
}

export const VOICE_INPUT_MODEL_PREFERENCES = Object.freeze([
  'FunAudioLLM/SenseVoiceSmall',
  'TeleAI/TeleSpeechASR',
  'whisper-1',
]);

export function resolveSttModelsEndpoint(raw = '') {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (/\/audio\/transcriptions$/i.test(text)) {
    return text.replace(/\/audio\/transcriptions$/i, '/models');
  }
  if (/\/v\d+$/i.test(text)) return `${text}/models`;
  return `${text}/v1/models`;
}

/** 只把可用于语音转文字的模型放进下拉框，避免误选 TTS/聊天模型。 */
export function filterVoiceInputModelNames(models = []) {
  const unique = [...new Set((Array.isArray(models) ? models : [])
    .map((item) => String(
      typeof item === 'string' ? item : (item?.id || item?.name || ''),
    ).trim())
    .filter(Boolean))];
  return unique.filter((model) => (
    /(?:whisper|sensevoice|telespeech|speech[-_/ ]?to[-_/ ]?text|transcri|\basr\b|audio[-_/ ]?text)/i.test(model)
    && !/(?:cosyvoice|fish[-_/ ]?speech|\btts\b|text[-_/ ]?to[-_/ ]?speech)/i.test(model)
  ));
}

function parseVoiceInputModelResponse(data = {}) {
  const rows = Array.isArray(data?.data)
    ? data.data
    : (Array.isArray(data?.models) ? data.models : []);
  return filterVoiceInputModelNames(rows);
}

/** 从当前 STT 服务拉取模型；浏览器跨域失败时走本站登录态代理。 */
export async function fetchVoiceInputModels(config = null) {
  const cfg = await resolveCustomConfig(config);
  const upstreamUrl = resolveSttModelsEndpoint(cfg.endpoint);
  if (!upstreamUrl) return { models: [], error: '请先填写语音转写接口地址' };
  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const requestModels = async (target, proxy = false) => {
    const res = await fetch(target, {
      method: 'GET',
      headers: proxy
        ? { ...headers, 'X-MM-Upstream-URL': upstreamUrl }
        : headers,
    });
    const raw = await res.text().catch(() => '');
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!res.ok) {
      const detail = String(data?.error?.message || data?.error || data?.message || raw || '').trim();
      throw new Error(`模型列表请求失败 ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
    }
    return parseVoiceInputModelResponse(data);
  };

  try {
    return { models: await requestModels(upstreamUrl), error: '' };
  } catch (directError) {
    if (!/^https?:\/\//i.test(upstreamUrl)) {
      return { models: [], error: String(directError?.message || directError) };
    }
    try {
      return { models: await requestModels('/api/v1/audio/models', true), error: '' };
    } catch (proxyError) {
      return {
        models: [],
        error: String(proxyError?.message || directError?.message || proxyError || directError),
      };
    }
  }
}

export async function transcribeWithCustom(blob, { config } = {}) {
  const cfg = await resolveCustomConfig(config);
  cfg.endpoint = resolveSttEndpoint(cfg.endpoint);
  if (!cfg.endpoint) throw new Error('请先配置 STT 接口');
  const fileName = sttFileNameForBlob(blob);
  const buildForm = () => {
    const next = new FormData();
    next.append('file', blob, fileName);
    next.append('model', cfg.model);
    if (cfg.language) next.append('language', cfg.language);
    return next;
  };
  const form = buildForm();
  const headers = { ...(cfg.customHeaders || {}) };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-type') delete headers[key];
  }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let res = null;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: form,
    });
  } catch (err) {
    if (!/^https?:\/\//i.test(cfg.endpoint)) throw err;
    res = await fetch('/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        ...headers,
        'X-MM-Upstream-URL': cfg.endpoint,
      },
      body: buildForm(),
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`STT 请求失败 ${res.status}：${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => ({}));
  return String(json?.text || json?.transcript || '').trim();
}

export async function transcribeOnce(options = {}) {
  const cfg = normalize(options.config || await loadVoiceInputConfig());
  if (cfg.provider === 'browser') {
    if (!isBrowserSpeechSupported()) {
      if (await hasCustomTranscriptionFallback(cfg)) {
        const blob = await recordOnce({ maxMs: Math.max(3000, Number(options.maxMs || 15000) || 15000) });
        return transcribeWithCustom(blob, { config: cfg });
      }
      throw browserSpeechUnavailableError();
    }
    return new Promise((resolve, reject) => {
      let session = null;
      let done = false;
      const finish = (text) => {
        if (done) return;
        done = true;
        try { session?.stop?.(); } catch (_) {}
        resolve(String(text || session?.transcript || '').trim());
      };
      try {
        session = createBrowserSpeechSession({ language: cfg.language || 'zh-CN' });
        session.onPartial = options.onPartial || null;
        session.onFinal = finish;
        session.onError = (ev) => {
          if (done) return;
          done = true;
          reject(mapSpeechRecognitionError(ev));
        };
        session.start();
        setTimeout(() => finish(session?.transcript || ''), Math.max(3000, Number(options.maxMs || 15000) || 15000));
      } catch (err) {
        reject(err);
      }
    });
  }
  const blob = await recordOnce({ maxMs: Math.max(3000, Number(options.maxMs || 15000) || 15000) });
  return transcribeWithCustom(blob, { config: cfg });
}
/**
 * APK 不自行录音时，把听写交给用户当前输入法。应用只能聚焦普通文本框并
 * 拉起键盘，不能也不应尝试代替用户点击某一家输入法的麦克风按钮。
 */
export function focusSystemDictationInput(input) {
  if (!input || input.disabled || input.readOnly || typeof input.focus !== 'function') return false;
  try { input.focus({ preventScroll: false }); } catch (_) { input.focus(); }
  try {
    const end = String(input.value || '').length;
    input.setSelectionRange?.(end, end);
  } catch (_) {}
  try {
    window.Capacitor?.Plugins?.Keyboard?.show?.().catch?.(() => {});
  } catch (_) {}
  return true;
}
