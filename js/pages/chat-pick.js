import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { captureElementScrollState, restoreElementScrollState } from '../core/scroll-state.js';
import { listCharacters } from '../core/character-store.js';
import { createGroupChat, ensurePrivateChat } from '../core/chat-store.js';
import { ensureStrangerThread } from '../core/stranger-thread-store.js';
import { getAliasAccount } from '../core/alias-account-store.js';
import { getRoleTierLabel } from '../models/character.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function render(container, params = {}) {
  const mode = String(params.mode || 'group');
  if (mode === 'alias-private') {
    const user = await ensureDefaultUser();
    const characters = await listCharacters({ excludeAnonNpc: true });
    const userAccountId = String(params.userAccountId || '').trim();
    const account = userAccountId ? await getAliasAccount(userAccountId).catch(() => null) : null;
    if (userAccountId && (!account || account.ownerType !== 'user' || account.ownerId !== user.id || account.status !== 'active')) {
      showToast('当前马甲不可用');
      back();
      return;
    }
    let query = '';
    container.className = 'page scrapbook-page chat-pick-page chat-alias-private-pick';

    function paintPrivate() {
      const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
      const filtered = characters
        .filter((char) => !normalizedQuery || [char.name, char.realName, char.customNickname]
          .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(normalizedQuery)))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
      const rows = filtered.length ? filtered.map((char) => {
        const sub = [getRoleTierLabel(char.roleTier), char.customNickname].filter(Boolean).join(' · ');
        return `<button type="button" class="chat-pick-row" data-id="${esc(char.id)}">
          <span class="chat-pick-avatar">${characterAvatarHtml(char, { className: 'chat-pick-avatar-img' })}</span>
          <span class="chat-pick-body"><strong>${esc(char.name)}</strong><small>${esc(sub || '角色')}</small></span>
          <span class="chat-pick-row-chevron" aria-hidden="true">${icon('chevron')}</span>
        </button>`;
      }).join('') : `<div class="chat-empty scrapbook-empty"><div class="chat-empty-text">没有找到联系人</div></div>`;
      container.innerHTML = `
        <header class="navbar">
          <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
          <h1 class="navbar-title">选择联系人</h1>
          <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
        </header>
        <main class="chat-pick-scroll scrapbook-scroll">
          <div class="chat-alias-private-identity">${esc(account?.displayName || user.name || user.nickname || '我')}</div>
          <label class="chat-alias-private-search"><span class="sr-only">搜索联系人</span><input type="search" class="form-input" value="${esc(query)}" placeholder="搜索联系人"></label>
          <div class="chat-pick-list">${rows}</div>
        </main>`;
      container.querySelector('[data-back]')?.addEventListener('click', back);
      container.querySelector('.chat-alias-private-search input')?.addEventListener('input', (event) => {
        query = String(event.target.value || '');
        paintPrivate();
        const input = container.querySelector('.chat-alias-private-search input');
        input?.focus();
        input?.setSelectionRange(query.length, query.length);
      });
      container.querySelectorAll('.chat-pick-row').forEach((row) => {
        row.addEventListener('click', async () => {
          const characterId = String(row.dataset.id || '').trim();
          const character = characters.find((item) => item.id === characterId);
          if (!characterId) return;
          row.disabled = true;
          try {
            const chat = userAccountId
              ? await ensureStrangerThread({
                userId: user.id,
                characterId,
                userAccountId,
                initiatorType: 'user',
                friendshipState: 'intercepted',
              })
              : await ensurePrivateChat(user.id, characterId, character?.name || '');
            navigate('chat/thread', { chatId: chat.id, entry: 'list' });
          } catch (error) {
            row.disabled = false;
            showToast(error?.message || '无法创建会话');
          }
        });
      });
    }

    paintPrivate();
    return;
  }
  if (mode !== 'group') {
    navigate('chat');
    return;
  }

  const user = await ensureDefaultUser();
  const characters = await listCharacters({ excludeAnonNpc: true });
  const selected = new Set();
  let groupName = '';
  let includeSelf = true;
  let ownerId = 'user';

  container.className = 'page scrapbook-page chat-pick-page';

  function paint() {
    const scrollState = captureElementScrollState(container, '.chat-pick-scroll');
    const filtered = characters.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
    const minSelected = includeSelf ? 1 : 2;
    if (ownerId !== 'user' && !selected.has(ownerId)) ownerId = includeSelf ? 'user' : ([...selected][0] || '');
    if (!includeSelf && ownerId === 'user') ownerId = [...selected][0] || '';
    const ownerOptions = [
      ...(includeSelf ? [{ id: 'user', name: '我' }] : []),
      ...[...selected].map((id) => {
        const c = characters.find((x) => x.id === id);
        return { id, name: c?.name || id };
      }),
    ];
    const listHtml = filtered.length
      ? filtered.map((char) => {
        const sub = [getRoleTierLabel(char.roleTier), char.customNickname].filter(Boolean).join(' · ');
        const checked = selected.has(char.id) ? ' checked' : '';
        return `
          <button type="button" class="chat-pick-row" data-id="${esc(char.id)}">
            <span class="chat-pick-avatar">${characterAvatarHtml(char, { className: 'chat-pick-avatar-img' })}</span>
            <span class="chat-pick-body">
              <strong>${esc(char.name)}</strong>
              <small>${esc(sub || '角色')}</small>
            </span>
            <input type="checkbox" class="chat-pick-check" data-id="${esc(char.id)}"${checked} aria-label="选择 ${esc(char.name)}" />
          </button>
        `;
      }).join('')
      : `<div class="chat-empty scrapbook-empty">${emptyIllustration('chat')}<div class="chat-empty-text">通讯录还是空的</div></div>`;

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">创建群聊</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="chat-pick-scroll scrapbook-scroll">
        <label class="api-field chat-pick-group-name">
          <span class="api-field-label">群名称（可选）</span>
          <input type="text" class="form-input chat-pick-name-input" value="${esc(groupName)}" placeholder="例如：日常闲聊" />
        </label>
        <label class="chat-new-toggle-row">
          <span>
            <strong>包含我自己</strong>
            <small>关闭后为旁观群：你不入群，只看角色互动</small>
          </span>
          <input type="checkbox" class="chat-pick-include-self" ${includeSelf ? 'checked' : ''} />
        </label>
        ${ownerOptions.length ? `
        <label class="api-field chat-pick-owner">
          <span class="api-field-label">群主</span>
          <select class="form-input chat-pick-owner-select">
            ${ownerOptions.map((o) => `<option value="${esc(o.id)}" ${ownerId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select>
        </label>
        ` : ''}
        <div class="chat-pick-list">${listHtml}</div>
      </main>
      <footer class="chat-pick-footer">
        <span class="chat-pick-count">已选 ${selected.size} 人</span>
        <button type="button" class="btn btn-primary btn-sm chat-pick-confirm" ${selected.size < minSelected ? 'disabled' : ''}>创建群聊</button>
      </footer>
    `;

    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('.chat-pick-name-input')?.addEventListener('input', (e) => {
      groupName = String(e.target.value || '');
    });
    container.querySelector('.chat-pick-include-self')?.addEventListener('change', (e) => {
      includeSelf = !!e.target.checked;
      if (!includeSelf && ownerId === 'user') ownerId = [...selected][0] || '';
      if (includeSelf && !ownerId) ownerId = 'user';
      paint();
    });
    container.querySelector('.chat-pick-owner-select')?.addEventListener('change', (e) => {
      ownerId = String(e.target.value || '').trim() || (includeSelf ? 'user' : '');
    });
    container.querySelectorAll('.chat-pick-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = String(row.getAttribute('data-id') || '').trim();
        if (!id) return;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        paint();
      });
    });
    container.querySelector('.chat-pick-confirm')?.addEventListener('click', async () => {
      const min = includeSelf ? 1 : 2;
      if (selected.size < min) {
        showToast(includeSelf ? '请至少选择 1 位角色' : '旁观群聊至少选择 2 位角色');
        return;
      }
      try {
        const chat = await createGroupChat(user.id, [...selected], groupName, { includeSelf, ownerId });
        navigate('chat/thread', { chatId: chat.id });
      } catch (err) {
        showToast(String(err?.message || err));
      }
    });
    restoreElementScrollState(container, '.chat-pick-scroll', scrollState);
  }

  paint();
}
