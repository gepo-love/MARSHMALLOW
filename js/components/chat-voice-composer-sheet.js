import { icon } from './svg-icons.js';
import { resolveVoiceEventDuration } from '../core/chat/card-render.js';
import { showToast } from './toast.js';
import {
  focusSystemDictationInput,
  formatVoiceInputError,
  loadVoiceInputConfig,
  startVoiceInputSession,
} from '../core/companion/voice-input.js';
import { isNativeShell } from '../core/native-update-bridge.js';

const MODE_KEY = 'marshmallow:chat-voice-composer-mode';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function loadChatVoiceComposerMode() {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return ['text', 'voice', 'ime'].includes(mode) ? mode : '';
  } catch (_) {
    return '';
  }
}

export function saveChatVoiceComposerMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, ['voice', 'ime'].includes(mode) ? mode : 'text');
  } catch (_) {}
}

/**
 * 聊天页统一语音入口：仿真实语音输入的小弹窗。
 * - 文字模式：输入框发语音条（时长随字数）
 * - 语音模式：按住说话，松开发语音条
 * - 设置里切换模式，下次打开默认沿用上次的选项
 */
export function openChatVoiceComposerSheet({
  variant = '',
  onSendVoice,
  ensureVoiceNotice,
  onClosed,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;

  const nativeImeDictation = isNativeShell();
  const savedMode = loadChatVoiceComposerMode();
  let mode = nativeImeDictation
    ? (savedMode === 'text' ? 'text' : 'ime')
    : (savedMode === 'voice' ? 'voice' : 'text');
  let settingsOpen = false;
  let isTranscribing = false;
  let voiceStatus = '';
  let voiceSession = null;
  let voicePointerId = null;
  let voiceStopRequested = false;
  let voiceStartedAt = 0;
  let voiceStopTimer = null;
  let voiceTextDraft = '';
  let closed = false;

  const isAnon = variant === 'anon';
  const sheetClass = isAnon
    ? 'modal-sheet anon-modal-sheet chat-voice-sheet chat-voice-sheet--anon'
    : 'modal-sheet scrapbook-card chat-voice-sheet';

  host.classList.add('active');

  function cleanupListeners() {
    host.removeEventListener('pointerup', onPointerEnd);
    host.removeEventListener('pointercancel', onPointerEnd);
  }

  function closeSheet() {
    if (closed) return;
    closed = true;
    cleanupListeners();
    if (voiceStopTimer) clearTimeout(voiceStopTimer);
    voiceStopTimer = null;
    try { voiceSession?.abort?.(); } catch (_) {}
    voiceSession = null;
    host.classList.remove('active');
    host.innerHTML = '';
    try { onClosed?.(); } catch (_) {}
  }

  function modeLabel() {
    if (mode === 'voice') return '语音输入';
    if (mode === 'ime') return '输入法听写';
    return '文字发语音条';
  }

  function renderBody() {
    if (mode === 'voice') {
      return `
        <div class="chat-voice-sheet-voice">
          <button type="button" class="chat-voice-sheet-hold${isTranscribing ? ' is-recording' : ''}" data-voice-sheet-hold aria-label="按住说话">
            ${esc(isTranscribing ? (voiceStatus || '松开发送') : '按住说话')}
          </button>
          <p class="chat-voice-sheet-hint">${isTranscribing ? esc(voiceStatus || '松开后发送语音条') : '按住说话，松开后按转写内容发送语音条'}</p>
        </div>
      `;
    }
    return `
      <div class="chat-voice-sheet-text">
        <textarea class="form-input chat-voice-sheet-input" rows="4" placeholder="${mode === 'ime' ? '点这里，再点键盘上的麦克风听写' : '输入要发出去的语音内容'}"></textarea>
        ${mode === 'ime' ? '<p class="chat-voice-sheet-hint">语音由输入法转成文字，说完可修改后发送</p>' : ''}
        <button type="button" class="btn btn-primary chat-voice-sheet-send">发送语音条</button>
      </div>
    `;
  }

  function renderSettings() {
    return `
      <div class="chat-voice-sheet-settings${settingsOpen ? ' is-open' : ''}" data-voice-sheet-settings-panel ${settingsOpen ? '' : 'hidden'}>
        <div class="chat-voice-sheet-settings-title">输入方式</div>
        <div class="chat-voice-sheet-settings-options">
          <button type="button" class="chat-voice-sheet-mode-btn${mode === 'text' ? ' is-active' : ''}" data-voice-sheet-mode="text">文字发语音条</button>
          ${nativeImeDictation
    ? `<button type="button" class="chat-voice-sheet-mode-btn${mode === 'ime' ? ' is-active' : ''}" data-voice-sheet-mode="ime">输入法听写</button>`
    : `<button type="button" class="chat-voice-sheet-mode-btn${mode === 'voice' ? ' is-active' : ''}" data-voice-sheet-mode="voice">语音输入</button>`}
        </div>
        <p class="text-hint chat-voice-sheet-settings-note">下次点语音按钮会默认进入这里选中的方式</p>
        ${nativeImeDictation ? '<p class="chat-voice-sheet-apk-note">APK 不读取麦克风；听写能力由当前输入法提供</p>' : ''}
      </div>
    `;
  }

  function paint() {
    const sheet = host.querySelector('.chat-voice-sheet');
    if (!sheet) return;
    sheet.innerHTML = `
      <header class="chat-voice-sheet-head">
        <span class="chat-voice-sheet-title">${esc(modeLabel())}</span>
        <div class="chat-voice-sheet-head-actions">
          <button type="button" class="navbar-btn chat-voice-sheet-settings-btn${settingsOpen ? ' is-active' : ''}" data-voice-sheet-settings-toggle aria-label="设置">${icon('settings')}</button>
          <button type="button" class="navbar-btn modal-close-btn" data-voice-sheet-close aria-label="关闭">${icon('close')}</button>
        </div>
      </header>
      ${renderSettings()}
      <div class="chat-voice-sheet-body">${renderBody()}</div>
    `;
    bindSheet();
  }

  async function submitVoiceText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      showToast('请输入语音内容');
      return;
    }
    const duration = resolveVoiceEventDuration({}, trimmed);
    closeSheet();
    await onSendVoice?.({ text: trimmed, duration });
  }

  function resetCapture() {
    if (voiceStopTimer) clearTimeout(voiceStopTimer);
    voiceStopTimer = null;
    isTranscribing = false;
    voiceSession = null;
    voicePointerId = null;
    voiceStopRequested = false;
    voiceStartedAt = 0;
    voiceStatus = '';
    voiceTextDraft = '';
  }

  function updateHoldUi(status = voiceStatus) {
    voiceStatus = status;
    const hold = host.querySelector('[data-voice-sheet-hold]');
    if (hold) {
      hold.classList.toggle('is-recording', isTranscribing);
      hold.textContent = isTranscribing ? (voiceStatus || '松开发送') : '按住说话';
    }
    const hint = host.querySelector('.chat-voice-sheet-hint');
    if (hint) {
      hint.textContent = isTranscribing
        ? (voiceStatus || '松开后发送语音条')
        : '按住说话，松开后按转写内容发送语音条';
    }
  }

  function stopSessionWhenReady(session = voiceSession) {
    if (!session) return;
    if (voiceStopTimer) clearTimeout(voiceStopTimer);
    const elapsed = Date.now() - voiceStartedAt;
    const delay = Math.max(0, 700 - elapsed);
    if (delay > 0) {
      voiceStopTimer = setTimeout(() => {
        voiceStopTimer = null;
        if (!voiceStopRequested || voiceSession !== session) return;
        try { session.stop?.(); } catch (_) {}
      }, delay);
      return;
    }
    try { session.stop?.(); } catch (_) {}
  }

  function stopCapture() {
    if (!isTranscribing) return;
    voiceStopRequested = true;
    const elapsed = Date.now() - voiceStartedAt;
    updateHoldUi(elapsed < 300 ? '正在听…' : '正在转文字…');
    stopSessionWhenReady();
  }

  async function startCapture(e) {
    if (mode !== 'voice' || isTranscribing || closed) return;
    const hold = e.target.closest('[data-voice-sheet-hold]');
    if (!hold || !host.contains(hold)) return;
    if (typeof ensureVoiceNotice === 'function') {
      const ok = await ensureVoiceNotice();
      if (!ok) return;
    }
    e.preventDefault();
    voicePointerId = e.pointerId;
    voiceStopRequested = false;
    voiceStartedAt = Date.now();
    voiceTextDraft = '';
    isTranscribing = true;
    updateHoldUi('正在听…');
    try { hold.setPointerCapture?.(e.pointerId); } catch (_) {}
    try {
      const cfg = await loadVoiceInputConfig();
      const session = await startVoiceInputSession({
        config: cfg,
        maxMs: 30_000,
        preferCustom: true,
        onPartial: (partial) => {
          voiceTextDraft = String(partial || '').trim();
          updateHoldUi(voiceTextDraft || '正在听…');
        },
        onState: (state) => {
          updateHoldUi(state === 'transcribing' ? '正在转文字…' : '正在听…');
        },
      });
      voiceSession = session;
      if (voiceStopRequested) {
        updateHoldUi('正在转文字…');
        stopSessionWhenReady(session);
      }
      session.promise
        .then(async (text) => {
          const finalText = String(text || voiceTextDraft || '').trim();
          resetCapture();
          if (!finalText) {
            showToast('没有听到可用文字');
            paint();
            return;
          }
          await submitVoiceText(finalText);
        })
        .catch((err) => {
          const aborted = /aborted/i.test(String(err?.message || err || ''));
          resetCapture();
          paint();
          if (!aborted) showToast(formatVoiceInputError(err), 4500);
        });
    } catch (err) {
      resetCapture();
      paint();
      showToast(formatVoiceInputError(err), 4500);
    }
  }

  function bindSheet() {
    host.querySelector('[data-voice-sheet-close]')?.addEventListener('click', closeSheet);
    host.querySelector('[data-voice-sheet-settings-toggle]')?.addEventListener('click', () => {
      settingsOpen = !settingsOpen;
      paint();
    });
    host.querySelectorAll('[data-voice-sheet-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = String(btn.getAttribute('data-voice-sheet-mode') || 'text');
        if (!['text', 'voice', 'ime'].includes(next)) return;
        if (isTranscribing) stopCapture();
        mode = next;
        saveChatVoiceComposerMode(mode);
        settingsOpen = false;
        paint();
        if (mode === 'text' || mode === 'ime') {
          const input = host.querySelector('.chat-voice-sheet-input');
          if (mode === 'ime') focusSystemDictationInput(input);
          else input?.focus();
        }
      });
    });
    host.querySelector('.chat-voice-sheet-send')?.addEventListener('click', async () => {
      const text = host.querySelector('.chat-voice-sheet-input')?.value || '';
      await submitVoiceText(text);
    });
    const hold = host.querySelector('[data-voice-sheet-hold]');
    if (hold) {
      hold.addEventListener('pointerdown', (e) => {
        startCapture(e).catch((err) => showToast(err?.message || '语音输入失败'));
      });
    }
  }

  host.innerHTML = `
    <div class="modal-overlay chat-voice-sheet-overlay" data-voice-sheet-overlay>
      <div class="${sheetClass}" role="dialog" aria-modal="true" aria-label="发语音"></div>
    </div>
  `;
  host.querySelector('.chat-voice-sheet-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSheet();
  });
  host.querySelector('.chat-voice-sheet')?.addEventListener('click', (e) => e.stopPropagation());

  host.addEventListener('pointerup', onPointerEnd);
  host.addEventListener('pointercancel', onPointerEnd);

  function onPointerEnd(e) {
    if (voicePointerId !== e.pointerId) return;
    e.preventDefault();
    stopCapture();
  }

  paint();
  if (mode === 'text' || mode === 'ime') {
    requestAnimationFrame(() => {
      const input = host.querySelector('.chat-voice-sheet-input');
      if (mode === 'ime') focusSystemDictationInput(input);
      else input?.focus();
    });
  }
}
