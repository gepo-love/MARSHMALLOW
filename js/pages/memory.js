import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getMany } from '../core/db.js';
import { isAnonymousNpcRecord } from '../models/character.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import {
  loadMemoryWorkspace,
  listMemoryCharacterIds,
  scopeTotal,
  deleteGhostCharacterScope,
  GLOBAL_SCOPE_ID,
} from '../core/memory/memory-scope.js';
import { getMemoryIconSvg } from '../data/memory-layout.js';
import { showToast } from '../components/toast.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bubble(total) {
  const text = total > 99 ? '99+' : String(total);
  return `<span class="mh-bubble ${total === 0 ? 'is-empty' : ''}">${text}</span>`;
}

/** 首帧先画记忆馆结构，数据聚合期间不显示通用「加载中」。 */
function renderMemorySkeleton(container) {
  if (container.firstElementChild) return;
  container.className = 'page memory-hall';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" aria-label="返回" disabled>${icon('back')}</button>
      <h1 class="navbar-title">记忆馆</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="memory-hall-scroll" aria-busy="true">
      <div class="page-skeleton" aria-hidden="true">
        <span class="sk-block sk-bar" style="width:42%"></span>
        <div class="sk-grid">
          <span class="sk-block sk-tile"></span>
          <span class="sk-block sk-tile"></span>
          <span class="sk-block sk-tile"></span>
          <span class="sk-block sk-tile"></span>
        </div>
      </div>
    </main>`;
}

export default async function render(container) {
  renderMemorySkeleton(container);
  const user = await ensureDefaultUser();
  const slotName = String(user.slotName || user.name || '默认档').trim() || '默认档';
  const [
    ws,
    lightweightNpcModule,
    phoneContactsModule,
    relationshipModule,
    hygieneModule,
  ] = await Promise.all([
    loadMemoryWorkspace(user.id),
    import('../core/lightweight-npc.js'),
    import('../core/character-phone-contacts.js'),
    import('../core/relationship-network.js'),
    import('../core/data-hygiene.js'),
  ]);
  const {
    buildLightweightNpcCharacter,
    isLightweightNpcId,
  } = lightweightNpcModule;
  const {
    buildPhoneLightContactCharacter,
    loadPhoneContactAcrossOwnersLookup,
  } = phoneContactsModule;
  const ids = listMemoryCharacterIds(ws);
  const [relationshipNetwork, knownActorIds, storedCharacters, findPhoneContact] = await Promise.all([
    relationshipModule.loadRelationshipNetwork(),
    hygieneModule.loadKnownActorIdSet(),
    getMany('characters', ids),
    loadPhoneContactAcrossOwnersLookup(),
  ]);
  const relationshipNpcById = new Map(
    (relationshipNetwork?.npcs || [])
      .filter((row) => row?.id)
      .map((row) => [String(row.id).trim(), row]),
  );
  const characters = (await Promise.all(ids.map(async (id, index) => {
    // 角色表读取失败时必须让页面加载失败，不能把临时数据库错误伪装成“全部是幽灵角色”。
    let ch = storedCharacters[index] || null;
    let isPhoneContact = false;
    // 联系人的规范身份不一定仍以 phone-contact: 开头：旧记录常把 lightnpc_*
    // 放在 linkedActorId。必须按全部联系人字段反查，否则数据自检会保护它，
    // 记忆馆却把它显示成“能删但实际删不掉”的幽灵角色。
    if (!ch) {
      const hit = findPhoneContact(id);
      if (hit?.contact) {
        ch = buildPhoneLightContactCharacter(hit.contact, hit.ownerId);
        isPhoneContact = true;
      }
    }
    if (!ch) {
      const relationshipNpc = relationshipNpcById.get(String(id || '').trim());
      if (relationshipNpc) ch = buildLightweightNpcCharacter(relationshipNpc);
    }
    const isKnownActor = knownActorIds.has(String(id || '').trim());
    // 一条仍存在的聊天也是轻量身份的强锚点。若实体资料暂缺，不展示危险的删除入口；
    // 后续可从手机联系人或关系网恢复资料，而不是误清整组记忆。
    if (!ch && isKnownActor) {
      ch = {
        id,
        name: id,
        metadata: { isLightweightNpc: true },
        _lightweightNpc: true,
      };
    }
    // 一次性群聊路人仍只收进全局匿名往事；已私聊、收藏或相认的路人才有独立入口。
    if (ch && isAnonymousNpcRecord(ch)
      && ch.anonymousLifecycle?.retained !== true
      && !['private', 'revealed'].includes(String(ch.anonymousLifecycle?.phase || ''))) return null;
    // 通讯录里已经查不到这个 id 对应的角色卡了：不是真实角色，是记忆/事实里残留的
    // 脏数据（曾经把一段人名原文当成了角色 id，或者角色本身已被删除），标成幽灵角色，
    // 只给「查看 + 删除」，不当正常角色卡展示。关系网轻量 NPC / 仍在用的手机联系人算合法身份。
    const isLightNpc = !!(ch && (
      isPhoneContact
      || ch._lightweightNpc
      || ch.metadata?.isLightweightNpc
      || isLightweightNpcId(id)
      || /^(?:npc_|phone-contact:)/i.test(String(id || ''))
    ));
    return {
      id,
      name: (ch && (ch.name || ch.customNickname)) || id,
      char: ch,
      total: scopeTotal(ws, id),
      isGhost: !isKnownActor,
      isLightNpc,
      isPhoneContact,
    };
  }))).filter(Boolean);
  characters.sort((a, b) => (Number(a.isGhost) - Number(b.isGhost)) || (b.total - a.total) || a.name.localeCompare(b.name, 'zh-CN'));

  const globalTotal = scopeTotal(ws, GLOBAL_SCOPE_ID);
  const hasAny = characters.length || globalTotal;

  const prevScroll = captureScrollerTop(container, '.memory-hall-scroll');
  container.className = 'page memory-hall';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">记忆馆</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="memory-hall-scroll">
      <div class="memory-hall-intro">
        <div class="mh-slot-chip">当前档位 · ${esc(slotName)}</div>
        <div class="mh-sub">选一位 TA，翻开属于你们的记忆馆</div>
      </div>
      ${hasAny ? `
        <div class="mh-picker">
          ${characters.map((c) => `
            <button type="button" class="mh-pick-card ${c.isGhost ? 'is-ghost' : ''}" data-character="${esc(c.id)}">
              ${c.isGhost ? `<span class="mh-pick-ghost-del" data-ghost-del="${esc(c.id)}" data-ghost-name="${esc(c.name)}" aria-label="删除幽灵角色">${icon('trash')}</span>` : ''}
              <span class="mh-pick-avatar">${characterAvatarHtml(c.char, { className: 'mh-pick-avatar-img' })}</span>
              <span class="mh-pick-name">${esc(c.name)}</span>
              <span class="mh-pick-hint">${c.isGhost ? '疑似残留身份 · 已无有效来源' : (c.isPhoneContact ? '手机联系人 · ' : (c.isLightNpc ? '轻量 NPC · ' : (isAnonymousNpcRecord(c.char) ? '匿名网友 · ' : '')))}${c.total ? `${c.total} 条记忆` : '还没有记忆'}</span>
            </button>
          `).join('')}
          <button type="button" class="mh-pick-card mh-pick-global" data-character="${GLOBAL_SCOPE_ID}">
            <span class="mh-pick-avatar mh-pick-avatar-icon">${getMemoryIconSvg('jar')}</span>
            <span class="mh-pick-name">全局 · 共享</span>
            <span class="mh-pick-hint">群聊与未归属的记忆</span>
          </button>
        </div>
      ` : `
        <div class="chat-empty scrapbook-empty">
          ${emptyIllustration('memory')}
          <div class="chat-empty-text">这个档位还没有记忆</div>
          <div class="chat-empty-hint">和 TA 聊起来，开启自动摘要后，这里会按角色收纳你们的故事</div>
        </div>
      `}
    </main>
  `;
  restoreScrollerTop(container, '.memory-hall-scroll', prevScroll);

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-character]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-ghost-del]')) return;
      const character = card.getAttribute('data-character');
      if (character) navigate('memory/hall', { character });
    });
  });
  container.querySelectorAll('[data-ghost-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ghostId = btn.getAttribute('data-ghost-del');
      const ghostName = btn.getAttribute('data-ghost-name') || ghostId;
      if (!ghostId) return;
      if (!window.confirm(`删除幽灵角色「${ghostName}」？TA 名下的记忆、事实、相册与孤儿关系节点都会被清掉，此操作不可撤销。`)) return;
      try {
        // 确认框可能停留较久，期间角色可能已恢复；删除前用与数据自检相同的
        // 完整身份规则重新核验，档位 ID、正式角色及轻量身份一律不能删除。
        const { scanDataHygiene } = await import('../core/data-hygiene.js');
        const report = await scanDataHygiene();
        const stillGhost = report.ghostMemoryScopes.some((item) => (
          String(item?.userId || '').trim() === String(user.id || '').trim()
          && String(item?.characterId || '').trim() === String(ghostId || '').trim()
        ));
        if (!stillGhost) {
          showToast('该身份仍在使用，已取消删除');
          await render(container);
          return;
        }
        await deleteGhostCharacterScope(user.id, ghostId);
        showToast('已删除幽灵角色');
        await render(container);
      } catch (err) {
        showToast('删除失败');
      }
    });
  });
}
