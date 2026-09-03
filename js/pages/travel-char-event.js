import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { openChatBubbleMenu, bindLongPress } from '../components/chat-bubble-menu.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { captureElementScrollState, restoreElementScrollState } from '../core/scroll-state.js';
import { getCharacter } from '../core/character-store.js';
import { getUserDisplayName } from '../models/user.js';
import { ensurePrivateChat } from '../core/chat-store.js';
import { openTravelReelViewer } from '../components/travel-reel-viewer.js';
import { renderNarrationTextWithTranslations, bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { stripLeakedCharacterCodes } from '../core/chat/character-code-fallback.js';
import {
  TRAVEL_THEME_PRESETS,
  TRAVEL_POSTCARD_STYLES,
  cancelTravelCharTrip,
  captureCheckpointPhoto,
  createTravelCharTrip,
  deleteTravelCharTrip,
  finishTravelCharTrip,
  listTravelCharTrips,
  markTravelCharTripNotificationsRead,
  postCheckpointAskUserToChat,
  regenerateTravelPostcardImage,
  resolveCheckpointChoice,
  saveTravelCharTrip,
  syncTravelCharTrips,
  updateTravelPostcardPrompt,
} from '../core/travel-char.js';
import { resolveImageProviderForScene, loadImageToolConfig } from '../core/image-generation-tools.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 一趟旅行的回忆胶卷：途中拍到的实景照 + 归来明信片，按发生顺序排。
function tripGalleryImages(trip) {
  if (!trip) return [];
  const images = [];
  (trip.checkpoints || []).forEach((cp) => {
    if (cp.capturedPhoto?.image) {
      images.push({
        src: cp.capturedPhoto.image,
        caption: cp.placeName || cp.title || '',
        sub: Number(cp.dayIndex) > 0 ? `第 ${Number(cp.dayIndex) + 1} 天` : '',
      });
    }
  });
  if (trip.postcard?.image) {
    images.push({ src: trip.postcard.image, caption: trip.postcard.title || '归来明信片' });
  }
  return images;
}

function formatLeft(ms) {
  const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  if (total <= 0) return '现在';
  const min = Math.floor(total / 60);
  const sec = total % 60;
  const hour = Math.floor(min / 60);
  const restMin = min % 60;
  if (hour > 0) return `${hour}小时${restMin}分`;
  if (min > 0) return `${min}分${sec}秒`;
  return `${sec}秒`;
}

function formatClock(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function checkpointDueAt(trip, cp) {
  const depart = Number(trip.departAt || trip.createdAt || Date.now()) || Date.now();
  return depart + Number(cp.offsetMinutes || 0) * 60000;
}

function tripProgress(trip) {
  const now = Date.now();
  const stopped = trip.status === 'returned' || trip.status === 'terminated';
  const cps = Array.isArray(trip.checkpoints) ? trip.checkpoints : [];
  const next = stopped ? null : cps.find((cp) => checkpointDueAt(trip, cp) > now);
  if (next) return { target: checkpointDueAt(trip, next), label: '下一段' };
  if (trip.status === 'away') return { target: Number(trip.expectedReturnAt || now), label: '归来' };
  if (trip.status === 'returned') return { target: 0, label: '已归来' };
  if (trip.status === 'terminated') return { target: 0, label: '已终止' };
  return { target: 0, label: '未出发' };
}

function stageClass(trip, cp) {
  if (trip.status === 'returned' || trip.status === 'terminated') return 'is-open';
  return checkpointDueAt(trip, cp) <= Date.now() ? 'is-open' : 'is-locked';
}

function tripUserName(trip, fallback = '用户') {
  // 老行程的 userDisplayName 可能存了裸「我」，会和角色第一人称撞车，统一回落「用户」。
  const raw = String(trip.invite?.userDisplayName || fallback || '').trim();
  return raw && raw !== '我' && raw !== '我自己' ? raw : '用户';
}

function inviteText(trip, preset, userName = '我') {
  const bits = [preset.label || '旅行'];
  if ((trip.invite?.companionNames || []).length) bits.push(`同行 ${trip.invite.companionNames.join('、')}`);
  if (trip.withUser) bits.push(`${tripUserName(trip, userName)}同行`);
  return `邀请已送达 · ${bits.join(' · ')}`;
}

function routeStopsHtml(trip) {
  const stops = Array.isArray(trip.route?.stops) ? trip.route.stops : [];
  if (!stops.length) return '';
  return `
    <div class="travel-event-stops">
      ${stops.slice(0, 4).map((stop, idx) => `
        <span>
          <b>${idx + 1}</b>
          ${esc(stop.placeName || stop.address || stop.district || '地点')}
        </span>
      `).join('')}
    </div>
  `;
}

function departureCardMediaHtml(departureCard, character) {
  const image = String(departureCard?.image || '').trim();
  // 历史数据曾被 clean(800) 截断，data URL 不完整会直接裂图。
  const imageLikelyValid = image && !image.endsWith('…') && (!/^data:image\//i.test(image) || image.length > 1200);
  if (imageLikelyValid) {
    return `<img class="travel-departure-card-img" src="${esc(image)}" alt="" data-departure-card-img>`;
  }
  if (character) {
    return characterAvatarHtml(character, { className: 'travel-departure-card-avatar' });
  }
  return '<span class="travel-departure-card-mark">✦</span>';
}

function participantsText(trip, character, userName = '我') {
  const companionIds = trip.invite?.companionIds || [];
  const companionNames = trip.invite?.companionNames || [];
  const joinedIds = trip.invite?.companionJoinedIds || [];
  const joinedNames = joinedIds.length
    ? joinedIds.map((id) => {
      const idx = companionIds.indexOf(id);
      return idx >= 0 ? companionNames[idx] : '';
    }).filter(Boolean)
    : companionNames.filter(Boolean);
  const names = [
    character?.customNickname || character?.name || trip.characterNames?.[0] || 'TA',
    ...joinedNames,
  ];
  if (trip.withUser) names.push(tripUserName(trip, userName));
  return names.filter(Boolean).join('、');
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const userName = getUserDisplayName(user);
  const characterId = String(params.character || params.characterId || '').trim();
  const tripId = String(params.id || '').trim();
  // 主题留空/传 'random' 时交给 createTravelCharTrip 按人设加权随机抽，不再兜底成固定的"观鸟"。
  const rawTheme = String(params.theme || '').trim();
  const theme = TRAVEL_THEME_PRESETS[rawTheme] ? rawTheme : '';
  // 目的地可选：用户在创建面板填了具体地名就带过来；留空则照旧按角色当前定位自动推断。
  const destinationOverride = String(params.destination || '').trim().slice(0, 60);
  const withUser = String(params.withUser || '') === '1';
  const coTravelMode = withUser && String(params.coTravelMode || '') === 'parallel' ? 'parallel' : 'together';
  const lengthMode = String(params.lengthMode || '') === 'extended' ? 'extended' : 'quick';
  const durationDays = lengthMode === 'extended' ? Math.max(1, Math.min(7, Number(params.durationDays || 3) || 3)) : 0;
  const companionIds = String(params.companions || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 5);
  const imagePrefs = {
    showCharacter: String(params.showCharacter || '') === '1',
    showUserPresence: withUser && String(params.showUserPresence || '') === '1',
    styleMode: String(params.imageStyle || '').trim(),
    styleId: String(params.styleId || '').trim(),
    allowPeople: String(params.allowPeople || '') === '1',
    customStyleSuffix: String(params.styleSuffix || '').trim().slice(0, 300),
    identitySafety: 'no_identifiable_person',
    autoImageAllNodes: String(params.autoImageAllNodes || '') === '1',
  };

  container.className = 'page scrapbook-page travel-event-page';

  let character = characterId ? await getCharacter(characterId).catch(() => null) : null;
  let trip = null;
  let activeCharacterId = characterId;
  let busy = false;
  let timer = null;
  let postcardSide = 'front';
  let imageGenEnabled = false;

  async function refreshImageGenEnabled() {
    const cfg = await loadImageToolConfig().catch(() => null);
    imageGenEnabled = !!(cfg && resolveImageProviderForScene('travelImages', cfg));
    return imageGenEnabled;
  }

  function postcardToolsHtml(trip, preset) {
    if (trip.status !== 'returned' || !trip.postcard) return '';
    const returnLabel = preset.collectibleLabel || '明信片';
    const styleId = trip.postcard.styleId || preset.postcardStyleId || 'watercolor_cartoon';
    const styleOptions = Object.entries(TRAVEL_POSTCARD_STYLES).map(([id, style]) => (
      `<option value="${esc(id)}" ${id === styleId ? 'selected' : ''}>${esc(style.label)}</option>`
    )).join('');
    const hasImage = !!trip.postcard.image;
    return `
      <div class="travel-postcard-tools">
        <label class="travel-postcard-style-field">
          <span>${esc(returnLabel)}风格</span>
          <select class="travel-postcard-style-select" ${busy ? 'disabled' : ''}>${styleOptions}</select>
        </label>
        <div class="travel-postcard-tool-actions">
          <button type="button" class="btn btn-outline btn-sm travel-postcard-generate" ${busy || !imageGenEnabled ? 'disabled' : ''}>
            ${icon('image')} ${hasImage ? '换一张' : '生成图片'}
          </button>
          <button type="button" class="btn btn-soft btn-sm travel-postcard-edit-prompt" ${busy ? 'disabled' : ''}>改 prompt</button>
        </div>
        ${!imageGenEnabled ? '<small class="travel-postcard-tools-hint">生图未开启，请先在 API 设置里配置图像生成</small>' : ''}
        ${hasImage ? '' : '<small class="travel-postcard-tools-hint">归来时会自动尝试生图；没出图可在这里手动生成</small>'}
      </div>
    `;
  }

  function renderShell(body, title = '旅行事件', showMenu = false) {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${esc(title)}</h1>
        <div class="travel-navbar-actions">
          ${showMenu ? `<button type="button" class="navbar-btn" data-trip-menu aria-label="旅行操作">${icon('more')}</button>` : ''}
          <button type="button" class="navbar-btn" data-home aria-label="旅行char">${icon('pin')}</button>
        </div>
      </header>
      ${body}
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-home]')?.addEventListener('click', () => navigate('travel-char'));
    container.querySelector('[data-trip-menu]')?.addEventListener('click', onTripMenu);
    bindNarrationTranslationToggle(container);
  }

  async function onTripMenu() {
    if (!trip) return;
    const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
    const actions = [];
    if (trip.status === 'away') {
      actions.push({
        label: '终止这趟旅行',
        onClick: async () => {
          trip = await cancelTravelCharTrip({ userId: user.id, characterId: activeCharacterId, tripId: trip.id }).catch((err) => {
            showToast(err?.message || '终止失败');
            return trip;
          });
          showToast('已终止这趟旅行');
          renderTrip();
        },
      });
    }
    actions.push({
      label: '删除这条记录',
      variant: 'danger',
      onClick: async () => {
        if (!window.confirm(`删除「${trip.title || preset.label || '这趟旅行'}」的记录？已经带回的收集物和共同记忆不会被删除。`)) return;
        await deleteTravelCharTrip({ userId: user.id, characterId: activeCharacterId, tripId: trip.id }).catch((err) => {
          showToast(err?.message || '删除失败');
          return null;
        });
        showToast('已删除旅行记录');
        navigate('travel-char', {}, true);
      },
    });
    openChatRowSheet({
      chatTitle: trip.title || preset.label || '旅行记录',
      actions,
    });
  }

  function renderLoading() {
    const preset = TRAVEL_THEME_PRESETS[theme] || {};
    const bits = [preset.label || '旅行'];
    if (companionIds.length) bits.push(`${companionIds.length} 位同行`);
    if (withUser) bits.push(`${userName}同行`);
    renderShell(`
      <main class="travel-event-scroll scrapbook-scroll">
        <section class="travel-event-dialog">
          <div class="travel-event-avatar">
            ${character ? characterAvatarHtml(character, { className: 'travel-event-avatar-img' }) : emptyIllustration('chat')}
          </div>
          <div class="travel-bubbles">
            <div class="travel-bubble is-user">${esc(`邀请已送达 · ${bits.join(' · ')}`)}</div>
            <div class="travel-bubble is-char is-thinking">
              <span class="travel-dot"></span><span class="travel-dot"></span><span class="travel-dot"></span>
            </div>
          </div>
        </section>
        <section class="travel-event-loader">
          <div class="travel-loader-map"><span></span><span></span><span></span></div>
          <strong>正在等 TA 回应</strong>
        </section>
      </main>
    `, '发出邀请');
  }

  // checkpoint 自带的互动：choice 选完直接揭开预写好的分支（不再调用生成）；
  // ask_user 把提问原样发进真实私聊，回答走真实聊天记忆；photo 是用户主动触发的一次实景生图。
  function checkpointInteractionHtml(cp) {
    const interaction = cp.interaction || { type: 'none' };
    if (interaction.type === 'choice') {
      if (cp.resolvedOptionId || !interaction.options?.length) return '';
      return `
        <div class="travel-checkpoint-interaction">
          ${interaction.prompt ? `<p class="travel-interaction-prompt">${esc(interaction.prompt)}</p>` : ''}
          <div class="travel-choice-row">
            ${interaction.options.map((opt) => `
              <button type="button" class="travel-choice-btn" data-checkpoint-choice="${esc(cp.id)}" data-option="${esc(opt.id)}" ${busy ? 'disabled' : ''}>${esc(opt.label)}</button>
            `).join('')}
          </div>
        </div>
      `;
    }
    if (interaction.type === 'ask_user') {
      return `
        <div class="travel-checkpoint-interaction">
          <p class="travel-interaction-prompt">${esc(interaction.prompt || 'TA 想问你点什么')}</p>
          <button type="button" class="btn btn-outline travel-ask-user-btn" data-checkpoint-ask="${esc(cp.id)}" ${busy ? 'disabled' : ''}>${cp.askedInChatAt ? '回到那条聊天' : '去聊天里回TA'}</button>
        </div>
      `;
    }
    return '';
  }

  // 任意已解锁 checkpoint 都能手动生图 + 重roll，不再局限于 interaction.type === 'photo'。
  function checkpointImageActionHtml(cp) {
    const hasImage = !!cp.capturedPhoto?.image;
    return `
      <div class="travel-checkpoint-interaction travel-checkpoint-image-action${hasImage ? ' is-done' : ''}">
        ${hasImage ? `<span class="travel-interaction-done">${icon('check')} 已生成，回忆胶卷里能看</span>` : ''}
        <button type="button" class="btn btn-outline btn-sm travel-photo-btn" data-checkpoint-photo="${esc(cp.id)}" ${busy ? 'disabled' : ''}>${icon('image')} ${hasImage ? '换一张' : '生成图片'}</button>
      </div>
    `;
  }

  function progressCardHtml(cp, idx, locked = false) {
    const cls = stageClass(trip, cp);
    const due = checkpointDueAt(trip, cp);
    const open = !locked && cls === 'is-open';
    return `
      <article class="travel-progress-card ${open ? 'is-open' : 'is-locked'}">
        <div class="travel-progress-head">
          <span>${open ? icon('check') : icon('time')}</span>
          <div>
            <strong>${esc(cp.title || `节点 ${idx + 1}`)}</strong>
            <small>${open ? formatClock(due) : `还有 ${formatLeft(due - Date.now())}`}</small>
          </div>
        </div>
        ${open ? `
          <p>${cp.body ? renderNarrationTextWithTranslations(cp.body) : esc('TA 在路上停了一下。')}</p>
          <div class="travel-progress-photo">
            ${trip.route?.mapImage ? `<img src="${esc(trip.route.mapImage)}" alt="">` : '<div class="travel-fake-map"><span></span><span></span><span></span></div>'}
          </div>
          <div class="travel-stage-tags">
            ${cp.placeName ? `<span>${icon('pin')} ${esc(cp.placeName)}</span>` : ''}
            ${cp.mood ? `<span>${esc(cp.mood)}</span>` : ''}
            ${cp.collectibleHint ? `<span>${esc(cp.collectibleHint)}</span>` : ''}
          </div>
          ${checkpointInteractionHtml(cp)}
          ${checkpointImageActionHtml(cp)}
        ` : `
          <p class="travel-locked-text">还没到这一段。</p>
        `}
      </article>
    `;
  }

  // AI 偶尔会把角色内部 id 直接当名字/抄进台词（上下文里给模型看过 (id=xxx) 提示），
  // 这里按主角色 + 同行角色兜底建一份 id → 名字映射，渲染前替换掉。
  function travelCharCodeFallbackOptions() {
    const characters = {};
    const mainId = String(trip?.characterIds?.[0] || character?.id || '').trim();
    const mainName = String(character?.customNickname || character?.name || trip?.characterNames?.[0] || '').trim();
    if (mainId && mainName) characters[mainId] = { name: mainName };
    const companionIds = trip?.invite?.companionIds || [];
    const companionNames = trip?.invite?.companionNames || [];
    companionIds.forEach((id, idx) => {
      const cid = String(id || '').trim();
      const cname = String(companionNames[idx] || '').trim();
      if (cid && cname) characters[cid] = { name: cname };
    });
    return { characters, userName };
  }

  function chatBubbleHtml(item) {
    const role = item.role || 'character';
    if (role === 'progress') return progressCardHtml(item.checkpoint, item.index, item.locked);
    const cls = role === 'user' ? 'is-user' : 'is-char';
    const codeFallback = travelCharCodeFallbackOptions();
    const name = role === 'user' ? userName : stripLeakedCharacterCodes(item.senderName || 'TA', codeFallback);
    const text = stripLeakedCharacterCodes(item.text || '', codeFallback);
    const editable = item.id && item.persisted !== false;
    return `
      <div class="travel-chat-row ${cls}" ${editable ? `data-event-chat-id="${esc(item.id)}"` : ''}>
        <div class="travel-chat-meta">${esc(name)}</div>
        <button type="button" class="travel-bubble ${cls} ${editable ? 'is-editable' : ''}" ${editable ? `data-event-chat-id="${esc(item.id)}"` : ''}>${esc(text)}</button>
      </div>
    `;
  }

  function activityFeedHtml(accepted) {
    const now = Date.now();
    const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
    const items = [
      {
        role: 'user',
        senderName: userName,
        text: inviteText(trip, preset, userName),
        persisted: false,
        createdAt: Number(trip.createdAt || now) || now,
      },
      {
        role: 'character',
        senderName: character?.customNickname || character?.name || trip.characterNames?.[0] || 'TA',
        text: trip.decision?.reply || (accepted ? '好突然，不过也行。' : '这次先不了。'),
        persisted: false,
        createdAt: Number(trip.createdAt || now) + 1000,
      },
      ...(trip.decision?.companionReactions || []).filter((item) => item.reply).map((item, idx) => ({
        role: 'character',
        senderName: item.name || '同行',
        text: item.reply,
        persisted: false,
        createdAt: Number(trip.createdAt || now) + 1400 + idx,
      })),
      ...(trip.eventChat || []).map((item) => ({
        ...item,
        role: item.role || (item.senderId === 'user' ? 'user' : 'character'),
        createdAt: Number(item.createdAt || now) || now,
      })),
    ];

    if (accepted) {
      (trip.checkpoints || []).forEach((cp, idx) => {
        const due = checkpointDueAt(trip, cp);
        const open = trip.status === 'returned' || due <= now;
        if (open) {
          items.push({
            role: 'progress',
            checkpoint: cp,
            index: idx,
            locked: false,
            createdAt: open ? due : now + 10 + idx,
          });
        }
      });
    }

    return `
      <section class="travel-activity-chat" aria-live="polite">
        ${items
    .filter((item) => item.role === 'progress' || item.text)
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .map(chatBubbleHtml)
    .join('')}
        ${busy ? `
          <div class="travel-chat-row is-char">
            <div class="travel-chat-meta">活动中</div>
            <div class="travel-bubble is-char is-thinking">
              <span class="travel-dot"></span><span class="travel-dot"></span><span class="travel-dot"></span>
            </div>
          </div>
        ` : ''}
      </section>
    `;
  }

  async function renderTrip() {
    await refreshImageGenEnabled().catch(() => null);
    const scrollState = captureElementScrollState(container, '.travel-event-scroll');
    const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
    const progress = tripProgress(trip);
    const countdown = progress.target ? formatLeft(progress.target - Date.now()) : '';
    const title = trip.title || preset.label || '旅行事件';
    const accepted = trip.decision?.accepted !== false && trip.status !== 'cancelled';
    const canFinish = trip.status === 'away' && Number(trip.expectedReturnAt || 0) <= Date.now();
    const returnLabel = preset.collectibleLabel || '明信片';
    const galleryImages = tripGalleryImages(trip);

    renderShell(`
      <main class="travel-event-scroll scrapbook-scroll">
        <section class="travel-event-board">
          <div class="travel-event-title">
            <strong>${esc(title)}</strong>
            <small>${esc(participantsText(trip, character, userName) || trip.city || trip.route?.summary || '附近')}</small>
          </div>
          <div class="travel-countdown ${trip.status}">
            <span>${esc(progress.label)}</span>
            <strong>${esc(countdown || (trip.status === 'returned' ? '已完成' : trip.status === 'terminated' ? '已终止' : '待定'))}</strong>
          </div>
          ${trip.departureCard ? `
            <div class="travel-departure-card">
              ${departureCardMediaHtml(trip.departureCard, character)}
              <em>${esc(trip.departureCard.text || '准备出发了')}</em>
            </div>
          ` : ''}
          ${routeStopsHtml(trip)}
          ${trip.route?.mapImage ? `<img class="travel-map-img" src="${esc(trip.route.mapImage)}" alt="">` : '<div class="travel-fake-map"><span></span><span></span><span></span></div>'}
        </section>

        ${galleryImages.length ? `
          <section class="travel-panel travel-reel-panel">
            <div class="travel-section-title">回忆胶卷</div>
            <div class="travel-reel-strip-preview">
              ${galleryImages.map((img, idx) => `
                <button type="button" class="travel-reel-thumb-btn" data-idx="${idx}" aria-label="${esc([img.caption, img.sub].filter(Boolean).join(' · ') || '查看照片')}">
                  <img src="${esc(img.src)}" alt="" loading="lazy">
                </button>
              `).join('')}
            </div>
          </section>
        ` : ''}

        ${accepted ? activityFeedHtml(accepted) : `
          <section class="travel-event-empty">
            ${emptyIllustration('message')}
            <strong>${esc(trip.decision?.reason || 'TA 这次没有出发')}</strong>
          </section>
        `}

        ${trip.status === 'returned' ? `
          <section class="travel-return-card travel-postcard is-${esc(postcardSide)}">
            <div class="travel-postcard-front travel-polaroid">
              <span class="travel-trip-stamp">${esc(returnLabel)}</span>
              <div class="travel-polaroid-photo">${trip.postcard?.image ? `<img src="${esc(trip.postcard.image)}" alt="" data-postcard-view>` : ''}</div>
              <div class="travel-polaroid-caption">${esc(trip.postcard?.title || `${preset.label || '旅行'}${returnLabel}`)}</div>
            </div>
            <div class="travel-postcard-back">
              <strong>${esc(trip.postcard?.title || `${preset.label || '旅行'}${returnLabel}`)}</strong>
              <p>${esc(trip.postcard?.albumNote || trip.postcard?.summary || trip.returnSummary || '已经收进相册和共同记忆。')}</p>
              ${trip.memoryText ? `<small>${esc(trip.memoryText)}</small>` : ''}
            </div>
            <button type="button" class="travel-postcard-flip">${postcardSide === 'front' ? '翻到背面' : '翻到正面'}</button>
            ${postcardToolsHtml(trip, preset)}
          </section>
        ` : ''}
      </main>
      <footer class="travel-footer">
        ${accepted ? `
          <button type="button" class="btn btn-primary travel-find-chat">${icon('message')} 找TA聊聊</button>
        ` : ''}
        ${canFinish ? `<button type="button" class="btn btn-primary travel-finish">${icon('check')} 带回${esc(returnLabel)}</button>` : ''}
        ${trip.status === 'away' && !canFinish ? `<button type="button" class="btn btn-outline travel-wait" disabled>${icon('time')} 探索中</button>` : ''}
        ${trip.status !== 'away' ? `<button type="button" class="btn btn-primary travel-back-home">回到旅行char</button>` : ''}
      </footer>
    `, '旅行事件', true);

    container.querySelector('.travel-finish')?.addEventListener('click', onFinish);
    container.querySelector('.travel-back-home')?.addEventListener('click', () => navigate('travel-char'));
    container.querySelector('[data-departure-card-img]')?.addEventListener('error', (e) => {
      const img = e.currentTarget;
      if (!character) return;
      const holder = document.createElement('span');
      holder.innerHTML = characterAvatarHtml(character, { className: 'travel-departure-card-avatar' });
      const node = holder.firstElementChild;
      if (node) img.replaceWith(node);
    }, { once: true });
    container.querySelectorAll('.travel-reel-thumb-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openTravelReelViewer({ images: galleryImages, startIndex: Number(btn.getAttribute('data-idx')) || 0 });
      });
    });
    container.querySelector('[data-postcard-view]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const startIndex = Math.max(0, galleryImages.length - 1);
      openTravelReelViewer({ images: galleryImages, startIndex });
    });
    container.querySelector('.travel-postcard-front .travel-polaroid-photo img')?.addEventListener('click', () => {
      const idx = Math.max(0, galleryImages.findIndex((img) => img.src === trip.postcard?.image));
      openTravelReelViewer({ images: galleryImages, startIndex: idx });
    });
    container.querySelector('.travel-find-chat')?.addEventListener('click', async () => {
      const cid = activeCharacterId || character?.id || '';
      if (!cid) return;
      const chat = await ensurePrivateChat(user.id, cid, character?.customNickname || character?.name || '').catch(() => null);
      if (!chat) {
        showToast('打开聊天失败');
        return;
      }
      navigate('chat/thread', { chatId: chat.id });
    });
    container.querySelector('.travel-postcard-flip')?.addEventListener('click', () => {
      postcardSide = postcardSide === 'front' ? 'back' : 'front';
      renderTrip();
    });
    container.querySelector('.travel-postcard-style-select')?.addEventListener('change', async (e) => {
      if (busy || !trip || !activeCharacterId) return;
      const styleId = String(e.target.value || '').trim();
      if (!styleId || !TRAVEL_POSTCARD_STYLES[styleId]) return;
      busy = true;
      renderTrip();
      try {
        trip = await updateTravelPostcardPrompt({
          userId: user.id,
          characterId: activeCharacterId,
          tripId: trip.id,
          styleId,
        });
        showToast('已切换风格');
      } catch (err) {
        showToast(err?.message || '切换失败');
      } finally {
        busy = false;
        renderTrip();
      }
    });
    container.querySelector('.travel-postcard-generate')?.addEventListener('click', onRegeneratePostcard);
    container.querySelector('.travel-postcard-edit-prompt')?.addEventListener('click', onEditPostcardPrompt);
    container.querySelectorAll('[data-checkpoint-choice]').forEach((btn) => {
      btn.addEventListener('click', () => onResolveCheckpointChoice(
        btn.getAttribute('data-checkpoint-choice') || '',
        btn.getAttribute('data-option') || '',
      ));
    });
    container.querySelectorAll('[data-checkpoint-ask]').forEach((btn) => {
      btn.addEventListener('click', () => onAskUserCheckpoint(btn.getAttribute('data-checkpoint-ask') || ''));
    });
    container.querySelectorAll('[data-checkpoint-photo]').forEach((btn) => {
      btn.addEventListener('click', () => onCaptureCheckpointPhoto(btn.getAttribute('data-checkpoint-photo') || ''));
    });
    bindEventBubbleMenus();
    restoreElementScrollState(container, '.travel-event-scroll', scrollState);
  }

  async function onRegeneratePostcard() {
    if (busy || !trip || !activeCharacterId) return;
    if (!imageGenEnabled) {
      showToast('请先在 API 设置里开启生图');
      return;
    }
    busy = true;
    renderTrip();
    try {
      trip = await regenerateTravelPostcardImage({
        userId: user.id,
        characterId: activeCharacterId,
        tripId: trip.id,
      });
      showToast(trip.postcard?.image ? '已生成图片' : '生成失败');
    } catch (err) {
      showToast(err?.message || '生成失败');
    } finally {
      busy = false;
      renderTrip();
    }
  }

  async function onEditPostcardPrompt() {
    if (busy || !trip || !activeCharacterId || !trip.postcard) return;
    const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
    const styleId = trip.postcard.styleId || preset.postcardStyleId || 'watercolor_cartoon';
    const fallback = trip.postcard.postcardImagePrompt || '';
    openTextEditorModal({
      title: `编辑${preset.collectibleLabel || '明信片'} prompt`,
      value: trip.postcard.imagePromptOverride || fallback,
      multiline: true,
      confirmLabel: '保存',
      onSave: async (next) => {
        const text = String(next || '').trim();
        trip = await updateTravelPostcardPrompt({
          userId: user.id,
          characterId: activeCharacterId,
          tripId: trip.id,
          imagePromptOverride: text,
          styleId,
        });
        showToast('已保存 prompt');
        renderTrip();
      },
    });
  }

  function openReturnCollectibleModal(returnedTrip) {
    const host = document.getElementById('modal-container');
    if (!host || !returnedTrip) return;
    const preset = TRAVEL_THEME_PRESETS[returnedTrip.theme] || {};
    const returnLabel = preset.collectibleLabel || '明信片';
    const title = returnedTrip.postcard?.title || `${preset.label || '旅行'}${returnLabel}`;
    const summary = returnedTrip.postcard?.albumNote || returnedTrip.postcard?.summary || returnedTrip.returnSummary || '已经收进旅行相册。';
    const image = returnedTrip.postcard?.image || '';
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-travel-return-overlay>
        <div class="modal-sheet scrapbook-card travel-return-modal" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>${esc(returnLabel)}已收录</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-travel-return-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body travel-return-modal-body">
            <div class="travel-return-modal-card">
              <span class="travel-trip-stamp">${esc(returnLabel)}</span>
              ${image ? `<img src="${esc(image)}" alt="">` : '<div class="travel-fake-map"><span></span><span></span><span></span></div>'}
              <strong>${esc(title)}</strong>
              <p>${esc(summary)}</p>
            </div>
            <div class="travel-return-modal-actions">
              ${imageGenEnabled ? `<button type="button" class="btn btn-outline" data-travel-return-generate>${icon('image')} ${image ? '换一张' : '生成图片'}</button>` : ''}
              <button type="button" class="btn btn-primary" data-travel-open-album>查看相册</button>
              <button type="button" class="btn btn-soft" data-travel-return-close>留在这里</button>
            </div>
            ${!imageGenEnabled ? '<small class="travel-postcard-tools-hint">生图未开启，请先在 API 设置里配置图像生成</small>' : ''}
          </div>
        </div>
      </div>
    `;
    const close = () => {
      host.innerHTML = '';
      host.classList.remove('active');
    };
    host.querySelectorAll('[data-travel-return-close]').forEach((btn) => btn.addEventListener('click', close));
    host.querySelector('[data-travel-return-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close();
    });
    host.querySelector('[data-travel-return-generate]')?.addEventListener('click', async () => {
      if (!imageGenEnabled || !returnedTrip?.id || !activeCharacterId) {
        showToast('请先在 API 设置里开启生图');
        return;
      }
      const btn = host.querySelector('[data-travel-return-generate]');
      if (btn) btn.disabled = true;
      try {
        trip = await regenerateTravelPostcardImage({
          userId: user.id,
          characterId: activeCharacterId,
          tripId: returnedTrip.id,
        });
        close();
        showToast('已生成图片');
        renderTrip();
      } catch (err) {
        showToast(err?.message || '生成失败');
        if (btn) btn.disabled = false;
      }
    });
    host.querySelector('[data-travel-open-album]')?.addEventListener('click', () => {
      close();
      navigate('memory/travel-album', { character: activeCharacterId });
    });
  }

  async function updateEventChatMessage(messageId, patch = {}) {
    const id = String(messageId || '').trim();
    if (!id || !trip) return;
    const nextChat = (trip.eventChat || []).map((item) => (
      item.id === id ? { ...item, ...patch } : item
    ));
    trip = await saveTravelCharTrip(user.id, { ...trip, eventChat: nextChat });
    renderTrip();
  }

  async function deleteEventChatMessage(messageId) {
    const id = String(messageId || '').trim();
    if (!id || !trip) return;
    trip = await saveTravelCharTrip(user.id, {
      ...trip,
      eventChat: (trip.eventChat || []).filter((item) => item.id !== id),
    });
    renderTrip();
  }

  function openEventBubbleActions(messageId, point) {
    const msg = (trip.eventChat || []).find((item) => item.id === messageId);
    if (!msg) return;
    openChatBubbleMenu({
      x: point?.x || window.innerWidth / 2,
      y: point?.y || window.innerHeight / 2,
      actions: [
        {
          label: '编辑气泡',
          onClick: () => openTextEditorModal({
            title: '编辑活动气泡',
            value: msg.text || '',
            multiline: true,
            confirmLabel: '保存',
            onSave: async (next) => {
              if (!next) return;
              await updateEventChatMessage(messageId, { text: next.slice(0, 260) });
            },
          }),
        },
        {
          label: '删除',
          danger: true,
          onClick: () => deleteEventChatMessage(messageId),
        },
      ],
    });
  }

  function bindEventBubbleMenus() {
    container.querySelectorAll('.travel-bubble.is-editable[data-event-chat-id]').forEach((bubble) => {
      const id = bubble.getAttribute('data-event-chat-id') || '';
      bubble.addEventListener('click', (e) => {
        e.preventDefault();
        openEventBubbleActions(id, { x: e.clientX, y: e.clientY });
      });
      bindLongPress(bubble, (point) => openEventBubbleActions(id, point));
    });
  }

  async function onResolveCheckpointChoice(checkpointId, optionId) {
    if (busy || !trip || !activeCharacterId || !checkpointId || !optionId) return;
    busy = true;
    renderTrip();
    try {
      trip = await resolveCheckpointChoice({
        userId: user.id,
        characterId: activeCharacterId,
        tripId: trip.id,
        checkpointId,
        optionId,
      });
    } catch (err) {
      showToast(`失败：${err?.message || err}`);
    } finally {
      busy = false;
      renderTrip();
    }
  }

  async function onAskUserCheckpoint(checkpointId) {
    if (busy || !trip || !activeCharacterId || !checkpointId) return;
    busy = true;
    renderTrip();
    try {
      const { trip: nextTrip, chat } = await postCheckpointAskUserToChat({
        userId: user.id,
        characterId: activeCharacterId,
        tripId: trip.id,
        checkpointId,
        characterName: character?.customNickname || character?.name || trip.characterNames?.[0] || '',
      });
      trip = nextTrip;
      navigate('chat/thread', { chatId: chat.id });
    } catch (err) {
      showToast(`失败：${err?.message || err}`);
      busy = false;
      renderTrip();
    }
  }

  async function onCaptureCheckpointPhoto(checkpointId) {
    if (busy || !trip || !activeCharacterId || !checkpointId) return;
    busy = true;
    renderTrip();
    try {
      trip = await captureCheckpointPhoto({
        userId: user.id,
        characterId: activeCharacterId,
        tripId: trip.id,
        checkpointId,
      });
      showToast('已生成图片');
    } catch (err) {
      showToast(`失败：${err?.message || err}`);
    } finally {
      busy = false;
      renderTrip();
    }
  }

  async function loadTrip() {
    if (!tripId) return null;
    if (characterId) await syncTravelCharTrips({ userId: user.id, characterId }).catch(() => null);
    const trips = await listTravelCharTrips(user.id, characterId).catch(() => []);
    const found = trips.find((item) => item.id === tripId) || null;
    if (found && !activeCharacterId) activeCharacterId = found.characterIds?.[0] || '';
    return found;
  }

  async function onFinish() {
    if (busy || !trip || !activeCharacterId) return;
    busy = true;
    const btn = container.querySelector('.travel-finish');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '收纳中...';
    }
    try {
      trip = await finishTravelCharTrip({ userId: user.id, characterId: activeCharacterId, tripId: trip.id });
      showToast('已带回收集物');
      await renderTrip();
      openReturnCollectibleModal(trip);
    } catch (err) {
      showToast(`失败：${err?.message || err}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '带回';
      }
    } finally {
      busy = false;
    }
  }

  async function createAndEnter() {
    if (!characterId) {
      renderShell(`<main class="travel-event-scroll travel-event-empty">${emptyIllustration('chat')}<strong>先选择一位角色</strong></main>`);
      return;
    }
    if (!character) character = await getCharacter(characterId).catch(() => null);
    if (!character) {
      renderShell(`<main class="travel-event-scroll travel-event-empty">${emptyIllustration('chat')}<strong>角色不存在</strong></main>`);
      return;
    }
    renderLoading();
    try {
      const result = await createTravelCharTrip({
        user,
        userId: user.id,
        characterId,
        character,
        theme,
        destinationOverride,
        withUser,
        coTravelMode,
        lengthMode,
        durationDays,
        companionIds,
        imagePrefs,
      });
      navigate('travel-char/event', { id: result.trip.id, character: characterId }, true);
    } catch (err) {
      showToast(`失败：${err?.message || err}`);
      navigate('travel-char', {}, true);
    }
  }

  if (!tripId) {
    await createAndEnter();
    return;
  }

  trip = await loadTrip();
  if (!trip) {
    renderShell(`<main class="travel-event-scroll travel-event-empty">${emptyIllustration('message')}<strong>旅行事件不存在</strong></main>`);
    return;
  }
  await refreshImageGenEnabled().catch(() => null);
  await markTravelCharTripNotificationsRead(user.id, trip.id).catch(() => null);
  if (!character && trip.characterIds?.[0]) {
    character = await getCharacter(trip.characterIds[0]).catch(() => null);
  }
  renderTrip();
  timer = setInterval(() => {
    if (!document.body.contains(container)) {
      clearInterval(timer);
      return;
    }
    if (trip?.status === 'away') renderTrip();
  }, 30000);
}
