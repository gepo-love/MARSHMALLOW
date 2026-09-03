import { back, invalidateKeepAlive, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser, saveUserRecord } from '../core/user-slot.js';
import {
  deleteChatAppearancePreset,
  loadChatAppearancePresets,
  presetToAppearance,
  buildChatAppearanceReferenceMarkdown,
} from '../core/chat-appearance.js';
import {
  deleteBeautifyAsset,
  listBeautifyAssets,
  saveBeautifyImage,
} from '../core/beautify-assets.js';
import {
  listChatsForUser,
  loadIdentityChatAppearanceDefaults,
  buildIdentityChatAppearanceSyncPatch,
  saveChat,
} from '../core/chat-store.js';
import { downloadTextFile } from '../core/appearance-theme-export.js';
import { getUserDisplayName } from '../models/user.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function presetMeta(preset = {}) {
  const parts = [
    String(preset.css || '').trim() ? '整页' : '',
    String(preset.userBubbleCss || preset.charBubbleCss || '').trim() ? '气泡' : '',
    Number(preset.bubbleFontSize || 0) > 0 ? '字号' : '',
    preset.bubbleGrouping === true ? '连续气泡' : '',
  ].filter(Boolean);
  return parts.join(' · ') || '基础消息样式';
}

function avatarHtml(user) {
  const name = getUserDisplayName(user);
  if (user?.avatar) return `<img src="${esc(user.avatar)}" alt="" decoding="async">`;
  return `<span>${esc(name.slice(0, 1))}</span>`;
}

