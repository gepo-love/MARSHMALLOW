import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { listCharacters } from '../core/character-store.js';
import { isSelectableContactCharacter } from '../models/character.js';
import { isAnonymousNpcCharacter } from '../core/anonymous-npc.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  getUserDisplayName,
  hasActiveIdentityBinding,
  identityBindingSelectsCharacter,
} from '../models/user.js';
import { resolveActorDisplayLabel } from '../core/chat/character-code-fallback.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import {
  createGroupChat,
  getChat,
  listChatsForUser,
  participantSetKey,
  saveChat,
} from '../core/chat-store.js';
import {
  loadRelationshipNetwork,
  saveRelationshipNetwork,
  findCircle,
  newEdgeId,
} from '../core/relationship-network.js';
import {
  loadAcquaintanceLedger,
  recordAcquaintance,
  removeAcquaintance,
} from '../core/acquaintance-ledger.js';
import {
  loadAppearancePrefs,
  getActiveTheme,
  applySettingsWallpaperPreview,
  isWindowHomeTheme,
  isSeaHomeTheme,
} from '../core/appearance-prefs.js';
import {
  createPhoneSocialActorDirectory,
  phoneSocialActorNameKey,
} from '../core/phone-social-actor-directory.js';
import { dismissLightweightNpc } from '../core/lightweight-npc.js';

const PERSON_ICON = '<path d="M0-5.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9M-7.5 12c0-3.5 3.1-6.5 7.5-6.5s7.5 3 7.5 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 小群关系图布局：我在下方，其余在上方弧线 */
function sceneLayout(nodeIds, w = 320, h = 260) {
  const pos = {};
  const userY = h - 36;
  const cx = w / 2;
  if (!nodeIds.length) return pos;
  const others = nodeIds.filter((id) => id !== 'user');
  pos.user = { x: cx, y: userY };
  if (!others.length) return pos;
  if (others.length === 1) {
    pos[others[0]] = { x: cx, y: 72 };
    return pos;
  }
  const arcR = Math.min(w * 0.34, 88);
  const arcCy = userY - arcR - 28;
  others.forEach((id, i) => {
    const ang = Math.PI + ((i + 1) / (others.length + 1)) * Math.PI;
    pos[id] = { x: cx + arcR * Math.cos(ang), y: arcCy + arcR * Math.sin(ang) * 0.55 };
  });
  return pos;
}

