import {
  focusSystemDictationInput,
  formatVoiceInputError,
  loadVoiceInputConfig,
  transcribeOnce,
} from '../core/companion/voice-input.js';
import { isNativeShell } from '../core/native-update-bridge.js';
import { bindNarrationTranslationToggle, renderNarrationTextWithTranslations, stripTranslationMarks } from '../core/narration-translation.js';
import { splitSpokenTextSegments } from '../core/speech-segmentation.js';
import {
  createVoicePlaybackUrl,
  getCallLineVoice,
  primeVoicePlayback,
  removeCallLineVoices,
  stripVoiceDisplayTags,
} from '../core/voice-tools.js';
import { captureMediaGesture, takePlayableAudio, playAudioWhenReady } from '../core/media-playback.js';
import { upgradeMixedContentMediaUrl } from '../core/media-url.js';
import { exportCachedVoiceSequence } from '../core/voice-audio-export.js';
import { showToast } from './toast.js';
import { icon } from './svg-icons.js';

function getVoiceCallHost() {
  let host = document.getElementById('voice-call-container');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'voice-call-container';
  host.className = 'voice-call-host active';
  document.body.appendChild(host);
  return host;
}

function releaseVoiceCallHost(host) {
  if (!host || host.id !== 'voice-call-container') return;
  if (host.querySelector('.voice-call-overlay')) return;
  host.classList.remove('active', 'has-floating-call');
  host.remove();
}

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 通话回调和旧存档可能把正文包在对象里。只读取已知文本字段，绝不让
 * String(object) 把界面和后续上下文污染成 "[object Object]"。
 */
export function normalizeVoiceCallText(value, depth = 0) {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string') {
    return /^\[object Object\]$/i.test(value.trim()) ? '' : value;
  }
  if (['number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeVoiceCallText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object') return '';
  for (const key of ['text', 'content', 'body', 'message', 'output_text', 'reply']) {
    const text = normalizeVoiceCallText(value[key], depth + 1);
    if (text.trim()) return text;
  }
  return '';
}

function formatCallDuration(ms = 0) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function stripVoicePerformanceTags(text = '') {
  return stripVoiceDisplayTags(text);
}

export function splitVoiceCallDisplaySegments(text = '', options = {}) {
  const clean = normalizeVoiceCallText(text).replace(/\r/g, '\n').trim();
  if (!clean) return [];
  const maxChars = Math.max(24, Math.min(96, Number(options.maxChars) || 58));
  const maxSegments = Math.max(1, Math.min(12, Number(options.maxSegments) || 8));
  return splitSpokenTextSegments(clean, {
    maxChars,
    maxSegments,
    mergeShortChars: 10,
  });
}

export function normalizeVoiceCallReplyDisplayMode(value = '') {
  return String(value || '').trim() === 'single' ? 'single' : 'segments';
}

export function collectVoiceCallExportAudioIds(entries = []) {
  const seen = new Set();
  const ids = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (!entry || entry.from === 'user') return;
    const candidates = Array.isArray(entry.audioIds) && entry.audioIds.length
      ? entry.audioIds
      : [entry.audioId];
    candidates.forEach((value) => {
      const id = String(value || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    });
  });
  return ids;
}

export function collectVoiceCallReplayGroup(entries = [], lineIndex = -1) {
  const rows = Array.isArray(entries) ? entries : [];
  const index = Number(lineIndex);
  const entry = rows[index];
  if (!entry || entry.from === 'user' || !normalizeVoiceCallText(entry.rawText).trim()) return null;
  const replyGroupId = String(entry.replyGroupId || '').trim();
  if (!replyGroupId) {
    return {
      entry,
      text: normalizeVoiceCallText(entry.rawText).trim(),
      indexes: [index],
    };
  }
  let first = index;
  let last = index;
  while (first > 0 && rows[first - 1]?.from !== 'user' && String(rows[first - 1]?.replyGroupId || '').trim() === replyGroupId) first -= 1;
  while (last + 1 < rows.length && rows[last + 1]?.from !== 'user' && String(rows[last + 1]?.replyGroupId || '').trim() === replyGroupId) last += 1;
  const groupEntries = rows.slice(first, last + 1);
  return {
    entry: { ...entry, replyGroupId, replyPartIndex: 0, replyPartCount: groupEntries.length },
    text: groupEntries.map((row) => normalizeVoiceCallText(row.rawText).trim()).filter(Boolean).join('\n'),
    indexes: groupEntries.map((_row, offset) => first + offset),
  };
}

function splitVideoCaptionPages(text = '') {
  // 字幕是转瞬即逝的预览，只显示外语原文；完整的外语+中文对照留给可展开的通话记录面板。
  const clean = stripVoicePerformanceTags(stripTranslationMarks(normalizeVoiceCallText(text)))
    .replace(/([。！？!?）)])\s*/g, '$1\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!clean) return [];
  const pages = [];
  for (const line of clean.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    let buf = '';
    for (const ch of line) {
      buf += ch;
      if (/[。！？!?）)]/.test(ch) || buf.length >= 42) {
        const next = buf.trim();
        if (next) pages.push(next);
        buf = '';
      }
    }
    if (buf.trim()) pages.push(buf.trim());
  }
  return pages.length ? pages : [clean.replace(/\n+/g, ' ')];
}

function createDialToneController() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  let ctx = null;
  let timer = null;
  const beep = async () => {
    ctx = ctx || new AudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 425;
    gain.gain.value = 0.055;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      try { osc.stop(); osc.disconnect(); gain.disconnect(); } catch (_) {}
    }, 180);
  };
  const start = () => {
    if (timer) return;
    void beep();
    timer = setInterval(() => { void beep(); }, 1150);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const destroy = () => {
    stop();
    if (ctx) void ctx.close?.();
    ctx = null;
  };
  return { start, stop, destroy };
}

