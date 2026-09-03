import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getCharacter } from '../core/character-store.js';
import {
  getStreamerChannel,
  saveStreamerChannel,
  appendStreamerRoomBatch,
  appendStreamerUserMessage,
  deleteStreamerChannel,
  endStreamerSession,
  startStreamerSession,
  updateStreamerSceneImage,
  touchFanState,
} from '../core/streamer-store.js';
import { generateStreamerRoomBatchAI, generateStreamerOpeningTopicAI, generateStreamerSongPickAI } from '../core/streamer-ai.js';
import {
  getStreamerPopularityTierById,
  getStreamerImageSyncTierById,
  getStreamerIdleIntervalTierById,
  STREAMER_IMAGE_SYNC_TIERS,
  STREAMER_IDLE_INTERVAL_TIERS,
} from '../data/streamer-presets.js';
import {
  captureMediaGesture,
  takePlayableAudio,
  playAudioWhenReady,
  trackForegroundMediaAudio,
} from '../core/media-playback.js';
import {
  buildVoiceSpeechProfileOverride,
  synthesizeVoice,
  synthesizeStreamerLineVoice,
  createVoicePlaybackUrl,
  isCharacterVoiceTtsEnabled,
  loadVoiceToolConfig,
  isVoiceToolEnabled,
  resolveVoiceToolConfigForProfile,
} from '../core/voice-tools.js';
import { bindNarrationTranslationToggle, stripTranslationMarks } from '../core/narration-translation.js';
import { messageLikelyNeedsTranslation, sanitizeAiTranslation } from '../core/translation-utils.js';
import { generateImageForScene, persistGeneratedImageUrlLocally, loadImageToolConfig } from '../core/image-generation-tools.js';
import { applyImageLockByCharacterId, mergeImageLockIntoOptions } from '../core/character-image-lock.js';
import { resolveSocialImageGenMode } from '../core/social-image-generation.js';
import { listImageStylePresets } from '../core/image-style-presets.js';
import {
  loadMusicLibrary,
  createAudioUrlForTrack,
  saveMusicTrack,
  normalizeNeteaseSong,
  importNeteaseSongsToLibrary,
} from '../core/music-library.js';
import { loadNeteaseProviderConfig, searchNeteaseSongs, getNeteaseSongPlayUrl } from '../core/netease-provider.js';

const IMAGE_MODE_OPTIONS = [
  { id: '', label: '跟随全局' },
  { id: 'novelai', label: 'NovelAI' },
  { id: 'realistic', label: '兼容生图' },
  { id: 'smart', label: '智能路由' },
];

const IMAGE_STYLE_OPTIONS = [
  { id: '', label: '跟随全局' },
  ...listImageStylePresets().map((p) => ({ id: p.id, label: p.label })),
];

const IDLE_INTERVAL_MS = { small: 95000, mid: 65000, big: 42000 };

function resolveIdleIntervalMs(persona = {}, tier = {}) {
  const override = getStreamerIdleIntervalTierById(persona?.idleIntervalId);
  if (override) return override.ms;
  return IDLE_INTERVAL_MS[tier.id] || IDLE_INTERVAL_MS.mid;
}

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

function bgStyle(src = '') {
  const clean = String(src || '').trim();
  if (/^(data:image\/|https?:\/\/|blob:)/i.test(clean)) {
    return `background-image:url(${escAttr(clean)});background-size:cover;background-position:center`;
  }
  return '';
}

