import { back, navigate } from '../core/router.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getCharacter } from '../core/character-store.js';
import { showToast } from '../components/toast.js';
import { loadContactGroupsConfig } from '../core/contact-groups.js';
import {
  generateCharacterMailboxReply,
  generateMailboxRound,
  listMailboxRecipients,
  MAILBOX_RECIPIENT_CATEGORIES,
  resolveMailboxRecipient,
} from '../core/mailbox-ai.js';
import {
  loadMailboxPreset,
  mailboxTypeLabel,
  MAILBOX_SOURCE_OPTIONS,
  MAILBOX_TYPE_BIAS_OPTIONS,
  MAILBOX_TYPE_OPTIONS,
  normalizeMailboxType,
  saveMailboxPreset,
} from '../core/mailbox-presets.js';
import {
  handleTranslationToggleClick,
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';
import {
  createMailboxMessage,
  deleteMailboxMessage,
  deleteMailboxThread,
  editMailboxMessage,
  getMailboxMessage,
  listMailboxThread,
  loadMailbox,
  markMailboxThreadRead,
  patchMailboxMessage,
  patchMailboxThread,
} from '../core/mailbox-store.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatListTime(timestamp = 0) {
  const date = new Date(Number(timestamp) || Date.now());
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  return date.toLocaleDateString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric' });
}