export function openVoiceCallModal(options = {}) {
  // 通话会跨页面悬浮，不能与普通弹窗共用 #modal-container。
  // 普通弹窗大量使用 innerHTML/replaceChildren，复用会静默销毁通话和未保存转写。
  const container = getVoiceCallHost();
  if (!container) return null;
  const title = String(options.title || options.name || '语音通话').trim();
  const note = String(options.note || '').trim();
  const avatarHtml = String(options.avatarHtml || '').trim();
  const mode = String(options.mode || 'voice').trim() === 'video' ? 'video' : 'voice';
  const characterId = String(options.characterId || '').trim();
  const videoMode = mode === 'video';
  const nativeImeDictation = isNativeShell();
  const voiceProfile = options.voiceProfile && typeof options.voiceProfile === 'object' ? options.voiceProfile : {};
  const enableChat = options.enableChat !== false;
  const state = String(options.state || 'incoming').toLowerCase();
  const outgoing = state === 'outgoing';
  const incoming = state !== 'active' && !outgoing;
  let active = state === 'active';
  let loading = active && options.connecting === true;
  let ending = false;
  let closed = false;
  let startedAt = active ? (Math.max(0, Number(options.startedAt || 0) || 0) || Date.now()) : 0;
  let timer = null;
  let transcribing = false;
  let busy = false;
  const dialTone = createDialToneController();
  const transcript = [];
  const lineEntries = [];
  let hydratingEntries = false;
  let videoCaptionPages = [];
  let videoCaptionIndex = 0;
  let videoLogDirty = true;
  let replaying = false;
  let openingRetryHandler = null;
  const replyDisplayMode = normalizeVoiceCallReplyDisplayMode(options.replyDisplayMode);
  const nativeVideo = videoMode
    && document.documentElement.classList.contains('capacitor-native');

  container.classList.add('active');
  const overlay = document.createElement('div');
  overlay.className = `voice-call-overlay${videoMode ? ' voice-call-overlay--video' : ''}${options.minimized ? ' is-mini' : ''}`;
  const callKey = String(options.callKey || '').trim();
  if (callKey) overlay.dataset.voiceCallKey = callKey;
  const userVisual = String(options.userVisual || '').trim();
  const bgVisual = upgradeMixedContentMediaUrl(
    String(options.backgroundImage || voiceProfile.videoBackground || voiceProfile.video_background || '').trim(),
  );
  const bgFitValue = String(
    options.backgroundFit || voiceProfile.videoBackgroundFit || voiceProfile.video_background_fit || '',
  ).trim().toLowerCase();
  const bgFit = ['cover', 'contain', 'fill'].includes(bgFitValue) ? bgFitValue : 'cover';
  const bgPositionValue = String(
    options.backgroundPosition
      || voiceProfile.videoBackgroundPosition
      || voiceProfile.video_background_position
      || '',
  ).trim().toLowerCase();
  const bgPosition = ['center', 'top', 'bottom', 'left', 'right'].includes(bgPositionValue)
    ? bgPositionValue
    : 'center';
  overlay.innerHTML = `
    <div class="voice-call-screen${incoming ? ' is-ringing' : ' is-active'}${enableChat && !videoMode ? ' voice-call-screen--chat' : ''} voice-call-screen--${mode}${bgVisual ? ' has-call-bg has-video-bg' : ' has-no-video-bg'}">
      ${bgVisual ? `<div class="voice-call-custom-background ${videoMode ? 'voice-call-video-backdrop' : 'voice-call-voice-backdrop'}" aria-hidden="true"></div>` : ''}
      <div class="voice-call-statusbar">
        <div class="voice-call-titlebar">
          <span class="voice-call-title">${mode === 'video' ? '视频通话' : '语音通话'}</span>
          <span class="voice-call-timer">${incoming ? '邀请中' : outgoing ? '等待接听' : loading ? '接通中' : '00:00'}</span>
        </div>
        <div class="voice-call-window-controls">
          ${videoMode ? `<button type="button" class="voice-call-compact" aria-label="收起通话">${icon('chevronDown')}</button>` : ''}
          <button type="button" class="voice-call-mini" aria-label="小窗">${icon('window')}</button>
          <button type="button" class="voice-call-close" aria-label="${options.closeBehavior === 'minimize' ? '收起到小窗' : '关闭'}">${icon(options.closeBehavior === 'minimize' ? 'chevronDown' : 'close')}</button>
        </div>
      </div>
      ${videoMode ? `
        <div class="voice-call-video-stage">
          <div class="voice-call-video-main">${bgVisual ? `<img src="${esc(bgVisual)}" alt="">` : '<span>未设置视频背景</span>'}</div>
          <div class="voice-call-video-name"><b>${esc(title)}</b><span class="voice-call-video-state">${incoming ? '等待接听' : outgoing ? '等待对方接听' : loading ? '接通中' : '视频通话中'}</span></div>
          <div class="voice-call-video-pip">${userVisual ? `<img src="${esc(userVisual)}" alt="">` : '<span>我</span>'}</div>
          <button type="button" class="voice-call-video-caption" hidden></button>
          <button type="button" class="voice-call-video-caption-reroll" hidden aria-label="重 roll" title="重 roll">${icon('reroll')}</button>
        </div>
        <button type="button" class="voice-call-video-log-toggle" aria-label="展开通话记录" aria-expanded="false" title="通话记录">${icon('time')}</button>
        <div class="voice-call-video-log" hidden></div>
      ` : ''}
      ${!videoMode ? `
      <div class="voice-call-profile">
        <div class="voice-call-avatar">${avatarHtml || `<span>${esc(title.slice(0, 1) || '语')}</span>`}</div>
        <div class="voice-call-name">${esc(title)}</div>
        <div class="voice-call-state">${incoming ? '邀请你语音通话' : outgoing ? '等待对方接听' : loading ? '接通中' : '语音通话中'}</div>
        ${note ? `<div class="voice-call-note">${esc(note)}</div>` : ''}
      </div>
      ` : ''}
      <div class="voice-call-opening-error" hidden role="status">
        <span>开场白生成失败</span>
        <button type="button" class="voice-call-opening-retry">${icon('reroll')}<span>重 roll</span></button>
      </div>
      ${enableChat && !videoMode ? `
        <div class="voice-call-log-shell">
          <div class="voice-call-log" aria-label="通话转写">
            <div class="voice-call-log-empty">接通后，对话会留在这里</div>
            <div class="voice-call-loading" hidden><span></span><b>加载中</b></div>
          </div>
          <button type="button" class="voice-call-log-toggle" aria-expanded="false">
            <span>展开通话记录</span>${icon('chevronDown')}
          </button>
        </div>
      ` : ''}
      ${videoMode ? `<div class="voice-call-controls">
        <button type="button" class="voice-call-control voice-call-voice-input" aria-label="${nativeImeDictation ? '输入文字' : '语音转写'}">${nativeImeDictation ? `${icon('edit')}<span>输入</span>` : `${icon('voice')}<span>语音转写</span>`}</button>
      </div>` : ''}
      ${enableChat ? `
        <div class="voice-call-input${videoMode ? ' voice-call-input--video' : ''}${nativeImeDictation ? ' voice-call-input--native-ime' : ''}">
          <textarea class="voice-call-input-text" placeholder="${videoMode && !nativeImeDictation ? '说完后可在这里修改' : '输入你要说的话'}" rows="1"></textarea>
          ${videoMode ? `<button type="button" class="voice-call-input-send" aria-label="发送" title="发送">${icon('advance')}</button>` : `${nativeImeDictation ? '' : `<button type="button" class="voice-call-input-transcribe" aria-label="听写" title="听写">${icon('voice')}</button>`}
          <button type="button" class="voice-call-input-send" aria-label="发送" title="发送">${icon('advance')}</button>`}
        </div>
      ` : ''}
      <div class="voice-call-actions">
        ${incoming ? `<button type="button" class="voice-call-action voice-call-action--decline" aria-label="挂断">${icon('phoneOff')}</button><button type="button" class="voice-call-action voice-call-action--answer" aria-label="接听">${icon('voiceCall')}</button>` : ''}
        ${incoming ? '' : `<button type="button" class="voice-call-action voice-call-action--end" aria-label="挂断">${icon('phoneOff')}</button>`}
      </div>
    </div>
  `;
  container.appendChild(overlay);
  overlay.style.setProperty('--voice-call-bg-fit', bgFit);
  overlay.style.setProperty('--voice-call-bg-size', bgFit === 'fill' ? '100% 100%' : bgFit);
  overlay.style.setProperty('--voice-call-bg-position', bgPosition);
  const customBackground = overlay.querySelector('.voice-call-custom-background');
  if (customBackground && bgVisual) {
    customBackground.style.backgroundImage = `url(${JSON.stringify(bgVisual)})`;
  }
  container.classList.toggle('has-floating-call', options.minimized === true);
  bindNarrationTranslationToggle(overlay);

  const timerEl = overlay.querySelector('.voice-call-timer');
  const stateEl = overlay.querySelector('.voice-call-state');
  const videoStateEl = overlay.querySelector('.voice-call-video-state');
  const screen = overlay.querySelector('.voice-call-screen');
  const actions = overlay.querySelector('.voice-call-actions');
  const compactBtn = overlay.querySelector('.voice-call-compact');
  const closeBtn = overlay.querySelector('.voice-call-close');
  const logEl = overlay.querySelector('.voice-call-log');
  const voiceLogToggle = overlay.querySelector('.voice-call-log-toggle');
  const videoLogEl = overlay.querySelector('.voice-call-video-log');
  const videoLogToggle = overlay.querySelector('.voice-call-video-log-toggle');
  const videoCaptionRerollBtn = overlay.querySelector('.voice-call-video-caption-reroll');
  const openingErrorEl = overlay.querySelector('.voice-call-opening-error');
  const openingRetryBtn = overlay.querySelector('.voice-call-opening-retry');
  const loadingEl = overlay.querySelector('.voice-call-loading');
  const inputEl = overlay.querySelector('.voice-call-input-text');
  const transcribeBtn = overlay.querySelector('.voice-call-input-transcribe');
  const sendBtn = overlay.querySelector('.voice-call-input-send');
  const videoVoiceBtn = overlay.querySelector('.voice-call-voice-input');
  const statusbarEl = overlay.querySelector('.voice-call-statusbar');

  // 落库转写用角色名，避免上下文里「对方：」被弱模型读成会议纪要发言人。
  const peerLabel = String(options.name || options.title || 'TA').trim() || 'TA';
  const transcriptText = () => transcript.map((x) => `${x.from === 'user' ? '我' : peerLabel}：${x.text}`).join('\n');
  const snapshotEntries = () => lineEntries.map((entry) => ({ ...entry }));
  const emitEntriesChange = () => {
    if (hydratingEntries || closed || typeof options.onEntriesChange !== 'function') return;
    try {
      const pending = options.onEntriesChange({
        transcriptText: transcriptText(),
        entries: snapshotEntries(),
      });
      pending?.catch?.((err) => console.warn('[voice-call] checkpoint failed', err));
    } catch (err) {
      console.warn('[voice-call] checkpoint failed', err);
    }
  };
  const formatEntryTime = (time = Date.now()) => {
    const d = new Date(Number(time || Date.now()) || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const getLastAiLineIndex = () => {
    if (!lineEntries.length) return -1;
    const last = lineEntries.length - 1;
    return lineEntries[last].from !== 'user' && lineEntries[last].rawText ? last : -1;
  };
  const aiLineActionsHtml = (lineIndex, canReroll = false) => `
    <div class="voice-call-line-actions">
      <button type="button" class="voice-call-line-replay" data-replay-line="${lineIndex}" aria-label="播放">${icon('play')}</button>
      ${canReroll ? `<button type="button" class="voice-call-line-reroll" data-reroll-line="${lineIndex}" aria-label="重 roll" title="重 roll">${icon('reroll')}</button>` : ''}
    </div>
  `;
  const isReplayAnchorLine = (lineIndex) => {
    const entry = lineEntries[Number(lineIndex)];
    if (!entry || entry.from === 'user') return false;
    const replyGroupId = String(entry.replyGroupId || '').trim();
    if (!replyGroupId) return true;
    const next = lineEntries[Number(lineIndex) + 1];
    return !next || next.from === 'user' || String(next.replyGroupId || '').trim() !== replyGroupId;
  };
  const splitLogTextSegments = (text = '') => {
    const clean = normalizeVoiceCallText(text).trim();
    if (!clean) return [];
    return replyDisplayMode === 'single'
      ? [clean]
      : splitVoiceCallDisplaySegments(clean);
  };
  const buildVideoLogRounds = () => {
    const rounds = [];
    let current = null;
    lineEntries.forEach((entry, index) => {
      const replyGroupId = String(entry.replyGroupId || '').trim();
      const beginsAiGroup = entry.from !== 'user'
        && replyGroupId
        && current?.replyGroupId
        && current.replyGroupId !== replyGroupId;
      if (!current || entry.from === 'user' || beginsAiGroup) {
        current = { entries: [], startedAt: entry.at, endedAt: entry.at, replayLineIndex: -1, replyGroupId };
        rounds.push(current);
      }
      if (replyGroupId) current.replyGroupId = replyGroupId;
      current.entries.push({ ...entry, lineIndex: index });
      current.endedAt = entry.at || current.endedAt;
      if (entry.from !== 'user' && entry.rawText) current.replayLineIndex = index;
    });
    return rounds;
  };
  const syncLatestRerollUi = () => {
    const lastAi = getLastAiLineIndex();
    const canReroll = lastAi >= 0 && active && !ending && !closed && typeof options.onRerollLast === 'function';
    if (logEl) {
      logEl.querySelectorAll('.voice-call-line').forEach((row) => {
        const lineIndex = Number(row.getAttribute('data-line-index'));
        const meta = row.querySelector('.voice-call-line-meta');
        if (!meta || row.classList.contains('is-user')) return;
        meta.querySelector('.voice-call-line-actions')?.remove();
        if (isReplayAnchorLine(lineIndex)) {
          meta.insertAdjacentHTML('beforeend', aiLineActionsHtml(lineIndex, canReroll && lineIndex === lastAi));
        }
      });
      if (replaying || busy || loading) {
        logEl.querySelectorAll('[data-replay-line], [data-reroll-line]').forEach((btn) => {
          btn.disabled = true;
        });
      }
      if (replaying) {
        logEl.querySelectorAll('[data-replay-line]').forEach((btn) => {
          btn.classList.add('is-playing');
        });
      }
    }
    if (videoCaptionRerollBtn) {
      videoCaptionRerollBtn.hidden = !canReroll || !videoMode;
      videoCaptionRerollBtn.disabled = !canReroll || busy || loading || replaying;
    }
  };
  const syncTimer = () => {
    if (!active || !timerEl) return;
    if (loading) {
      timerEl.textContent = '接通中';
      return;
    }
    timerEl.textContent = formatCallDuration(Date.now() - startedAt);
  };
  const setInputVisible = () => {
    const canInput = !!active;
    if (logEl) logEl.style.display = canInput ? '' : 'none';
    const logWrap = overlay.querySelector('.voice-call-log-shell');
    if (logWrap) logWrap.style.display = canInput ? '' : 'none';
    const inputWrap = overlay.querySelector('.voice-call-input');
    if (inputWrap && !videoMode) inputWrap.style.display = canInput ? '' : 'none';
    if (inputWrap && videoMode) inputWrap.classList.toggle('is-open', canInput && screen?.classList.contains('is-input-open'));
  };
  const setBusy = (nextBusy) => {
    busy = !!nextBusy;
    overlay.querySelectorAll('button, textarea').forEach((el) => {
      const keepLive = el.classList.contains('voice-call-close')
        || el.classList.contains('voice-call-mini')
        || el.classList.contains('voice-call-compact')
        || el.classList.contains('voice-call-video-log-toggle')
        || el.classList.contains('voice-call-video-caption')
        || el.classList.contains('voice-call-input-text')
        || el.classList.contains('narration-translate-btn')
        || el.hasAttribute('data-translation-toggle')
        || (videoMode && el.classList.contains('voice-call-voice-input'));
      if (keepLive) {
        el.disabled = false;
        return;
      }
      if (el.classList.contains('voice-call-action--end') && busy) return;
      el.disabled = busy;
    });
    syncLatestRerollUi();
  };
  const setStatusText = (text = '') => {
    const next = String(text || '').trim();
    if (next && stateEl) stateEl.textContent = next;
    if (next && videoStateEl) videoStateEl.textContent = next;
  };
  const setLoading = (nextLoading, text = '加载中') => {
    loading = !!nextLoading;
    if (loading && String(text || '').includes('接通')) dialTone?.start();
    else dialTone?.stop();
    if (loadingEl) {
      loadingEl.hidden = !loading;
      const label = loadingEl.querySelector('b');
      if (label) label.textContent = String(text || '加载中');
      if (loading && logEl) logEl.scrollTop = logEl.scrollHeight;
    }
    // 回复/首句加载时仍允许先输入下一句话；只锁发送和听写，避免 iOS 键盘完全无法唤起。
    if (inputEl) inputEl.disabled = false;
    if (transcribeBtn) transcribeBtn.disabled = loading || transcribing;
    if (videoVoiceBtn) videoVoiceBtn.disabled = loading || transcribing;
    if (sendBtn) sendBtn.disabled = loading;
    syncLatestRerollUi();
    syncTimer();
  };
  const setOpeningError = (message = '', retryHandler = null) => {
    const text = String(message || '').trim();
    openingRetryHandler = text && typeof retryHandler === 'function' ? retryHandler : null;
    if (!openingErrorEl) return;
    openingErrorEl.hidden = !text;
    const label = openingErrorEl.firstElementChild;
    // 开场为空时通常是模型没有给出可说出口的台词；内部校验码会让人误以为设置冲突。
    if (label) label.textContent = text
      ? '开场白生成失败：模型未返回可用台词，请点「重 roll」重试。'
      : '开场白生成失败';
    if (openingRetryBtn) openingRetryBtn.disabled = !openingRetryHandler || busy || loading;
  };
  const retryOpening = async (gestureToken = null) => {
    const handler = openingRetryHandler;
    if (!handler || closed || ending || busy || loading) {
      gestureToken?.dispose?.();
      return;
    }
    setOpeningError('');
    try {
      await handler({ gestureToken });
    } catch (err) {
      gestureToken?.dispose?.();
      console.warn('[voice-call] opening retry failed', err);
      setOpeningError('开场白生成失败', handler);
    }
  };
  const close = () => {
    if (closed) return;
    stopFloatingDrag();
    closed = true;
    overlay.__marshmallowVoiceCallController = null;
    active = false;
    if (timer) clearInterval(timer);
    dialTone?.destroy();
    try { options.onClose?.(); } catch (_) {}
    container.classList.remove('has-floating-call');
    // Android WebView 上全屏背景纹理 + 多层半透明合成可能占满 GPU。
    // 关闭时立即释放背景与 DOM，不等待淡出动画，避免用户挂断后仍卡在通话层。
    if (nativeVideo) {
      screen?.style?.removeProperty('background-image');
      overlay.remove();
      if (!container.querySelector('.modal-overlay, .voice-call-overlay')) container.classList.remove('active');
      releaseVoiceCallHost(container);
      return;
    }
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity .18s ease';
    setTimeout(() => {
      overlay.remove();
      if (!container.querySelector('.modal-overlay, .voice-call-overlay')) container.classList.remove('active');
      releaseVoiceCallHost(container);
    }, 180);
  };
  const setVideoInputOpen = (open) => {
    if (!videoMode) return;
    screen?.classList.toggle('is-input-open', !!open);
    setInputVisible();
    if (open && inputEl) setTimeout(() => inputEl.focus(), 30);
  };
  function setVideoLogOpen(open) {
    if (!videoMode) return;
    if (videoLogEl) videoLogEl.hidden = !open;
    videoLogToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    videoLogToggle?.setAttribute('aria-label', open ? '收起通话记录' : '展开通话记录');
    videoLogToggle?.classList.toggle('is-open', open);
    overlay.classList.toggle('is-log-open', open);
    if (open && videoLogDirty) renderVideoLog();
  }
  const resetOverlayPosition = () => {
    overlay.style.left = '';
    overlay.style.top = '';
    overlay.style.right = '';
    overlay.style.bottom = '';
  };
  const setWindowMode = (nextMode = 'full') => {
    const modeName = String(nextMode || 'full');
    const mini = modeName === 'mini';
    const compact = modeName === 'compact';
    overlay.classList.toggle('is-mini', mini);
    overlay.classList.toggle('is-compact', compact);
    container.classList.toggle('has-floating-call', mini || compact);
    resetOverlayPosition();
    if (!mini && !compact) {
      setInputVisible();
      return;
    }
    setVideoInputOpen(false);
    setVideoLogOpen(false);
  };
  const renderVideoLog = () => {
    if (!videoLogEl) return;
    videoLogDirty = false;
    const head = `<div class="voice-call-video-log-head"><span>通话记录</span><button type="button" data-close-video-log aria-label="关闭通话记录">${icon('close')}</button></div>`;
    if (!lineEntries.length) {
      videoLogEl.innerHTML = `${head}<div class="voice-call-video-log-empty">暂无通话记录</div>`;
      return;
    }
    const lastAi = getLastAiLineIndex();
    const canReroll = lastAi >= 0 && active && !ending && !closed && typeof options.onRerollLast === 'function';
    const rounds = buildVideoLogRounds();
    videoLogEl.innerHTML = head + rounds.map((round, roundIndex) => {
      const isLatestAiRound = canReroll && roundIndex === rounds.length - 1 && round.replayLineIndex === lastAi;
      return `
      <div class="voice-call-video-log-round">
        ${round.entries.map((entry) => {
          const parts = splitLogTextSegments(entry.text);
          return `
            <div class="voice-call-video-log-line ${entry.from === 'user' ? 'is-user' : 'is-ai'}">
              <b>${entry.from === 'user' ? '我' : esc(title)}</b>
              <div class="voice-call-video-log-bubbles">
                ${(parts.length ? parts : [entry.text]).map((part) => `<span>${renderNarrationTextWithTranslations(part)}</span>`).join('')}
              </div>
            </div>
          `;
        }).join('')}
        <div class="voice-call-video-log-round-foot">
          <time>${esc(formatEntryTime(round.endedAt))}</time>
          <div class="voice-call-video-log-actions">
            ${round.replayLineIndex >= 0 ? `<button type="button" class="voice-call-video-log-replay" data-replay-line="${round.replayLineIndex}">重听</button>` : ''}
            ${isLatestAiRound ? `<button type="button" class="voice-call-video-log-reroll" data-reroll-line="${lastAi}">重 roll</button>` : ''}
          </div>
        </div>
      </div>
    `;
    }).join('');
    if (replaying || busy || loading) {
      videoLogEl.querySelectorAll('[data-replay-line], [data-reroll-line]').forEach((btn) => {
        btn.disabled = true;
      });
    }
    if (replaying) {
      videoLogEl.querySelectorAll('.voice-call-video-log-replay').forEach((btn) => {
        btn.classList.add('is-playing');
        btn.textContent = '播放中';
      });
    }
  };
  const invalidateVideoLog = () => {
    if (!videoMode) return;
    videoLogDirty = true;
    // 折叠时只标记脏，不创建任何历史 DOM；展开后再一次性渲染。
    if (videoLogEl && !videoLogEl.hidden) renderVideoLog();
  };
  const setReplayBusy = (busyState) => {
    replaying = !!busyState;
    overlay.querySelectorAll('[data-replay-line]').forEach((btn) => {
      btn.disabled = replaying || busy || loading;
      btn.classList.toggle('is-playing', replaying);
      if (btn.classList.contains('voice-call-video-log-replay')) {
        btn.textContent = replaying ? '播放中' : '重听';
      }
    });
    overlay.querySelectorAll('[data-reroll-line]').forEach((btn) => {
      btn.disabled = replaying || busy || loading;
    });
    if (videoCaptionRerollBtn) {
      videoCaptionRerollBtn.disabled = replaying || busy || loading || videoCaptionRerollBtn.hidden;
    }
  };
  const updateVideoCaption = (text = '', reset = true) => {
    if (!videoMode) return;
    const caption = overlay.querySelector('.voice-call-video-caption');
    if (!caption) return;
    const nextPages = splitVideoCaptionPages(text);
    if (reset) {
      videoCaptionPages = nextPages;
      videoCaptionIndex = 0;
    }
    const current = videoCaptionPages[videoCaptionIndex] || '';
    const hasNext = videoCaptionIndex < videoCaptionPages.length - 1;
    caption.innerHTML = current
      ? `<span>${esc(current)}</span>${hasNext ? '<i class="voice-call-caption-more" aria-label="还有下一段">...</i>' : ''}`
      : '';
    caption.hidden = !current;
  };
  const showVideoThinkingCaption = () => {
    if (!videoMode) return;
    videoCaptionPages = ['...'];
    videoCaptionIndex = 0;
    const caption = overlay.querySelector('.voice-call-video-caption');
    if (!caption) return;
    caption.innerHTML = '<span class="voice-call-caption-thinking">...</span>';
    caption.hidden = false;
  };
  const addSingleLine = (line = {}) => {
    if (closed) return;
    const text = (normalizeVoiceCallText(line.rawText) || normalizeVoiceCallText(line.text)).trim();
    if (!text) return;
    const from = String(line.from || 'user').trim();
    const displayText = stripVoicePerformanceTags(text);
    // 只有表演标签、没有可见台词的异常回复不应把内部 TTS 指令落进字幕或历史。
    if (!displayText) return;
    const pendingAudioId = from === 'user'
      ? ''
      : String(line.pendingAudioId || options.getAudioId?.(text) || '').trim();
    const entry = {
      from,
      text: displayText,
      rawText: text,
      at: Number(line.at || 0) || Date.now(),
      audioId: String(line.audioId || '').trim(),
      audioIds: Array.isArray(line.audioIds) ? line.audioIds.map(String).filter(Boolean) : [],
      pendingAudioId,
      audioDataUrls: Array.isArray(line.audioDataUrls) ? line.audioDataUrls.map(String).filter(Boolean) : [],
      replyGroupId: String(line.replyGroupId || '').trim(),
      replyPartIndex: Math.max(0, Number(line.replyPartIndex || 0) || 0),
      replyPartCount: Math.max(1, Number(line.replyPartCount || 1) || 1),
    };
    const lineIndex = lineEntries.push(entry) - 1;
    transcript.push(entry);
    if (videoMode) {
      invalidateVideoLog();
      if (from !== 'user' && line.suppressVideoCaption !== true) updateVideoCaption(displayText);
      syncLatestRerollUi();
    }
    emitEntriesChange();
    if (!logEl) return;
    logEl.querySelector('.voice-call-log-empty')?.remove();
    const row = document.createElement('div');
    row.className = `voice-call-line ${from === 'user' ? 'is-user' : 'is-ai'}`;
    row.setAttribute('data-line-index', String(lineIndex));
    if (entry.replyGroupId) row.setAttribute('data-reply-group', entry.replyGroupId);
    if (entry.replyPartIndex > 0) row.classList.add('is-reply-continuation');
    row.innerHTML = `<div class="voice-call-line-meta"><span>${from === 'user' ? '我' : '对方'}</span>${from === 'user' ? '' : aiLineActionsHtml(lineIndex, false)}</div><div class="voice-call-line-body">${renderNarrationTextWithTranslations(displayText)}</div>`;
    if (loadingEl && logEl.contains(loadingEl)) {
      logEl.insertBefore(row, loadingEl);
    } else {
      logEl.appendChild(row);
    }
    syncLatestRerollUi();
    logEl.scrollTop = logEl.scrollHeight;
  };
  const addLine = (line = {}) => {
    if (closed) return;
    const text = (normalizeVoiceCallText(line.rawText) || normalizeVoiceCallText(line.text)).trim();
    const from = String(line.from || 'user').trim();
    if (!text || from === 'user' || replyDisplayMode === 'single' || line.split === false) {
      addSingleLine(line);
      return;
    }
    const parts = splitVoiceCallDisplaySegments(text);
    if (parts.length <= 1) {
      addSingleLine(line);
      return;
    }
    const replyGroupId = String(line.replyGroupId || `call-reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`).trim();
    const pendingAudioId = String(line.pendingAudioId || options.getAudioId?.(text) || '').trim();
    parts.forEach((part, index) => addSingleLine({
      ...line,
      text: part,
      rawText: part,
      replyGroupId,
      replyPartIndex: index,
      replyPartCount: parts.length,
      pendingAudioId,
      suppressVideoCaption: true,
    }));
    if (videoMode) updateVideoCaption(stripVoicePerformanceTags(text));
  };
  const removeLastAiLine = () => {
    const lastAi = getLastAiLineIndex();
    if (lastAi < 0) return null;
    const groupId = String(lineEntries[lastAi]?.replyGroupId || '').trim();
    let first = lastAi;
    if (groupId) {
      while (first > 0 && lineEntries[first - 1]?.from !== 'user' && lineEntries[first - 1]?.replyGroupId === groupId) first -= 1;
    }
    const removed = lineEntries.splice(first, lastAi - first + 1);
    removed.forEach((entry) => {
      const transcriptIndex = transcript.lastIndexOf(entry);
      if (transcriptIndex >= 0) transcript.splice(transcriptIndex, 1);
    });
    for (let index = first; index <= lastAi; index += 1) {
      logEl?.querySelector(`.voice-call-line[data-line-index="${index}"]`)?.remove();
    }
    if (videoMode) {
      updateVideoCaption('');
      invalidateVideoLog();
    }
    syncLatestRerollUi();
    emitEntriesChange();
    return {
      ...removed[0],
      rawText: removed.map((entry) => entry.rawText || entry.text).join(''),
      text: removed.map((entry) => entry.text).join(''),
    };
  };
  const restoreAiLine = (entry = null) => {
    if (!entry || closed) return;
    const text = (normalizeVoiceCallText(entry.rawText) || normalizeVoiceCallText(entry.text)).trim();
    if (!text) return;
    addLine({ from: 'ai', text });
  };
  const rerollLastLine = async (gestureToken = null) => {
    if (!active || closed || ending || busy || replaying || loading) {
      gestureToken?.dispose?.();
      return;
    }
    if (typeof options.onRerollLast !== 'function') {
      gestureToken?.dispose?.();
      return;
    }
    const lastAi = getLastAiLineIndex();
    if (lastAi < 0) {
      gestureToken?.dispose?.();
      return;
    }
    const snapshot = removeLastAiLine();
    if (videoMode) showVideoThinkingCaption();
    let reply = '';
    let failed = false;
    try {
      setBusy(true);
      setLoading(true, '重新生成');
      syncLatestRerollUi();
      reply = await options.onRerollLast({ gestureToken });
    } catch (err) {
      gestureToken?.dispose?.();
      failed = true;
      console.warn('[voice-call] reroll failed', err);
    } finally {
      setLoading(false);
      if (!closed && !ending) setBusy(false);
    }
    if (closed || ending || !active) return;
    const next = normalizeVoiceCallText(reply).trim();
    if (next) {
      addLine({ from: 'ai', text: next });
      return;
    }
    if (failed || !next) restoreAiLine(snapshot);
    syncLatestRerollUi();
  };
  const replayLine = async (lineIndex, gestureToken = null) => {
    const replayGroup = collectVoiceCallReplayGroup(lineEntries, lineIndex);
    if (!replayGroup || closed || ending || replaying) {
      gestureToken?.dispose?.();
      return;
    }
    try {
      setReplayBusy(true);
      setLoading(true, '重新播放');
      // 手势所有权交给 onReplayText → playCallTtsQueue，此处勿二次 dispose。
      const played = await options.onReplayText?.(replayGroup.text, replayGroup.entry, { gestureToken });
      if (played === false) setStatusText('这一轮没有可播放语音');
    } catch (err) {
      gestureToken?.dispose?.();
      console.warn('[voice-call] replay failed', err);
    } finally {
      setReplayBusy(false);
      if (!closed && !ending) setLoading(false);
    }
  };
  const markAudioReady = (audioId = '', segmentAudioIds = []) => {
    const id = String(audioId || '').trim();
    if (!id) return;
    const ids = (Array.isArray(segmentAudioIds) ? segmentAudioIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    let changed = false;
    lineEntries.forEach((entry) => {
      if (entry.pendingAudioId !== id) return;
      entry.audioId = ids[0] || id;
      entry.audioIds = ids.length ? [...ids] : [id];
      changed = true;
    });
    if (changed) emitEntriesChange();
  };
  const startCall = async (gestureToken = null, soundGestureTokens = []) => {
    const backgroundTokens = Array.isArray(soundGestureTokens) ? soundGestureTokens : [];
    if (closed || ending || active) {
      gestureToken?.dispose?.();
      backgroundTokens.forEach((token) => token?.dispose?.());
      return;
    }
    setBusy(true);
    try {
      await options.onAccept?.({ gestureToken, soundGestureTokens: backgroundTokens });
    } catch (err) {
      gestureToken?.dispose?.();
      backgroundTokens.forEach((token) => token?.dispose?.());
      console.warn('[voice-call] accept failed', err);
      setBusy(false);
      return;
    }
    if (closed || ending) {
      setBusy(false);
      return;
    }
    active = true;
    startedAt = Date.now();
    screen?.classList.remove('is-ringing');
    screen?.classList.add('is-active');
    if (stateEl) stateEl.textContent = videoMode ? '视频通话中' : '语音通话中';
    if (videoStateEl) videoStateEl.textContent = '视频通话中';
    if (actions) {
      actions.innerHTML = `<button type="button" class="voice-call-action voice-call-action--end" aria-label="挂断">${icon('phoneOff')}</button>`;
      actions.querySelector('.voice-call-action--end')?.addEventListener('click', endCall);
    }
    setInputVisible();
    syncTimer();
    timer = setInterval(syncTimer, 500);
    setBusy(false);
  };
  async function declineCall() {
    if (closed || ending) return;
    ending = true;
    setBusy(true);
    // UI 与 GPU 纹理先释放，记录落库在后台继续；不能让保存延迟把用户困在通话页。
    close();
    try {
      await options.onDecline?.();
    } catch (err) {
      console.warn('[voice-call] decline failed', err);
    } finally {
      close();
    }
  }
  async function endCall(endOptions = {}) {
    if (closed || ending) return;
    ending = true;
    setBusy(true);
    const durationMs = active && startedAt ? Date.now() - startedAt : 0;
    const endPayload = {
      durationMs,
      durationLabel: formatCallDuration(durationMs),
      cancelled: outgoing && !active,
      ambienceMode: 'off',
      transcriptText: transcriptText(),
      entries: snapshotEntries(),
      aiInitiated: endOptions.aiInitiated === true,
      endReason: String(endOptions.endReason || '').trim(),
      goodbyeText: String(endOptions.goodbyeText || '').trim(),
    };
    // 先关重型画面再保存记录。close 会通过 onClose 停止 AI/TTS/音频，
    // endPayload 已在关闭前快照，不影响通话记录完整性。
    close();
    try {
      await options.onEnd?.(endPayload);
    } catch (err) {
      console.warn('[voice-call] end failed', err);
    } finally {
      close();
    }
  }

  overlay.querySelector('.voice-call-action--answer')?.addEventListener('click', (e) => {
    void startCall(captureMediaGesture(e), [captureMediaGesture(e), captureMediaGesture(e)]);
  });
  overlay.querySelector('.voice-call-action--decline')?.addEventListener('click', () => { void declineCall(); });
  overlay.querySelector('.voice-call-action--end')?.addEventListener('click', endCall);
  overlay.querySelector('.voice-call-mini')?.addEventListener('click', () => {
    setWindowMode(overlay.classList.contains('is-mini') ? 'full' : 'mini');
  });
  compactBtn?.addEventListener('click', () => {
    setWindowMode(overlay.classList.contains('is-compact') ? 'full' : 'compact');
  });
  closeBtn?.addEventListener('click', () => {
    if (options.closeBehavior === 'minimize' && active && !ending) {
      if (overlay.classList.contains('is-mini') || overlay.classList.contains('is-compact')) {
        close();
        return;
      }
      setWindowMode('mini');
      return;
    }
    if (active && !ending) {
      void endCall();
      return;
    }
    close();
  });
  const stopFloatingDrag = (e = null) => {
    const drag = overlay.__voiceCallDrag;
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    overlay.__voiceCallDrag = null;
    overlay.classList.remove('is-dragging');
    window.removeEventListener('pointermove', moveFloatingCall);
    window.removeEventListener('pointerup', stopFloatingDrag);
    window.removeEventListener('pointercancel', stopFloatingDrag);
    try {
      if (overlay.hasPointerCapture?.(drag.pointerId)) overlay.releasePointerCapture(drag.pointerId);
    } catch (_) { /* 某些旧 WebView 不完整实现 pointer capture */ }
  };
  const moveFloatingCall = (e) => {
    const drag = overlay.__voiceCallDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
    const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight);
    const maxX = Math.max(8, viewportWidth - drag.width - 8);
    const maxY = Math.max(8, viewportHeight - drag.height - 8);
    const x = Math.max(8, Math.min(maxX, drag.originX + e.clientX - drag.startX));
    const y = Math.max(8, Math.min(maxY, drag.originY + e.clientY - drag.startY));
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (!overlay.classList.contains('is-mini') && !overlay.classList.contains('is-compact')) return;
    if (e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    if (e.target.closest('button, a, input, textarea, select, [contenteditable="true"], .voice-call-log, .voice-call-video-log')) return;
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    overlay.__voiceCallDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
    };
    overlay.classList.add('is-dragging');
    try { overlay.setPointerCapture?.(e.pointerId); } catch (_) { /* window 监听继续兜底 */ }
    window.addEventListener('pointermove', moveFloatingCall, { passive: false });
    window.addEventListener('pointerup', stopFloatingDrag);
    window.addEventListener('pointercancel', stopFloatingDrag);
  });
  overlay.addEventListener('click', (e) => {
    const openingRetry = e.target.closest?.('.voice-call-opening-retry');
    if (openingRetry) {
      e.preventDefault();
      e.stopPropagation();
      void retryOpening(captureMediaGesture(e));
      return;
    }
    const closeVideoLogBtn = e.target.closest?.('[data-close-video-log]');
    if (closeVideoLogBtn) {
      e.preventDefault();
      e.stopPropagation();
      setVideoLogOpen(false);
      return;
    }
    const rerollBtn = e.target.closest?.('[data-reroll-line], .voice-call-video-caption-reroll');
    if (rerollBtn) {
      e.preventDefault();
      e.stopPropagation();
      void rerollLastLine(captureMediaGesture(e));
      return;
    }
    const replayBtn = e.target.closest?.('[data-replay-line]');
    if (!replayBtn) {
      const captionBtn = e.target.closest?.('.voice-call-video-caption');
      if (captionBtn && videoCaptionPages.length > 1) {
        e.preventDefault();
        if (videoCaptionIndex >= videoCaptionPages.length - 1) return;
        videoCaptionIndex += 1;
        updateVideoCaption('', false);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    void replayLine(replayBtn.getAttribute('data-replay-line'), captureMediaGesture(e));
  });
  voiceLogToggle?.addEventListener('click', () => {
    const expanded = !screen?.classList.contains('is-log-expanded');
    screen?.classList.toggle('is-log-expanded', expanded);
    voiceLogToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const label = voiceLogToggle.querySelector('span');
    if (label) label.textContent = expanded ? '收起通话记录' : '展开通话记录';
    if (expanded && logEl) requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
  });
  // 移动端在收起输入框后的首个 click 偶尔会被 IME 吞掉；pointerup 先响应，
  // click 仍保留给键盘操作。状态只认 overlay class，避免 WebView 的 hidden
  // 属性与视觉状态短暂不同步后把按钮卡成“点不开”。
  let videoLogPointerToggleAt = 0;
  const toggleVideoLog = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setVideoLogOpen(!overlay.classList.contains('is-log-open'));
  };
  videoLogToggle?.addEventListener('pointerup', (e) => {
    if (e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    videoLogPointerToggleAt = Date.now();
    toggleVideoLog(e);
  });
  videoLogToggle?.addEventListener('click', (e) => {
    if (Date.now() - videoLogPointerToggleAt < 700) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    toggleVideoLog(e);
  });
  const submitInput = async (gestureToken = null) => {
    if (!active || closed || ending || busy) {
      gestureToken?.dispose?.();
      return;
    }
    const text = String(inputEl?.value || '').trim();
    if (!text) {
      gestureToken?.dispose?.();
      return;
    }
    inputEl.value = '';
    addLine({ from: 'user', text });
    if (videoMode) {
      setVideoInputOpen(false);
      showVideoThinkingCaption();
    }
    else updateVideoCaption(text);
    let reply = '';
    try {
      setBusy(true);
      setLoading(true, '对方正在回复');
      reply = await options.onSendText?.(text, { gestureToken });
    } finally {
      setLoading(false);
      if (!closed && !ending) setBusy(false);
    }
    if (closed || ending || !active) return;
    const replyText = normalizeVoiceCallText(reply);
    if (replyText.trim()) addLine({
      from: 'ai',
      text: replyText,
      audioDataUrls: Array.isArray(reply?.audioDataUrls) ? reply.audioDataUrls : [],
    });
  };
  sendBtn?.addEventListener('click', (e) => {
    void submitInput(captureMediaGesture(e));
  });
  const runTranscription = async () => {
    if (!active || closed || ending || transcribing || busy) return;
    if (nativeImeDictation) {
      if (videoMode) setVideoInputOpen(true);
      focusSystemDictationInput(inputEl);
      return;
    }
    try {
      transcribing = true;
      if (videoMode) setVideoInputOpen(true);
      [transcribeBtn, videoVoiceBtn].filter(Boolean).forEach((button) => {
        button.disabled = true;
        button.classList.add('is-listening');
        button.setAttribute('aria-label', '听写中');
      });
      const cfg = await loadVoiceInputConfig();
      const text = await transcribeOnce({
        config: cfg,
        maxMs: 15000,
        onPartial: (partial) => {
          if (partial && inputEl) inputEl.value = partial;
        },
      });
      const finalText = String(text || '').trim();
      if (finalText && inputEl) {
        inputEl.value = finalText;
        inputEl.focus();
        updateVideoCaption(finalText);
      } else {
        setStatusText('没有听到可用文字');
      }
    } catch (err) {
      setStatusText(formatVoiceInputError(err));
    } finally {
      transcribing = false;
      [transcribeBtn, videoVoiceBtn].filter(Boolean).forEach((button) => {
        button.disabled = loading;
        button.classList.remove('is-listening');
        button.setAttribute('aria-label', videoMode ? '语音转写' : '听写');
        button.innerHTML = videoMode ? `${icon('voice')}<span>语音转写</span>` : icon('voice');
      });
    }
  };
  transcribeBtn?.addEventListener('click', () => { void runTranscription(); });
  videoVoiceBtn?.addEventListener('click', () => { void runTranscription(); });
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submitInput(captureMediaGesture(e));
    }
  });
  setInputVisible();
  const initialEntries = Array.isArray(options.initialEntries)
    ? options.initialEntries.filter((entry) => entry
      && (normalizeVoiceCallText(entry.text) || normalizeVoiceCallText(entry.rawText)).trim())
    : [];
  if (initialEntries.length) {
    hydratingEntries = true;
    initialEntries.forEach((entry) => addLine(entry));
    hydratingEntries = false;
  }
  if (loading) setLoading(true, '接通中');
  if (active) {
    timer = setInterval(syncTimer, 500);
    syncTimer();
  }
  const controller = {
    overlay,
    close,
    addLine,
    markAudioReady,
    setLoading,
    setStatusText,
    setOpeningError,
    adoptMediaGesture: (gestureToken = null) => {
      if (typeof options.onMediaGesture === 'function') {
        options.onMediaGesture(gestureToken);
        return true;
      }
      gestureToken?.dispose?.();
      return false;
    },
    acceptCall: startCall,
    declineCall,
    endCall,
    getSnapshot: () => ({
      transcriptText: transcriptText(),
      entries: snapshotEntries(),
    }),
    expand: () => setWindowMode('full'),
    minimize: () => setWindowMode('mini'),
  };
  overlay.__marshmallowVoiceCallController = controller;
  return controller;
}