function renderSceneGraph(group, circle, ctx) {
  const { nodeName, nodeKind, userName } = ctx;
  if (!group) {
    return `
      <div class="rn-scene rn-scene--empty">
        <p>建一个小群，已标的关系会在这里展示。</p>
        <button type="button" class="rn-scene-cta" data-open="group">建小群</button>
      </div>`;
  }
  const memberSet = new Set((group.memberIds || []).filter((id) => nodeKind(id)));
  const inScene = (id) => id === 'user' || memberSet.has(id);
  const nodeIds = ['user', ...group.memberIds.filter((id) => memberSet.has(id))];
  const edges = (circle.edges || []).filter((e) => inScene(e.a) && inScene(e.b));
  const pos = sceneLayout(nodeIds);

  const lines = edges.map((e) => {
    const pa = pos[e.a === 'user' ? 'user' : e.a] || pos.user;
    const pb = pos[e.b === 'user' ? 'user' : e.b] || pos.user;
    if (!pa || !pb) return '';
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2 - 6;
    const label = e.label ? `<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" class="rn-scene-edge-label" text-anchor="middle">${esc(e.label)}</text>` : '';
    return `<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" class="rn-scene-edge"/>${label}`;
  }).join('');

  const nodes = nodeIds.map((id) => {
    const p = pos[id];
    if (!p) return '';
    const isUser = id === 'user';
    const kind = isUser ? 'me' : nodeKind(id);
    const name = isUser ? userName : nodeName(id);
    const isNpc = kind === 'npc';
    const label = isNpc ? `<text x="${p.x.toFixed(1)}" y="${(p.y + 36).toFixed(1)}" class="rn-scene-npc-tag" text-anchor="middle">NPC</text>` : '';
    return `
      <g class="rn-scene-node-wrap rn-scene-node-wrap--${kind}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
        <circle r="22" class="rn-scene-node${isNpc ? ' is-npc' : ''}"/>
        <g class="rn-scene-icon" transform="scale(0.9)">${PERSON_ICON}</g>
        <text class="rn-scene-name" y="34" text-anchor="middle">${esc((name || '').slice(0, 4))}</text>
        ${label}
      </g>`;
  }).join('');

  return `
    <div class="rn-scene">
      <svg class="rn-scene-svg" viewBox="0 0 320 260" preserveAspectRatio="xMidYMid meet" aria-label="${esc(group.name)}关系图">
        ${lines}${nodes}
      </svg>
      <div class="rn-scene-cap">${esc(group.name)} · 共享记忆</div>
    </div>`;
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const [prefs, chars] = await Promise.all([
    loadAppearancePrefs().catch(() => null),
    listCharacters({ userId: user.id }).catch(() => []),
  ]);
  const active = getActiveTheme(prefs);
  const theme = active.theme;
  const glassTheme = isWindowHomeTheme(active.id, theme) || isSeaHomeTheme(active.id, theme);
  const userName = getUserDisplayName(user) || '我';
  const binding = user?.identityBinding && typeof user.identityBinding === 'object'
    ? user.identityBinding
    : {};
  // 未绑定继续使用旧版全员关系网；scope=identity 的旧链接也不能把页面筛成空白。
  const identityScope = String(params.scope || '') === 'identity'
    && hasActiveIdentityBinding(binding);

  let [net, acquaintanceLedger] = await Promise.all([
    loadRelationshipNetwork(user.id),
    loadAcquaintanceLedger(user.id).catch(() => ({ entries: [] })),
  ]);
  const characters = (chars || [])
    .filter((c) => isSelectableContactCharacter(c) && !isAnonymousNpcCharacter(c))
    .filter((c) => {
      if (!identityScope) return true;
      return identityBindingSelectsCharacter(binding, c);
    });
  const charById = new Map(characters.map((c) => [c.id, c]));

  const state = { view: 'overview', circleId: null, groupId: null, overlay: null, draft: null };

  container.className = `page scrapbook-page rel-net${glassTheme ? ' rel-net--glass' : ''}`;
  if (theme) applySettingsWallpaperPreview(container, theme);

  async function persist() {
    net = await saveRelationshipNetwork(net, user.id);
  }

  function npcById(id) {
    return (net.npcs || []).find((n) => n.id === id) || null;
  }
  function nodeName(id) {
    if (id === 'user') return userName;
    const c = charById.get(id);
    if (c) {
      return resolveActorDisplayLabel(c.name || c.realName || c.customNickname, {
        user,
        characters: { [id]: c },
        fallback: '角色',
      });
    }
    const n = npcById(id);
    if (n?.name) return String(n.name).trim();
    return resolveActorDisplayLabel(id, { user, fallback: '已移除' });
  }
  function nodeKind(id) {
    if (id === 'user') return 'me';
    if (charById.has(id)) return 'char';
    if (npcById(id)) return 'npc';
    return null;
  }
  function circleMembers(circle) {
    return (circle.memberIds || [])
      .map((id) => ({ id, name: nodeName(id), kind: nodeKind(id) }))
      .filter((m) => m.kind && m.kind !== 'me');
  }
  function activeGroup(circle) {
    if (!circle) return null;
    const groups = circle.groups || [];
    if (!groups.length) return null;
    return groups.find((g) => g.id === state.groupId) || groups[0];
  }
  const graphCtx = { nodeName, nodeKind, userName };

  function renderOverview() {
    const circles = net.circles || [];
    const rows = circles.map((c) => {
      const members = circleMembers(c);
      const meta = [
        `${members.length} 人`,
        (c.edges || []).length ? `${(c.edges || []).length} 条关系` : '',
        (c.groups || []).length ? `${(c.groups || []).length} 小群` : '',
      ].filter(Boolean).join(' · ') || '空子网';
      return `
        <button type="button" class="rn-subnet-row" data-circle="${esc(c.id)}">
          <span class="rn-subnet-meta">
            <span class="rn-subnet-name">${esc(c.name)}</span>
            <span class="rn-subnet-sub">${esc(meta)}</span>
          </span>
          <span class="rn-subnet-chev" aria-hidden="true">›</span>
        </button>`;
    }).join('');
    const hint = circles.length
      ? ''
      : '<div class="rn-ov-hint">关系网由多个子网组成。把互相认识的人放进同一子网，再建小群、标特别关系；关系图只展示小群，不会把所有人摊在一张图上。</div>';
    const dynamicRows = (acquaintanceLedger.entries || [])
      .filter((entry) => charById.has(entry.a) && charById.has(entry.b))
      .slice(0, 20)
      .map((entry) => `
        <div class="rn-list-row">
          <button type="button" class="rn-ledger-main" data-ledger-edit="${esc(entry.a)}|${esc(entry.b)}">
            <span>${esc(nodeName(entry.a))} · ${esc(entry.label || '认识')} · ${esc(nodeName(entry.b))}</span>
            <span class="rn-list-row-hint">${entry.source === 'ai' ? '剧情更新' : '互动记录'}</span>
          </button>
          <button type="button" class="rn-ledger-remove" data-ledger-remove="${esc(entry.a)}|${esc(entry.b)}" aria-label="删除这条认识记录">×</button>
        </div>`).join('');
    const dynamicPanel = dynamicRows ? `
      <section class="rn-panel rn-ledger-panel">
        <div class="rn-panel-head">
          <span class="rn-panel-title">剧情认识</span>
          <span class="rn-panel-count">${(acquaintanceLedger.entries || []).length}</span>
        </div>
        <div class="rn-list">${dynamicRows}</div>
      </section>` : '';
    return `
      <div class="rn-overview">
        ${hint}
        <div class="rn-subnet-list">${rows}</div>
        <button type="button" class="rn-subnet-row rn-subnet-row--add" data-open="circle-new">
          ${icon('plus')}<span>新建子网</span>
        </button>
        ${dynamicPanel}
      </div>`;
  }

  function renderMemberPanel(circle) {
    const members = circleMembers(circle);
    const chips = members.slice(0, 14).map((m) =>
      `<span class="rn-chip rn-chip--${m.kind}">${esc((m.name || '').slice(0, 6))}</span>`,
    ).join('');
    const more = members.length > 14 ? `<span class="rn-chip rn-chip--more">+${members.length - 14}</span>` : '';
    return `
      <section class="rn-panel">
        <div class="rn-panel-head">
          <span class="rn-panel-title">成员</span>
          <span class="rn-panel-count">${members.length}</span>
          <button type="button" class="rn-panel-action" data-open="members">管理</button>
        </div>
        <div class="rn-member-chips">${chips || '<span class="rn-panel-empty-inline">还没有成员</span>'}${more}</div>
      </section>`;
  }

  function renderEdgesPanel(circle) {
    const idSet = new Set(circle.memberIds || []);
    idSet.add('user');
    const edges = (circle.edges || []).filter((e) => idSet.has(e.a) && idSet.has(e.b));
    const list = edges.length
      ? edges.map((e) => `
          <button type="button" class="rn-list-row" data-edge-edit="${esc(e.id)}">
            <span>${esc(nodeName(e.a))} · ${esc(e.label || '关系')} · ${esc(nodeName(e.b))}</span>
            <span class="rn-list-row-hint">编辑</span>
          </button>`).join('')
      : '<div class="rn-panel-empty-inline">还没有标过关系。同网默认认识，特别关系在这里标。</div>';
    return `
      <section class="rn-panel">
        <div class="rn-panel-head">
          <span class="rn-panel-title">已标关系</span>
          <button type="button" class="rn-panel-action" data-open="edge">新增</button>
        </div>
        <div class="rn-list">${list}</div>
      </section>`;
  }

  function renderGroupsPanel(circle, activeGrp) {
    const groups = circle.groups || [];
    const list = groups.length
      ? groups.map((g) => `
          <button type="button" class="rn-list-row${activeGrp && activeGrp.id === g.id ? ' is-active' : ''}" data-select-group="${esc(g.id)}">
            <span>${esc(g.name)}</span>
            <span class="rn-list-row-meta">${g.memberIds.length} 人 · 共享记忆</span>
          </button>`).join('')
      : '<div class="rn-panel-empty-inline">还没有小群。建一个后，上方关系图只展示该群成员。</div>';
    return `
      <section class="rn-panel">
        <div class="rn-panel-head">
          <span class="rn-panel-title">小群</span>
          ${activeGrp ? `<button type="button" class="rn-panel-action" data-group-edit>管理</button>` : ''}
          <button type="button" class="rn-panel-action" data-open="group">新建</button>
        </div>
        <div class="rn-list">${list}</div>
      </section>`;
  }

  function renderSubnetView() {
    const circle = findCircle(net, state.circleId);
    if (!circle) { state.view = 'overview'; return renderOverview(); }
    const group = activeGroup(circle);
    const groups = circle.groups || [];
    const pickOpts = groups.map((g) =>
      `<option value="${esc(g.id)}"${(state.groupId || groups[0]?.id) === g.id ? ' selected' : ''}>${esc(g.name)}</option>`,
    ).join('');
    const filterBar = groups.length ? `
      <div class="rn-filterbar">
        <label class="rn-pill rn-pill--dark">
          <select class="rn-group-pick" data-group-pick>${pickOpts}</select>
        </label>
        <span class="rn-pill rn-pill--ghost">关系图 · 当前小群</span>
      </div>` : '';

    return `
      <div class="rn-subnet">
        <div class="rn-subnet-head">
          <button type="button" class="rn-subnet-back" data-overview>${icon('back')}<span>关系网</span></button>
          <span class="rn-subnet-title">${esc(circle.name)}</span>
          <button type="button" class="rn-subnet-more" data-open="circle-edit" aria-label="管理子网">${icon('more')}</button>
        </div>
        ${filterBar}
        ${renderSceneGraph(group, circle, graphCtx)}
        <div class="rn-panels">
          ${renderMemberPanel(circle)}
          ${renderEdgesPanel(circle)}
          ${renderGroupsPanel(circle, group)}
        </div>
      </div>`;
  }

  function memberChecklist(selectedIds, opts = {}) {
    const sel = new Set(selectedIds || []);
    const npcNameCounts = new Map();
    for (const npc of net.npcs || []) {
      const key = phoneSocialActorNameKey(npc?.name);
      if (key) npcNameCounts.set(key, (npcNameCounts.get(key) || 0) + 1);
    }
    const npcRows = (net.npcs || []).map((n) => {
      const duplicate = (npcNameCounts.get(phoneSocialActorNameKey(n.name)) || 0) > 1;
      const source = (n.sourceChatIds || []).length ? '对话产生' : '关系网条目';
      const canDelete = !/^phone-contact:/i.test(String(n.id || ''));
      return `
        <span class="rn-npc-check">
          <label class="rn-check rn-check--npc">
            <input type="checkbox" data-member="${esc(n.id)}" ${sel.has(n.id) ? 'checked' : ''}>
            <span>${esc(n.name)}${duplicate ? `<small>${esc(source)}</small>` : ''}</span>
          </label>
          ${canDelete ? `<button type="button" class="rn-npc-delete" data-delete-npc="${esc(n.id)}" aria-label="删除 NPC ${esc(n.name)}">${icon('trash')}</button>` : ''}
        </span>`;
    }).join('');
    const charRows = characters.map((c) => `
      <label class="rn-check">
        <input type="checkbox" data-member="${esc(c.id)}" ${sel.has(c.id) ? 'checked' : ''}>
        <span>${esc(c.name || '角色')}</span>
      </label>`).join('');
    const npcAdder = opts.allowNpc ? `
      <div class="rn-npc-add">
        <input class="rn-input" data-new-npc placeholder="加个简单 NPC，如 房东" maxlength="24">
        <button type="button" class="rn-btn rn-btn-ok rn-npc-add-btn" data-new-npc-btn>加</button>
      </div>` : '';
    const body = (charRows + npcRows) || `<div class="rn-panel-empty-inline">${identityScope ? '当前身份还没有绑定角色。' : '还没有角色，先去通讯录新建。'}</div>`;
    return `${npcAdder}<div class="rn-checks">${body}</div>`;
  }

  function renderOverlay() {
    if (!state.overlay) return '';
    const circle = findCircle(net, state.circleId);

    if (state.overlay === 'circle-new') {
      return overlayShell('新建子网', `
        <label class="rn-ed-label">子网名</label>
        <input class="rn-input" data-circle-name placeholder="如 全职 / 合租公寓" maxlength="24">
      `, '创建');
    }
    if (state.overlay === 'circle-edit') {
      return overlayShell('管理子网', `
        <label class="rn-ed-label">子网名</label>
        <input class="rn-input" data-circle-name value="${esc(circle ? circle.name : '')}" maxlength="24">
      `, '保存', '删除子网');
    }
    if (state.overlay === 'members') {
      return overlayShell('管理成员', memberChecklist(circle ? circle.memberIds : [], { allowNpc: true }), '保存');
    }
    if (state.overlay === 'edge' || state.overlay === 'edge-edit') {
      const members = circle ? circleMembers(circle) : [];
      if (members.length < 1) {
        return overlayShell('标关系', '<div class="rn-panel-empty-inline">先加成员，再标关系。</div>', '');
      }
      const editing = state.overlay === 'edge-edit' && state.draft;
      const selA = editing ? state.draft.a : '';
      const selB = editing ? state.draft.b : '';
      const selLabel = editing ? (state.draft.label || '') : '';
      const opts = (selected) => {
        const userOpt = `<option value="user"${selected === 'user' ? ' selected' : ''}>${esc(userName)}</option>`;
        const rest = members.map((m) =>
          `<option value="${esc(m.id)}"${selected === m.id ? ' selected' : ''}>${esc(m.name)}</option>`,
        ).join('');
        return userOpt + rest;
      };
      return overlayShell(editing ? '编辑关系' : '标关系', `
        <label class="rn-ed-label">谁</label>
        <select class="rn-select" data-edge-a>${opts(selA)}</select>
        <label class="rn-ed-label">和谁</label>
        <select class="rn-select" data-edge-b>${opts(selB)}</select>
        <label class="rn-ed-label">关系</label>
        <input class="rn-input" data-edge-label value="${esc(selLabel)}" placeholder="如 恋人 / 同事 / 邻居" maxlength="20">
      `, editing ? '保存' : '标关系', editing ? '删除' : '');
    }
    if (state.overlay === 'group' || state.overlay === 'group-edit') {
      const g = state.draft || { name: '', memberIds: [], shareMemory: true };
      const memberIds = circle ? circle.memberIds : [];
      const checks = memberIds.map((id) => {
        if (!nodeKind(id) || id === 'user') return '';
        return `
          <label class="rn-check">
            <input type="checkbox" data-member="${esc(id)}" ${g.memberIds.includes(id) ? 'checked' : ''}>
            <span>${esc(nodeName(id))}</span>
          </label>`;
      }).join('') || '<div class="rn-panel-empty-inline">子网里还没成员。</div>';
      const isEdit = state.overlay === 'group-edit';
      return overlayShell(isEdit ? '管理小群' : '建小群', `
        <label class="rn-ed-label">小群名</label>
        <input class="rn-input" data-group-name value="${esc(g.name)}" placeholder="如 默认小群 / 周末饭搭子" maxlength="24">
        <label class="rn-ed-label">成员（至少 2 位角色）</label>
        <div class="rn-checks">${checks}</div>
        <p class="rn-group-note">建群即共享秘密基地后台记忆，关系图只展示这个小群。</p>
      `, isEdit ? '保存' : '建小群', isEdit ? '删除小群' : '');
    }
    return '';
  }

  function overlayShell(title, body, okLabel, dangerLabel) {
    return `
      <div class="rn-overlay" data-overlay>
        <div class="rn-sheet" role="dialog" aria-modal="true">
          <div class="rn-sheet-head"><span>${esc(title)}</span><button type="button" class="rn-sheet-x" data-overlay-close aria-label="关闭">×</button></div>
          <div class="rn-sheet-body">${body}</div>
          <div class="rn-sheet-actions">
            ${dangerLabel ? `<button type="button" class="rn-btn rn-btn-danger" data-overlay-danger>${esc(dangerLabel)}</button>` : '<span></span>'}
            ${okLabel ? `<button type="button" class="rn-btn rn-btn-ok" data-overlay-ok>${esc(okLabel)}</button>` : ''}
          </div>
        </div>
      </div>`;
  }

  function paint() {
    const prevScroll = captureScrollerTop(container, '.rel-net-scroll');
    const onOverview = state.view !== 'circle';
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn rn-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${identityScope ? '身份关系网' : '关系网'}</h1>
        ${onOverview ? `<button type="button" class="navbar-btn rn-nav-add" data-open="circle-new" aria-label="新建子网">${icon('plus')}</button>` : '<span class="navbar-btn" aria-hidden="true"></span>'}
      </header>
      <main class="rel-net-scroll">${onOverview ? renderOverview() : renderSubnetView()}</main>
      ${renderOverlay()}
    `;
    restoreScrollerTop(container, '.rel-net-scroll', prevScroll);
    bind();
  }

  function closeOverlay() {
    state.overlay = null;
    state.draft = null;
    paint();
  }

  async function createObserverChatForGroup(name, memberIds) {
    const requested = [...new Set((memberIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const unresolved = requested.filter((id) => !charById.has(id) && !npcById(id));
    if (unresolved.length) {
      showToast(`有 ${unresolved.length} 位成员身份无法解析，请先重新选择`);
      return '';
    }
    if (requested.length < 2) {
      showToast('小群至少需要 2 位角色');
      return '';
    }
    try {
      const wantKey = participantSetKey(requested);
      const existing = (await listChatsForUser(user.id))
        .filter((chat) => chat?.type === 'group' && !(chat.participants || []).includes('user'))
        .find((chat) => participantSetKey(chat.participants) === wantKey);
      if (existing) return existing.id;
      const chat = await createGroupChat(user.id, requested, name, { includeSelf: false });
      chat.metadata = {
        ...(chat.metadata || {}),
        groupOrigin: 'relationship-network',
      };
      chat.groupSettings = {
        ...(chat.groupSettings || {}),
        isObserverMode: true,
      };
      await saveChat(chat);
      return chat.id;
    } catch (err) {
      showToast(String((err && err.message) || err).slice(0, 120));
      return '';
    }
  }

  function bind() {
    container.querySelector('.rn-back')?.addEventListener('click', () => {
      if (state.view === 'circle') { state.view = 'overview'; state.circleId = null; state.groupId = null; paint(); }
      else back();
    });
    container.querySelector('[data-overview]')?.addEventListener('click', () => {
      state.view = 'overview'; state.circleId = null; state.groupId = null; paint();
    });

    container.querySelectorAll('[data-circle]').forEach((b) => b.addEventListener('click', () => {
      state.view = 'circle';
      state.circleId = b.getAttribute('data-circle');
      const circle = findCircle(net, state.circleId);
      state.groupId = circle?.groups?.[0]?.id || null;
      paint();
    }));

    container.querySelectorAll('[data-ledger-edit]').forEach((button) => {
      button.addEventListener('click', async () => {
        const [a, b] = String(button.getAttribute('data-ledger-edit') || '').split('|');
        if (!a || !b) return;
        const current = (acquaintanceLedger.entries || []).find(
          (entry) => (entry.a === a && entry.b === b) || (entry.a === b && entry.b === a),
        );
        const label = window.prompt('关系描述', current?.label || '认识');
        if (label === null) return;
        await recordAcquaintance(a, b, {
          level: current?.level || 'met',
          label,
          source: 'manual',
          userId: user.id,
        });
        acquaintanceLedger = await loadAcquaintanceLedger(user.id);
        paint();
      });
    });
    container.querySelectorAll('[data-ledger-remove]').forEach((button) => {
      button.addEventListener('click', async () => {
        const [a, b] = String(button.getAttribute('data-ledger-remove') || '').split('|');
        if (!a || !b) return;
        await removeAcquaintance(a, b, user.id);
        acquaintanceLedger = await loadAcquaintanceLedger(user.id);
        paint();
      });
    });

    container.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      const key = b.getAttribute('data-open');
      if (key === 'circle-new' && state.view !== 'circle') {
        state.overlay = key;
        state.draft = null;
        paint();
        return;
      }
      if (state.view !== 'circle' && key !== 'circle-new') return;
      state.overlay = key;
      state.draft = key === 'group' ? { name: '', memberIds: [], shareMemory: true } : null;
      paint();
    }));

    container.querySelector('[data-group-pick]')?.addEventListener('change', (e) => {
      state.groupId = e.target.value;
      paint();
    });

    container.querySelectorAll('[data-select-group]').forEach((b) => b.addEventListener('click', () => {
      state.groupId = b.getAttribute('data-select-group');
      paint();
    }));

    container.querySelector('[data-group-edit]')?.addEventListener('click', () => {
      const circle = findCircle(net, state.circleId);
      const g = activeGroup(circle);
      if (!g) return;
      state.overlay = 'group-edit';
      state.draft = { id: g.id, name: g.name, memberIds: [...g.memberIds], shareMemory: true };
      paint();
    });

    container.querySelectorAll('[data-edge-edit]').forEach((b) => b.addEventListener('click', () => {
      const circle = findCircle(net, state.circleId);
      const edge = circle && (circle.edges || []).find((x) => x.id === b.getAttribute('data-edge-edit'));
      if (!edge) return;
      state.overlay = 'edge-edit';
      state.draft = { id: edge.id, a: edge.a, b: edge.b, label: edge.label || '' };
      paint();
    }));

    container.querySelector('[data-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeOverlay();
    });
    container.querySelector('[data-overlay-close]')?.addEventListener('click', closeOverlay);

    container.querySelectorAll('[data-delete-npc]').forEach((button) => {
      button.addEventListener('click', async () => {
        const npcId = button.getAttribute('data-delete-npc');
        const npc = npcById(npcId);
        if (!npc) return;
        const sameNameRemains = (net.npcs || []).some((row) => (
          row?.id !== npcId
          && phoneSocialActorNameKey(row?.name) === phoneSocialActorNameKey(npc.name)
        ));
        if (!window.confirm(`删除 NPC「${npc.name}」？相关关系、群成员和对话窗口会一起清理。`)) return;
        button.disabled = true;
        const result = await dismissLightweightNpc(npcId, {
          name: npc.name,
          sourceChatIds: npc.sourceChatIds || [],
          purgeChats: true,
          global: true,
          blockName: !sameNameRemains,
          userId: user.id,
        }).catch(() => null);
        if (!result?.ok) {
          button.disabled = false;
          showToast('删除失败，请稍后重试');
          return;
        }
        net = await loadRelationshipNetwork(user.id);
        if (!findCircle(net, state.circleId)) {
          state.view = 'overview';
          state.circleId = null;
          state.groupId = null;
          state.overlay = null;
          state.draft = null;
        }
        showToast(`已删除「${npc.name}」`);
        paint();
      });
    });

    container.querySelector('[data-new-npc-btn]')?.addEventListener('click', async () => {
      const name = container.querySelector('[data-new-npc]')?.value.trim();
      if (!name) { showToast('给 NPC 起个名字'); return; }
      const checked = [...container.querySelectorAll('[data-member]:checked')].map((el) => el.getAttribute('data-member'));
      const directory = createPhoneSocialActorDirectory({
        characters,
        relationshipNetwork: net,
      });
      const existing = directory.resolve('', { name });
      const nameKey = phoneSocialActorNameKey(name);
      if (!existing && directory.ambiguousNameKeys.has(nameKey)) {
        showToast('存在同名角色，请直接勾选对应成员');
        return;
      }
      const previousDismissedCount = (net.dismissedNpcs || []).length;
      net.dismissedNpcs = (net.dismissedNpcs || []).filter((entry) => entry?.nameKey !== nameKey);
      const restored = net.dismissedNpcs.length !== previousDismissedCount;
      let newId = existing?.id || '';
      if (!newId) {
        net.npcs = [...(net.npcs || []), { name }];
      }
      if (!newId || restored) {
        await persist();
      }
      if (!newId) {
        newId = (net.npcs[net.npcs.length - 1] || {}).id;
      }
      state.overlay = 'members';
      paint();
      const set = new Set([...checked, newId]);
      container.querySelectorAll('[data-member]').forEach((el) => { el.checked = set.has(el.getAttribute('data-member')); });
    });

    container.querySelector('[data-overlay-ok]')?.addEventListener('click', async () => {
      const circle = findCircle(net, state.circleId);

      if (state.overlay === 'circle-new') {
        const name = container.querySelector('[data-circle-name]')?.value.trim();
        if (!name) { showToast('给子网起个名字'); return; }
        net.circles = [...(net.circles || []), { name, memberIds: [], edges: [], groups: [] }];
        await persist();
        const created = net.circles[net.circles.length - 1];
        state.overlay = null; state.draft = null;
        state.view = 'circle'; state.circleId = created.id; state.groupId = null;
        paint();
        return;
      }

      if (state.overlay === 'circle-edit' && circle) {
        const name = container.querySelector('[data-circle-name]')?.value.trim();
        if (!name) { showToast('名字不能为空'); return; }
        circle.name = name;
        await persist();
        closeOverlay();
        return;
      }

      if (state.overlay === 'members' && circle) {
        circle.memberIds = [...container.querySelectorAll('[data-member]:checked')].map((el) => el.getAttribute('data-member'));
        await persist();
        closeOverlay();
        return;
      }

      if ((state.overlay === 'edge' || state.overlay === 'edge-edit') && circle) {
        const a = container.querySelector('[data-edge-a]')?.value;
        const b = container.querySelector('[data-edge-b]')?.value;
        const label = container.querySelector('[data-edge-label]')?.value.trim() || '';
        if (!a || !b || a === b) { showToast('选两个不同的人'); return; }
        if (state.overlay === 'edge-edit' && state.draft?.id) {
          const edge = (circle.edges || []).find((x) => x.id === state.draft.id);
          if (edge) { edge.a = a; edge.b = b; edge.label = label; }
        } else {
          circle.edges = [...(circle.edges || []), { id: newEdgeId(), a, b, label }];
        }
        await persist();
        closeOverlay();
        return;
      }

      if ((state.overlay === 'group' || state.overlay === 'group-edit') && circle) {
        const name = container.querySelector('[data-group-name]')?.value.trim();
        if (!name) { showToast('给小群起个名字'); return; }
        const memberIds = [...container.querySelectorAll('[data-member]:checked')].map((el) => el.getAttribute('data-member'));
        const existing = state.overlay === 'group-edit'
          ? (circle.groups || []).find((x) => x.id === state.draft.id)
          : null;
        const unresolved = memberIds.filter((id) => !charById.has(id) && !npcById(id));
        if (unresolved.length) {
          showToast(`有 ${unresolved.length} 位成员身份无法解析，请先重新选择`);
          return;
        }
        if (memberIds.length < 2) {
          showToast('小群至少需要 2 位角色');
          return;
        }
        let shareChatId = existing?.shareChatId || '';
        if (!shareChatId) shareChatId = await createObserverChatForGroup(name, memberIds);
        if (!shareChatId) return;
        if (shareChatId) {
          const sharedChat = await getChat(shareChatId).catch(() => null);
          const realMembers = memberIds.filter((id) => charById.has(id) || npcById(id));
          if (sharedChat) {
            sharedChat.participants = [...new Set(realMembers)];
            sharedChat.groupSettings = {
              ...(sharedChat.groupSettings || {}),
              name,
              owner: realMembers.includes(sharedChat.groupSettings?.owner)
                ? sharedChat.groupSettings.owner
                : realMembers[0],
              isObserverMode: true,
            };
            sharedChat.metadata = {
              ...(sharedChat.metadata || {}),
              relationshipGroupId: existing?.id || state.draft?.id || '',
              groupOrigin: 'relationship-network',
            };
            await saveChat(sharedChat);
          }
        }
        if (existing) {
          existing.name = name;
          existing.memberIds = memberIds;
          existing.shareMemory = true;
          existing.shareChatId = shareChatId;
        } else {
          circle.groups = [...(circle.groups || []), { name, memberIds, shareMemory: true, shareChatId }];
        }
        await persist();
        state.groupId = existing ? existing.id : circle.groups[circle.groups.length - 1]?.id;
        state.overlay = null; state.draft = null;
        paint();
        if (shareChatId) showToast('已建共享后台');
        return;
      }
    });

    container.querySelector('[data-overlay-danger]')?.addEventListener('click', async () => {
      const circle = findCircle(net, state.circleId);
      if (state.overlay === 'circle-edit' && circle) {
        net.circles = (net.circles || []).filter((c) => c.id !== circle.id);
        await persist();
        state.overlay = null; state.view = 'overview'; state.circleId = null; state.groupId = null;
        paint();
        return;
      }
      if (state.overlay === 'edge-edit' && circle && state.draft?.id) {
        circle.edges = (circle.edges || []).filter((x) => x.id !== state.draft.id);
        await persist();
        closeOverlay();
        return;
      }
      if (state.overlay === 'group-edit' && circle && state.draft?.id) {
        circle.groups = (circle.groups || []).filter((x) => x.id !== state.draft.id);
        if (state.groupId === state.draft.id) state.groupId = circle.groups[0]?.id || null;
        await persist();
        closeOverlay();
      }
    });
  }

  paint();
}