function formatFullTime(timestamp = 0) {
  return new Date(Number(timestamp) || Date.now()).toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function avatarFallback(name = '') {
  const label = String(name || '邮').trim().slice(0, 1) || '邮';
  return `<span class="mail-avatar-fallback">${esc(label)}</span>`;
}

async function resolveMailAvatar(mail, userId) {
  const actorId = String(mail?.characterId || mail?.from?.actorId || '').trim();
  if (!actorId) return '';
  const character = await getCharacter(actorId, { userId }).catch(() => null);
  return String(character?.avatar || '').trim();
}

function mailGlyph(name) {
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/>',
    compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    receive: '<path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M4 17v3h16v-3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    star: '<path d="m12 2.8 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.4l6.2-.9Z"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M9 12h6"/>',
    reply: '<path d="m9 17-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    attach: '<path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    delete: '<path d="M4 7h16"/><path d="m9 7 .8-3h4.4l.8 3"/><path d="m6.5 7 .8 13h9.4l.8-13"/><path d="M10 11v5M14 11v5"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function renderFolderTabs(active = 'all') {
  return ['all:全部', 'unread:未读', 'starred:星标', 'archived:归档'].map((entry) => {
    const [key, label] = entry.split(':');
    return `<button type="button" class="mail-folder-tab${active === key ? ' is-active' : ''}" data-mail-folder="${key}">${label}</button>`;
  }).join('');
}

function groupMailboxThreads(messages = [], folder = 'all', query = '') {
  const groups = new Map();
  messages.filter((row) => !row.deleted).forEach((row) => {
    const rows = groups.get(row.threadId) || [];
    rows.push(row);
    groups.set(row.threadId, rows);
  });
  const needle = String(query || '').trim().toLowerCase();
  return [...groups.entries()].map(([threadId, rows]) => {
    rows.sort((a, b) => b.timestamp - a.timestamp);
    const folderRows = folder === 'archived' ? rows.filter((row) => row.archived) : rows.filter((row) => !row.archived);
    if (!folderRows.length) return null;
    if (folder === 'unread' && !folderRows.some((row) => row.direction === 'inbound' && !row.readAt)) return null;
    if (folder === 'starred' && !folderRows.some((row) => row.starred)) return null;
    if (needle && !rows.some((row) => [row.from?.name, row.from?.address, row.to?.[0]?.name, row.to?.[0]?.address, row.subject, row.preview]
      .some((value) => String(value || '').toLowerCase().includes(needle)))) return null;
    return {
      threadId,
      rows,
      latest: folderRows[0],
      unread: folderRows.some((row) => row.direction === 'inbound' && !row.readAt),
      starred: folderRows.some((row) => row.starred),
      archivedCount: rows.filter((row) => row.archived).length,
    };
  }).filter(Boolean).sort((a, b) => b.latest.timestamp - a.latest.timestamp);
}

async function renderInbox(container, user, params) {
  const folder = ['unread', 'starred', 'archived'].includes(params.folder) ? params.folder : 'all';
  const mailbox = await loadMailbox(user.id);
  const query = String(params.q || '').trim().toLowerCase();
  const visible = groupMailboxThreads(mailbox.messages, folder, query);
  const avatarPairs = await Promise.all(visible.slice(0, 120).map(async (thread) => [thread.threadId, await resolveMailAvatar(thread.latest, user.id)]));
  const avatars = new Map(avatarPairs);

  container.innerHTML = `
    <div class="mail-shell">
      <header class="mail-topbar">
        <div class="mail-heading-group">
          <button type="button" class="mail-icon-btn mail-exit-btn" data-mail-exit aria-label="返回">${mailGlyph('back')}</button>
          <div class="mail-heading"><h1>邮箱</h1><span>${esc(mailbox.accountAddress)}</span></div>
        </div>
        <div class="mail-top-actions">
          <button type="button" class="mail-icon-btn" data-mail-generate aria-label="生成来信">${mailGlyph('receive')}</button>
          <button type="button" class="mail-icon-btn" data-mail-settings aria-label="邮箱预设">${mailGlyph('settings')}</button>
          <button type="button" class="mail-icon-btn" data-mail-search aria-label="搜索">${mailGlyph('search')}</button>
          <button type="button" class="mail-icon-btn" data-mail-compose aria-label="写邮件">${mailGlyph('compose')}</button>
        </div>
      </header>
      <div class="mail-search-row" ${params.search === '1' ? '' : 'hidden'}>
        <input type="search" data-mail-search-input value="${esc(params.q || '')}" placeholder="搜索发件人、主题或正文" autocomplete="off">
        <button type="button" data-mail-search-cancel>取消</button>
      </div>
      <nav class="mail-folder-tabs" aria-label="邮箱分类">${renderFolderTabs(folder)}</nav>
      <main class="mail-list">
        ${visible.map((thread) => {
          const mail = thread.latest;
          const inbound = mail.direction === 'inbound';
          const party = inbound ? mail.from : (mail.to[0] || {});
          const avatar = avatars.get(thread.threadId);
          return `<button type="button" class="mail-row${thread.unread ? ' is-unread' : ''}" data-mail-id="${esc(mail.id)}">
            <span class="mail-unread-dot" aria-hidden="true"></span>
            <span class="mail-avatar">${avatar ? `<img src="${esc(avatar)}" alt="">` : avatarFallback(party.name)}</span>
            <span class="mail-row-copy">
              <span class="mail-row-line"><strong>${esc(inbound ? (party.name || party.address || '未知发件人') : `发给 ${party.name || party.address || '未知收件人'}`)}</strong><span class="mail-row-meta">${thread.rows.length > 1 ? `<span>${thread.rows.length} 封</span>` : ''}<time>${esc(formatListTime(mail.timestamp))}</time></span></span>
              <b>${esc(mail.subject)}${thread.archivedCount > 0 && thread.archivedCount < thread.rows.length ? '<small>含已归档邮件</small>' : ''}</b>
              <span>${esc(mail.preview || '（无正文）')}</span>
            </span>
            <span class="mail-row-star${thread.starred ? ' is-active' : ''}" aria-label="${thread.starred ? '已星标' : '未星标'}">${mailGlyph('star')}</span>
          </button>`;
        }).join('') || `<div class="mail-empty"><span>${folder === 'all' ? '✉' : '—'}</span><p>${query ? '没有找到相关邮件' : '这里还没有邮件'}</p></div>`}
      </main>
    </div>`;

  container.querySelector('[data-mail-exit]')?.addEventListener('click', () => back());
  container.querySelector('[data-mail-generate]')?.addEventListener('click', () => navigate('mailbox', { mode: 'generate' }));
  container.querySelector('[data-mail-settings]')?.addEventListener('click', () => navigate('mailbox', { mode: 'settings' }));
  container.querySelector('[data-mail-compose]')?.addEventListener('click', () => navigate('mailbox', { mode: 'compose' }));
  container.querySelector('[data-mail-search]')?.addEventListener('click', () => navigate('mailbox', { search: '1', folder, q: params.q || '' }));
  container.querySelector('[data-mail-search-cancel]')?.addEventListener('click', () => navigate('mailbox', { folder }, true));
  container.querySelector('[data-mail-search-input]')?.addEventListener('change', (event) => navigate('mailbox', { search: '1', folder, q: event.target.value }, true));
  container.querySelectorAll('[data-mail-folder]').forEach((button) => button.addEventListener('click', () => navigate('mailbox', { folder: button.getAttribute('data-mail-folder') }, true)));
  container.querySelectorAll('[data-mail-id]').forEach((button) => button.addEventListener('click', () => navigate('mailbox', { id: button.getAttribute('data-mail-id') })));
}

async function renderDetail(container, user, mail) {
  await markMailboxThreadRead(user.id, mail.threadId).catch(() => null);
  mail = await getMailboxMessage(user.id, mail.id) || mail;
  const thread = await listMailboxThread(user.id, mail.threadId);
  const latest = thread[thread.length - 1] || mail;
  const avatars = new Map(await Promise.all(thread.map(async (row) => [
    row.id,
    row.direction === 'inbound' ? await resolveMailAvatar(row, user.id) : '',
  ])));
  const threadArchived = thread.length > 0 && thread.every((row) => row.archived);
  const threadStarred = thread.some((row) => row.starred);
  container.innerHTML = `
    <div class="mail-shell mail-detail-shell" data-mail-detail-id="${esc(mail.id)}">
      <header class="mail-detail-topbar">
        <button type="button" class="mail-back-btn" data-mail-back>${mailGlyph('back')}<span>收件箱</span></button>
        <div class="mail-top-actions">
          <button type="button" class="mail-icon-btn${threadArchived ? ' is-active' : ''}" data-mail-thread-archive aria-label="${threadArchived ? '移回收件箱' : '归档邮件串'}">${mailGlyph('archive')}</button>
          <button type="button" class="mail-icon-btn${threadStarred ? ' is-active' : ''}" data-mail-thread-star aria-label="${threadStarred ? '取消星标' : '星标邮件串'}">${mailGlyph('star')}</button>
        </div>
      </header>
      <main class="mail-detail-scroll">
        <h1>${esc(mail.subject)}</h1>
        <div class="mail-thread-count">${thread.length > 1 ? `${thread.length} 封往来` : '1 封邮件'}</div>
        <section class="mail-thread" aria-label="邮件往来">
          ${thread.map((row, index) => {
            const expanded = index === thread.length - 1;
            const sender = row.direction === 'inbound' ? row.from : row.from;
            const recipient = row.direction === 'inbound' ? row.to : row.to;
            const avatar = avatars.get(row.id);
            const bodyTranslation = sanitizeAiTranslation(row.body, row.bodyTranslation);
            const canTranslate = !!bodyTranslation || messageLikelyNeedsTranslation(row.body);
            return `<article class="mail-thread-message${expanded ? ' is-expanded' : ''}${row.archived ? ' is-archived' : ''}" data-mail-thread-message="${esc(row.id)}">
              <div class="mail-thread-message-head">
                <button type="button" class="mail-message-toggle" data-mail-message-toggle aria-expanded="${expanded ? 'true' : 'false'}">
                  <span class="mail-avatar">${avatar ? `<img src="${esc(avatar)}" alt="">` : avatarFallback(sender?.name || (row.direction === 'outbound' ? '我' : '邮'))}</span>
                  <span class="mail-message-sender"><strong>${esc(sender?.name || sender?.address || (row.direction === 'outbound' ? '我' : '未知发件人'))}</strong><small>${esc(row.subject)}</small></span>
                  <span class="mail-message-time"><time>${esc(formatListTime(row.timestamp))}</time>${mailGlyph('chevron')}</span>
                </button>
                <div class="mail-message-more">
                  <button type="button" class="mail-message-more-btn" data-mail-message-more aria-label="这封邮件的更多操作" aria-expanded="false">${mailGlyph('more')}</button>
                  <div class="mail-message-menu" data-mail-message-menu hidden>
                    <button type="button" data-mail-edit="${esc(row.id)}">编辑这封邮件</button>
                    <button type="button" data-mail-single-archive="${esc(row.id)}">${row.archived ? '将这封移回收件箱' : '仅归档这封'}</button>
                    <button type="button" class="mail-danger-action" data-mail-delete="${esc(row.id)}">删除这封邮件</button>
                  </div>
                </div>
              </div>
              <div class="mail-thread-message-body" ${expanded ? '' : 'hidden'}>
                <div class="mail-recipient-line">${row.direction === 'inbound' ? '发给' : '发送给'} ${esc((recipient || []).filter(Boolean).map((party) => party.name || party.address).join('、') || '我')}</div>
                <div class="mail-body">${esc(row.body || '（无正文）')}</div>
                ${canTranslate ? `<div class="mail-translation-block">
                  <button type="button" class="mail-translate-btn" data-translation-toggle="${esc(row.id)}" aria-expanded="false">翻译</button>
                  <div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(bodyTranslation)}</div></div>
                </div>` : ''}
                ${row.direction === 'outbound' && row.replyStatus ? `
                  <div class="mail-reply-status${row.replyStatus === 'failed' ? ' is-failed' : ''}">
                    <span>${row.replyStatus === 'pending' ? '等待回信' : (row.replyStatus === 'answered' ? '已收到回信' : '暂时没有收到回信')}</span>
                    ${row.replyStatus === 'failed' ? `<button type="button" data-mail-retry="${esc(row.id)}">重新收信</button>` : ''}
                  </div>` : ''}
                <div class="mail-date-stamp">${esc(formatFullTime(row.timestamp))} · ${esc(mailboxTypeLabel(row.mailType))}${row.archived ? ' · 已归档' : ''}</div>
              </div>
            </article>`;
          }).join('')}
        </section>
      </main>
      <footer class="mail-detail-actions">
        <button type="button" data-mail-reply>${mailGlyph('reply')}<span>回复</span></button>
        <button type="button" data-mail-thread-star>${mailGlyph('star')}<span>${threadStarred ? '取消星标' : '星标'}</span></button>
        <button type="button" data-mail-thread-archive>${mailGlyph('archive')}<span>${threadArchived ? '移回收件箱' : '归档邮件串'}</span></button>
        <button type="button" class="mail-danger-action" data-mail-thread-delete>${mailGlyph('delete')}<span>删除邮件串</span></button>
      </footer>
    </div>`;
  container.querySelector('[data-mail-back]')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-mail-message-toggle]').forEach((button) => button.addEventListener('click', () => {
    const card = button.closest('[data-mail-thread-message]');
    const body = card?.querySelector('.mail-thread-message-body');
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    card?.classList.toggle('is-expanded', !expanded);
    if (body) body.hidden = expanded;
  }));
  container.querySelectorAll('[data-mail-message-more]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = button.parentElement?.querySelector('[data-mail-message-menu]');
    container.querySelectorAll('[data-mail-message-menu]').forEach((other) => {
      if (other !== menu) other.hidden = true;
    });
    if (menu) {
      menu.hidden = !menu.hidden;
      button.setAttribute('aria-expanded', String(!menu.hidden));
    }
  }));
  const closeMessageMenus = () => {
    container.querySelectorAll('[data-mail-message-menu]').forEach((menu) => { menu.hidden = true; });
    container.querySelectorAll('[data-mail-message-more]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  };
  container.querySelector('.mail-detail-shell')?.addEventListener('click', (event) => {
    if (!event.target.closest('.mail-message-more')) closeMessageMenus();
  });
  container.querySelector('.mail-detail-shell')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const activeMenuButton = container.querySelector('[data-mail-message-more][aria-expanded="true"]');
    closeMessageMenus();
    activeMenuButton?.focus();
  });
  container.querySelectorAll('[data-translation-toggle]').forEach((button) => button.addEventListener('click', async (event) => {
    const row = thread.find((item) => item.id === button.getAttribute('data-translation-toggle'));
    if (!row) return;
    const ok = await handleTranslationToggleClick(event.currentTarget, {
      sourceText: row.body,
      translationText: row.bodyTranslation,
      onRepaired: async (translation) => patchMailboxMessage(user.id, row.id, { bodyTranslation: translation }),
    });
    if (!ok) showToast('翻译暂时不可用，请稍后再试');
  }));
  container.querySelector('[data-mail-reply]')?.addEventListener('click', () => navigate('mailbox', { mode: 'compose', replyTo: latest.id }));
  container.querySelectorAll('[data-mail-retry]').forEach((button) => button.addEventListener('click', async (event) => {
    const mailId = button.getAttribute('data-mail-retry');
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = '收信中…';
    const result = await generateCharacterMailboxReply({ user, mailId });
    const next = await getMailboxMessage(user.id, mailId);
    await renderDetail(container, user, next || mail);
    showToast(result?.ok ? '收到回信了' : `收信失败：${result?.reason || '请稍后重试'}`);
  }));
  container.querySelectorAll('[data-mail-thread-star]').forEach((button) => button.addEventListener('click', async () => {
    await patchMailboxThread(user.id, mail.threadId, { starred: !threadStarred });
    await renderDetail(container, user, await getMailboxMessage(user.id, mail.id));
  }));
  container.querySelectorAll('[data-mail-thread-archive]').forEach((button) => button.addEventListener('click', async () => {
    await patchMailboxThread(user.id, mail.threadId, { archived: !threadArchived });
    showToast(threadArchived ? `已将邮件串移回收件箱（${thread.length} 封）` : `已归档此邮件串（${thread.length} 封）`);
    navigate('mailbox', { folder: threadArchived ? 'all' : 'archived' }, true);
  }));
  container.querySelectorAll('[data-mail-single-archive]').forEach((button) => button.addEventListener('click', async () => {
    const mailId = button.getAttribute('data-mail-single-archive');
    const row = thread.find((item) => item.id === mailId);
    if (!row) return;
    await patchMailboxMessage(user.id, row.id, { archived: !row.archived });
    showToast(row.archived ? '已将这封邮件移回收件箱' : '已归档这封邮件');
    await renderDetail(container, user, await getMailboxMessage(user.id, mail.id));
  }));
  container.querySelectorAll('[data-mail-edit]').forEach((button) => button.addEventListener('click', () => {
    navigate('mailbox', { mode: 'edit', id: button.getAttribute('data-mail-edit') });
  }));
  container.querySelectorAll('[data-mail-delete]').forEach((button) => button.addEventListener('click', async () => {
    const mailId = button.getAttribute('data-mail-delete');
    if (!window.confirm('删除这封邮件？')) return;
    await deleteMailboxMessage(user.id, mailId);
    const remaining = await listMailboxThread(user.id, mail.threadId);
    showToast('邮件已删除');
    if (!remaining.length) {
      navigate('mailbox', {}, true);
      return;
    }
    await renderDetail(container, user, remaining[remaining.length - 1]);
  }));
  container.querySelector('[data-mail-thread-delete]')?.addEventListener('click', async () => {
    if (!window.confirm(`删除整个邮件串（${thread.length} 封）？`)) return;
    await deleteMailboxThread(user.id, mail.threadId);
    showToast('邮件串已删除');
    navigate('mailbox', {}, true);
  });
}

