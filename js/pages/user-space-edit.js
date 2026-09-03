import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml, escAttr } from '../components/scrapbook-illustrations.js';
import { describeImageSaveResult, saveImageSrc } from '../components/image-lightbox.js';
import { isOversizedAvatarDataUrl } from '../core/avatar-compaction.js';
import { showToast } from '../components/toast.js';
import { openSlotNameModal } from '../components/slot-name-modal.js';
import { openOptionPicker } from '../components/option-picker.js';
import { openAiFillReviewModal } from '../components/ai-fill-review-modal.js';
import { openUserProfileAiModal } from '../components/user-profile-ai-modal.js';
import {
  getCurrentUser,
  saveUserRecord,
  listUsers,
  createUserSlot,
  duplicateUserSlot,
  deleteUserIdentity,
  deleteUserSlot,
  setCurrentUserId,
} from '../core/user-slot.js';
import { normalizeUserRecord } from '../models/user.js';
import { IMAGE_LOCK_MODES, normalizeImageLock } from '../models/character.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import {
  getEffectiveWeatherCityForUser,
  fetchWeatherForCity,
  summarizeWeatherForHint,
  summarizeWeatherDisplay,
  weatherSourceLabel,
} from '../core/weather-location.js';
import { get, put } from '../core/db.js';
import { loadAmapConfig, amapTextSearch } from '../core/amap-tools.js';
import {
  generateCharacterImage,
  isNovelAiImageGenerationEnabled,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
  optimizeImageDataUrlForNovelAiReference,
  persistGeneratedImageUrlLocally,
} from '../core/image-generation-tools.js';
import { listImageStylePresets } from '../core/image-style-presets.js';
import {
  applyUserImageLock,
  resolveUserImageLockRefUrl,
} from '../core/user-image-lock.js';
import { listAllWorldBookRows, listWorldBookRootOptions } from '../core/world-book-store.js';
import { buildUserAiReviewFields, generateUserProfileDraft } from '../core/profile-ai-generation.js';
import { downloadUserSlotArchive } from '../core/user-slot-archive.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function saveImageToDevice(src, button) {
  const url = String(src || '').trim();
  if (!url) {
    showToast('还没有可保存的图片');
    return;
  }
  const previousHtml = button?.innerHTML || '';
  if (button) {
    button.disabled = true;
    button.textContent = '保存中…';
  }
  try {
    const result = await saveImageSrc(url);
    showToast(describeImageSaveResult(result));
  } catch (err) {
    showToast(`保存失败：${String(err?.message || err).slice(0, 100)}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = previousHtml;
    }
  }
}

function getVal(container, selector) {
  return String(container.querySelector(selector)?.value ?? '').trim();
}

function field(label, input) {
  return `
    <label class="api-field">
      <span class="api-field-label">${esc(label)}</span>
      ${input}
    </label>
  `;
}

function cleanProfileEventText(value = '', max = 260) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function userProfileEventsKey(userId = '') {
  return `userProfileChangeEvents_${String(userId || '').trim()}`;
}

async function appendUserProfileChangeEvents(userId = '', events = []) {
  const uid = String(userId || '').trim();
  const list = Array.isArray(events) ? events.filter((event) => event?.text) : [];
  if (!uid || !list.length) return;
  const key = userProfileEventsKey(uid);
  const row = await get(key).catch(() => null);
  const current = Array.isArray(row?.value) ? row.value : [];
  await put({
    key,
    value: [...current, ...list].slice(-80),
  });
}

function avatarUrlFieldValue(avatar = '') {
  const value = String(avatar || '').trim();
  return /^https?:\/\//i.test(value) ? value : '';
}

function renderUserImageStyleOptions(selectedId = '') {
  const current = String(selectedId || '').trim();
  const group = (label, presets) => (presets.length
    ? `<optgroup label="${esc(label)}">${presets.map((p) => `<option value="${esc(p.id)}" ${current === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>`
    : '');
  return [
    `<option value="" ${current ? '' : 'selected'}>跟随全局默认</option>`,
    group('兼容人物（gpt / gemini 等中转）', listImageStylePresets('realistic')),
    group('NovelAI 二次元', listImageStylePresets('novelai')),
  ].join('');
}

function openUserDrawPreview(url, { onUseAvatar, onUseRef } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) {
    onUseAvatar?.();
    return;
  }
  host.innerHTML = `
    <div class="modal-overlay" data-draw-overlay>
      <div class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" style="max-width:360px;" data-draw-sheet>
        <div class="modal-header"><h3>生图预览</h3></div>
        <div class="modal-body" style="padding-top:0;">
          <img src="${esc(url)}" alt="用户生图预览" style="width:100%;border-radius:12px;display:block;" />
        </div>
        <div class="modal-body" style="display:flex;flex-wrap:wrap;gap:8px;padding-top:0;">
          <button type="button" class="btn btn-primary btn-block" data-draw-use>设为头像</button>
          ${onUseRef ? '<button type="button" class="btn btn-soft btn-block" data-draw-use-ref>设为锁定参考图</button>' : ''}
          <button type="button" class="btn btn-outline btn-block" data-draw-save>${icon('download')}保存到本地</button>
          <button type="button" class="btn btn-outline btn-block" data-draw-close>关闭</button>
        </div>
      </div>
    </div>
  `;
  host.classList.add('active');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-draw-overlay]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  host.querySelector('[data-draw-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-draw-close]')?.addEventListener('click', close);
  host.querySelector('[data-draw-save]')?.addEventListener('click', (e) => {
    saveImageToDevice(url, e.currentTarget);
  });
  host.querySelector('[data-draw-use]')?.addEventListener('click', () => {
    onUseAvatar?.();
    close();
  });
  host.querySelector('[data-draw-use-ref]')?.addEventListener('click', () => {
    onUseRef?.();
    close();
  });
}