function stripStreamerStageDirections(text = '') {
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

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const channelId = String(params.channelId || '').trim();
  let channel = channelId ? await getStreamerChannel(channelId) : null;

  container.className = 'page anon-page anon-streamer-room-page';

  if (!channel) {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">直播间</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <div class="anon-empty">这个直播间已经不在了</div>
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    return;
  }

  await touchFanState(user.id, channel.id).catch(() => {});
  channel = await saveStreamerChannel({ ...channel, lastVisitAt: Date.now() }).catch(() => channel);

  const tier = getStreamerPopularityTierById(channel.persona?.popularityTier);

  const charVoiceRow = channel.sourceType === 'character'
    ? await getCharacter(channel.characterId).catch(() => null)
    : null;
  const canVoice = channel.sourceType === 'character'
    ? isCharacterVoiceTtsEnabled(charVoiceRow?.voiceProfile || {})
    : !!channel.persona?.voiceId;
  const globalVoiceCfg = await loadVoiceToolConfig().catch(() => null);
  const voiceCfg = channel.sourceType === 'character' && globalVoiceCfg
    ? resolveVoiceToolConfigForProfile(globalVoiceCfg, charVoiceRow?.voiceProfile || {})
    : globalVoiceCfg;
  const voiceReady = canVoice && isVoiceToolEnabled(voiceCfg || {});
  let voiceMuted = !(voiceReady && channel.persona?.voiceEnabled);

  container.innerHTML = `
    <header class="navbar streamer-room-navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <div class="streamer-room-navbar-actions">
        <button type="button" class="streamer-room-icon-btn streamer-history-btn" data-history-toggle aria-label="本场记录" aria-expanded="false">${icon('time')}</button>
        <button type="button" class="streamer-room-icon-btn" data-settings-toggle aria-label="直播设置" aria-expanded="false">${icon('settings')}</button>
        <button type="button" class="streamer-room-icon-btn streamer-voice-btn ${voiceReady ? '' : 'is-disabled'}" data-voice-toggle aria-label="语音开关">${icon('voice')}</button>
        <button type="button" class="streamer-room-icon-btn streamer-end-btn" data-end-toggle ${channel.status === 'ended' ? 'hidden' : ''}>下播</button>
      </div>
    </header>
    <main class="streamer-room-body">
      <div class="streamer-stage" id="streamer-stage" style="${bgStyle(channel.currentSceneImage || channel.persona?.avatarCover)}">
        <div class="streamer-stage-scrim"></div>
        <button type="button" class="streamer-stage-avatar-chip" data-open-space aria-label="进入主播空间">
          <span class="streamer-stage-avatar-thumb">${/^(data:image\/|https?:\/\/|blob:)/i.test(String(channel.persona?.avatar || channel.persona?.avatarCover || '')) ? `<img src="${escAttr(channel.persona?.avatar || channel.persona?.avatarCover)}" alt="" />` : '🎙️'}</span>
          <span class="streamer-stage-avatar-text">
            <span class="streamer-live-badge streamer-stage-live" ${channel.status === 'ended' ? 'hidden' : ''} aria-hidden="true"><i></i>LIVE</span>
            <span class="streamer-stage-offline-badge" ${channel.status === 'ended' ? '' : 'hidden'}>已下播</span>
            <strong>${esc(channel.persona?.handle || '匿名主播')}</strong>
            <small>${esc(channel.persona?.categoryLabel || '')} · ${esc(tier.label)}</small>
          </span>
        </button>
        <div class="streamer-danmaku-layer" id="streamer-danmaku-layer" aria-hidden="true"></div>
        <button type="button" class="streamer-stage-reroll-btn" id="streamer-scene-reroll" hidden aria-label="重新生成这张画面">${icon('reroll')}</button>
        <button type="button" class="streamer-stage-upload-btn" id="streamer-scene-upload" aria-label="上传背景画面">${icon('upload')}</button>
        <input type="file" class="streamer-scene-file" id="streamer-scene-file" accept="image/*" hidden />
        <div class="streamer-scene-loading" id="streamer-scene-loading" hidden>画面切换中…</div>
        <div class="streamer-stage-caption" id="streamer-stage-caption" hidden></div>
        <div class="streamer-history-panel" id="streamer-history-panel" hidden>
          <div class="streamer-history-panel-head">
            <span>本场记录</span>
            <button type="button" class="streamer-history-close" data-history-close aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="streamer-history-panel-body" id="streamer-history-body"></div>
        </div>
        <div class="streamer-history-panel" id="streamer-music-panel" hidden>
          <div class="streamer-history-panel-head">
            <span>点歌</span>
            <button type="button" class="streamer-history-close" data-music-panel-close aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="streamer-history-panel-body streamer-music-panel-body">
            <form class="streamer-music-search" id="streamer-music-search" hidden>
              <input type="search" class="form-input" placeholder="搜网易云歌名 / 歌手来点歌" maxlength="60" />
              <button type="submit" class="btn btn-sm">搜索</button>
            </form>
            <div id="streamer-music-search-results"></div>
            <div class="streamer-chip-row streamer-music-playlist-row" id="streamer-music-playlists" hidden></div>
            <div class="streamer-music-dj-row">
              <label class="streamer-settings-toggle-row">
                <input type="checkbox" id="streamer-music-chardj" ${channel.persona?.musicCharDJ ? 'checked' : ''} />
                <span>主播管歌：一首播完让主播自己挑下一首</span>
              </label>
              <button type="button" class="btn btn-sm btn-outline streamer-music-char-pick" data-music-char-pick>让主播换一首</button>
            </div>
            <div id="streamer-music-list"></div>
          </div>
        </div>
        <div class="streamer-history-panel" id="streamer-settings-panel" hidden>
          <div class="streamer-history-panel-head">
            <span>直播设置</span>
            <button type="button" class="streamer-history-close" data-settings-close aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="streamer-settings-body">
            <div class="streamer-settings-section">
              <div class="streamer-settings-label">直播背景</div>
              <div class="streamer-cover-actions">
                <button type="button" class="btn btn-sm btn-outline" data-upload-scene>上传背景</button>
                <button type="button" class="btn btn-sm btn-outline" data-gen-scene-cover>AI 生成封面</button>
              </div>
              <p class="streamer-settings-hint">没开生图时也可上传本地图片当封面/背景；有封面后仍可随时更换。</p>
            </div>
            <div class="streamer-settings-section">
              <div class="streamer-settings-label">换画面频率</div>
              <div class="streamer-chip-row" data-image-tier-row>
                ${STREAMER_IMAGE_SYNC_TIERS.map((t) => `<button type="button" class="streamer-settings-chip ${t.id === channel.persona?.imageSyncTier ? 'is-active' : ''}" data-image-tier="${t.id}">${esc(t.label)}</button>`).join('')}
              </div>
              <p class="streamer-settings-hint" data-image-tier-hint>${esc(getStreamerImageSyncTierById(channel.persona?.imageSyncTier).hint)}</p>
            </div>
            <div class="streamer-settings-section">
              <div class="streamer-settings-label">生图引擎（局内覆盖，不受外面生图开关限制）</div>
              <div class="streamer-chip-row" data-image-mode-row>
                ${IMAGE_MODE_OPTIONS.map((o) => `<button type="button" class="streamer-settings-chip ${o.id === (channel.persona?.imageGenMode || '') ? 'is-active' : ''}" data-image-mode="${o.id}">${esc(o.label)}</button>`).join('')}
              </div>
            </div>
            <div class="streamer-settings-section">
              <div class="streamer-settings-label">画面画风（本直播间专用）</div>
              <div class="streamer-chip-row" data-image-style-row>
                ${IMAGE_STYLE_OPTIONS.map((o) => `<button type="button" class="streamer-settings-chip ${o.id === (channel.persona?.imageStyleId || '') ? 'is-active' : ''}" data-image-style="${o.id}">${esc(o.label)}</button>`).join('')}
              </div>
            </div>
            <div class="streamer-settings-section">
              <label class="streamer-settings-toggle-row">
                <input type="checkbox" id="streamer-settings-idle" ${channel.persona?.idleAutoPlay ? 'checked' : ''} />
                <span>挂机模式：不用一直互动，主播会定时自己往下播（需要保持直播间开着）</span>
              </label>
              <div class="streamer-chip-row" data-idle-interval-row>
                ${STREAMER_IDLE_INTERVAL_TIERS.map((t) => `<button type="button" class="streamer-settings-chip ${t.id === (channel.persona?.idleIntervalId || '') ? 'is-active' : ''}" data-idle-interval="${t.id}">${esc(t.label)}</button>`).join('')}
              </div>
              <p class="streamer-settings-hint">不选就按人气档位给默认间隔（小主播 95 秒 / 中腰部 65 秒 / 大主播 42 秒）</p>
            </div>
          </div>
        </div>
        <div class="streamer-ended-overlay" id="streamer-ended-overlay" ${channel.status === 'ended' ? '' : 'hidden'}>
          <p>主播已经下播了，这场记录已经收进主播空间</p>
          <div class="streamer-restart-form">
            <button type="button" class="btn btn-primary" data-restart-auto>AI 帮忙定这场播什么</button>
            <div class="streamer-restart-custom">
              <input type="text" class="form-input" id="streamer-restart-input" placeholder="或者自己写这次想播的方向…" maxlength="60" />
              <button type="button" class="btn" data-restart-custom>开始这场直播</button>
            </div>
            <button type="button" class="btn btn-outline" data-open-space>进入主播空间</button>
          </div>
        </div>
      </div>
      <div class="streamer-music-bar" id="streamer-music-bar">
        <button type="button" class="streamer-music-track" data-music-pick aria-label="点歌">
          <span class="streamer-music-note" aria-hidden="true">♪</span>
          <span class="streamer-music-title" id="streamer-music-title">背景音乐 · 点歌</span>
        </button>
        <div class="streamer-music-controls">
          <button type="button" class="streamer-music-btn" data-music-prev aria-label="上一首">‹</button>
          <button type="button" class="streamer-music-btn is-main" data-music-toggle aria-label="播放">▶</button>
          <button type="button" class="streamer-music-btn" data-music-next aria-label="下一首">›</button>
        </div>
      </div>
      <div class="streamer-room-status" id="streamer-room-status" hidden></div>
      <form class="streamer-room-composer" id="streamer-room-composer" ${channel.status === 'ended' ? 'hidden' : ''}>
        <button type="button" class="streamer-gift-btn" data-gift aria-label="打赏">${icon('redpacket')}</button>
        <input type="text" class="form-input streamer-room-input" placeholder="发条弹幕…" maxlength="60" />
        <button type="submit" class="streamer-room-send" aria-label="发送">${icon('send')}</button>
      </form>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', async () => {
    if (channel.ephemeral) {
      await deleteStreamerChannel(channel.id).catch(() => {});
    }
    stopAmbientLoop();
    stopIdleLoop();
    stopVoicePlayback();
    stopRoomMusic();
    back();
  });

  const stageEl = container.querySelector('#streamer-stage');
  const danmakuLayerEl = container.querySelector('#streamer-danmaku-layer');
  const sceneLoadingEl = container.querySelector('#streamer-scene-loading');
  const sceneRerollBtn = container.querySelector('#streamer-scene-reroll');
  const sceneUploadBtn = container.querySelector('#streamer-scene-upload');
  const sceneFileInput = container.querySelector('#streamer-scene-file');
  const captionEl = container.querySelector('#streamer-stage-caption');
  const endedOverlayEl = container.querySelector('#streamer-ended-overlay');
  const statusEl = container.querySelector('#streamer-room-status');
  const composerEl = container.querySelector('#streamer-room-composer');
  const inputEl = container.querySelector('.streamer-room-input');
  const endBtn = container.querySelector('[data-end-toggle]');
  const voiceBtn = container.querySelector('[data-voice-toggle]');
  const historyBtn = container.querySelector('[data-history-toggle]');
  const historyPanelEl = container.querySelector('#streamer-history-panel');
  const historyBodyEl = container.querySelector('#streamer-history-body');
  const settingsBtn = container.querySelector('[data-settings-toggle]');
  const settingsPanelEl = container.querySelector('#streamer-settings-panel');
  const musicPanelEl = container.querySelector('#streamer-music-panel');
  const musicListEl = container.querySelector('#streamer-music-list');
  const musicTitleEl = container.querySelector('#streamer-music-title');
  const musicToggleBtn = container.querySelector('[data-music-toggle]');
  const restartAutoBtn = container.querySelector('[data-restart-auto]');
  const restartCustomBtn = container.querySelector('[data-restart-custom]');
  const restartInputEl = container.querySelector('#streamer-restart-input');

  const reduceMotion = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  let currentAudio = null;
  let replaying = false;
  function stopVoicePlayback() {
    try { currentAudio?.pause(); } catch (_) { /* noop */ }
    currentAudio = null;
  }

  function setReplayBusy(next) {
    replaying = !!next;
    historyBodyEl?.querySelectorAll('[data-replay-id]').forEach((btn) => {
      btn.disabled = replaying;
      btn.classList.toggle('is-playing', replaying);
    });
  }

  async function playStreamerLineVoice(text, {
    force = false,
    lineId = '',
    speechPlan = null,
    gestureToken = null,
  } = {}) {
    if (!voiceReady || (voiceMuted && !force)) {
      gestureToken?.dispose?.();
      return;
    }
    // 语气标签库开着时，把带括号的舞台指示原样交给语音合成去转换成 MiniMax 停顿/语气标签；
    // 没开就照旧整段删掉，避免把中文动作描述原样念出来
    const raw = stripTranslationMarks(String(text || '').trim());
    const visibleSpeech = stripStreamerStageDirections(raw);
    const speakText = speechPlan?.text || (voiceCfg?.styleBook?.enabled ? raw : visibleSpeech);
    if (!speakText) {
      gestureToken?.dispose?.();
      return;
    }
    const playSlot = { gesture: gestureToken, audio: null };
    try {
      if (force) setReplayBusy(true);
      const characterId = channel.sourceType === 'character' ? channel.characterId : '';
      const baseVoiceProfile = channel.sourceType === 'character'
        ? (charVoiceRow?.voiceProfile || {})
        : { voiceId: channel.persona?.voiceId };
      const voiceProfileOverride = buildVoiceSpeechProfileOverride(
        baseVoiceProfile,
        speechPlan,
        voiceCfg,
      ) || baseVoiceProfile;
      const payload = lineId
        ? await synthesizeStreamerLineVoice({ channelId: channel.id, lineId, text: speakText, characterId, voiceProfileOverride })
        : await synthesizeVoice({ text: speakText, characterId, voiceProfileOverride });
      const { url, revoke } = createVoicePlaybackUrl(payload);
      if (!url) {
        if (force) setReplayBusy(false);
        return;
      }
      stopVoicePlayback();
      const audio = takePlayableAudio(url, playSlot);
      if (!audio) {
        revoke();
        if (force) setReplayBusy(false);
        return;
      }
      audio.setAttribute('playsinline', 'true');
      currentAudio = audio;
      duckRoomMusic();
      audio.addEventListener('ended', () => { revoke(); restoreRoomMusic(); if (force) setReplayBusy(false); }, { once: true });
      await playAudioWhenReady(audio).catch(() => {
        revoke();
        restoreRoomMusic();
        if (force) {
          setReplayBusy(false);
          showToast('重听失败，再点一次试试');
        }
        /* 挂机/进房自动播被系统拦住时不刷 Toast，用户可点历史重听 */
      });
    } catch (_) {
      restoreRoomMusic();
      if (force) { setReplayBusy(false); showToast('重听失败'); }
      /* 非重听时静默失败，不打扰文字/弹幕体验 */
    } finally {
      playSlot.gesture?.dispose?.();
    }
  }

  // ---- 背景音乐（点歌/切歌）：房间本地播放器，复用音乐库数据，语音播报时自动压低音量。
  // 网易云歌不要求提前有 playUrl：播放时现向网易云取链；面板里还能直接搜网易云点歌、按歌单切队列、让主播自己挑歌。
  let musicLibraryTracks = [];
  let musicPlaylists = [];
  let musicTracks = [];
  let musicPlaylistId = '';
  let musicIndex = -1;
  let musicAudio = null;
  let musicVolumeBeforeDuck = null;
  let musicLoaded = false;
  let musicPlaySeq = 0;
  let neteaseCfg = null;
  let musicCharDJ = channel.persona?.musicCharDJ === true;
  let charPickBusy = false;
  let lastSearchSongs = [];
  const ROOM_MUSIC_VOLUME = 0.55;
  const musicSearchFormEl = container.querySelector('#streamer-music-search');
  const musicSearchInputEl = musicSearchFormEl?.querySelector('input');
  const musicSearchResultsEl = container.querySelector('#streamer-music-search-results');
  const musicPlaylistRowEl = container.querySelector('#streamer-music-playlists');
  const musicCharPickBtn = container.querySelector('[data-music-char-pick]');

  function isNeteaseTrack(track) {
    return track?.source === 'netease' || track?.provider === 'netease';
  }

  function neteaseOk() {
    return !!(neteaseCfg?.enabled && neteaseCfg.apiBaseUrl);
  }

  function canPlayTrack(track) {
    return !!createAudioUrlForTrack(track) || (isNeteaseTrack(track) && neteaseOk());
  }

  function duckRoomMusic() {
    if (!musicAudio) return;
    if (musicVolumeBeforeDuck === null) musicVolumeBeforeDuck = musicAudio.volume;
    musicAudio.volume = Math.min(musicAudio.volume, 0.16);
  }

  function restoreRoomMusic() {
    if (!musicAudio || musicVolumeBeforeDuck === null) return;
    musicAudio.volume = musicVolumeBeforeDuck;
    musicVolumeBeforeDuck = null;
  }

  function stopRoomMusic() {
    musicPlaySeq += 1; // 作废还在取音源链接的播放请求
    try { musicAudio?.pause(); } catch (_) { /* noop */ }
    musicAudio = null;
    musicVolumeBeforeDuck = null;
  }

  function updateMusicBar() {
    const track = musicTracks[musicIndex];
    if (musicTitleEl) musicTitleEl.textContent = track ? `${track.title} · ${track.artist}` : '背景音乐 · 点歌';
    if (musicToggleBtn) {
      const playing = !!(musicAudio && !musicAudio.paused);
      musicToggleBtn.textContent = playing ? 'Ⅱ' : '▶';
      musicToggleBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
    }
    musicListEl?.querySelectorAll('[data-music-track]').forEach((row) => {
      row.classList.toggle('is-active', track && row.getAttribute('data-music-track') === track.id);
    });
  }

  /** 按当前所选歌单套用播放队列，尽量保住正在播的那首的位置 */
  function applyMusicQueue() {
    const currentId = musicTracks[musicIndex]?.id || '';
    if (musicPlaylistId) {
      const pl = musicPlaylists.find((p) => p.id === musicPlaylistId);
      const ids = pl?.trackIds || [];
      musicTracks = ids.map((id) => musicLibraryTracks.find((t) => t.id === id)).filter(Boolean);
      if (!musicTracks.length) {
        musicPlaylistId = '';
        musicTracks = musicLibraryTracks.slice();
      }
    } else {
      musicTracks = musicLibraryTracks.slice();
    }
    musicIndex = currentId ? musicTracks.findIndex((t) => t.id === currentId) : -1;
  }

  async function ensureMusicTracksLoaded(force = false) {
    if (musicLoaded && !force) return;
    if (!neteaseCfg) neteaseCfg = await loadNeteaseProviderConfig().catch(() => null);
    const lib = await loadMusicLibrary().catch(() => ({ tracks: [], playlists: [] }));
    musicLibraryTracks = (lib.tracks || []).filter(canPlayTrack);
    const validIds = new Set(musicLibraryTracks.map((t) => t.id));
    musicPlaylists = (lib.playlists || []).filter((p) => (p.trackIds || []).some((id) => validIds.has(id)));
    musicLoaded = true;
    applyMusicQueue();
  }

  /** 拿到能塞给 Audio 的地址；网易云歌没有有效 playUrl 时现向网易云取一条并写回曲库 */
  async function resolveTrackUrl(track) {
    const direct = createAudioUrlForTrack(track);
    if (direct) return direct;
    if (!isNeteaseTrack(track) || !neteaseOk()) return '';
    const play = await getNeteaseSongPlayUrl(neteaseCfg, track);
    const playUrl = String(play?.playUrl || play?.url || play?.data?.playUrl || play?.data?.url || '').trim();
    if (!playUrl) {
      throw new Error(play?.message || play?.msg || '网易云没有返回可播放链接');
    }
    const row = await saveMusicTrack({
      ...track,
      playUrl,
      playUrlExpireAt: Number(play.playUrlExpireTime || play.expireTime || 0) || (Date.now() + 20 * 60 * 1000),
    });
    const patch = { playUrl: row.playUrl, playUrlExpireAt: row.playUrlExpireAt };
    Object.assign(track, patch);
    const inLib = musicLibraryTracks.find((t) => t.id === track.id);
    if (inLib) Object.assign(inLib, patch);
    return createAudioUrlForTrack(row);
  }

  async function playMusicAtIndex(idx, {
    announce = false,
    by = 'user',
    comment = '',
    gestureToken = null,
  } = {}) {
    const track = musicTracks[idx];
    if (!track) {
      gestureToken?.dispose?.();
      return;
    }
    const isNewTrack = idx !== musicIndex;
    const willAnnounce = announce && isNewTrack && channel.status !== 'ended';
    // 点歌后还要等 AI/TTS 播台词：手势垫片留给主播语音；纯切歌则留给音乐本身。
    const voiceGesture = willAnnounce ? gestureToken : null;
    const musicGesture = willAnnounce ? null : gestureToken;
    stopRoomMusic();
    const seq = ++musicPlaySeq;
    musicIndex = idx;
    updateMusicBar();
    let url = '';
    try {
      url = await resolveTrackUrl(track);
    } catch (err) {
      voiceGesture?.dispose?.();
      musicGesture?.dispose?.();
      showToast(err?.message || '取不到这首歌的音源');
      return;
    }
    if (seq !== musicPlaySeq) {
      voiceGesture?.dispose?.();
      musicGesture?.dispose?.();
      return;
    }
    if (!url) {
      voiceGesture?.dispose?.();
      musicGesture?.dispose?.();
      showToast('这首歌没有可播放的音源');
      return;
    }
    const playSlot = { gesture: musicGesture, audio: null };
    const audio = takePlayableAudio(url, playSlot) || new Audio(url);
    playSlot.gesture?.dispose?.();
    audio.setAttribute('playsinline', 'true');
    audio.volume = ROOM_MUSIC_VOLUME;
    trackForegroundMediaAudio(audio, { active: true });
    musicAudio = audio;
    audio.addEventListener('ended', () => handleMusicEnded());
    audio.play().then(updateMusicBar).catch(() => {
      showToast('浏览器拦截了自动播放，再点一次试试');
      updateMusicBar();
    });
    updateMusicBar();
    if (willAnnounce) {
      runBatch({
        songRequest: `${track.title} - ${track.artist}`,
        songBy: by,
        songComment: comment,
        gestureToken: voiceGesture,
      });
    }
  }

  function handleMusicEnded() {
    if (!musicTracks.length) return;
    if (musicCharDJ) {
      charPickNextSong({ auto: true });
    } else {
      playMusicAtIndex((musicIndex + 1) % musicTracks.length);
    }
  }

  /** 主播自己挑下一首：AI 按人设从当前队列里选，失败就顺延下一首 */
  async function charPickNextSong({ auto = false, gestureToken = null } = {}) {
    if (charPickBusy) {
      gestureToken?.dispose?.();
      return;
    }
    await ensureMusicTracksLoaded();
    if (!musicTracks.length) {
      gestureToken?.dispose?.();
      if (!auto) showToast('还没有可播放的歌，先去音乐页导入几首');
      return;
    }
    charPickBusy = true;
    if (musicCharPickBtn) musicCharPickBtn.disabled = true;
    try {
      const current = musicTracks[musicIndex];
      let picked = null;
      let comment = '';
      try {
        const result = await generateStreamerSongPickAI({
          channel,
          tracks: musicTracks,
          currentTrack: current ? `${current.title} - ${current.artist}` : '',
        });
        picked = result.track;
        comment = result.comment;
      } catch (_) { /* AI 挑失败就顺延下一首 */ }
      let idx = picked ? musicTracks.findIndex((t) => t.id === picked.id) : -1;
      if (idx < 0 || idx === musicIndex) idx = (musicIndex + 1) % musicTracks.length;
      await playMusicAtIndex(idx, { announce: true, by: 'streamer', comment, gestureToken });
      gestureToken = null;
    } finally {
      gestureToken?.dispose?.();
      charPickBusy = false;
      if (musicCharPickBtn) musicCharPickBtn.disabled = false;
    }
  }

  async function toggleMusicPlay({ gestureToken = null } = {}) {
    if (musicAudio) {
      gestureToken?.dispose?.();
      if (musicAudio.paused) {
        trackForegroundMediaAudio(musicAudio, { active: true });
        await musicAudio.play().catch(() => {});
      }
      else musicAudio.pause();
      updateMusicBar();
      return;
    }
    await ensureMusicTracksLoaded();
    if (!musicTracks.length) {
      gestureToken?.dispose?.();
      showToast('还没有可播放的歌，先去音乐页导入几首');
      return;
    }
    playMusicAtIndex(musicIndex >= 0 ? musicIndex : 0, { announce: true, gestureToken });
  }

  async function skipMusic(dir = 1, { gestureToken = null } = {}) {
    await ensureMusicTracksLoaded();
    if (!musicTracks.length) {
      gestureToken?.dispose?.();
      showToast('还没有可播放的歌，先去音乐页导入几首');
      return;
    }
    const next = ((musicIndex < 0 ? 0 : musicIndex) + dir + musicTracks.length) % musicTracks.length;
    playMusicAtIndex(next, { announce: true, gestureToken });
  }

  function renderMusicPlaylistChips() {
    if (!musicPlaylistRowEl) return;
    if (!musicPlaylists.length) {
      musicPlaylistRowEl.hidden = true;
      musicPlaylistRowEl.innerHTML = '';
      return;
    }
    musicPlaylistRowEl.hidden = false;
    musicPlaylistRowEl.innerHTML = [
      `<button type="button" class="streamer-settings-chip ${musicPlaylistId ? '' : 'is-active'}" data-music-playlist="">全部</button>`,
      ...musicPlaylists.map((p) => `<button type="button" class="streamer-settings-chip ${p.id === musicPlaylistId ? 'is-active' : ''}" data-music-playlist="${escAttr(p.id)}">${esc(p.title)}</button>`),
    ].join('');
  }

  function renderMusicTrackList() {
    if (!musicListEl) return;
    if (!musicTracks.length) {
      musicListEl.innerHTML = `<div class="streamer-history-empty">${neteaseOk() ? '这里还没有歌，搜网易云点一首，或去「音乐」页导入' : '音乐库还没有歌，先去「音乐」页导入几首（登录网易云后这里还能直接搜歌点歌）'}</div>`;
      return;
    }
    musicListEl.innerHTML = musicTracks.map((t) => `
      <button type="button" class="streamer-music-item ${t.id === musicTracks[musicIndex]?.id ? 'is-active' : ''}" data-music-track="${escAttr(t.id)}">
        <strong>${esc(t.title)}</strong>
        <small>${esc(t.artist)}${isNeteaseTrack(t) ? ' · 网易云' : ''}</small>
      </button>
    `).join('');
  }

  async function renderMusicPanel() {
    await ensureMusicTracksLoaded();
    if (musicSearchFormEl) musicSearchFormEl.hidden = !neteaseOk();
    renderMusicPlaylistChips();
    renderMusicTrackList();
  }

  musicSearchFormEl?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const keyword = String(musicSearchInputEl?.value || '').trim();
    if (!keyword || !musicSearchResultsEl) return;
    musicSearchResultsEl.innerHTML = '<div class="streamer-history-empty">搜索中…</div>';
    try {
      const songs = await searchNeteaseSongs(neteaseCfg, keyword, { limit: 12 });
      lastSearchSongs = songs;
      if (!songs.length) {
        musicSearchResultsEl.innerHTML = '<div class="streamer-history-empty">没搜到，换个词试试</div>';
        return;
      }
      musicSearchResultsEl.innerHTML = songs.map((song, i) => {
        const t = normalizeNeteaseSong(song);
        return `
          <button type="button" class="streamer-music-item" data-music-request="${i}">
            <strong>${esc(t.title)}</strong>
            <small>${esc(t.artist)} · 网易云 · 点歌</small>
          </button>`;
      }).join('');
    } catch (err) {
      musicSearchResultsEl.innerHTML = `<div class="streamer-history-empty">${esc(err?.message || '网易云搜索失败')}</div>`;
    }
  });

  musicSearchResultsEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-music-request]');
    if (!btn) return;
    const song = lastSearchSongs[Number(btn.getAttribute('data-music-request'))];
    if (!song) return;
    btn.disabled = true;
    try {
      const [row] = await importNeteaseSongsToLibrary([song], {
        playlistId: 'pl_streamer_requests',
        playlistTitle: '直播点歌',
      });
      if (!row) throw new Error('这首歌导入失败');
      await ensureMusicTracksLoaded(true);
      let idx = musicTracks.findIndex((t) => t.id === row.id);
      if (idx < 0) {
        musicPlaylistId = '';
        applyMusicQueue();
        idx = musicTracks.findIndex((t) => t.id === row.id);
      }
      if (idx < 0) throw new Error('这首歌暂时不可播放');
      await playMusicAtIndex(idx, { announce: true, gestureToken: captureMediaGesture(e) });
      setMusicPanelOpen(false);
    } catch (err) {
      showToast(err?.message || '点歌失败');
      btn.disabled = false;
    }
  });

  musicPlaylistRowEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-music-playlist]');
    if (!btn) return;
    const next = btn.getAttribute('data-music-playlist') || '';
    if (next === musicPlaylistId) return;
    musicPlaylistId = next;
    applyMusicQueue();
    renderMusicPlaylistChips();
    renderMusicTrackList();
    if (musicTracks.length && !(musicAudio && !musicAudio.paused)) {
      playMusicAtIndex(0, { announce: true, gestureToken: captureMediaGesture(e) });
    }
  });

  container.querySelector('#streamer-music-chardj')?.addEventListener('change', async (e) => {
    musicCharDJ = !!e.target.checked;
    channel = await saveStreamerChannel({
      ...channel,
      persona: { ...channel.persona, musicCharDJ },
    }).catch(() => channel);
  });

  musicCharPickBtn?.addEventListener('click', (e) => charPickNextSong({ gestureToken: captureMediaGesture(e) }));

  musicListEl?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-music-track]');
    if (!row) return;
    const idx = musicTracks.findIndex((t) => t.id === row.getAttribute('data-music-track'));
    if (idx < 0) return;
    playMusicAtIndex(idx, { announce: true, gestureToken: captureMediaGesture(e) });
    setMusicPanelOpen(false);
  });

  container.querySelector('[data-music-pick]')?.addEventListener('click', () => setMusicPanelOpen(!!musicPanelEl?.hidden));
  container.querySelector('[data-music-panel-close]')?.addEventListener('click', () => setMusicPanelOpen(false));
  container.querySelector('[data-music-toggle]')?.addEventListener('click', (e) => {
    void toggleMusicPlay({ gestureToken: captureMediaGesture(e) });
  });
  container.querySelector('[data-music-prev]')?.addEventListener('click', (e) => {
    skipMusic(-1, { gestureToken: captureMediaGesture(e) });
  });
  container.querySelector('[data-music-next]')?.addEventListener('click', (e) => {
    skipMusic(1, { gestureToken: captureMediaGesture(e) });
  });

  function updateVoiceBtn() {
    if (!voiceBtn) return;
    voiceBtn.classList.toggle('is-muted', voiceMuted || !voiceReady);
    voiceBtn.setAttribute('aria-pressed', String(!voiceMuted && voiceReady));
  }
  updateVoiceBtn();
  voiceBtn?.addEventListener('click', async () => {
    if (!voiceReady) return;
    voiceMuted = !voiceMuted;
    if (voiceMuted) stopVoicePlayback();
    updateVoiceBtn();
    channel = await saveStreamerChannel({
      ...channel,
      persona: { ...channel.persona, voiceEnabled: !voiceMuted },
    }).catch(() => channel);
  });

  const AMBIENT_INTERVAL_MS = { small: 6200, mid: 4200, big: 2600 };
  let ambientTimer = null;
  function stopAmbientLoop() {
    if (ambientTimer) clearInterval(ambientTimer);
    ambientTimer = null;
  }
  function startAmbientLoop() {
    stopAmbientLoop();
    if (reduceMotion || channel.status === 'ended') return;
    const interval = AMBIENT_INTERVAL_MS[tier.id] || AMBIENT_INTERVAL_MS.mid;
    ambientTimer = setInterval(() => {
      if (channel.status === 'ended' || !channel.recentDanmaku.length) return;
      const pick = channel.recentDanmaku[Math.floor(Math.random() * channel.recentDanmaku.length)];
      if (pick) spawnFlyingDanmaku(pick);
    }, interval);
  }

  let idleTimer = null;
  let batchBusy = false;
  function stopIdleLoop() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }
  function startIdleLoop() {
    stopIdleLoop();
    if (channel.status === 'ended' || channel.persona?.idleAutoPlay !== true) return;
    const interval = resolveIdleIntervalMs(channel.persona, tier);
    idleTimer = setInterval(() => {
      if (channel.status === 'ended' || batchBusy) return;
      runBatch();
    }, interval);
  }

  let laneCursor = 0;
  const DANMAKU_LANES = 6;
  function spawnFlyingDanmaku(item) {
    if (!danmakuLayerEl || channel.status === 'ended') return;
    const span = document.createElement('span');
    span.className = `streamer-flying-danmaku${item.fromUser ? ' is-user' : ''}`;
    span.textContent = item.fromUser ? `我：${item.text}` : `${item.from}：${item.text}`;
    const lane = laneCursor % DANMAKU_LANES;
    laneCursor += 1;
    span.style.top = `${6 + lane * (13)}%`;
    const duration = reduceMotion ? 0 : 7 + Math.random() * 4.5;
    if (reduceMotion) {
      span.classList.add('is-static');
      danmakuLayerEl.appendChild(span);
      setTimeout(() => span.remove(), 3600);
      return;
    }
    span.style.animationDuration = `${duration.toFixed(2)}s`;
    danmakuLayerEl.appendChild(span);
    span.addEventListener('animationend', () => span.remove());
  }

  function updateCaption(text = '', translation = '') {
    if (!captionEl) return;
    const clean = String(text || '').trim();
    if (!clean) {
      captionEl.hidden = true;
      captionEl.innerHTML = '';
      return;
    }
    captionEl.hidden = false;
    captionEl.innerHTML = `${esc(clean)}${streamerTranslationSuffixHtml(clean, translation)}`;
  }

  function setStageBackground(url = '') {
    if (!stageEl) return;
    const src = String(url || '').trim();
    if (!/^(data:image\/|https?:\/\/|blob:)/i.test(src)) return;
    stageEl.style.backgroundImage = `url("${src}")`;
    stageEl.style.backgroundSize = 'cover';
    stageEl.style.backgroundPosition = 'center';
  }

  function replayRecentDanmakuOnLoad() {
    const recent = (channel.recentDanmaku || []).slice(0, 5).reverse();
    recent.forEach((row, idx) => {
      setTimeout(() => spawnFlyingDanmaku(row), idx * 650);
    });
  }

  function buildHistoryRows() {
    const rows = [
      ...(channel.streamerLines || []).map((l) => ({ kind: 'line', id: l.id, text: l.text, translation: l.translation || '', ts: l.ts })),
      ...(channel.recentDanmaku || []).map((d) => ({
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

  function renderHistoryPanel() {
    if (!historyBodyEl) return;
    const rows = buildHistoryRows();
    if (!rows.length) {
      historyBodyEl.innerHTML = '<div class="streamer-history-empty">本场还没有记录，下播后会收进主播空间的录屏</div>';
      return;
    }
    historyBodyEl.innerHTML = rows.map((row) => {
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
    }).join('');
    historyBodyEl.scrollTop = historyBodyEl.scrollHeight;
  }

  function closeAllPanels() {
    if (historyPanelEl) historyPanelEl.hidden = true;
    if (settingsPanelEl) settingsPanelEl.hidden = true;
    if (musicPanelEl) musicPanelEl.hidden = true;
    historyBtn?.setAttribute('aria-expanded', 'false');
    historyBtn?.classList.remove('is-open');
    settingsBtn?.setAttribute('aria-expanded', 'false');
    settingsBtn?.classList.remove('is-open');
  }

  function setHistoryOpen(open) {
    if (!historyPanelEl) return;
    closeAllPanels();
    historyPanelEl.hidden = !open;
    historyBtn?.setAttribute('aria-expanded', String(open));
    historyBtn?.classList.toggle('is-open', open);
    if (open) renderHistoryPanel();
  }

  function setSettingsOpen(open) {
    if (!settingsPanelEl) return;
    closeAllPanels();
    settingsPanelEl.hidden = !open;
    settingsBtn?.setAttribute('aria-expanded', String(open));
    settingsBtn?.classList.toggle('is-open', open);
  }

  function setMusicPanelOpen(open) {
    if (!musicPanelEl) return;
    closeAllPanels();
    musicPanelEl.hidden = !open;
    if (open) renderMusicPanel();
  }

  historyBodyEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-replay-id]');
    if (!btn || replaying) return;
    const line = (channel.streamerLines || []).find((l) => l.id === btn.getAttribute('data-replay-id'));
    if (line) {
      playStreamerLineVoice(line.text, {
        force: true,
        lineId: line.id,
        speechPlan: line.speechPlan,
        gestureToken: captureMediaGesture(e),
      });
    }
  });

  function paintEndedState() {
    const ended = channel.status === 'ended';
    if (endedOverlayEl) endedOverlayEl.hidden = !ended;
    if (endBtn) endBtn.hidden = ended;
    container.querySelector('.streamer-stage-live')?.toggleAttribute('hidden', ended);
    const offlineBadge = container.querySelector('.streamer-stage-offline-badge');
    if (offlineBadge) offlineBadge.hidden = !ended;
    if (composerEl) composerEl.hidden = ended;
    if (ended) stopVoicePlayback();
    if (sceneRerollBtn) sceneRerollBtn.hidden = !lastScenePrompt || ended;
    if (sceneUploadBtn) sceneUploadBtn.hidden = ended;
  }

  function setStatus(text = '') {
    if (!statusEl) return;
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  async function resolveRoomImageConfig() {
    const mode = String(channel.persona?.imageGenMode || '').trim();
    if (!mode) return null;
    const base = await loadImageToolConfig().catch(() => ({}));
    return {
      ...base,
      usage: { ...(base.usage || {}), chatImages: true },
      scenes: { ...(base.scenes || {}), chatImages: mode },
    };
  }

  let lastScenePrompt = '';
  let sceneBusy = false;

  function updateRerollBtn() {
    if (!sceneRerollBtn) return;
    sceneRerollBtn.hidden = !lastScenePrompt || channel.status === 'ended';
    sceneRerollBtn.disabled = sceneBusy;
  }

  /** 有过内容但从没成功生成过封面的老频道（比如生图配置是后补的）：进房时用人设信息拼一句兜底画面提示词，补一张封面 */
  function buildFallbackScenePrompt(persona = {}) {
    const bits = [
      'vertical portrait of a good-looking person live streaming',
      persona.categoryLabel ? `${persona.categoryLabel} stream` : '',
      persona.personality || '',
      persona.worldSetting || '',
      'half body, upper body framing, face turned away or looking down or covered so face is not clearly visible, chin or side profile can show',
      'natural cozy indoor lighting, clear well-exposed framing',
    ].filter(Boolean);
    return bits.join(', ');
  }

  let noCoverHintShown = false;

  /** 给现场捏的匿名人格（没有通讯录角色可依托）一个轻量一致性锁：第一次换画面就固定一个 seed 存下来，后续换画面复用同一个 seed，尽量保持同一个人/同一种风格 */
  async function resolvePersonaImageLockOptions() {
    if (channel.persona?.imageLockEnabled === false) return {};
    let seed = Number(channel.persona?.imageLockSeed) || 0;
    if (!seed) {
      seed = 1 + Math.floor(Math.random() * 4294967294);
      channel = await saveStreamerChannel({ ...channel, persona: { ...channel.persona, imageLockSeed: seed } }).catch(() => channel);
    }
    const options = { seed };
    // 独立头像是最稳定、最明确的脸部参考；没有头像时才退回首张直播封面。
    const refUrl = String(channel.persona?.avatar || channel.persona?.avatarCover || '').trim();
    if (/^(data:image\/|https?:\/\/|blob:)/i.test(refUrl)) options.refImageUrls = [refUrl];
    return options;
  }

  async function maybeUpdateScene(scenePrompt = '', { force = false } = {}) {
    const prompt = String(scenePrompt || '').trim();
    if (!prompt) return;
    lastScenePrompt = prompt;
    updateRerollBtn();
    const imageTier = getStreamerImageSyncTierById(channel.persona?.imageSyncTier);
    const hasScene = !!(channel.currentSceneImage || channel.persona?.avatarCover);
    if (!force && hasScene) {
      // 已经有过画面：'固定画面' 档位之后不再变；其它档位按概率决定这一轮要不要换
      if (imageTier.id === 'off') return;
      if (Math.random() > imageTier.chance) return;
    }
    // 还没有任何画面时（不管什么档位），或用户手动点了重新生成：这次必须尝试生成一次
    if (sceneBusy) return;
    const localCfg = await resolveRoomImageConfig();
    const mode = await resolveSocialImageGenMode('chatImages', localCfg).catch(() => '');
    if (!mode) {
      // 手动重roll，或这个频道从来没成功出过封面：提示可开生图，也可直接上传背景
      if (force || (!hasScene && !noCoverHintShown)) {
        noCoverHintShown = true;
        showToast('未启用生图：可在直播设置上传背景，或在「API 管理 › 生图」/本局生图引擎里开启');
      }
      return;
    }
    sceneBusy = true;
    updateRerollBtn();
    if (sceneLoadingEl) sceneLoadingEl.hidden = false;
    try {
      const styleId = String(channel.persona?.imageStyleId || '').trim();
      // 直播画面固定竖屏半身构图，兼当背景和头像用
      let genOptions = {
        aspect: 'portrait',
        forcePortrait: true,
        ...(localCfg ? { config: localCfg } : {}),
        ...(styleId ? { styleId } : {}),
      };
      let genPrompt = prompt;
      if (channel.sourceType === 'character' && channel.characterId) {
        const lockResult = await applyImageLockByCharacterId(channel.characterId, prompt, {
          config: localCfg || undefined,
          styleEngineOverride: false,
          forcePortrait: true,
        }).catch(() => null);
        if (lockResult) {
          genOptions = mergeImageLockIntoOptions(lockResult, genOptions);
          genPrompt = lockResult.prompt || prompt;
        }
      } else {
        genOptions = { ...genOptions, ...(await resolvePersonaImageLockOptions()) };
      }
      const result = await generateImageForScene(genPrompt, 'chatImages', genOptions);
      const url = await persistGeneratedImageUrlLocally(result?.url || '');
      if (url) {
        channel = await updateStreamerSceneImage(channel.id, url);
        // 现捏人格的第一张画面顺手存成 avatarCover：往后既能当兼容引擎的锁脸参考图，也能在没画面时兜底当封面/头像
        if (channel.sourceType !== 'character' && !channel.persona?.avatarCover) {
          channel = await saveStreamerChannel({ ...channel, persona: { ...channel.persona, avatarCover: url } }).catch(() => channel);
        }
        setStageBackground(url);
      } else if (force) {
        showToast('生成失败');
      }
    } catch (err) {
      if (force) showToast(err?.message || '生成失败');
      /* 非手动重roll时静默跳过，不打扰当轮内容 */
    } finally {
      if (sceneLoadingEl) sceneLoadingEl.hidden = true;
      sceneBusy = false;
      updateRerollBtn();
    }
  }

  sceneRerollBtn?.addEventListener('click', () => {
    if (!lastScenePrompt || sceneBusy) return;
    maybeUpdateScene(lastScenePrompt, { force: true });
  });

  async function applyUploadedScene(dataUrl = '') {
    const url = String(dataUrl || '').trim();
    if (!/^(data:image\/|https?:\/\/|blob:)/i.test(url)) {
      showToast('请选择图片文件');
      return;
    }
    try {
      const persisted = await persistGeneratedImageUrlLocally(url).catch(() => url);
      channel = await updateStreamerSceneImage(channel.id, persisted);
      if (!channel.persona?.avatarCover) {
        channel = await saveStreamerChannel({
          ...channel,
          persona: { ...channel.persona, avatarCover: persisted },
        }).catch(() => channel);
      }
      setStageBackground(persisted);
      lastScenePrompt = lastScenePrompt || buildFallbackScenePrompt(channel.persona);
      updateRerollBtn();
      showToast('背景已更新');
    } catch (err) {
      showToast(err?.message || '上传失败');
    }
  }

  function openSceneFilePicker() {
    if (channel.status === 'ended') {
      showToast('已下播，无法更换背景');
      return;
    }
    sceneFileInput?.click();
  }

  sceneUploadBtn?.addEventListener('click', () => openSceneFilePicker());
  container.querySelector('[data-upload-scene]')?.addEventListener('click', () => openSceneFilePicker());
  sceneFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !/^image\//.test(file.type || '')) return;
    const reader = new FileReader();
    reader.onload = () => applyUploadedScene(String(reader.result || ''));
    reader.onerror = () => showToast('读取图片失败');
    reader.readAsDataURL(file);
  });
  container.querySelector('[data-gen-scene-cover]')?.addEventListener('click', async () => {
    if (channel.status === 'ended') {
      showToast('已下播，无法生成封面');
      return;
    }
    const prompt = lastScenePrompt || buildFallbackScenePrompt(channel.persona);
    await maybeUpdateScene(prompt, { force: true });
  });

  async function runBatch({
    userMessage = '',
    isGift = false,
    giftLabel = '',
    openingTopic = '',
    songRequest = '',
    songBy = 'user',
    songComment = '',
    gestureToken = null,
  } = {}) {
    if (channel.status === 'ended' || batchBusy) {
      gestureToken?.dispose?.();
      return;
    }
    batchBusy = true;
    setStatus(userMessage ? '主播正在回应…' : (songRequest ? '主播正在切歌…' : '主播上线中…'));
    try {
      const batch = await generateStreamerRoomBatchAI({ channel, user, userMessage, isGift, giftLabel, openingTopic, songRequest, songBy, songComment });
      channel = await appendStreamerRoomBatch(channel.id, batch);
      updateCaption(batch.streamerLine, batch.translation || '');
      batch.danmaku.forEach((row) => spawnFlyingDanmaku(row));
      const newLine = batch.streamerLine ? channel.streamerLines[0] : null;
      playStreamerLineVoice(batch.streamerLine, {
        lineId: newLine?.id || '',
        speechPlan: batch.speechPlan,
        gestureToken,
      });
      gestureToken = null;
      const scenePrompt = String(batch.scenePrompt || '').trim()
        || (!(channel.currentSceneImage || channel.persona?.avatarCover)
          ? buildFallbackScenePrompt(channel.persona)
          : '');
      if (scenePrompt) maybeUpdateScene(scenePrompt, {
        force: !(channel.currentSceneImage || channel.persona?.avatarCover),
      });
      if (historyPanelEl && !historyPanelEl.hidden) renderHistoryPanel();
    } catch (err) {
      gestureToken?.dispose?.();
      showToast(err?.message || '生成失败');
    } finally {
      setStatus('');
      batchBusy = false;
    }
  }

  bindNarrationTranslationToggle(container, {
    onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
  });

  paintEndedState();
  const lastLine = channel.streamerLines?.[0];
  if (lastLine) updateCaption(lastLine.text, lastLine.translation || '');
  if (channel.status !== 'ended') {
    if (!channel.streamerLines.length && !channel.recentDanmaku.length) {
      runBatch();
    } else {
      replayRecentDanmakuOnLoad();
      // 已经播过内容但从没成功出过封面（比如生图是后来才配置的）：进房顺手补一张，别一直空着
      if (!channel.currentSceneImage && !channel.persona?.avatarCover) {
        maybeUpdateScene(buildFallbackScenePrompt(channel.persona), { force: true });
      }
    }
    startAmbientLoop();
    startIdleLoop();
  }

  endBtn?.addEventListener('click', async () => {
    if (channel.status === 'ended') return;
    stopAmbientLoop();
    stopIdleLoop();
    stopVoicePlayback();
    endBtn.disabled = true;
    try {
      channel = await endStreamerSession(channel.id);
      updateCaption('');
      paintEndedState();
      renderHistoryPanel();
      showToast('已下播，这场记录收进主播空间了');
    } catch (err) {
      showToast(err?.message || '下播失败');
    } finally {
      endBtn.disabled = false;
    }
  });

  async function restartSession(topicHint = '', gestureToken = null) {
    channel = await startStreamerSession(channel.id);
    paintEndedState();
    updateCaption('');
    await runBatch({ openingTopic: topicHint, gestureToken });
    startAmbientLoop();
    startIdleLoop();
  }

  restartAutoBtn?.addEventListener('click', async (e) => {
    const gestureToken = captureMediaGesture(e);
    restartAutoBtn.disabled = true;
    if (restartCustomBtn) restartCustomBtn.disabled = true;
    try {
      const topic = await generateStreamerOpeningTopicAI(channel).catch(() => '');
      await restartSession(topic, gestureToken);
    } catch (err) {
      gestureToken?.dispose?.();
      showToast(err?.message || '开播失败');
    } finally {
      restartAutoBtn.disabled = false;
      if (restartCustomBtn) restartCustomBtn.disabled = false;
    }
  });

  restartCustomBtn?.addEventListener('click', async (e) => {
    const topic = String(restartInputEl?.value || '').trim();
    if (!topic) {
      showToast('写点这次想播的方向吧');
      return;
    }
    const gestureToken = captureMediaGesture(e);
    restartCustomBtn.disabled = true;
    if (restartAutoBtn) restartAutoBtn.disabled = true;
    try {
      await restartSession(topic, gestureToken);
      if (restartInputEl) restartInputEl.value = '';
    } catch (err) {
      gestureToken?.dispose?.();
      showToast(err?.message || '开播失败');
    } finally {
      restartCustomBtn.disabled = false;
      if (restartAutoBtn) restartAutoBtn.disabled = false;
    }
  });

  historyBtn?.addEventListener('click', () => setHistoryOpen(!!historyPanelEl?.hidden));
  container.querySelector('[data-history-close]')?.addEventListener('click', () => setHistoryOpen(false));

  settingsBtn?.addEventListener('click', () => setSettingsOpen(!!settingsPanelEl?.hidden));
  container.querySelector('[data-settings-close]')?.addEventListener('click', () => setSettingsOpen(false));

  container.querySelector('[data-image-tier-row]')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-image-tier]');
    if (!btn) return;
    const value = btn.getAttribute('data-image-tier');
    if (value === channel.persona?.imageSyncTier) return;
    channel = await saveStreamerChannel({ ...channel, persona: { ...channel.persona, imageSyncTier: value } });
    container.querySelectorAll('[data-image-tier]').forEach((chip) => chip.classList.toggle('is-active', chip.getAttribute('data-image-tier') === value));
    const hintEl = container.querySelector('[data-image-tier-hint]');
    if (hintEl) hintEl.textContent = getStreamerImageSyncTierById(value).hint;
  });

  container.querySelector('[data-idle-interval-row]')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-idle-interval]');
    if (!btn) return;
    const clicked = btn.getAttribute('data-idle-interval') || '';
    const value = clicked === (channel.persona?.idleIntervalId || '') ? '' : clicked;
    channel = await saveStreamerChannel({ ...channel, persona: { ...channel.persona, idleIntervalId: value } });
    container.querySelectorAll('[data-idle-interval]').forEach((chip) => chip.classList.toggle('is-active', chip.getAttribute('data-idle-interval') === value));
    if (channel.persona?.idleAutoPlay) startIdleLoop();
  });

  container.querySelector('[data-image-mode-row]')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-image-mode]');
    if (!btn) return;
    const value = btn.getAttribute('data-image-mode') || '';
    if (value === (channel.persona?.imageGenMode || '')) return;
    channel = await saveStreamerChannel({
      ...channel,
      persona: { ...channel.persona, imageGenMode: value, imageGenForceOn: value !== '' },
    });
    container.querySelectorAll('[data-image-mode]').forEach((chip) => chip.classList.toggle('is-active', (chip.getAttribute('data-image-mode') || '') === value));
  });

  container.querySelector('[data-image-style-row]')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-image-style]');
    if (!btn) return;
    const value = btn.getAttribute('data-image-style') || '';
    if (value === (channel.persona?.imageStyleId || '')) return;
    channel = await saveStreamerChannel({
      ...channel,
      persona: { ...channel.persona, imageStyleId: value },
    });
    container.querySelectorAll('[data-image-style]').forEach((chip) => chip.classList.toggle('is-active', (chip.getAttribute('data-image-style') || '') === value));
  });

  container.querySelector('#streamer-settings-idle')?.addEventListener('change', async (e) => {
    const checked = !!e.target.checked;
    channel = await saveStreamerChannel({ ...channel, persona: { ...channel.persona, idleAutoPlay: checked } });
    if (checked) {
      startIdleLoop();
      showToast('挂机模式已开启，主播会定时自己往下播');
    } else {
      stopIdleLoop();
    }
  });

  container.querySelectorAll('[data-open-space]').forEach((btn) => btn.addEventListener('click', () => {
    stopAmbientLoop();
    stopIdleLoop();
    stopVoicePlayback();
    stopRoomMusic();
    navigate('anon/streamer/space', { channelId: channel.id });
  }));

  container.querySelector('[data-gift]')?.addEventListener('click', () => {
    showToast('打赏功能还在做，先靠弹幕给主播加油吧');
  });

  composerEl?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = String(inputEl?.value || '').trim();
    if (!text || channel.status === 'ended') return;
    const gestureToken = captureMediaGesture(e);
    inputEl.value = '';
    channel = await appendStreamerUserMessage(channel.id, text);
    spawnFlyingDanmaku({ from: '我', fromUser: true, text });
    if (historyPanelEl && !historyPanelEl.hidden) renderHistoryPanel();
    await runBatch({ userMessage: text, gestureToken });
  });
}
