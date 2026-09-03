import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import { getCharacter } from '../core/character-store.js';
import {
  deleteStreamerChannel,
  getStreamerChannel,
  saveStreamerChannel,
  listStreamerRecordings,
} from '../core/streamer-store.js';
import { ensureStreamerPrivateChat, ensureStreamerFanGroup, findStreamerFanGroup } from '../core/streamer-chat.js';
import { getStreamerPopularityTierById } from '../data/streamer-presets.js';
import { captureMediaGesture, takePlayableAudio, playAudioWhenReady } from '../core/media-playback.js';
import {
  buildVoiceSpeechProfileOverride,
  synthesizeVoice,
  createVoicePlaybackUrl,
  isCharacterVoiceTtsEnabled,
  loadVoiceToolConfig,
  isVoiceToolEnabled,
  resolveVoiceToolConfigForProfile,
} from '../core/voice-tools.js';
import { bindNarrationTranslationToggle, stripTranslationMarks } from '../core/narration-translation.js';
import { messageLikelyNeedsTranslation, sanitizeAiTranslation } from '../core/translation-utils.js';

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

function coverStyle(cover = '') {
  const src = String(cover || '').trim();
  if (/^(data:image\/|https?:\/\/|blob:)/i.test(src)) {
    return `style="background-image:url(${escAttr(src)});background-size:cover;background-position:center"`;
  }
  return '';
}

