/**
 * 相遇模块过场动画小窗。
 * - candy：慢慢拆开一颗小糖果的透明玻璃纸（时光机·展开过往）。
 * - connect：两点之间连线 + 流动光点（线下 / 约会·推进交互）。
 *
 * 用法：const cut = showCutscene('candy', '正在拆开这段过往…');
 *       try { await 生成(); await cut.close(); } catch { await cut.close(0); }
 * close(minMs) 会保证小窗至少停留 minMs 毫秒，避免一闪而过。
 */

const CANDY_ART = `
<svg class="cutscene-art" viewBox="0 0 160 120" aria-hidden="true">
  <g class="cs-candy">
    <!-- 垫在下方的糖纸底座 -->
    <polygon class="cs-wrapper-base" points="45,38 115,38 115,82 45,82" fill="#e8f4f8" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>

    <!-- 宝石糖果核心 -->
    <g class="cs-candy-gem">
      <polygon points="66,42 94,42 88,50 72,50" fill="#ffffff" opacity="0.9" />
      <polygon points="94,42 110,60 96,60 88,50" fill="#fde2e4" />
      <polygon points="110,60 94,78 88,70 96,60" fill="#fbe2cd" />
      <polygon points="94,78 66,78 72,70 88,70" fill="#f1b98f" />
      <polygon points="66,78 50,60 64,60 72,70" fill="#dcedf6" />
      <polygon points="50,60 66,42 72,50 64,60" fill="#b6cde0" />
      <polygon class="cs-gem-center" points="72,50 88,50 96,60 88,70 72,70 64,60" fill="#fdf8f4" />
      <!-- 高光 -->
      <polygon class="cs-gem-shine" points="72,50 82,50 76,56 68,56" fill="#ffffff" />
    </g>

    <!-- 向外翻折的四片糖纸 -->
    <polygon class="cs-flap-t" points="45,38 115,38 80,60" fill="#e2f0f7" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>
    <polygon class="cs-flap-b" points="45,82 115,82 80,60" fill="#dcedf6" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>
    <polygon class="cs-flap-l" points="45,38 80,60 45,82" fill="#d5e8f2" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>
    <polygon class="cs-flap-r" points="115,38 80,60 115,82" fill="#e8f4f8" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>

    <!-- 闪烁星芒 -->
    <g class="cs-sparkle">
      <path d="M80 22 L82 28 L88 30 L82 32 L80 38 L78 32 L72 30 L78 28 Z" fill="#f1b98f"/>
      <path d="M52 32 L53.5 36 L58 37.5 L53.5 39 L52 43 L50.5 39 L46 37.5 L50.5 36 Z" fill="#b6cde0"/>
      <path d="M108 80 L109.5 84 L114 85.5 L109.5 87 L108 91 L106.5 87 L102 85.5 L106.5 84 Z" fill="#fde2e4"/>
    </g>
  </g>
</svg>`;

const CONNECT_ART = `
<svg class="cutscene-art" viewBox="0 0 160 120" aria-hidden="true">
  <line class="cs-line" x1="42" y1="60" x2="118" y2="60"/>
  <circle class="cs-node cs-node-a" cx="42" cy="60" r="9"/>
  <circle class="cs-node cs-node-b" cx="118" cy="60" r="9"/>
  <circle class="cs-pulse" cx="42" cy="60" r="4.5"/>
</svg>`;

export function showCutscene(kind = 'candy', label = '') {
  const type = kind === 'connect' ? 'connect' : 'candy';
  const overlay = document.createElement('div');
  overlay.className = 'cutscene-overlay';
  overlay.setAttribute('role', 'status');
  overlay.innerHTML = `
    <div class="cutscene-window cutscene-${type}">
      ${type === 'connect' ? CONNECT_ART : CANDY_ART}
      ${label ? `<p class="cutscene-label">${String(label)}</p>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-in'));

  const startedAt = Date.now();
  let closed = false;
  return {
    async close(minMs = 1000) {
      if (closed) return;
      closed = true;
      const elapsed = Date.now() - startedAt;
      if (elapsed < minMs) await new Promise((r) => setTimeout(r, minMs - elapsed));
      overlay.classList.add('is-out');
      await new Promise((r) => setTimeout(r, 300));
      overlay.remove();
    },
  };
}
