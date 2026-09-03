import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import {
  getCharacter,
  saveCharacter,
  saveCharacterForUser,
} from '../core/character-store.js';
import { getRoleTierLabel } from '../models/character.js';
import { ensureDefaultUser, getUserById } from '../core/user-slot.js';
import { ensurePrivateChat } from '../core/chat-store.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import { captureMediaGesture, storePendingMediaGesture } from '../core/media-playback.js';
import {
  loadAppearancePrefs,
  getActiveTheme,
  applySettingsWallpaperPreview,
  isWindowHomeTheme,
  isSeaHomeTheme,
} from '../core/appearance-prefs.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function newShotId() {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function winChrome(editKey) {
  const pencil = editKey
    ? `<button type="button" class="cc-win-edit" data-edit="${esc(editKey)}" aria-label="编辑">${icon('edit')}</button>`
    : '';
  return `<span class="cc-win-ctrls">${pencil}<i class="cc-win-min" aria-hidden="true"></i><i class="cc-win-close" aria-hidden="true"></i></span>`;
}

export default async function render(container, params = {}) {
  const id = params.id;
  const [prefs, loaded, currentUser] = await Promise.all([
    loadAppearancePrefs().catch(() => null),
    id ? getCharacter(id) : null,
    ensureDefaultUser(),
  ]);
  const requestedIdentityUserId = String(params.identityUserId || '').trim();
  const user = requestedIdentityUserId
    && requestedIdentityUserId !== String(currentUser?.id || '')
    ? await getUserById(requestedIdentityUserId).catch(() => null)
    : currentUser;
  const identityRequested = String(params.scope || '') === 'identity';
  if (identityRequested && !user?.id) {
    container.className = 'page scrapbook-page contacts-card';
    container.innerHTML = `<header class="navbar"><button type="button" class="navbar-btn identity-scope-back" aria-label="返回">${icon('back')}</button><h1 class="navbar-title">名片</h1><span class="navbar-btn" aria-hidden="true"></span></header><div class="placeholder-page"><div class="placeholder-text">目标档位已不可用，请返回后重新进入</div></div>`;
    container.querySelector('.identity-scope-back')?.addEventListener('click', () => back());
    return;
  }
  const identityScope = identityRequested;
  const scopedLoaded = identityScope && id
    ? await getCharacter(id, { userId: user.id }).catch(() => null)
    : loaded;

  if (!scopedLoaded) {
    container.className = 'page scrapbook-page contacts-card';
    container.innerHTML = `
      <header class="navbar"><button type="button" class="navbar-btn cc-back" aria-label="返回">${icon('back')}</button><h1 class="navbar-title">名片</h1><span class="navbar-btn" aria-hidden="true"></span></header>
      <div class="placeholder-page"><div class="placeholder-text">找不到这位角色</div></div>
    `;
    container.querySelector('.cc-back')?.addEventListener('click', () => back());
    return;
  }

  const active = getActiveTheme(prefs);
  const theme = active.theme;
  const glassTheme = isWindowHomeTheme(active.id, theme) || isSeaHomeTheme(active.id, theme);

  let char = scopedLoaded;
  const ui = { editIntro: false, editAbout: false };

  container.className = `page scrapbook-page contacts-card${glassTheme ? ' contacts-card--glass' : ''}`;
  if (theme) applySettingsWallpaperPreview(container, theme);

  async function persist(patch) {
    char = { ...char, ...patch };
    try {
      char = identityScope
        ? await saveCharacterForUser(user.id, char, { forceOverride: true })
        : await saveCharacter(char);
    } catch (err) {
      showToast(String((err && err.message) || err).slice(0, 140));
    }
  }

  async function openChat(extra = {}) {
    try {
      const chat = await ensurePrivateChat(user.id, char.id, char.name || '');
      navigate('chat/thread', { chatId: chat.id, entry: 'list', ...extra });
    } catch (err) {
      showToast(String((err && err.message) || err));
    }
  }

  // ── 个人简介窗 ──
  function renderIntro() {
    const cardData = char.card || {};
    const handle = (char.customNickname || (char.aliases || [])[0] || char.realName || char.name || '').trim();
    const chips = [getRoleTierLabel(char.roleTier), char.currentRole].filter(Boolean);
    if (ui.editIntro) {
      const contacts = cardData.contacts || [];
      const rows = (contacts.length ? contacts : [{ label: '', value: '' }]).map((c) => `
        <div class="cc-ec-row">
          <input class="cc-ec-label" placeholder="标签" value="${esc(c.label)}" maxlength="24">
          <input class="cc-ec-value" placeholder="内容" value="${esc(c.value)}" maxlength="80">
          <button type="button" class="cc-ec-del" aria-label="删除">×</button>
        </div>`).join('');
      return `
        <label class="cc-ed-label">个性签名</label>
        <textarea class="cc-ed-sign" rows="2" maxlength="140" placeholder="写一句个性签名…">${esc(cardData.signature || '')}</textarea>
        <label class="cc-ed-label">联络方式</label>
        <div class="cc-ec-list">${rows}</div>
        <button type="button" class="cc-ec-add">+ 添加一条</button>
        <div class="cc-ed-actions">
          <button type="button" class="cc-ed-cancel" data-cancel="intro">取消</button>
          <button type="button" class="cc-ed-save" data-save="intro">保存</button>
        </div>`;
    }
    const contacts = cardData.contacts || [];
    const contactsHtml = contacts.length
      ? contacts.map((c) => `<div class="cc-contact"><span class="cc-contact-k">${esc(c.label || '—')}</span><span class="cc-contact-v">${esc(c.value)}</span></div>`).join('')
      : '<div class="cc-contact is-empty">还没有联络方式，点右上角铅笔添加</div>';
    return `
      <div class="cc-intro-head">
        <div class="cc-avatar">${characterAvatarHtml(char, { className: 'cc-avatar-img' })}</div>
        <div class="cc-intro-id">
          <div class="cc-name">${esc(char.name || '未命名')}</div>
          ${handle ? `<div class="cc-handle">@${esc(handle)}</div>` : ''}
          ${chips.length ? `<div class="cc-chips">${chips.map((c) => `<span class="cc-chip">${esc(c)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
      <p class="cc-sign${cardData.signature ? '' : ' is-empty'}">${cardData.signature ? esc(cardData.signature) : '写一句个性签名…'}</p>
      <div class="cc-sub-h">联络</div>
      <div class="cc-contacts">${contactsHtml}</div>
      <div class="cc-intro-foot"><button type="button" class="cc-send">${icon('message')}<span>发消息</span></button></div>
    `;
  }

  // ── 形象图秀图窗（纯装饰）──
  function renderShots() {
    const shots = Array.isArray(char.showcaseImages) ? char.showcaseImages : [];
    const tiles = shots.map((im) => `
      <figure class="cc-shot${char.avatar === im.url ? ' is-avatar' : ''}" data-shot="${esc(im.id)}">
        <img src="${esc(im.url)}" alt="${esc(im.caption || '形象图')}" loading="lazy">
        <div class="cc-shot-bar">
          <button type="button" class="cc-shot-btn" data-shot-avatar="${esc(im.id)}" aria-label="设为头像">${icon('check')}</button>
          <button type="button" class="cc-shot-btn cc-shot-del" data-shot-del="${esc(im.id)}" aria-label="删除">${icon('trash')}</button>
        </div>
      </figure>`).join('');
    return `
      <div class="cc-shots">
        ${tiles}
        <label class="cc-shot-add">${icon('plus')}<span>上传</span><input type="file" accept="image/*" hidden class="cc-shot-file" multiple></label>
      </div>
    `;
  }

  // ── 关于我窗 ──
  function renderAbout() {
    const about = String((char.card || {}).about || '').trim();
    if (ui.editAbout) {
      return `
        <textarea class="cc-ed-about" rows="7" maxlength="2000" placeholder="写点关于 TA 的事…&#10;每行一条，比如：&#10;ENFP 巨蟹座 坐标海滨小城&#10;没回就是还在睡，不会故意不回">${esc(about)}</textarea>
        <div class="cc-ed-actions">
          <button type="button" class="cc-ed-cancel" data-cancel="about">取消</button>
          <button type="button" class="cc-ed-save" data-save="about">保存</button>
        </div>`;
    }
    if (!about) return '<p class="cc-about-empty">还没有写「关于我」，点右上角铅笔添加。</p>';
    return `<div class="cc-about-lines">${about.split('\n').filter((l) => l.trim()).map((l) => `<div class="cc-about-line">${esc(l)}</div>`).join('')}</div>`;
  }

  function paint() {
    const prevScroll = captureScrollerTop(container, '.contacts-card-scroll');
    container.innerHTML = `
      <header class="navbar contacts-card-nav">
        <button type="button" class="navbar-btn cc-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">名片</h1>
        <span class="navbar-btn" aria-hidden="true"></span>
      </header>
      <main class="contacts-card-scroll">
        <section class="cc-win cc-win--intro">
          <div class="cc-win-bar"><span class="cc-win-title">个人简介</span>${winChrome('intro')}</div>
          <div class="cc-win-body">${renderIntro()}</div>
        </section>

        <section class="cc-win cc-win--shots">
          <div class="cc-win-bar"><span class="cc-win-title">相册</span>${winChrome('')}</div>
          <div class="cc-win-body">${renderShots()}</div>
        </section>

        <section class="cc-win cc-win--about">
          <div class="cc-win-bar"><span class="cc-win-title">关于我</span>${winChrome('about')}</div>
          <div class="cc-win-body">${renderAbout()}</div>
        </section>
      </main>
      <footer class="contacts-card-actions">
        <button type="button" class="cc-act cc-call" aria-label="语音通话">${icon('voiceCall')}<span>语音</span></button>
        <button type="button" class="cc-act cc-msg is-primary">${icon('message')}<span>发消息</span></button>
      </footer>
    `;
    restoreScrollerTop(container, '.contacts-card-scroll', prevScroll);
    bind();
  }

  function collectContacts() {
    return [...container.querySelectorAll('.cc-ec-row')].map((row) => ({
      label: row.querySelector('.cc-ec-label')?.value || '',
      value: row.querySelector('.cc-ec-value')?.value || '',
    })).filter((c) => c.label.trim() || c.value.trim());
  }

  function bind() {
    container.querySelector('.cc-back')?.addEventListener('click', () => back());
    container.querySelectorAll('.cc-send, .cc-msg').forEach((b) => b.addEventListener('click', () => { void openChat(); }));
    container.querySelector('.cc-call')?.addEventListener('click', (e) => {
      storePendingMediaGesture(captureMediaGesture(e));
      void openChat({ startCall: '1', callNonce: String(Date.now()) });
    });

    // 编辑切换
    container.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const k = b.getAttribute('data-edit');
      if (k === 'intro') ui.editIntro = true;
      if (k === 'about') ui.editAbout = true;
      paint();
    }));
    container.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => {
      const k = b.getAttribute('data-cancel');
      if (k === 'intro') ui.editIntro = false;
      if (k === 'about') ui.editAbout = false;
      paint();
    }));

    // 个人简介保存
    container.querySelector('[data-save="intro"]')?.addEventListener('click', async () => {
      const signature = container.querySelector('.cc-ed-sign')?.value || '';
      const contacts = collectContacts();
      ui.editIntro = false;
      await persist({ card: { ...(char.card || {}), signature, contacts } });
      paint();
    });
    container.querySelector('.cc-ec-add')?.addEventListener('click', () => {
      const list = container.querySelector('.cc-ec-list');
      if (!list) return;
      const div = document.createElement('div');
      div.className = 'cc-ec-row';
      div.innerHTML = '<input class="cc-ec-label" placeholder="标签" maxlength="24"><input class="cc-ec-value" placeholder="内容" maxlength="80"><button type="button" class="cc-ec-del" aria-label="删除">×</button>';
      list.appendChild(div);
      div.querySelector('.cc-ec-del').addEventListener('click', () => div.remove());
    });
    container.querySelectorAll('.cc-ec-del').forEach((b) => b.addEventListener('click', () => b.closest('.cc-ec-row')?.remove()));

    // 关于我保存
    container.querySelector('[data-save="about"]')?.addEventListener('click', async () => {
      const about = container.querySelector('.cc-ed-about')?.value || '';
      ui.editAbout = false;
      await persist({ card: { ...(char.card || {}), about } });
      paint();
    });

    // 形象图：上传 / 设头像 / 删除（纯装饰）
    container.querySelector('.cc-shot-file')?.addEventListener('change', async (e) => {
      const input = e.target;
      const files = [...(input.files || [])];
      if (!files.length) return;
      const added = [];
      for (const file of files) {
        try {
          const { dataUrl } = await fileToOptimizedChatImageDataUrl(file);
          if (dataUrl) added.push({ id: newShotId(), url: dataUrl, caption: '' });
        } catch (err) {
          showToast(`上传失败：${(err && err.message) || err}`);
        }
      }
      input.value = '';
      if (added.length) {
        await persist({ showcaseImages: [...(char.showcaseImages || []), ...added] });
        showToast(`已添加 ${added.length} 张`);
        paint();
      }
    });
    container.querySelectorAll('[data-shot-avatar]').forEach((b) => b.addEventListener('click', async () => {
      const im = (char.showcaseImages || []).find((x) => x.id === b.getAttribute('data-shot-avatar'));
      if (!im) return;
      await persist({ avatar: im.url });
      showToast('已设为头像');
      paint();
    }));
    container.querySelectorAll('[data-shot-del]').forEach((b) => b.addEventListener('click', async () => {
      const sid = b.getAttribute('data-shot-del');
      await persist({ showcaseImages: (char.showcaseImages || []).filter((x) => x.id !== sid) });
      paint();
    }));
  }

  paint();
}