function stripStageDirections(text = '') {
  return String(text || '')
    .replace(/[（(]([^（）()]{1,40})[）)]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function streamerTranslationSuffixHtml(source = '', translation = '') {
  const src = String(source || '').trim();
  if (!src) return '';
  const sanitized = sanitizeAiTranslation(src, translation);
  if (!sanitized && !messageLikelyNeedsTranslation(src)) return '';
  const show = sanitized || '';
  return `<button type="button" class="chat-bubble-translate-btn streamer-translate-btn" data-translation-toggle data-translation-source="${escAttr(src)}" aria-expanded="false">翻译</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(show)}</div></div>`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatRange(startedAt, endedAt) {
  const start = new Date(Number(startedAt) || Date.now());
  const end = new Date(Number(endedAt) || Date.now());
  const sameDay = start.toDateString() === end.toDateString();
  const endStr = sameDay ? `${pad2(end.getHours())}:${pad2(end.getMinutes())}` : formatTime(endedAt);
  return `${formatTime(startedAt)} ~ ${endStr}`;
}

function renderRecordingCard(recording) {
  return `
    <button type="button" class="streamer-recording-card" data-recording-id="${escAttr(recording.id)}">
      <div class="streamer-recording-cover" ${coverStyle(recording.coverImage)}></div>
      <div class="streamer-recording-body">
        <strong>${esc(formatRange(recording.startedAt, recording.endedAt))}</strong>
        <small>${esc(recording.categoryLabel || '直播回放')} · ${recording.streamerLines.length} 条台词</small>
      </div>
      ${icon('chevron')}
    </button>
  `;
}

function buildRecordingRows(recording) {
  const rows = [
    ...(recording.streamerLines || []).map((l) => ({ kind: 'line', id: l.id, text: l.text, translation: l.translation || '', ts: l.ts })),
    ...(recording.recentDanmaku || []).map((d) => ({
      kind: 'danmaku',
      id: d.id,
      text: d.text,
      from: d.from,
      fromUser: d.fromUser,
      translation: d.translation || '',
      ts: d.ts,
    })),
  ];
  return rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function renderRecordingDetail(recording, voiceReady) {
  const rows = buildRecordingRows(recording);
  const body = rows.length
    ? rows.map((row) => {
      if (row.kind === 'line') {
        return `
          <div class="streamer-history-row is-line">
            <div class="streamer-history-row-text">${esc(row.text)}${streamerTranslationSuffixHtml(row.text, row.translation)}</div>
            ${voiceReady ? `<button type="button" class="streamer-history-replay" data-replay-id="${escAttr(row.id)}" aria-label="重听">${icon('voiceCall')}</button>` : ''}
          </div>
        `;
      }
      const danmakuZh = row.fromUser ? '' : streamerTranslationSuffixHtml(row.text, row.translation);
      return `<div class="streamer-history-row is-danmaku ${row.fromUser ? 'is-user' : ''}"><b>${esc(row.fromUser ? '我' : row.from)}</b><span>${esc(row.text)}${danmakuZh}</span></div>`;
    }).join('')
    : '<div class="streamer-history-empty">这场没有留下记录</div>';
  return `
    <div class="streamer-space-detail">
      <button type="button" class="streamer-space-detail-back" data-detail-back>${icon('back')}<span>返回列表</span></button>
      <div class="streamer-space-detail-meta">
        <strong>${esc(recording.handle)}</strong>
        <small>${esc(formatRange(recording.startedAt, recording.endedAt))}</small>
      </div>
      <div class="streamer-space-detail-body">${body}</div>
    </div>
  `;
}

export default async function render(container, params = {}) {
  const channelId = String(params.channelId || '').trim();
  const channel = channelId ? await getStreamerChannel(channelId) : null;

  container.className = 'page anon-page anon-streamer-space-page';

  if (!channel) {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">主播空间</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <div class="anon-empty">这个主播空间已经不在了</div>
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    return;
  }

  const tier = getStreamerPopularityTierById(channel.persona?.popularityTier);
  const recordings = await listStreamerRecordings(channel.id).catch(() => []);
  const ended = channel.status === 'ended';

  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">主播空间</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll streamer-space-scroll" id="streamer-space-main"></main>
  `;
  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  const mainEl = container.querySelector('#streamer-space-main');
  let listScrollTop = 0;
  let currentAudio = null;
  function stopAudio() {
    try { currentAudio?.pause(); } catch (_) { /* noop */ }
    currentAudio = null;
  }

  function buildMainHtml() {
    const avatarSrc = String(channel.persona?.avatar || channel.persona?.avatarCover || '').trim();
    return `
      <section class="streamer-space-profile" ${coverStyle(channel.currentSceneImage || channel.persona?.avatarCover)}>
        <div class="streamer-space-profile-scrim"></div>
        <div class="streamer-space-profile-body">
          <button type="button" class="streamer-space-avatar" data-avatar-upload aria-label="换头像">
            ${/^(data:image\/|https?:\/\/|blob:)/i.test(avatarSrc) ? `<img src="${escAttr(avatarSrc)}" alt="" />` : '<span>🎙️</span>'}
            <span class="streamer-space-avatar-edit">${icon('edit')}</span>
          </button>
          <span class="streamer-space-status-badge ${ended ? 'is-ended' : ''}">${ended ? '已下播' : 'LIVE'}</span>
          <div class="streamer-space-name-row">
            <strong>${esc(channel.persona?.handle || '匿名主播')}</strong>
            <button type="button" class="streamer-space-edit-persona" data-edit-persona aria-label="编辑设定">${icon('edit')}</button>
          </div>
          <small>${esc(channel.persona?.categoryLabel || '')} · ${esc(tier.label)}</small>
          ${channel.persona?.signature ? `<p>${esc(channel.persona.signature)}</p>` : ''}
        </div>
      </section>
      <input type="file" class="streamer-space-avatar-file" accept="image/*" hidden />
      <button type="button" class="btn btn-primary btn-block" data-go-room>${ended ? '重新开播' : '进直播间'}</button>
      <div class="streamer-space-actions">
        <button type="button" class="streamer-space-action-btn" data-private-chat>${icon('message')}<span>私聊</span></button>
        <button type="button" class="streamer-space-action-btn" data-fan-group>${icon('sparkle')}<span>粉丝群</span></button>
      </div>
      <section class="streamer-space-recordings">
        <h2>直播回放</h2>
        <div id="streamer-recording-list">${recordings.length ? recordings.map(renderRecordingCard).join('') : '<div class="anon-empty">还没有录屏，下播后会出现在这里</div>'}</div>
      </section>
      <button type="button" class="btn btn-outline btn-block is-danger" data-delete-channel>删除主播空间</button>
    `;
  }

  async function resolveVoiceReady(recording) {
    if (!recording.voiceEnabled) return false;
    const globalVoiceCfg = await loadVoiceToolConfig().catch(() => null);
    if (recording.sourceType === 'character') {
      const char = await getCharacter(recording.characterId).catch(() => null);
      const voiceCfg = globalVoiceCfg
        ? resolveVoiceToolConfigForProfile(globalVoiceCfg, char?.voiceProfile || {})
        : null;
      return isVoiceToolEnabled(voiceCfg || {})
        && isCharacterVoiceTtsEnabled(char?.voiceProfile || {}, voiceCfg?.provider);
    }
    return isVoiceToolEnabled(globalVoiceCfg || {}) && !!recording.voiceId;
  }

  async function playRecordingLine(recording, line = {}, gestureToken = null) {
    const text = String(line?.text || '');
    const speechPlan = line?.speechPlan && typeof line.speechPlan === 'object'
      ? line.speechPlan
      : null;
    const speakText = speechPlan?.text || stripStageDirections(stripTranslationMarks(text));
    if (!speakText) {
      gestureToken?.dispose?.();
      return;
    }
    const playSlot = { gesture: gestureToken, audio: null };
    try {
      const characterId = recording.sourceType === 'character' ? recording.characterId : '';
      const character = recording.sourceType === 'character'
        ? await getCharacter(recording.characterId).catch(() => null)
        : null;
      const globalVoiceCfg = await loadVoiceToolConfig().catch(() => null);
      const voiceCfg = globalVoiceCfg
        ? resolveVoiceToolConfigForProfile(globalVoiceCfg, character?.voiceProfile || {})
        : null;
      const baseVoiceProfile = recording.sourceType === 'character'
        ? (character?.voiceProfile || {})
        : { voiceId: recording.voiceId };
      const voiceProfileOverride = buildVoiceSpeechProfileOverride(
        baseVoiceProfile,
        speechPlan,
        voiceCfg || {},
      ) || baseVoiceProfile;
      const payload = await synthesizeVoice({
        text: speakText,
        characterId,
        voiceProfileOverride,
        config: voiceCfg,
      });
      const { url, revoke } = createVoicePlaybackUrl(payload);
      if (!url) return;
      stopAudio();
      const audio = takePlayableAudio(url, playSlot);
      if (!audio) {
        revoke();
        showToast('重听失败，再点一次试试');
        return;
      }
      audio.setAttribute('playsinline', 'true');
      currentAudio = audio;
      audio.addEventListener('ended', () => revoke(), { once: true });
      await playAudioWhenReady(audio).catch(() => {
        revoke();
        showToast('重听失败，再点一次试试');
      });
    } catch (_) {
      showToast('重听失败');
    } finally {
      playSlot.gesture?.dispose?.();
    }
  }

  function renderMainView() {
    if (!mainEl) return;
    // 仍在列表态时先记下滚动，避免头像上传等重绘弹回顶部
    if (mainEl.querySelector('[data-go-room], [data-avatar-upload]')) {
      listScrollTop = mainEl.scrollTop || 0;
    }
    mainEl.innerHTML = buildMainHtml();
    mainEl.scrollTop = listScrollTop;
    mainEl.querySelector('[data-go-room]')?.addEventListener('click', () => {
      navigate('anon/streamer/room', { channelId: channel.id }, true);
    });
    mainEl.querySelector('[data-edit-persona]')?.addEventListener('click', () => {
      navigate('anon/streamer/persona-edit', { channelId: channel.id });
    });
    mainEl.querySelector('[data-delete-channel]')?.addEventListener('click', async (e) => {
      if (!window.confirm(`删除主播空间「${channel.persona?.handle || '匿名主播'}」？直播回放、私聊、粉丝群和随机主播档案都会被清掉，此操作不可撤销。`)) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const result = await deleteStreamerChannel(channel.id);
        if (!result?.deleted) throw new Error('主播空间已不存在');
        showToast('已删除主播空间');
        navigate('anon/streamer', {}, true);
      } catch (err) {
        btn.disabled = false;
        showToast(err?.message || '删除失败');
      }
    });
    mainEl.querySelector('[data-avatar-upload]')?.addEventListener('click', () => {
      mainEl.querySelector('.streamer-space-avatar-file')?.click();
    });
    mainEl.querySelector('.streamer-space-avatar-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !/^image\//.test(file.type || '')) return;
      try {
        const result = await fileToCroppedOptimizedAvatarDataUrl(file);
        if (!result?.dataUrl) return;
        channel.persona = {
          ...channel.persona,
          avatar: result.dataUrl,
          imageLockEnabled: channel.sourceType === 'generated'
            ? true
            : channel.persona?.imageLockEnabled,
          imageLockSeed: channel.sourceType === 'generated'
            ? (Number(channel.persona?.imageLockSeed) || (1 + Math.floor(Math.random() * 4294967294)))
            : channel.persona?.imageLockSeed,
        };
        await saveStreamerChannel(channel);
        renderMainView();
        showToast('头像已更新');
      } catch (_) {
        showToast('头像保存失败');
      }
    });
    const privateChatBtn = mainEl.querySelector('[data-private-chat]');
    const fanGroupBtn = mainEl.querySelector('[data-fan-group]');
    privateChatBtn?.addEventListener('click', async () => {
      privateChatBtn.disabled = true;
      try {
        const chat = await ensureStreamerPrivateChat(channel.userId, channel);
        navigate('chat/thread', { chatId: chat.id, from: 'streamer', streamerChannelId: channel.id });
      } catch (err) {
        showToast(err?.message || '打开私聊失败');
      } finally {
        privateChatBtn.disabled = false;
      }
    });
    fanGroupBtn?.addEventListener('click', async () => {
      fanGroupBtn.disabled = true;
      try {
        const existing = await findStreamerFanGroup(channel.userId, channel.id);
        if (!existing) showToast('正在张罗粉丝群…');
        const chat = existing || await ensureStreamerFanGroup(channel.userId, channel);
        navigate('chat/thread', { chatId: chat.id, from: 'streamer', streamerChannelId: channel.id });
      } catch (err) {
        showToast(err?.message || '打开粉丝群失败');
      } finally {
        fanGroupBtn.disabled = false;
      }
    });
    mainEl.querySelectorAll('[data-recording-id]').forEach((card) => {
      card.addEventListener('click', () => openRecording(card.getAttribute('data-recording-id')));
    });
  }

  async function openRecording(id) {
    const recording = recordings.find((r) => r.id === id);
    if (!recording || !mainEl) return;
    listScrollTop = mainEl.scrollTop || 0;
    stopAudio();
    const voiceReady = await resolveVoiceReady(recording);
    mainEl.innerHTML = renderRecordingDetail(recording, voiceReady);
    bindNarrationTranslationToggle(mainEl, {
      onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
    });
    mainEl.querySelector('[data-detail-back]')?.addEventListener('click', () => {
      stopAudio();
      renderMainView();
    });
    mainEl.querySelector('.streamer-space-detail-body')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-translation-toggle]')) return;
      const btn = e.target.closest('[data-replay-id]');
      if (!btn) return;
      const line = (recording.streamerLines || []).find((l) => l.id === btn.getAttribute('data-replay-id'));
      if (line) playRecordingLine(recording, line, captureMediaGesture(e));
    });
  }

  renderMainView();
}