async function renderEdit(container, user, mail) {
  container.innerHTML = `
    <div class="mail-shell mail-compose-shell">
      <header class="mail-compose-topbar">
        <button type="button" data-mail-edit-cancel>取消</button>
        <h1>编辑邮件</h1>
        <button type="button" class="mail-send-btn" data-mail-edit-save>保存</button>
      </header>
      <main class="mail-compose-form">
        <label><span>主题</span><input type="text" data-mail-subject value="${esc(mail.subject)}" maxlength="180" placeholder="邮件主题"></label>
        <label><span>类型</span><select data-mail-type>${MAILBOX_TYPE_OPTIONS.map((row) => `<option value="${esc(row.value)}" ${row.value === mail.mailType ? 'selected' : ''}>${esc(row.label)}</option>`).join('')}</select></label>
        <textarea data-mail-body maxlength="12000" placeholder="写点什么…">${esc(mail.body)}</textarea>
      </main>
    </div>`;
  container.querySelector('[data-mail-edit-cancel]')?.addEventListener('click', () => back());
  container.querySelector('[data-mail-edit-save]')?.addEventListener('click', async (event) => {
    const body = String(container.querySelector('[data-mail-body]')?.value || '').trim();
    if (!body) {
      showToast('请填写正文');
      return;
    }
    event.currentTarget.disabled = true;
    try {
      const saved = await editMailboxMessage(user.id, mail.id, {
        subject: container.querySelector('[data-mail-subject]')?.value,
        body,
        mailType: container.querySelector('[data-mail-type]')?.value,
      });
      if (!saved) throw new Error('邮件不存在或已删除');
      showToast('邮件已保存');
      navigate('mailbox', { id: saved.id }, true);
    } catch (error) {
      event.currentTarget.disabled = false;
      showToast(`保存失败：${error?.message || error}`);
    }
  });
}