function backgroundOpacity(value, fallback = 40) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export default async function render(container) {
  let user = await ensureDefaultUser();
  let [presets, images] = await Promise.all([
    loadChatAppearancePresets(),
    listBeautifyAssets('image').catch(() => []),
  ]);

  container.className = 'page identity-appearance-page';

  function identityAppearance() {
    return user?.identityAppearance && typeof user.identityAppearance === 'object'
      ? user.identityAppearance
      : {};
  }

  async function saveIdentityAppearance(patch = {}) {
    const current = identityAppearance();
    const next = await saveUserRecord({
      ...user,
      identityAppearance: {
        ...current,
        ...patch,
        chatAppearance: patch.chatAppearance === undefined
          ? current.chatAppearance
          : patch.chatAppearance,
      },
    });
    user = next;
    invalidateKeepAlive('chat');
    paint();
    return next;
  }

  function paint() {
    const profile = identityAppearance();
    const selectedPresetId = String(profile.chatPresetId || '');
    const selectedWallpaperId = String(profile.wallpaperAssetId || '');
    const selectedWallpaper = images.find((asset) => asset.id === selectedWallpaperId) || null;
    const hubBackgroundAssetId = String(profile.chatHubBackgroundAssetId || '');
    const sidebarBackgroundAssetId = String(profile.chatSidebarBackgroundAssetId || '');
    const hubBackgroundAsset = images.find((asset) => asset.id === hubBackgroundAssetId) || null;
    const sidebarBackgroundAsset = images.find((asset) => asset.id === sidebarBackgroundAssetId) || null;
    const hubBackgroundOpacity = backgroundOpacity(profile.chatHubBackgroundOpacity);
    const sidebarBackgroundOpacity = backgroundOpacity(profile.chatSidebarBackgroundOpacity);
    const hasDefaults = !!(selectedPresetId || selectedWallpaperId);

    container.innerHTML = `
      <header class="navbar identity-appearance-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">本身份装扮</h1>
        <button type="button" class="identity-appearance-doc" data-css-doc>CSS 文档</button>
      </header>

      <main class="identity-appearance-scroll">
        <section class="identity-appearance-profile">
          <div class="identity-appearance-avatar">${avatarHtml(user)}</div>
          <div>
            <strong>${esc(getUserDisplayName(user))}</strong>
            <span>${hasDefaults ? '新聊天将沿用当前选择' : '新聊天跟随各会话设置'}</span>
          </div>
          <button type="button" data-sync-existing ${hasDefaults ? '' : 'disabled'}>同步已有会话</button>
        </section>

        <section class="identity-appearance-section">
          <div class="identity-appearance-section-head">
            <div>
              <h2>消息预设</h2>
              <span>${selectedPresetId ? esc(profile.chatPresetName || '已选择') : '未选择'}</span>
            </div>
            <button type="button" data-create-preset>制作新预设</button>
          </div>
          <div class="identity-appearance-preset-list">
            <button type="button" class="identity-appearance-preset${selectedPresetId ? '' : ' is-active'}" data-preset="">
              <span class="identity-appearance-preset-demo is-plain">
                <i></i><i></i>
              </span>
              <span><strong>跟随会话</strong><small>不设身份默认</small></span>
              <b aria-hidden="true">${selectedPresetId ? '' : icon('check')}</b>
            </button>
            ${presets.map((preset) => `
              <article class="identity-appearance-preset-wrap">
                <button type="button" class="identity-appearance-preset${selectedPresetId === preset.id ? ' is-active' : ''}" data-preset="${esc(preset.id)}">
                  <span class="identity-appearance-preset-demo">
                    <i></i><i></i>
                  </span>
                  <span><strong>${esc(preset.name)}</strong><small>${esc(presetMeta(preset))}</small></span>
                  <b aria-hidden="true">${selectedPresetId === preset.id ? icon('check') : ''}</b>
                </button>
                ${preset.builtin ? '' : `<button type="button" class="identity-appearance-preset-delete" data-delete-preset="${esc(preset.id)}" aria-label="删除预设 ${esc(preset.name)}">${icon('trash')}</button>`}
              </article>
            `).join('')}
          </div>
        </section>

        <section class="identity-appearance-section">
          <div class="identity-appearance-section-head">
            <div>
              <h2>壁纸库</h2>
              <span>${selectedWallpaper ? esc(selectedWallpaper.name || '已选择') : '未选择'}</span>
            </div>
            <label class="identity-appearance-upload">
              导入
              <input type="file" accept="image/*" data-wallpaper-file hidden>
            </label>
          </div>
          <div class="identity-appearance-wallpapers">
            <button type="button" class="identity-appearance-wallpaper is-clear${selectedWallpaperId ? '' : ' is-active'}" data-wallpaper="">
              <span>${icon('close')}</span>
              <small>不设壁纸</small>
            </button>
            ${images.slice(0, 48).map((asset) => `
              <div class="identity-appearance-wallpaper-wrap">
                <button type="button" class="identity-appearance-wallpaper${selectedWallpaperId === asset.id ? ' is-active' : ''}" data-wallpaper="${esc(asset.id)}" aria-label="使用 ${esc(asset.name || '壁纸')}">
                  <img src="${esc(asset.dataUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
                  <small>${esc(asset.name || '壁纸')}</small>
                </button>
                <button type="button" class="identity-appearance-wallpaper-delete" data-delete-wallpaper="${esc(asset.id)}" aria-label="删除壁纸 ${esc(asset.name || '')}">${icon('trash')}</button>
              </div>
            `).join('')}
          </div>
          ${images.length ? '' : '<div class="identity-appearance-empty">导入一张图片，就能在所有会话里重复使用。</div>'}
        </section>

        <section class="identity-appearance-section">
          <div class="identity-appearance-section-head">
            <div>
              <h2>聊天首页背景</h2>
              <span>消息列表与身份侧栏</span>
            </div>
          </div>
          <div class="identity-appearance-regions">
            ${[
              {
                region: 'hub',
                title: '消息列表',
                asset: hubBackgroundAsset,
                opacity: hubBackgroundOpacity,
              },
              {
                region: 'sidebar',
                title: '身份侧栏',
                asset: sidebarBackgroundAsset,
                opacity: sidebarBackgroundOpacity,
              },
            ].map(({ region, title, asset, opacity }) => `
              <article class="identity-appearance-region" data-region-card="${region}">
                <div class="identity-appearance-region-preview${asset ? ' has-image' : ''}">
                  ${asset
                    ? `<img src="${esc(asset.dataUrl)}" alt="" decoding="async" style="opacity:${opacity / 100}">`
                    : `<span>${icon(region === 'hub' ? 'message' : 'folder')}</span>`}
                </div>
                <div class="identity-appearance-region-body">
                  <div class="identity-appearance-region-title">
                    <strong>${title}</strong>
                    <small>${asset ? esc(asset.name || '已选择图片') : '未设置'}</small>
                  </div>
                  <div class="identity-appearance-region-actions">
                    <label>
                      ${asset ? '替换' : '上传'}
                      <input type="file" accept="image/*" data-region-background-file="${region}" hidden>
                    </label>
                    ${asset ? `<button type="button" data-region-background-remove="${region}">移除</button>` : ''}
                  </div>
                  <label class="identity-appearance-opacity">
                    <span>图片透明度</span>
                    <input type="range" min="0" max="100" step="1" value="${opacity}" data-region-background-opacity="${region}" ${asset ? '' : 'disabled'}>
                    <output>${opacity}%</output>
                  </label>
                </div>
              </article>
            `).join('')}
          </div>
        </section>
      </main>
    `;
    bind();
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-css-doc]')?.addEventListener('click', async () => {
      try {
        await downloadTextFile(
          buildChatAppearanceReferenceMarkdown(),
          `marshmallow-chat-css-reference-${Date.now()}.md`,
        );
        showToast('消息页 CSS 文档已下载');
      } catch (err) {
        showToast(`下载失败：${err?.message || err}`);
      }
    });
    container.querySelector('[data-create-preset]')?.addEventListener('click', () => {
      navigate('beautify', { target: 'chat-thread' });
    });

    container.querySelectorAll('[data-preset]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = String(button.getAttribute('data-preset') || '');
        const preset = presets.find((item) => item.id === id);
        await saveIdentityAppearance({
          chatPresetId: preset?.id || '',
          chatPresetName: preset?.name || '',
          chatAppearance: preset ? presetToAppearance(preset) : {},
        });
        showToast(preset ? `已设为本身份默认「${preset.name}」` : '已取消身份消息预设');
      });
    });

    container.querySelectorAll('[data-delete-preset]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const id = String(button.getAttribute('data-delete-preset') || '');
        const preset = presets.find((item) => item.id === id);
        if (!preset || preset.builtin) return;
        if (!window.confirm(`删除美化预设“${preset.name}”？`)) return;
        await deleteChatAppearancePreset(id);
        presets = await loadChatAppearancePresets();
        if (identityAppearance().chatPresetId === id) {
          await saveIdentityAppearance({
            chatPresetId: '',
            chatPresetName: '',
            chatAppearance: {},
          });
        } else {
          paint();
        }
        showToast('美化预设已删除');
      });
    });

    container.querySelectorAll('[data-wallpaper]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = String(button.getAttribute('data-wallpaper') || '');
        await saveIdentityAppearance({ wallpaperAssetId: id });
        const asset = images.find((item) => item.id === id);
        showToast(asset ? `已设为本身份壁纸「${asset.name || '壁纸'}」` : '已取消身份默认壁纸');
      });
    });

    container.querySelectorAll('[data-delete-wallpaper]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const id = String(button.getAttribute('data-delete-wallpaper') || '');
        const asset = images.find((item) => item.id === id);
        if (!asset || !window.confirm(`从壁纸库删除“${asset.name || '这张图片'}”？`)) return;
        await deleteBeautifyAsset(id);
        images = await listBeautifyAssets('image').catch(() => []);
        const profile = identityAppearance();
        const patch = {};
        if (profile.wallpaperAssetId === id) patch.wallpaperAssetId = '';
        if (profile.chatHubBackgroundAssetId === id) patch.chatHubBackgroundAssetId = '';
        if (profile.chatSidebarBackgroundAssetId === id) patch.chatSidebarBackgroundAssetId = '';
        if (Object.keys(patch).length) {
          await saveIdentityAppearance(patch);
        } else {
          paint();
        }
        showToast('壁纸已从图库删除');
      });
    });

    container.querySelector('[data-wallpaper-file]')?.addEventListener('change', async (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        const asset = await saveBeautifyImage(file);
        images = await listBeautifyAssets('image').catch(() => []);
        await saveIdentityAppearance({ wallpaperAssetId: asset.id });
        showToast('壁纸已加入图库并设为本身份默认');
      } catch (err) {
        showToast(String(err?.message || '壁纸导入失败'));
      }
    });

    container.querySelectorAll('[data-region-background-file]').forEach((input) => {
      input.addEventListener('change', async (event) => {
        const target = event.currentTarget;
        const region = String(target.getAttribute('data-region-background-file') || '');
        const file = target.files?.[0];
        target.value = '';
        if (!file || !['hub', 'sidebar'].includes(region)) return;
        try {
          const asset = await saveBeautifyImage(file);
          images = await listBeautifyAssets('image').catch(() => []);
          await saveIdentityAppearance({
            [region === 'hub' ? 'chatHubBackgroundAssetId' : 'chatSidebarBackgroundAssetId']: asset.id,
          });
          showToast(region === 'hub' ? '消息列表背景已更新' : '身份侧栏背景已更新');
        } catch (err) {
          showToast(String(err?.message || '背景导入失败'));
        }
      });
    });

    container.querySelectorAll('[data-region-background-remove]').forEach((button) => {
      button.addEventListener('click', async () => {
        const region = String(button.getAttribute('data-region-background-remove') || '');
        if (!['hub', 'sidebar'].includes(region)) return;
        await saveIdentityAppearance({
          [region === 'hub' ? 'chatHubBackgroundAssetId' : 'chatSidebarBackgroundAssetId']: '',
        });
        showToast(region === 'hub' ? '已移除消息列表背景' : '已移除身份侧栏背景');
      });
    });

    container.querySelectorAll('[data-region-background-opacity]').forEach((input) => {
      input.addEventListener('input', () => {
        const card = input.closest('[data-region-card]');
        const value = backgroundOpacity(input.value);
        const output = card?.querySelector('output');
        const preview = card?.querySelector('.identity-appearance-region-preview img');
        if (output) output.textContent = `${value}%`;
        if (preview) preview.style.opacity = String(value / 100);
      });
      input.addEventListener('change', async () => {
        const region = String(input.getAttribute('data-region-background-opacity') || '');
        if (!['hub', 'sidebar'].includes(region)) return;
        await saveIdentityAppearance({
          [region === 'hub' ? 'chatHubBackgroundOpacity' : 'chatSidebarBackgroundOpacity']: backgroundOpacity(input.value),
        });
      });
    });

    container.querySelector('[data-sync-existing]')?.addEventListener('click', async (event) => {
      if (!window.confirm('把当前身份的消息预设与壁纸同步到已有会话？各会话对应项目会被覆盖。')) return;
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const defaults = await loadIdentityChatAppearanceDefaults(user.id);
        const syncPatch = buildIdentityChatAppearanceSyncPatch(defaults);
        const chats = await listChatsForUser(user.id);
        for (const chat of chats) {
          await saveChat({
            ...chat,
            groupSettings: {
              ...(chat.groupSettings || {}),
              ...syncPatch,
            },
          });
        }
        showToast(`已同步 ${chats.length} 个会话`);
      } catch (err) {
        showToast(String(err?.message || '同步失败'));
      } finally {
        button.disabled = false;
      }
    });
  }

  paint();
}