export function openVoiceCallRecordModal(record = {}) {
  const container = document.getElementById('modal-container');
  if (!container) return null;
  const title = String(record.counterpartName || record.title || record.name || '语音通话').trim();
  const note = String(record.note || '').trim();
  const duration = String(record.duration || '').trim();
  const state = String(record.callState || record.state || '').trim();
  // 打开旧记录时也即时清洗，已落库的 Fish 表演标签不会继续暴露在转写里。
  const transcript = stripVoicePerformanceTags(normalizeVoiceCallText(record.transcript).trim());
  const callMode = String(record.callMode || '').trim() === 'video' ? 'video' : 'voice';
  const callId = String(record.messageId || record.callId || '').trim();
  const entries = Array.isArray(record.entries)
    ? record.entries.filter((entry) => entry
      && stripVoicePerformanceTags(normalizeVoiceCallText(entry.text)).trim())
    : [];
  const exportAudioIds = collectVoiceCallExportAudioIds(entries);
  const hasSavedAudio = !!callId && exportAudioIds.length > 0;
  const formatRecordEntryTime = (value) => {
    const date = new Date(Number(value || Date.now()) || Date.now());
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };
  const timeText = record.endedAt || record.startedAt
    ? new Date(Number(record.endedAt || record.startedAt)).toLocaleString('zh-CN')
    : '';
  container.classList.add('active');
  const overlay = document.createElement('div');
  overlay.className = 'voice-call-overlay';
  const entriesHtml = entries.map((entry, entryIndex) => {
    const fromUser = entry.from === 'user';
    const at = formatRecordEntryTime(entry.at || record.startedAt || Date.now());
    const audioIds = (Array.isArray(entry.audioIds) ? entry.audioIds : [entry.audioId])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    return `
      <div class="voice-call-record-line ${fromUser ? 'is-user' : 'is-ai'}">
        <div class="voice-call-record-line-meta">
          <span>${esc(at)}</span><b>${fromUser ? '我' : esc(title)}</b>
          ${!fromUser && audioIds.length ? `<button type="button" class="voice-call-record-replay" data-record-line="${entryIndex}" aria-label="播放这句">${icon('play')}<span>重听</span></button>` : ''}
        </div>
        <div class="voice-call-record-line-text">${renderNarrationTextWithTranslations(stripVoicePerformanceTags(entry.text))}</div>
      </div>
    `;
  }).join('');
  overlay.innerHTML = `
    <div class="voice-call-screen is-active voice-call-record-screen">
      <div class="voice-call-statusbar">
        <span>${callMode === 'video' ? '视频通话' : '语音通话'}</span>
        <span>CALL ARCHIVE</span>
      </div>
      <div class="voice-call-record-card">
        <div class="voice-call-record-head">
          <div class="voice-call-record-icon">${icon(callMode === 'video' ? 'videoCall' : 'voiceCall')}</div>
          <div><h2>${esc(title)}</h2><p>${esc([timeText, duration, state].filter(Boolean).join(' · ') || '本地通话记录')}</p></div>
        </div>
        ${note ? `<div class="voice-call-record-note">${esc(note)}</div>` : ''}
        <div class="voice-call-record-transcript${entriesHtml || transcript ? '' : ' is-empty'}">
          ${entriesHtml || (transcript ? renderNarrationTextWithTranslations(transcript) : '暂无通话转写')}
        </div>
        <div class="voice-call-record-actions">
          ${hasSavedAudio ? `<button type="button" class="voice-call-record-export-audio">${icon('download')}<span>导出音频</span></button>` : ''}
          ${hasSavedAudio ? '<button type="button" class="voice-call-record-clear-audio">清除本次音频</button>' : ''}
          <button type="button" class="voice-call-record-close">完成</button>
        </div>
      </div>
    </div>
  `;
  container.appendChild(overlay);
  bindNarrationTranslationToggle(overlay);
  let activeAudio = null;
  let activePlayback = null;
  let activeButton = null;
  let playbackRun = 0;
  const resetPlayback = () => {
    playbackRun += 1;
    try { activeAudio?.pause?.(); } catch (_) {}
    activePlayback?.revoke?.();
    activeAudio = null;
    activePlayback = null;
    if (activeButton) {
      activeButton.classList.remove('is-playing', 'is-loading');
      activeButton.innerHTML = `${icon('play')}<span>重听</span>`;
    }
    activeButton = null;
  };
  const close = () => {
    resetPlayback();
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity .18s ease';
    setTimeout(() => {
      overlay.remove();
      if (!container.querySelector('.modal-overlay, .voice-call-overlay')) container.classList.remove('active');
    }, 180);
  };
  overlay.querySelector('.voice-call-record-close')?.addEventListener('click', close);
  overlay.querySelector('.voice-call-record-export-audio')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add('is-loading');
    const label = button.querySelector('span');
    if (label) label.textContent = '正在导出…';
    try {
      const payloads = [];
      for (const audioId of exportAudioIds) {
        const payload = await getCallLineVoice(callId, audioId).catch(() => null);
        if (!payload) throw new Error('本次通话有音频缓存已被清理');
        payloads.push({ payload, gapBeforeMs: payloads.length ? 260 : 0 });
      }
      const date = new Date(Number(record.startedAt || record.endedAt || Date.now()) || Date.now());
      const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
      const result = await exportCachedVoiceSequence(payloads, {
        filenameBase: `${title}-${callMode === 'video' ? '视频通话' : '语音通话'}-${stamp}`,
      });
      showToast(result.message || '通话音频已导出', 5200);
    } catch (error) {
      showToast(`音频导出失败：${error?.message || error}`, 5200);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove('is-loading');
        if (label) label.textContent = '导出音频';
      }
    }
  });
  overlay.querySelector('.voice-call-record-clear-audio')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    resetPlayback();
    button.disabled = true;
    await removeCallLineVoices(callId).catch(() => {});
    overlay.querySelectorAll('[data-record-line]').forEach((node) => node.remove());
    overlay.querySelector('.voice-call-record-export-audio')?.remove();
    button.remove();
  });
  overlay.querySelectorAll('[data-record-line]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const entryIndex = Number(button.getAttribute('data-record-line'));
      const entry = entries[entryIndex];
      const audioIds = (Array.isArray(entry?.audioIds) ? entry.audioIds : [entry?.audioId])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      if (!audioIds.length) return;
      if (button === activeButton) {
        resetPlayback();
        return;
      }
      resetPlayback();
      const run = playbackRun;
      const playSlot = { gesture: captureMediaGesture(event), audio: null };
      activeButton = button;
      button.classList.add('is-loading');
      button.innerHTML = '<span class="voice-msg-loading-dot" aria-hidden="true"></span><span>载入中</span>';
      try {
        // 已有点击手势垫片时不能再开第二路预热音轨，否则 iOS 可能只留下无声会话。
        if (!playSlot.gesture) await primeVoicePlayback().catch(() => {});
        for (const audioId of audioIds) {
          if (run !== playbackRun) return;
          const payload = await getCallLineVoice(callId, audioId).catch(() => null);
          if (!payload || run !== playbackRun) continue;
          const playback = createVoicePlaybackUrl(payload);
          if (!playback.url) continue;
          activePlayback = playback;
          const audio = takePlayableAudio(playback.url, playSlot);
          if (!audio) continue;
          audio.setAttribute('playsinline', 'true');
          activeAudio = audio;
          const started = await playAudioWhenReady(audio).then(() => true).catch(() => false);
          if (started) {
            button.classList.remove('is-loading');
            button.classList.add('is-playing');
            button.innerHTML = `${icon('pause')}<span>暂停</span>`;
            const completed = new Promise((resolve) => {
              let cancelTimer = null;
              const finish = () => {
                if (cancelTimer) clearInterval(cancelTimer);
                resolve();
              };
              audio.addEventListener('ended', finish, { once: true });
              audio.addEventListener('error', finish, { once: true });
              cancelTimer = setInterval(() => {
                if (run !== playbackRun) finish();
              }, 100);
            });
            await completed;
          }
          playback.revoke?.();
          activePlayback = null;
          activeAudio = null;
        }
      } finally {
        playSlot.gesture?.dispose?.();
      }
      if (run === playbackRun) resetPlayback();
    });
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  return { overlay, close };
}