function renderUserImageLock(user, naiEnabled = false, referenceEnabled = false) {
  const lock = normalizeImageLock(user.imageLock);
  const mode = IMAGE_LOCK_MODES.includes(lock.mode) ? lock.mode : 'none';
  const opt = (val, label, disabled) => `<option value="${val}" ${mode === val ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`;
  const refUrl = String(lock.refImageUrl || '').trim();
  const preview = refUrl || String(user.avatar || '').trim();
  const refNote = naiEnabled
    ? '参考图会用 NovelAI Vibe Transfer；换场景也尽量贴近同一张脸'
    : '参考图会用兼容生图编辑接口（软锁脸，效果因中转/模型而异）';
  return `
    <div class="contacts-lock user-space-lock" data-lock>
      <div class="contacts-lock-head">
        <span class="contacts-lock-title">生图锁定 · 锁形象</span>
        <select class="form-input contacts-lock-mode" data-lock-mode>
          ${opt('none', '不锁定', false)}
          ${opt('prompt', '提示词锁定（通用）', false)}
          ${opt('seed', `Seed 锁定（NovelAI）${naiEnabled ? '' : ' · 未配置'}`, !naiEnabled)}
          ${opt('reference', `参考图锁定${referenceEnabled ? '' : ' · 未配置'}`, !referenceEnabled)}
        </select>
      </div>
      <div class="contacts-lock-body" data-lock-body ${mode === 'none' ? 'hidden' : ''}>
        <textarea class="form-input contacts-lock-prompt" data-lock-prompt rows="3" placeholder="锁定的外观提示词（留空用上方「生图外观描述」）" ${mode === 'reference' ? 'hidden' : ''}>${esc(lock.prompt || '')}</textarea>
        <div class="contacts-lock-seed-row" data-lock-seed-row ${mode === 'seed' ? '' : 'hidden'}>
          <input class="form-input contacts-lock-seed" data-lock-seed inputmode="numeric" placeholder="Seed（留空随机一次并记住）" value="${esc(lock.seed || '')}">
        </div>
        <div class="contacts-lock-ref-row" data-lock-ref-row ${mode === 'reference' ? '' : 'hidden'}>
          <div class="contacts-lock-ref-preview" data-lock-ref-preview>${preview ? `<img src="${esc(preview)}" alt="锁定参考图">` : '<span>暂无参考图</span>'}</div>
          <div class="contacts-lock-ref-main">
            <div class="contacts-lock-ref-actions">
              <label class="btn btn-sm btn-outline">上传参考图<input type="file" accept="image/*" hidden class="us-lock-ref-file"></label>
              <button type="button" class="btn btn-sm btn-soft" data-lock-ref-clear ${refUrl ? '' : 'hidden'}>改用头像</button>
            </div>
            <span class="contacts-lock-ref-hint" data-lock-ref-hint>${refUrl ? '已设置专属参考图' : '暂用当前头像；建议上传或用「生成预览」锁定一张更准的参考图'}</span>
          </div>
        </div>
        <div class="contacts-lock-actions">
          <button type="button" class="btn btn-sm btn-soft" data-lock-gen>${icon('sparkle')}生成预览</button>
          <span class="contacts-lock-note" data-lock-note ${mode === 'reference' ? '' : 'hidden'}>${esc(refNote)}</span>
        </div>
      </div>
    </div>
  `;
}

function normalizeAvatarUrlInput(value = '') {
  let trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) trimmed = `https:${trimmed}`;
  if (/^http:\/\//i.test(trimmed)) trimmed = `https://${trimmed.slice(7)}`;
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  throw new Error('请输入有效的图片 URL（https）');
}

function groupUsersBySlot(users = [], currentUserId = '') {
  const groups = new Map();
  for (const identity of users) {
    const slotGroupId = String(identity?.slotGroupId || identity?.id || '').trim();
    if (!slotGroupId) continue;
    if (!groups.has(slotGroupId)) groups.set(slotGroupId, []);
    groups.get(slotGroupId).push(identity);
  }
  return [...groups.entries()].map(([id, identities]) => ({
    id,
    identities,
    primary: identities.find((identity) => identity.id === currentUserId) || identities[0],
  }));
}