async function renderCompose(container, user, params) {
  const [mailbox, recipients] = await Promise.all([
    loadMailbox(user.id),
    listMailboxRecipients(user.id),
  ]);
  const reply = params.replyTo ? await getMailboxMessage(user.id, params.replyTo) : null;
  const recipient = reply
    ? (reply.direction === 'inbound' ? reply.from : reply.to[0])
    : { name: '', address: '', actorId: '' };
  const subject = reply ? (/^回复[:：]/.test(reply.subject) ? reply.subject : `回复：${reply.subject}`) : '';
  const selectedType = normalizeMailboxType(reply?.mailType || 'auto');
  let selectedRecipient = recipients.find((row) => (
    row.address === recipient.address
    || (recipient.actorId && row.characterId === recipient.actorId)
  )) || null;
  if (!selectedRecipient && recipient.address) {
    selectedRecipient = {
      characterId: '',
      name: recipient.name || recipient.address,
      address: recipient.address,
      category: '',
      searchTerms: [recipient.name || ''].filter(Boolean),
    };
  }
  container.innerHTML = `
    <div class="mail-shell mail-compose-shell">
      <header class="mail-compose-topbar">
        <button type="button" data-mail-cancel>取消</button>
        <h1>${reply ? '回复' : '新邮件'}</h1>
        <button type="button" class="mail-send-btn" data-mail-send>发送</button>
      </header>
      <main class="mail-compose-form">
        <div class="mail-recipient-field">
          <span>收件人</span>
          <div class="mail-recipient-control">
            <input type="text" data-mail-recipient-search value="${esc(selectedRecipient?.name || selectedRecipient?.address || '')}" placeholder="输入人名、备注或邮箱" autocomplete="off" aria-label="收件人" aria-expanded="false">
            <div class="mail-recipient-results" data-mail-recipient-results hidden></div>
          </div>
        </div>
        <label><span>主题</span><input type="text" data-mail-subject value="${esc(subject)}" maxlength="180" placeholder="邮件主题"></label>
        <label><span>类型</span><select data-mail-type>${MAILBOX_TYPE_OPTIONS.map((row) => `<option value="${esc(row.value)}" ${row.value === selectedType ? 'selected' : ''}>${esc(row.label)}</option>`).join('')}</select></label>
        <textarea data-mail-body maxlength="12000" placeholder="写点什么…"></textarea>
      </main>
      <footer class="mail-compose-footer">
        <button type="button" class="mail-icon-btn" aria-label="添加附件">${mailGlyph('attach')}</button>
        <span>发件人：${esc(mailbox.accountAddress)}</span>
      </footer>
    </div>`;
  const recipientSearch = container.querySelector('[data-mail-recipient-search]');
  const recipientResults = container.querySelector('[data-mail-recipient-results]');
  const selectRecipientByAddress = (address = '') => {
    selectedRecipient = recipients.find((row) => row.address === address) || null;
    if (!selectedRecipient) return;
    recipientSearch.value = selectedRecipient.name;
    recipientResults.hidden = true;
    recipientSearch.setAttribute('aria-expanded', 'false');
  };
  const renderRecipientResults = () => {
    const query = String(recipientSearch?.value || '').trim().toLocaleLowerCase('zh-CN');
    const matched = recipients.filter((row) => !query || [
      row.name,
      row.address,
      ...(Array.isArray(row.searchTerms) ? row.searchTerms : []),
    ].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query)));
    recipientResults.innerHTML = Object.entries(MAILBOX_RECIPIENT_CATEGORIES).map(([category, label]) => {
      const rows = matched.filter((row) => row.category === category);
      if (!rows.length) return '';
      return `<section><div class="mail-recipient-group-label">${esc(label)}</div>${rows.map((row) => (
        `<button type="button" data-mail-recipient-address="${esc(row.address)}"><strong>${esc(row.name)}</strong><small>${esc(row.address)}</small></button>`
      )).join('')}</section>`;
    }).join('') || `<div class="mail-recipient-no-result">${query.includes('@') ? '按此邮箱地址发送' : '没有匹配的角色'}</div>`;
    recipientResults.querySelectorAll('[data-mail-recipient-address]').forEach((button) => {
      const chooseRecipient = () => selectRecipientByAddress(button.getAttribute('data-mail-recipient-address'));
      button.addEventListener('touchstart', (event) => {
        // 部分 Android WebView 会先触发输入框 blur，导致随后 click 的候选项已经消失。
        event.preventDefault();
        chooseRecipient();
      }, { passive: false });
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', chooseRecipient);
    });
    recipientResults.hidden = false;
    recipientSearch?.setAttribute('aria-expanded', 'true');
  };
  recipientSearch?.addEventListener('focus', renderRecipientResults);
  recipientSearch?.addEventListener('input', () => {
    selectedRecipient = null;
    renderRecipientResults();
  });
  recipientSearch?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      recipientResults.hidden = true;
      recipientSearch.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!['ArrowDown', 'Enter'].includes(event.key) || recipientResults.hidden) return;
    const firstResult = recipientResults.querySelector('[data-mail-recipient-address]');
    if (!firstResult) return;
    event.preventDefault();
    firstResult.click();
  });
  recipientSearch?.addEventListener('blur', () => {
    recipientResults.hidden = true;
    recipientSearch.setAttribute('aria-expanded', 'false');
  });
  container.querySelector('[data-mail-cancel]')?.addEventListener('click', () => back());
  container.querySelector('[data-mail-send]')?.addEventListener('click', async (event) => {
      const recipientInput = String(recipientSearch?.value || '').trim();
      const toAddress = selectedRecipient?.address || (recipientInput.includes('@') ? recipientInput : '');
      const nextSubject = String(container.querySelector('[data-mail-subject]')?.value || '').trim();
      const mailType = normalizeMailboxType(container.querySelector('[data-mail-type]')?.value || 'auto');
    const body = String(container.querySelector('[data-mail-body]')?.value || '').trim();
    if (!toAddress || !body) {
      showToast('请填写收件人和正文');
      return;
    }
    event.currentTarget.disabled = true;
    try {
      const resolvedRecipient = selectedRecipient?.characterId
        ? { characterId: selectedRecipient.characterId, name: selectedRecipient.name || '' }
        : await resolveMailboxRecipient(user.id, toAddress);
      const sent = await createMailboxMessage(user.id, {
        direction: 'outbound',
        from: { name: user.name || user.nickname || '我', address: mailbox.accountAddress },
        to: [{ name: resolvedRecipient?.name || selectedRecipient?.name || '', address: toAddress, actorId: resolvedRecipient?.characterId || selectedRecipient?.characterId || '' }],
        subject: nextSubject || '（无主题）',
        body,
        mailType,
        threadId: reply?.threadId || '',
        inReplyTo: reply?.id || '',
        characterId: resolvedRecipient?.characterId || selectedRecipient?.characterId || '',
        source: reply ? 'mail-reply' : 'user-compose',
        replyStatus: resolvedRecipient?.characterId || selectedRecipient?.characterId ? 'pending' : '',
      });
      showToast(resolvedRecipient?.characterId || selectedRecipient?.characterId ? '邮件已发送，等待回信' : '邮件已保存到发件箱');
      navigate('mailbox', { id: sent.id }, true);
      if (resolvedRecipient?.characterId || selectedRecipient?.characterId) {
        generateCharacterMailboxReply({ user, mailId: sent.id }).then(async (result) => {
          const shell = container.querySelector('.mail-detail-shell');
          if (shell?.getAttribute('data-mail-detail-id') !== sent.id) return;
          const latest = await getMailboxMessage(user.id, sent.id);
          if (latest) await renderDetail(container, user, latest);
          if (!result?.ok) showToast('暂时没有收到回信，稍后可以重试');
        });
      }
    } catch (error) {
      event.currentTarget.disabled = false;
      showToast(`发送失败：${error?.message || error}`);
    }
  });
}

