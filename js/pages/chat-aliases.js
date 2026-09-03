import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import {
  archiveAliasAccount,
  deleteAliasAccount,
  listAliasAccounts,
  saveAliasAccount,
} from '../core/alias-account-store.js';
import { ensureStrangerThread } from '../core/stranger-thread-store.js';
import { generateCharacterAliasAccount } from '../core/alias-account-generation.js';
import { maybeGenerateUserIntercepts } from '../core/user-intercept-auto.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import {
  applyChatHubInsPageClasses,
  buildChatHubInsChrome,
  chatHubInsToolbarIcon,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function renderChatAliases(container, params = {}) {
  const user = await ensureDefaultUser();
  const [characters, hubContext] = await Promise.all([
    listCharacters({ excludeAnonNpc: true, userId: user.id, identityScoped: true }),
    loadChatHubInsContext(),
  ]);
  const { hubInsChrome, windowTheme, seaTheme } = hubContext;
  applyChatHubInsPageClasses(container, {
    hubInsChrome,
    windowTheme,
    seaTheme,
    extraClasses: ['alias-manager-shell'],
  });
  const initialCharacterId = String(params.targetCharacterId || '').trim();
  let ownerType = params.ownerType === 'character' ? 'character' : 'user';
  const requestedOwnerId = String(params.ownerId || initialCharacterId || '').trim();
  let ownerId = ownerType === 'character'
    ? (characters.some((row) => row.id === requestedOwnerId) ? requestedOwnerId : (characters[0]?.id || ''))
    : user.id;
  let contactTargetId = characters.some((row) => row.id === initialCharacterId)
    ? initialCharacterId
    : (characters[0]?.id || '');
  let selectedId = '';
  let accounts = [];

  async function refresh() {
    accounts = ownerId
      ? await listAliasAccounts(ownerType, ownerId, { includeArchived: true, userId: user.id })
      : [];
    if (selectedId && !accounts.some((row) => row.id === selectedId)) selectedId = '';
  }

  function characterOptions() {
    return characters.map((row) => `<option value="${esc(row.id)}" ${row.id === ownerId ? 'selected' : ''}>${esc(row.name || row.id)}</option>`).join('');
  }

  function accountRows() {
    if (!accounts.length) return '<div class="alias-manager-empty">还没有马甲</div>';
    return accounts.map((row) => `
      <button type="button" class="alias-manager-row${row.id === selectedId ? ' is-active' : ''}" data-alias-id="${esc(row.id)}">
        <span class="alias-manager-avatar"><img src="${esc(row.avatar || resolveDefaultAvatar('chat'))}" alt="" /></span>
        <span class="alias-manager-row-copy"><strong>${esc(row.displayName)}</strong><small>${esc([row.windowLabel, row.handle ? `@${row.handle}` : '', row.bio || (row.status === 'archived' ? '已归档' : '')].filter(Boolean).join(' · '))}</small></span>
        ${row.status === 'archived' ? '<span class="alias-manager-state">已归档</span>' : ''}
      </button>
    `).join('');
  }

  function paint() {
    const selected = accounts.find((row) => row.id === selectedId) || null;
    const canContact = selected?.status === 'active' && contactTargetId && ownerType === 'user';
    const canSendIntercept = selected?.status === 'active' && ownerType === 'character';
    const headerHtml = hubInsChrome
      ? buildChatHubInsChrome({
        pageTitle: '马甲',
        showUserCard: false,
        showTabs: false,
        toolbarActionsHtml: `${chatHubInsToolbarIcon('alias-manager-ai-icon', 'AI 生成', 'sparkle', { 'data-ai-alias': '' })}${chatHubInsToolbarIcon('alias-manager-new-icon', '新建马甲', 'plus', { 'data-new-alias': '' })}`,
      })
      : `<header class="navbar alias-manager-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">马甲</h1>
        <button type="button" class="navbar-btn" data-ai-alias aria-label="AI 生成">${icon('sparkle')}</button>
        <button type="button" class="navbar-btn" data-new-alias aria-label="新建">${icon('plus')}</button>
      </header>`;
    container.innerHTML = `
      ${headerHtml}
      <main class="alias-manager-page">
        <div class="alias-manager-segment" role="tablist" aria-label="马甲归属">
          <button type="button" data-owner-type="user" class="${ownerType === 'user' ? 'is-active' : ''}">我的马甲</button>
          <button type="button" data-owner-type="character" class="${ownerType === 'character' ? 'is-active' : ''}">角色马甲</button>
        </div>
        ${ownerType === 'character' ? `
          <label class="alias-manager-field"><span>角色</span><span class="alias-manager-owner-row"><select class="form-input" data-character-owner>${characterOptions()}</select><button type="button" class="btn btn-outline" data-ai-random>${icon('dice')}随机生成</button></span></label>
        ` : `<label class="alias-manager-field"><span>联系角色</span><select class="form-input" data-contact-target>${characters.map((row) => `<option value="${esc(row.id)}" ${row.id === contactTargetId ? 'selected' : ''}>${esc(row.name || row.id)}</option>`).join('')}</select></label>`}
        <section class="alias-manager-list">${accountRows()}</section>
        <form class="alias-manager-form" data-alias-form>
          <input type="hidden" name="id" value="${esc(selected?.id || '')}" />
          <label class="alias-manager-field"><span>昵称</span><input class="form-input" name="displayName" maxlength="60" required value="${esc(selected?.displayName || '')}" /></label>
          <label class="alias-manager-field"><span>账号 ID</span><input class="form-input" name="handle" maxlength="60" value="${esc(selected?.handle || '')}" /></label>
          <label class="alias-manager-field"><span>头像</span><span class="alias-manager-avatar-edit"><span data-alias-avatar-preview class="alias-manager-avatar"><img src="${esc(selected?.avatar || resolveDefaultAvatar('chat'))}" alt="" /></span><button type="button" class="btn btn-outline" data-pick-alias-avatar>选择图片</button></span><input type="hidden" name="avatar" value="${esc(selected?.avatar || '')}" /><input type="file" data-alias-avatar-file accept="image/*" hidden /></label>
          <label class="alias-manager-field"><span>简介</span><input class="form-input" name="bio" maxlength="300" value="${esc(selected?.bio || '')}" /></label>
          <label class="alias-manager-field"><span>用途标签</span><input class="form-input" name="windowLabel" maxlength="40" placeholder="如：暗恋树洞 / 拉黑后绕回" value="${esc(selected?.windowLabel || '')}" /></label>
          <label class="alias-manager-field"><span>人设补充</span><textarea class="form-input" name="personaOverlay" rows="4" maxlength="4000" placeholder="本窗专用动机与使用方式（越具体越不容易和其它小号串）">${esc(selected?.personaOverlay || '')}</textarea></label>
          <div class="alias-manager-actions">
            <button type="submit" class="btn btn-primary">保存</button>
            ${selected && selected.status === 'active' ? '<button type="button" class="btn btn-outline" data-archive-alias>归档</button>' : ''}
            ${selected ? '<button type="button" class="btn btn-outline is-danger" data-delete-alias>删除</button>' : ''}
          </div>
          ${canContact ? '<button type="button" class="btn btn-soft alias-manager-contact" data-contact-as-alias>切换为这个马甲并发起对话</button>' : ''}
          ${canSendIntercept ? '<button type="button" class="btn btn-soft alias-manager-contact" data-send-intercept-as-alias>用这个号发陌生消息</button>' : ''}
        </form>
      </main>
    `;
    bind();
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', back);
    container.querySelector('[data-new-alias]')?.addEventListener('click', () => { selectedId = ''; paint(); });
    container.querySelector('[data-ai-alias]')?.addEventListener('click', async (event) => {
      if (ownerType !== 'character' || !ownerId) {
        showToast('请先切到角色马甲并选择角色');
        return;
      }
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const saved = await generateCharacterAliasAccount({
          userId: user.id,
          characterId: ownerId,
          onProgress: (text) => showToast(text, 1200),
        });
        selectedId = saved.id;
        await refresh();
        paint();
        showToast('已生成');
      } catch (error) {
        showToast(error?.message || '生成失败');
        if (button.isConnected) button.disabled = false;
      }
    });
    container.querySelector('[data-ai-random]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const saved = await generateCharacterAliasAccount({
          userId: user.id,
          onProgress: (text) => showToast(text, 1200),
        });
        ownerId = saved.ownerId;
        selectedId = saved.id;
        await refresh();
        paint();
        showToast('已随机生成');
      } catch (error) {
        showToast(error?.message || '生成失败');
        if (button.isConnected) button.disabled = false;
      }
    });
    container.querySelectorAll('[data-owner-type]').forEach((button) => {
      button.addEventListener('click', async () => {
        ownerType = button.dataset.ownerType === 'character' ? 'character' : 'user';
        ownerId = ownerType === 'user' ? user.id : (initialCharacterId || characters[0]?.id || '');
        selectedId = '';
        await refresh();
        paint();
      });
    });
    container.querySelector('[data-character-owner]')?.addEventListener('change', async (event) => {
      ownerId = String(event.target.value || '').trim();
      selectedId = '';
      await refresh();
      paint();
    });
    container.querySelector('[data-contact-target]')?.addEventListener('change', (event) => {
      contactTargetId = String(event.target.value || '').trim();
      paint();
    });
    const avatarFile = container.querySelector('[data-alias-avatar-file]');
    container.querySelector('[data-pick-alias-avatar]')?.addEventListener('click', () => avatarFile?.click());
    avatarFile?.addEventListener('change', async () => {
      const file = avatarFile.files?.[0];
      if (!file) return;
      try {
        const result = await fileToCroppedOptimizedAvatarDataUrl(file);
        const dataUrl = result?.dataUrl || '';
        if (!dataUrl) return;
        const input = container.querySelector('input[name="avatar"]');
        if (input) input.value = dataUrl;
        const preview = container.querySelector('[data-alias-avatar-preview]');
        if (preview) preview.innerHTML = `<img src="${esc(dataUrl)}" alt="" />`;
      } catch (error) {
        showToast(error?.message || '头像处理失败');
      }
    });
    container.querySelectorAll('[data-alias-id]').forEach((button) => {
      button.addEventListener('click', () => { selectedId = button.dataset.aliasId || ''; paint(); });
    });
    container.querySelector('[data-alias-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        const saved = await saveAliasAccount({
          id: data.get('id') || undefined,
          ownerType,
          ownerId,
          userId: user.id,
          displayName: data.get('displayName'),
          handle: data.get('handle'),
          avatar: data.get('avatar'),
          bio: data.get('bio'),
          windowLabel: data.get('windowLabel'),
          personaOverlay: data.get('personaOverlay'),
          createdBy: 'user',
        });
        selectedId = saved.id;
        await refresh();
        paint();
        showToast('已保存');
      } catch (error) {
        showToast(error?.message || '保存失败');
      }
    });
    container.querySelector('[data-archive-alias]')?.addEventListener('click', async () => {
      await archiveAliasAccount(selectedId);
      await refresh();
      paint();
      showToast('已归档');
    });
    container.querySelector('[data-delete-alias]')?.addEventListener('click', async () => {
      if (!selectedId) return;
      const selected = accounts.find((row) => row.id === selectedId);
      const name = selected?.displayName || '这个马甲';
      if (!window.confirm(`删除「${name}」及其相关记忆？已有陌生会话只保留当时的昵称与头像，不会重新恢复这个马甲。`)) return;
      try {
        await deleteAliasAccount(selectedId);
        selectedId = '';
        await refresh();
        paint();
        showToast('马甲及相关记忆已删除');
      } catch (error) {
        showToast(error?.message || '删除失败');
      }
    });
    container.querySelector('[data-contact-as-alias]')?.addEventListener('click', async () => {
      try {
        const chat = await ensureStrangerThread({
          userId: user.id,
          characterId: contactTargetId,
          userAccountId: ownerType === 'user' ? selectedId : '',
          characterAccountId: ownerType === 'character' ? selectedId : '',
          initiatorType: ownerType,
          friendshipState: 'intercepted',
        });
        navigate('chat/thread', { chatId: chat.id });
      } catch (error) {
        showToast(error?.message || '打开会话失败');
      }
    });
    container.querySelector('[data-send-intercept-as-alias]')?.addEventListener('click', async (event) => {
      if (!selectedId) return;
      const button = event.currentTarget;
      button.disabled = true;
      showToast('正在生成…', 1200);
      try {
        const result = await maybeGenerateUserIntercepts({ force: true, forceAliasId: selectedId });
        if (!result?.ok) throw new Error(result?.reason === 'in-flight' ? '正在生成中，请稍候' : '这一轮没有生成出有效消息');
        const chatId = result.results?.[0]?.chatId || '';
        showToast('已用这个号发来陌生消息');
        if (chatId) navigate('chat/thread', { chatId });
        else navigate('chat/intercepts');
      } catch (error) {
        showToast(error?.message || '生成失败');
        if (button.isConnected) button.disabled = false;
      }
    });
  }

  await refresh();
  paint();
}