export default async function render(container, params = {}) {
  let user = normalizeUserRecord(await getCurrentUser());
  let originalProfileSnapshot = {
    avatar: String(user.avatar || ''),
    signature: String(user.signature || ''),
    statusText: String(user.statusText || ''),
  };
  let slots = await listUsers();
  const focusAnonymous = String(params.focus || '').trim() === 'anonymous';
  const imageCfg = await loadImageToolConfig().catch(() => ({}));
  const naiEnabled = isNovelAiImageGenerationEnabled(imageCfg);
  const referenceEnabled = naiEnabled || isRealisticImageGenerationEnabled(imageCfg);
  const anonProfile = user.anonymousProfile && typeof user.anonymousProfile === 'object'
    ? user.anonymousProfile
    : {};

  container.className = `page scrapbook-page user-space-edit-page${focusAnonymous ? ' user-space-edit-page--anon-focus' : ''}`;

  function syncLockFromDom() {
    const lockHost = container.querySelector('[data-lock]');
    if (!lockHost) return;
    user.imageLock = normalizeImageLock({
      ...(user.imageLock || {}),
      mode: lockHost.querySelector('[data-lock-mode]')?.value || 'none',
      prompt: lockHost.querySelector('[data-lock-prompt]')?.value || '',
      seed: (lockHost.querySelector('[data-lock-seed]')?.value || '').replace(/\D/g, ''),
      refImageUrl: user.imageLock?.refImageUrl || '',
    });
  }

  function syncFormToUser() {
    if (!container.querySelector('.us-name')) return;
    syncLockFromDom();
    const bubbleColorText = getVal(container, '.us-bubble-color-text');
    Object.assign(user, {
      slotName: getVal(container, '.us-slot-name'),
      worldBackground: getVal(container, '.us-world-background'),
      name: getVal(container, '.us-name') || '用户',
      nickname: getVal(container, '.us-nickname'),
      preferredCallName: getVal(container, '.us-preferred-call-name'),
      gender: getVal(container, '.us-gender'),
      pronouns: getVal(container, '.us-pronouns'),
      signature: getVal(container, '.us-signature'),
      statusText: getVal(container, '.us-status'),
      birthday: getVal(container, '.us-birthday'),
      virtualCity: getVal(container, '.us-virtual-city'),
      realCityMap: getVal(container, '.us-real-city'),
      weatherHint: getVal(container, '.us-weather'),
      myPlaceLabel: getVal(container, '.us-my-place'),
      hobbies: getVal(container, '.us-hobbies'),
      dislikes: getVal(container, '.us-dislikes'),
      persona: getVal(container, '.us-persona'),
      xiaohongshuId: getVal(container, '.us-xhs-id'),
      weiboId: getVal(container, '.us-weibo-id'),
      appearancePrompt: getVal(container, '.us-appearance'),
      imageStyleId: getVal(container, '.us-image-style'),
      videoAvatar: getVal(container, '.us-video-avatar-url'),
      videoAppearancePrompt: getVal(container, '.us-video-appearance'),
      bubbleColor: /^#[0-9a-f]{6}$/i.test(bubbleColorText) ? bubbleColorText : '',
      anonymousProfile: {
        ...(user.anonymousProfile && typeof user.anonymousProfile === 'object' ? user.anonymousProfile : {}),
        defaultId: getVal(container, '.us-anon-id'),
        defaultBio: getVal(container, '.us-anon-bio'),
      },
    });
  }

  function renderAvatarHero() {
    const preview = user.avatar && !isOversizedAvatarDataUrl(user.avatar)
      ? `<img class="user-space-avatar-upload-img" src="${escAttr(user.avatar)}" alt="">`
      : characterAvatarHtml(user, { className: 'user-space-avatar-upload-fallback' });
    const avatarUrlValue = avatarUrlFieldValue(user.avatar);
    return `
      <section class="user-space-avatar-hero scrapbook-panel">
        <button type="button" class="user-space-avatar-upload-btn" aria-label="点击上传头像">
          ${preview}
          <span class="user-space-avatar-upload-hint">点击上传头像</span>
        </button>
        <input type="file" class="us-avatar-file" accept="image/*" hidden />
        <div class="user-space-avatar-actions">
          <button type="button" class="btn btn-outline btn-sm us-avatar-save" ${user.avatar ? '' : 'hidden'}>${icon('download')}保存头像</button>
          <button type="button" class="btn btn-outline btn-sm us-avatar-clear">清除头像</button>
        </div>
        <div class="user-space-avatar-url-stack">
          <input type="text" class="form-input us-avatar-url" value="${esc(avatarUrlValue)}" placeholder="或粘贴图片 URL">
          <button type="button" class="btn btn-outline btn-sm us-avatar-url-apply">使用 URL</button>
        </div>
      </section>
    `;
  }

  function renderVideoAvatarPanel() {
    const videoAvatar = String(user.videoAvatar || '').trim();
    return `
      <section class="user-space-card scrapbook-panel">
        <h3>我的视频形象</h3>
        <div class="user-space-video-avatar-grid">
          <div class="user-space-video-avatar-preview ${videoAvatar ? '' : 'is-empty'}">${videoAvatar && !isOversizedAvatarDataUrl(videoAvatar) ? `<img src="${esc(videoAvatar)}" alt="">` : '<span>未设置</span>'}</div>
          <div class="user-space-video-avatar-fields">
            ${field('视频形象图', `
              <div class="user-space-video-avatar-stack">
                <input type="text" class="form-input us-video-avatar-url" value="${esc(videoAvatar)}" placeholder="可粘 URL，也可上传本地图">
                <div class="user-space-video-avatar-actions">
                  <input type="file" class="us-video-avatar-file" accept="image/*" hidden />
                  <button type="button" class="btn btn-outline btn-sm us-video-avatar-upload">上传本地图</button>
                  <button type="button" class="btn btn-soft btn-sm us-video-avatar-clear">清除</button>
                </div>
              </div>
            `)}
            ${field('视频画面描述', `<textarea class="form-input us-video-appearance" rows="3" placeholder="视频里我看起来是什么样，给 AI 读取">${esc(user.videoAppearancePrompt || '')}</textarea>`)}
          </div>
        </div>
      </section>
    `;
  }

  function paint() {
    const previousScroll = container.querySelector('.user-space-edit-scroll')?.scrollTop;
    const slotGroups = groupUsersBySlot(slots, user.id);
    const currentSlotGroupId = String(user.slotGroupId || user.id).trim();
    const currentSlotGroup = slotGroups.find((slot) => slot.id === currentSlotGroupId) || slotGroups[0] || null;
    const currentSlotLabel = String(currentSlotGroup?.primary?.slotName || user.slotName || user.name || '未命名档位').trim();
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">编辑资料</h1>
        <button type="button" class="navbar-btn user-space-save-top" aria-label="保存">${icon('check')}</button>
      </header>
      <main class="user-space-edit-scroll scrapbook-scroll">
        ${renderAvatarHero()}
        <section class="user-space-card scrapbook-panel user-space-slot-switcher-card">
          <div class="user-space-slot-switcher-head">
            <span>当前档位</span>
            <button type="button" class="user-space-slot-manage" data-slot-manage>管理</button>
          </div>
          <button type="button" class="user-space-slot-switcher" data-slot-switch aria-label="切换档位">
            <strong>${esc(currentSlotLabel)}</strong>
            <span aria-hidden="true">›</span>
          </button>
        </section>
        <section class="user-space-card scrapbook-panel">
          <h3>档位背景</h3>
          <textarea class="form-input us-world-background" rows="6" placeholder="这个档位的世界背景、人物处境与故事前提">${esc(user.worldBackground || '')}</textarea>
        </section>
        <section class="user-space-card scrapbook-panel">
          <h3>基础信息</h3>
          <div class="api-form-grid">
            ${field('档位名称', `<input type="text" class="form-input us-slot-name" value="${esc(user.slotName)}" placeholder="例如：日常档" />`)}
            ${field('姓名', `<input type="text" class="form-input us-name" value="${esc(user.name)}" placeholder="真实或设定姓名" />`)}
            ${field('昵称', `<input type="text" class="form-input us-nickname" value="${esc(user.nickname)}" placeholder="展示用昵称" />`)}
            ${field('角色称呼', `<input type="text" class="form-input us-preferred-call-name" value="${esc(user.preferredCallName || '')}" placeholder="留空则使用姓名" />`)}
            ${field('性别', `<input type="text" class="form-input us-gender" value="${esc(user.gender || '')}" placeholder="如：男性、女性、非二元" />`)}
            ${field('第三人称代词', `<input type="text" class="form-input us-pronouns" value="${esc(user.pronouns || '')}" placeholder="如：他、她、TA" />`)}
            ${field('个性签名', `<input type="text" class="form-input us-signature" value="${esc(user.signature)}" placeholder="一句话介绍自己" />`)}
            ${field('状态语', `<input type="text" class="form-input us-status" value="${esc(user.statusText)}" placeholder="今天的心情" />`)}
            ${field('生日', `<input type="text" class="form-input us-birthday" value="${esc(user.birthday)}" placeholder="如 03-21 或 2000-03-21" />`)}
          </div>
        </section>

        <section class="user-space-card scrapbook-panel">
          <h3>城市与天气</h3>
          <div class="api-form-grid">
            ${field('所在城市（可虚拟）', `<input type="text" class="form-input us-virtual-city" value="${esc(user.virtualCity)}" placeholder="例如：云港市" />`)}
            ${field('映射现实城市', `<input type="text" class="form-input us-real-city" value="${esc(user.realCityMap)}" placeholder="例如：上海（用于天气参考）" />`)}
            ${field('天气描述', `<input type="text" class="form-input us-weather" value="${esc(user.weatherHint)}" placeholder="可留空；检测或聊天时自动读取" />`)}
            <div class="user-space-weather-row">
              <button type="button" class="btn btn-xs btn-outline us-weather-check">检测天气</button>
              <span class="text-hint us-weather-status" style="font-size:11px;line-height:1.45;flex:1;"></span>
            </div>
          </div>
        </section>

        <section class="user-space-card scrapbook-panel">
          <h3>我的位置</h3>
          <div class="api-form-grid">
            ${field('位置（TA 出门找你时用来算路程）', `<input type="text" class="form-input us-my-place" value="${esc(user.myPlaceLabel)}" placeholder="如：海边的老公寓，或输入关键词后点右边搜索" />`)}
            <div class="user-space-weather-row">
              <button type="button" class="btn btn-xs btn-outline us-my-place-search">高德搜索选点</button>
              <span class="text-hint us-my-place-status" style="font-size:11px;line-height:1.45;flex:1;"></span>
            </div>
            <div class="user-space-my-place-results" hidden></div>
          </div>
        </section>

        <section class="user-space-card scrapbook-panel">
          <div class="user-space-card-heading"><h3>性格与偏好</h3><button type="button" class="btn btn-soft btn-xs user-space-ai-fill">${icon('sparkle')}AI 补全</button></div>
          <div class="api-form-grid">
            ${field('兴趣爱好', `<textarea class="form-input us-hobbies" rows="2" placeholder="用逗号分隔">${esc(user.hobbies)}</textarea>`)}
            ${field('雷点', `<textarea class="form-input us-dislikes" rows="2" placeholder="用逗号分隔">${esc(user.dislikes)}</textarea>`)}
            <div class="api-field user-space-persona-field">
              <span class="api-field-label">人物设定</span>
              <textarea class="form-input us-persona" rows="6" placeholder="写给 AI 的用户人设">${esc(user.persona)}</textarea>
              <button type="button" class="user-space-persona-expand" data-expand-persona>展开编辑</button>
            </div>
          </div>
        </section>

        <section class="user-space-card scrapbook-panel">
          <h3>生图形象</h3>
          <div class="api-form-grid">
            ${field('生图外观描述', `<textarea class="form-input us-appearance" rows="3" placeholder="发型、穿搭、气质等；用户相关生图会优先用这段">${esc(user.appearancePrompt)}</textarea>`)}
            ${field('专属画风', `<select class="form-input us-image-style">${renderUserImageStyleOptions(user.imageStyleId)}</select>`)}
          </div>
          <div class="user-space-lock-host" style="margin-top:12px;">
            ${renderUserImageLock(user, naiEnabled, referenceEnabled)}
          </div>
        </section>

        <section class="user-space-card scrapbook-panel">
          <h3>我的社交账号</h3>
          <div class="api-form-grid">
            ${field('我的小红书号', `<input type="text" class="form-input us-xhs-id" value="${esc(user.xiaohongshuId)}" placeholder="填了才能识别转发链接是不是你本人发的" />`)}
            ${field('我的微博 ID', `<input type="text" class="form-input us-weibo-id" value="${esc(user.weiboId)}" placeholder="UID；留空则分享链接默认当作转发/刷到的内容" />`)}
          </div>
        </section>

        ${renderVideoAvatarPanel()}

        <section class="user-space-card scrapbook-panel user-space-anon-card" id="user-anon-profile">
          <h3>匿名马甲</h3>
          <div class="api-form-grid">
            ${field('默认匿名 ID', `<input type="text" class="form-input us-anon-id" value="${esc(anonProfile.defaultId || '')}" placeholder="留空则随机生成" maxlength="24" />`)}
            ${field('匿名签名', `<input type="text" class="form-input us-anon-bio" value="${esc(anonProfile.defaultBio || '')}" placeholder="在匿名区展示的一行介绍" maxlength="80" />`)}
          </div>
        </section>

        <section class="user-space-card scrapbook-panel">
          <h3>聊天外观</h3>
          ${field('全局气泡色', `<div class="user-space-color-row"><input type="color" class="us-bubble-color" value="${esc(user.bubbleColor || '#f3e6d4')}" /><input type="text" class="form-input us-bubble-color-text" placeholder="留空跟随主题" value="${esc(user.bubbleColor || '')}" /><button type="button" class="btn btn-soft btn-sm us-bubble-color-clear">恢复主题</button></div>`)}
        </section>

        <div class="user-space-actions">
          <button type="button" class="btn btn-primary user-space-save">保存资料</button>
        </div>
      </main>
    `;

    bind();
    if (Number.isFinite(previousScroll)) {
      window.requestAnimationFrame(() => {
        const scroll = container.querySelector('.user-space-edit-scroll');
        if (scroll) scroll.scrollTop = previousScroll;
      });
    } else if (focusAnonymous) {
      window.requestAnimationFrame(() => {
        container.querySelector('#user-anon-profile')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  async function collectForm() {
    syncFormToUser();
    return normalizeUserRecord(user);
  }

  async function saveForm() {
    syncFormToUser();
    const beforeProfile = { ...originalProfileSnapshot };
    const info = getEffectiveWeatherCityForUser(user);
    if (info.weatherCity && !getVal(container, '.us-weather')) {
      const weather = await fetchWeatherForCity(info.weatherCity).catch(() => null);
      const hint = summarizeWeatherForHint(weather);
      if (hint) user.weatherHint = hint.slice(0, 120);
    }
    const nextUser = await collectForm();
    user = await saveUserRecord(nextUser);
    const events = [];
    if (String(beforeProfile.avatar || '') !== String(user.avatar || '')) {
      const appearance = cleanProfileEventText(user.appearancePrompt, 180);
      events.push({
        id: `profile_avatar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'avatar',
        needsVision: !!user.avatar,
        text: user.avatar
          ? `用户刚换了头像。当前头像是聊天软件里可见的新头像${appearance ? `；用户资料里的外观描述是：${appearance}` : '；请先看头像图片，不要编造没看见的细节'}。`
          : '用户刚清除了头像。',
        createdAt: Date.now(),
        seenChatIds: [],
      });
    }
    if (String(beforeProfile.signature || '') !== String(user.signature || '')) {
      events.push({
        id: `profile_signature_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'signature',
        text: user.signature
          ? `用户刚换了个性签名：${cleanProfileEventText(user.signature, 180)}`
          : '用户刚清空了个性签名。',
        createdAt: Date.now(),
        seenChatIds: [],
      });
    }
    if (String(beforeProfile.statusText || '') !== String(user.statusText || '')) {
      events.push({
        id: `profile_status_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'status',
        text: user.statusText
          ? `用户刚更新了此刻状态：${cleanProfileEventText(user.statusText, 120)}`
          : '用户刚清空了此刻状态。',
        createdAt: Date.now(),
        seenChatIds: [],
      });
    }
    await appendUserProfileChangeEvents(user.id, events);
    originalProfileSnapshot = {
      avatar: String(user.avatar || ''),
      signature: String(user.signature || ''),
      statusText: String(user.statusText || ''),
    };
    showToast('资料已保存');
    back();
  }

  function renderWeatherStatus(extra = '') {
    const statusEl = container.querySelector('.us-weather-status');
    if (!statusEl) return;
    const info = getEffectiveWeatherCityForUser({
      ...user,
      virtualCity: getVal(container, '.us-virtual-city'),
      realCityMap: getVal(container, '.us-real-city'),
    });
    if (!info.weatherCity) {
      statusEl.textContent = extra || '填映射现实城市或所在城市后可检测；聊天时会自动读取天气背景。';
      return;
    }
    const base = `当前使用：${info.weatherCity}（${info.source}）；保存后聊天会自动注入天气。`;
    statusEl.textContent = extra ? `${base} ${extra}` : base;
  }

  function renderMyPlaceStatus(extra = '') {
    const statusEl = container.querySelector('.us-my-place-status');
    if (!statusEl) return;
    if (extra) {
      statusEl.textContent = extra;
      return;
    }
    statusEl.textContent = user.myPlaceAddress
      ? `已锁定：${user.myPlaceAddress}`
      : '自选文本即可；开了高德可以搜索选点，算路程更准。';
  }

  function closeUserSpaceModal() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.remove('active');
    host.innerHTML = '';
  }

  function openPersonaEditor() {
    const source = container.querySelector('.us-persona');
    const host = document.getElementById('modal-container');
    if (!source || !host) return;
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-persona-editor-overlay>
        <section class="modal-sheet scrapbook-card user-space-persona-editor-sheet" role="dialog" aria-modal="true" aria-label="编辑人物设定">
          <header class="modal-header">
            <h3>人物设定</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-persona-editor-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body user-space-persona-editor-body">
            <textarea class="form-input user-space-persona-editor-input" aria-label="人物设定全文" placeholder="写给 AI 的用户人设">${esc(source.value)}</textarea>
          </div>
          <footer class="modal-footer user-space-persona-editor-foot">
            <button type="button" class="btn btn-primary" data-persona-editor-save>完成</button>
          </footer>
        </section>
      </div>
    `;
    const editor = host.querySelector('.user-space-persona-editor-input');
    const close = () => closeUserSpaceModal();
    host.querySelector('[data-persona-editor-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    host.querySelector('[data-persona-editor-close]')?.addEventListener('click', close);
    host.querySelector('[data-persona-editor-save]')?.addEventListener('click', () => {
      source.value = String(editor?.value || '');
      close();
      source.focus({ preventScroll: true });
    });
    window.requestAnimationFrame(() => editor?.focus({ preventScroll: true }));
  }

  async function switchToSlot(id = '') {
    const nextId = String(id || '').trim();
    if (!nextId || nextId === user.id) return;
    await saveUserRecord(await collectForm());
    await setCurrentUserId(nextId);
    user = normalizeUserRecord(await getCurrentUser());
    originalProfileSnapshot = {
      avatar: String(user.avatar || ''),
      signature: String(user.signature || ''),
      statusText: String(user.statusText || ''),
    };
    slots = await listUsers();
    showToast('已切换档位');
    paint();
  }

  async function createSlotFromProfile() {
    const name = await openSlotNameModal({ title: '新建档位' });
    if (!name) return;
    await saveUserRecord(await collectForm());
    const created = await createUserSlot(name);
    await setCurrentUserId(created.id);
    user = normalizeUserRecord(created);
    originalProfileSnapshot = {
      avatar: String(user.avatar || ''),
      signature: String(user.signature || ''),
      statusText: String(user.statusText || ''),
    };
    slots = await listUsers();
    showToast(`已创建「${name}」`);
    paint();
  }

  async function copySlotFromProfile() {
    const name = await openSlotNameModal({
      title: '复制当前档位',
      value: `${user.slotName || user.name || '档位'} · 副本`,
      confirmText: '开始复制',
    });
    if (!name) return;
    showToast('正在复制档位…');
    await saveUserRecord(await collectForm());
    const copy = await duplicateUserSlot(user.id, name);
    await setCurrentUserId(copy.id);
    user = normalizeUserRecord(copy);
    originalProfileSnapshot = {
      avatar: String(user.avatar || ''),
      signature: String(user.signature || ''),
      statusText: String(user.statusText || ''),
    };
    slots = await listUsers();
    showToast('档位已复制');
    paint();
  }

  async function refreshAfterProfileDeletion(message) {
    user = normalizeUserRecord(await getCurrentUser());
    originalProfileSnapshot = {
      avatar: String(user.avatar || ''),
      signature: String(user.signature || ''),
      statusText: String(user.statusText || ''),
    };
    slots = await listUsers();
    showToast(message);
    paint();
  }

  async function deleteIdentityFromProfile() {
    if (!window.confirm('删除当前身份及其聊天、记忆和独立设置？此操作不可恢复。')) return;
    await deleteUserIdentity(user.id);
    await refreshAfterProfileDeletion('身份及其记录已删除');
  }

  async function deleteSlotFromProfile() {
    let archived = false;
    try {
      const marker = JSON.parse(localStorage.getItem('__mm_last_slot_archive__') || 'null');
      archived = String(marker?.slotGroupId || '') === String(user.slotGroupId || user.id)
        && Date.now() - Number(marker?.archivedAt || 0) < 24 * 60 * 60 * 1000;
    } catch (_) {}
    const archiveHint = archived
      ? '已检测到本档位今日导出的归档。'
      : '未检测到本档位今日的归档，建议先点「导出当前档位」。';
    if (!window.confirm(`${archiveHint}\n\n删除整个当前档位？档位内所有关联身份及其记录都会删除，且不可恢复。`)) return;
    await deleteUserSlot(user.id);
    await refreshAfterProfileDeletion('整个档位及其身份记录已删除');
  }

  async function archiveSlotFromProfile() {
    showToast('正在整理当前档位…');
    const result = await downloadUserSlotArchive(user.id, {
      slotName: user.slotName || user.name || '档位',
      onProgress: ({ storeName, count }) => {
        if (count && count % 100 === 0) showToast(`正在归档 ${storeName} · ${count} 条`, 1800);
      },
    });
    const remember = () => {
      try {
        localStorage.setItem('__mm_last_slot_archive__', JSON.stringify({
          slotGroupId: result.slotGroupId,
          filename: result.filename,
          archivedAt: Date.now(),
        }));
      } catch (_) {}
      showToast(`档位已归档 · ${result.filename}`, 7000);
    };
    if (!result.saved?.requiresSaveGesture || typeof result.saved.save !== 'function') {
      remember();
      return;
    }
    const host = document.getElementById('modal-container');
    if (!host) throw new Error('档位已整理，但无法打开系统保存');
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-slot-save-overlay>
        <section class="modal-sheet scrapbook-card" role="dialog" aria-modal="true">
          <header class="modal-header"><h3>档位已整理好</h3></header>
          <div class="modal-body"><button type="button" class="btn btn-primary" data-slot-save-confirm>保存到文件</button></div>
        </section>
      </div>`;
    const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
    host.querySelector('[data-slot-save-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    host.querySelector('[data-slot-save-confirm]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '正在打开…';
      try {
        await result.saved.save();
        close();
        remember();
      } catch (error) {
        button.disabled = false;
        button.textContent = '重新保存';
        showToast(String(error?.message || error));
      }
    });
  }

  function openSlotManagement() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-slot-manage-overlay>
        <section class="modal-sheet scrapbook-card user-space-slot-manage-sheet" role="dialog" aria-modal="true" aria-label="管理档位">
          <header class="modal-header">
            <h3>管理档位</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-slot-manage-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body user-space-slot-manage-body">
            <button type="button" class="user-space-slot-manage-action" data-slot-action="new"><span>新建档位</span><span aria-hidden="true">›</span></button>
            <button type="button" class="user-space-slot-manage-action" data-slot-action="copy"><span>复制当前档</span><span aria-hidden="true">›</span></button>
            <button type="button" class="user-space-slot-manage-action" data-slot-action="archive"><span>导出当前档位</span><span aria-hidden="true">›</span></button>
            <button type="button" class="user-space-slot-manage-action is-danger" data-slot-action="delete-identity"><span>删除当前身份</span><span aria-hidden="true">›</span></button>
            <button type="button" class="user-space-slot-manage-action is-danger" data-slot-action="delete-slot"><span>删除整个档位</span><span aria-hidden="true">›</span></button>
          </div>
        </section>
      </div>
    `;
    host.querySelector('[data-slot-manage-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeUserSpaceModal();
    });
    host.querySelector('[data-slot-manage-close]')?.addEventListener('click', closeUserSpaceModal);
    host.querySelectorAll('[data-slot-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.getAttribute('data-slot-action');
        closeUserSpaceModal();
        try {
          if (action === 'new') await createSlotFromProfile();
          else if (action === 'copy') await copySlotFromProfile();
          else if (action === 'archive') await archiveSlotFromProfile();
          else if (action === 'delete-identity') await deleteIdentityFromProfile();
          else if (action === 'delete-slot') await deleteSlotFromProfile();
        } catch (error) {
          showToast(String(error?.message || error));
        }
      });
    });
  }

  function bind() {
    renderWeatherStatus();
    renderMyPlaceStatus();
    container.querySelector('[data-expand-persona]')?.addEventListener('click', openPersonaEditor);
    container.querySelector('.user-space-ai-fill')?.addEventListener('click', async () => {
      syncFormToUser();
      const worldBookRows = await listAllWorldBookRows().catch(() => []);
      openUserProfileAiModal({
        worldBooks: listWorldBookRootOptions(worldBookRows),
        onGenerate: ({ description, worldBookIds }) => generateUserProfileDraft({
          description,
          worldBookIds,
          user,
        }),
        onGenerated: (draft) => {
          const fields = buildUserAiReviewFields(user, draft);
          if (!fields.length) {
            showToast('现有资料已经填满，没有需要补全的字段');
            return;
          }
          openAiFillReviewModal({
            title: 'User 补全预览',
            fields,
            onConfirm: (entries) => {
              const selectorById = {
                name: '.us-name', nickname: '.us-nickname', preferredCallName: '.us-preferred-call-name',
                gender: '.us-gender', pronouns: '.us-pronouns', birthday: '.us-birthday',
                virtualCity: '.us-virtual-city', realCityMap: '.us-real-city', signature: '.us-signature',
                hobbies: '.us-hobbies', dislikes: '.us-dislikes', persona: '.us-persona',
                appearancePrompt: '.us-appearance',
              };
              entries.forEach(({ id, value }) => {
                const input = container.querySelector(selectorById[id]);
                if (input) input.value = value;
              });
              syncFormToUser();
              showToast(`已填入 ${entries.length} 项，记得保存`);
            },
            onError: (error) => showToast(String(error?.message || error)),
          });
        },
        onError: (error) => showToast(String(error?.message || error)),
      });
    });
    container.querySelector('[data-slot-manage]')?.addEventListener('click', openSlotManagement);
    container.querySelector('[data-slot-switch]')?.addEventListener('click', async () => {
      syncFormToUser();
      const groups = groupUsersBySlot(slots, user.id);
      const currentGroupId = String(user.slotGroupId || user.id).trim();
      const current = groups.find((slot) => slot.id === currentGroupId) || null;
      const picked = await openOptionPicker({
        title: '切换档位',
        items: groups.map((slot) => ({
          id: slot.primary.id,
          label: slot.primary.slotName || slot.primary.name || '未命名档位',
        })),
        preselected: current?.primary?.id ? [current.primary.id] : [],
      });
      if (!picked || picked === current?.primary?.id) return;
      try {
        await switchToSlot(picked);
      } catch (error) {
        showToast(String(error?.message || error));
      }
    });
    container.querySelector('.us-virtual-city')?.addEventListener('input', () => renderWeatherStatus());
    container.querySelector('.us-real-city')?.addEventListener('input', () => renderWeatherStatus());
    container.querySelector('.us-weather-check')?.addEventListener('click', async () => {
      const btn = container.querySelector('.us-weather-check');
      const info = getEffectiveWeatherCityForUser({
        ...user,
        virtualCity: getVal(container, '.us-virtual-city'),
        realCityMap: getVal(container, '.us-real-city'),
      });
      if (!info.weatherCity) {
        showToast('请先填写映射现实城市或所在城市');
        renderWeatherStatus();
        return;
      }
      if (btn) btn.disabled = true;
      renderWeatherStatus('正在检测…');
      try {
        const weather = await fetchWeatherForCity(info.weatherCity);
        const hint = summarizeWeatherForHint(weather);
        const weatherInput = container.querySelector('.us-weather');
        if (weatherInput && hint) weatherInput.value = hint.slice(0, 120);
        const sourceLabel = weatherSourceLabel(weather);
        renderWeatherStatus(hint ? `${sourceLabel}：${summarizeWeatherDisplay(weather)}` : '已确认城市可用于天气');
        showToast(sourceLabel);
      } catch (err) {
        renderWeatherStatus();
        showToast(String(err?.message || '天气检测失败'));
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    const myPlaceInput = container.querySelector('.us-my-place');
    const myPlaceResults = container.querySelector('.user-space-my-place-results');
    myPlaceInput?.addEventListener('input', () => {
      // 手动改了文字，之前搜到的坐标/地址就不再对应，清掉避免路程算错地方。
      user.myPlaceAddress = '';
      user.myPlaceLocation = '';
      if (myPlaceResults) { myPlaceResults.hidden = true; myPlaceResults.innerHTML = ''; }
      renderMyPlaceStatus();
    });
    container.querySelector('.us-my-place-search')?.addEventListener('click', async () => {
      const keyword = getVal(container, '.us-my-place');
      if (!keyword) {
        showToast('先填一个地点关键词');
        return;
      }
      const cfg = await loadAmapConfig().catch(() => null);
      if (!cfg?.enabled || !cfg?.apiKey) {
        showToast('未开启高德，直接手打地点文字也能用');
        return;
      }
      const btn = container.querySelector('.us-my-place-search');
      if (btn) btn.disabled = true;
      renderMyPlaceStatus('搜索中…');
      try {
        const result = await amapTextSearch({ keywords: keyword, maxResults: 5 });
        const pois = Array.isArray(result?.pois) ? result.pois : [];
        if (!pois.length) {
          renderMyPlaceStatus('没搜到，试试换个关键词，或直接留文字');
          if (myPlaceResults) { myPlaceResults.hidden = true; myPlaceResults.innerHTML = ''; }
          return;
        }
        if (myPlaceResults) {
          myPlaceResults.hidden = false;
          myPlaceResults.innerHTML = pois.map((poi, idx) => `
            <button type="button" class="user-space-my-place-item" data-idx="${idx}">
              <strong>${esc(poi.name)}</strong>
              <small>${esc(poi.address || poi.district || '')}</small>
            </button>
          `).join('');
          myPlaceResults.querySelectorAll('[data-idx]').forEach((item) => {
            item.addEventListener('click', () => {
              const poi = pois[Number(item.dataset.idx || 0)];
              if (!poi) return;
              user.myPlaceLabel = poi.name || keyword;
              user.myPlaceAddress = poi.address || poi.district || '';
              user.myPlaceLocation = poi.location || '';
              if (myPlaceInput) myPlaceInput.value = user.myPlaceLabel;
              myPlaceResults.hidden = true;
              myPlaceResults.innerHTML = '';
              renderMyPlaceStatus();
              showToast('已选点');
            });
          });
        }
        renderMyPlaceStatus(`找到 ${pois.length} 个结果，点一个确认`);
      } catch (err) {
        renderMyPlaceStatus();
        showToast(String(err?.message || '搜索失败'));
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('.user-space-save')?.addEventListener('click', () => {
      saveForm().catch((err) => showToast(String(err?.message || err)));
    });
    container.querySelector('.user-space-save-top')?.addEventListener('click', () => {
      saveForm().catch((err) => showToast(String(err?.message || err)));
    });

    const colorInput = container.querySelector('.us-bubble-color');
    const colorText = container.querySelector('.us-bubble-color-text');
    colorInput?.addEventListener('input', () => {
      if (colorText) colorText.value = colorInput.value;
    });
    colorText?.addEventListener('input', () => {
      if (colorInput && /^#[0-9a-f]{6}$/i.test(colorText.value)) colorInput.value = colorText.value;
    });
    container.querySelector('.us-bubble-color-clear')?.addEventListener('click', () => {
      if (colorText) colorText.value = '';
    });

    const avatarFile = container.querySelector('.us-avatar-file');
    container.querySelector('.user-space-avatar-upload-btn')?.addEventListener('click', () => {
      avatarFile?.click();
    });
    avatarFile?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        syncFormToUser();
        const result = await fileToCroppedOptimizedAvatarDataUrl(file);
        if (!result) return;
        user.avatar = result.dataUrl || '';
        paint();
        showToast('头像已更新');
      } catch (err) {
        showToast(String(err?.message || err));
      } finally {
        e.target.value = '';
      }
    });
    container.querySelector('.us-avatar-url-apply')?.addEventListener('click', () => {
      try {
        syncFormToUser();
        const url = normalizeAvatarUrlInput(getVal(container, '.us-avatar-url'));
        if (!url) {
          showToast('请先粘贴图片 URL');
          container.querySelector('.us-avatar-url')?.focus();
          return;
        }
        user.avatar = url;
        paint();
        showToast('头像已更新');
      } catch (err) {
        showToast(String(err?.message || err));
      }
    });
    container.querySelector('.us-avatar-clear')?.addEventListener('click', () => {
      syncFormToUser();
      user.avatar = '';
      paint();
      showToast('已清除头像');
    });
    container.querySelector('.us-avatar-save')?.addEventListener('click', (e) => {
      saveImageToDevice(user.avatar, e.currentTarget);
    });

    const lockHost = container.querySelector('[data-lock]');
    if (lockHost) {
      const body = lockHost.querySelector('[data-lock-body]');
      const seedRow = lockHost.querySelector('[data-lock-seed-row]');
      const refreshLockRefUi = () => {
        const refRow = lockHost.querySelector('[data-lock-ref-row]');
        if (!refRow) return;
        const refUrl = String(user.imageLock?.refImageUrl || '').trim();
        const preview = refUrl || String(user.avatar || '').trim();
        const previewEl = refRow.querySelector('[data-lock-ref-preview]');
        if (previewEl) {
          previewEl.innerHTML = preview
            ? `<img src="${esc(preview)}" alt="锁定参考图">`
            : '<span>暂无参考图</span>';
        }
        const hintEl = refRow.querySelector('[data-lock-ref-hint]');
        if (hintEl) {
          hintEl.textContent = refUrl
            ? '已设置专属参考图'
            : '暂用当前头像；建议上传或用「生成预览」锁定一张更准的参考图';
        }
        const clearBtn = refRow.querySelector('[data-lock-ref-clear]');
        if (clearBtn) clearBtn.hidden = !refUrl;
      };
      lockHost.querySelector('[data-lock-mode]')?.addEventListener('change', (e) => {
        const mode = e.target.value;
        if (body) body.hidden = mode === 'none';
        if (seedRow) seedRow.hidden = mode !== 'seed';
        const promptField = lockHost.querySelector('[data-lock-prompt]');
        if (promptField) promptField.hidden = mode === 'reference';
        const refRow = lockHost.querySelector('[data-lock-ref-row]');
        if (refRow) refRow.hidden = mode !== 'reference';
        const note = lockHost.querySelector('[data-lock-note]');
        if (note) note.hidden = mode !== 'reference';
        syncLockFromDom();
      });
      lockHost.querySelectorAll('[data-lock-prompt],[data-lock-seed]').forEach((el) => {
        el.addEventListener('input', syncLockFromDom);
      });
      lockHost.querySelector('.us-lock-ref-file')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const result = await fileToCroppedOptimizedAvatarDataUrl(file, { title: '裁剪参考图', shape: 'square' });
          if (!result) return;
          user.imageLock = normalizeImageLock({ ...(user.imageLock || {}), refImageUrl: result.dataUrl });
          refreshLockRefUi();
          showToast('参考图已更新，记得保存');
        } catch (err) {
          showToast(`上传失败：${(err && err.message) || err}`);
        }
        e.target.value = '';
      });
      lockHost.querySelector('[data-lock-ref-clear]')?.addEventListener('click', () => {
        user.imageLock = normalizeImageLock({ ...(user.imageLock || {}), refImageUrl: '' });
        refreshLockRefUi();
        showToast('已改用当前头像做参考图');
      });
      lockHost.querySelector('[data-lock-gen]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        syncFormToUser();
        const lock = normalizeImageLock(user.imageLock);
        if (lock.mode === 'reference' && !resolveUserImageLockRefUrl(user)) {
          showToast('参考图锁定需要先上传参考图或设置头像');
          return;
        }
        const appearance = String(user.appearancePrompt || '').trim();
        const fallbackPrompt = appearance || 'portrait of a person, upper body';
        const promptText = (lock.mode !== 'reference' ? (lock.prompt || '').trim() : '') || fallbackPrompt;
        if (!promptText) {
          showToast('先写「生图外观描述」或锁定提示词');
          return;
        }
        const prev = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = '生成中…';
        try {
          const locked = await applyUserImageLock(user, promptText, { forcePortrait: true });
          const r = await generateCharacterImage(locked.prompt, {
            seed: locked.seed,
            refImageUrls: locked.refImageUrls,
            styleId: locked.styleId,
            providerOverride: locked.providerOverride,
          });
          if (r?.referenceSkipped) showToast('参考图锁定未生效，已改纯文生图', 5000);
          let url = String(r?.url || '');
          if (!url) throw new Error('未拿到图片数据');
          if (locked.seed != null) {
            const seedInput = lockHost.querySelector('[data-lock-seed]');
            if (seedInput && !seedInput.value) {
              seedInput.value = String(locked.seed);
              syncLockFromDom();
            }
          }
          url = await persistGeneratedImageUrlLocally(url).catch(() => url);
          const storedPortraitUrl = await optimizeImageDataUrlForNovelAiReference(url).catch(() => url);
          openUserDrawPreview(url, {
            onUseAvatar: () => {
              user.avatar = storedPortraitUrl;
              paint();
              showToast('已设为头像，记得保存');
            },
            onUseRef: () => {
              user.imageLock = normalizeImageLock({ ...(user.imageLock || {}), refImageUrl: storedPortraitUrl });
              paint();
              showToast('已设为锁定参考图，记得保存');
            },
          });
        } catch (err) {
          showToast(`生成失败：${String((err && err.message) || err).slice(0, 140)}`);
        } finally {
          btn.disabled = false;
          btn.innerHTML = prev;
        }
      });
    }

    const videoAvatarFile = container.querySelector('.us-video-avatar-file');
    const videoAvatarInput = container.querySelector('.us-video-avatar-url');
    const videoAvatarPreview = container.querySelector('.user-space-video-avatar-preview');
    const syncVideoAvatarPreview = () => {
      const url = String(videoAvatarInput?.value || '').trim();
      if (!videoAvatarPreview) return;
      videoAvatarPreview.classList.toggle('is-empty', !url);
      videoAvatarPreview.innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<span>未设置</span>';
    };
    videoAvatarInput?.addEventListener('input', syncVideoAvatarPreview);
    container.querySelector('.us-video-avatar-upload')?.addEventListener('click', () => {
      videoAvatarFile?.click();
    });
    videoAvatarFile?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        syncFormToUser();
        const { dataUrl } = await fileToOptimizedChatImageDataUrl(file);
        user.videoAvatar = dataUrl || '';
        if (videoAvatarInput) videoAvatarInput.value = user.videoAvatar;
        syncVideoAvatarPreview();
        showToast('视频形象已填入，记得保存');
      } catch (err) {
        showToast(`上传失败：${err?.message || err}`);
      } finally {
        e.target.value = '';
      }
    });
    container.querySelector('.us-video-avatar-clear')?.addEventListener('click', () => {
      syncFormToUser();
      user.videoAvatar = '';
      if (videoAvatarInput) videoAvatarInput.value = '';
      syncVideoAvatarPreview();
      showToast('已清除视频形象');
    });

  }

  paint();
}