async function loadManualMailboxTargets(userId) {
  const [recipients, groupConfig] = await Promise.all([
    listMailboxRecipients(userId),
    loadContactGroupsConfig().catch(() => ({ groups: [{ id: 'default', name: '默认' }] })),
  ]);
  const groupOptions = (groupConfig.groups || []).map((group) => ({
    ...group,
    count: recipients.filter((row) => row.category === 'contact' && row.groupId === group.id).length,
  })).filter((group) => group.count > 0);
  const recipientOptions = Object.entries(MAILBOX_RECIPIENT_CATEGORIES).map(([category, label]) => ({
    category,
    label,
    rows: recipients.filter((row) => row.category === category),
  })).filter((group) => group.rows.length > 0);
  return { recipients, groupOptions, recipientOptions };
}

function renderManualTargetOptions({ groupOptions = [], recipientOptions = [] } = {}) {
  return `
    <optgroup label="按来源轮换">
      ${MAILBOX_SOURCE_OPTIONS.map((row) => `<option value="source:${esc(row.value)}">${esc(row.label)}</option>`).join('')}
    </optgroup>
    ${groupOptions.length ? `<optgroup label="按通讯录分组">${groupOptions.map((group) => `<option value="group:${esc(group.id)}">${esc(group.name)}（${group.count}）</option>`).join('')}</optgroup>` : ''}
    ${recipientOptions.map((group) => `<optgroup label="指定${esc(group.label)}">${group.rows.map((row) => `<option value="character:${esc(row.characterId)}">${esc(row.name)}</option>`).join('')}</optgroup>`).join('')}`;
}

async function renderGenerate(container, user) {
  const targetOptions = await loadManualMailboxTargets(user.id);
  container.innerHTML = `
    <div class="mail-shell mail-generate-shell">
      <header class="mail-compose-topbar">
        <button type="button" data-mail-generate-back>取消</button>
        <h1>生成来信</h1>
        <span class="mail-topbar-spacer" aria-hidden="true"></span>
      </header>
      <main class="mail-preset-form mail-generate-form">
        <label>
          <span>生成对象</span>
          <select data-mail-manual-target>${renderManualTargetOptions(targetOptions)}</select>
        </label>
        <button type="button" class="mail-generate-round-btn" data-mail-generate-round>生成一封</button>
      </main>
    </div>`;
  container.querySelector('[data-mail-generate-back]')?.addEventListener('click', () => back());
  container.querySelector('[data-mail-generate-round]')?.addEventListener('click', async (event) => {
    const target = String(container.querySelector('[data-mail-manual-target]')?.value || 'source:contact');
    const separator = target.indexOf(':');
    const targetType = separator > 0 ? target.slice(0, separator) : 'source';
    const targetId = separator > 0 ? target.slice(separator + 1) : 'contact';
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '生成中…';
    try {
      const result = await generateMailboxRound({
        user,
        sources: targetType === 'source' ? [targetId] : ['contact'],
        groupId: targetType === 'group' ? targetId : '',
        characterId: targetType === 'character' ? targetId : '',
        reason: 'manual',
      });
      if (result.generatedCount > 0) {
        showToast(`收到来自 ${result.messages?.[0]?.name || 'TA'} 的新邮件`);
        navigate('mailbox', { id: result.messages[0].mailId }, true);
        return;
      }
      const reason = result.reason === 'target-out-of-scope'
        ? '这个角色不属于当前身份'
        : result.reason === 'no-source-candidates'
          ? '所选范围暂时没有可写信的人'
          : `生成失败：${result.reason || '请稍后重试'}`;
      showToast(reason);
    } catch (error) {
      showToast(`生成失败：${error?.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = '生成一封';
    }
  });
}

async function renderSettings(container, user) {
  const preset = await loadMailboxPreset(user.id);
  container.innerHTML = `
    <div class="mail-shell mail-preset-shell">
      <header class="mail-compose-topbar">
        <button type="button" data-mail-preset-back>取消</button>
        <h1>邮箱预设</h1>
        <button type="button" class="mail-send-btn" data-mail-preset-save>保存</button>
      </header>
      <main class="mail-preset-form">
        <label class="mail-preset-toggle">
          <span>定时查收邮箱</span>
          <input type="checkbox" data-mail-auto-enabled ${preset.autoFetchEnabled ? 'checked' : ''}>
        </label>
        <label data-mail-auto-interval-row ${preset.autoFetchEnabled ? '' : 'hidden'}>
          <span>生成间隔（小时）</span>
          <input type="number" data-mail-auto-interval min="1" max="720" step="1" value="${preset.autoFetchIntervalHours}">
        </label>
        <fieldset class="mail-source-field">
          <legend>定时来信来源</legend>
          ${MAILBOX_SOURCE_OPTIONS.map((row) => `<label><span>${esc(row.label)}</span><input type="checkbox" data-mail-source="${esc(row.value)}" ${preset.autoFetchSources.includes(row.value) ? 'checked' : ''}></label>`).join('')}
        </fieldset>
        <label>
          <span>私聊上下文条数</span>
          <input type="number" data-mail-preset-depth min="20" max="160" step="10" value="${preset.contextDepth}">
        </label>
        <label>
          <span>主动邮件倾向</span>
          <select data-mail-preset-bias>${MAILBOX_TYPE_BIAS_OPTIONS.map((row) => `<option value="${esc(row.value)}" ${row.value === preset.typeBias ? 'selected' : ''}>${esc(row.label)}</option>`).join('')}</select>
        </label>
        <label class="mail-preset-instruction">
          <span>自定义邮件指令</span>
          <textarea data-mail-preset-instruction maxlength="4000" placeholder="留空则跟随角色与当下关系">${esc(preset.customInstruction)}</textarea>
        </label>
      </main>
    </div>`;
  const selectedSources = () => [...container.querySelectorAll('[data-mail-source]:checked')]
    .map((input) => input.getAttribute('data-mail-source'))
    .filter(Boolean);
  const autoEnabled = container.querySelector('[data-mail-auto-enabled]');
  const autoIntervalRow = container.querySelector('[data-mail-auto-interval-row]');
  autoEnabled?.addEventListener('change', () => {
    autoIntervalRow.hidden = !autoEnabled.checked;
  });
  container.querySelector('[data-mail-preset-back]')?.addEventListener('click', () => back());
  container.querySelector('[data-mail-preset-save]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const sources = selectedSources();
      if (!sources.length) {
        showToast('请至少选择一种来信来源');
        event.currentTarget.disabled = false;
        return;
      }
      await saveMailboxPreset(user.id, {
        autoFetchEnabled: autoEnabled?.checked === true,
        autoFetchIntervalHours: container.querySelector('[data-mail-auto-interval]')?.value,
        autoFetchSources: sources,
        contextDepth: container.querySelector('[data-mail-preset-depth]')?.value,
        typeBias: container.querySelector('[data-mail-preset-bias]')?.value,
        customInstruction: container.querySelector('[data-mail-preset-instruction]')?.value,
      });
      showToast('邮箱预设已保存');
      back();
    } catch (error) {
      event.currentTarget.disabled = false;
      showToast(`保存失败：${error?.message || error}`);
    }
  });
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  container.className = 'page mailbox-page';
  if (params.mode === 'settings') {
    await renderSettings(container, user);
    return;
  }
  if (params.mode === 'generate') {
    await renderGenerate(container, user);
    return;
  }
  if (params.mode === 'compose') {
    await renderCompose(container, user, params);
    return;
  }
  if (params.mode === 'edit' && params.id) {
    const mail = await getMailboxMessage(user.id, params.id);
    if (mail && !mail.deleted) {
      await renderEdit(container, user, mail);
      return;
    }
  }
  if (params.id) {
    const mail = await getMailboxMessage(user.id, params.id);
    if (mail && !mail.deleted) {
      await renderDetail(container, user, mail);
      return;
    }
  }
  await renderInbox(container, user, params);
}
