// 内置装饰组件模板：一键添加到主屏，再在主屏编辑模式里删除/换页。
// 组件 HTML 走 Shadow DOM 渲染，<style> 只作用于组件内部；
// data-widget-image-slot 点按上传图片，data-widget-clock(-date) 实时时间。

export const BEAUTIFY_WIDGET_TEMPLATES = [
  {
    id: 'clock-card',
    name: '时钟卡',
    desc: '毛玻璃时间卡，实时走字',
    size: { cols: 2, rows: 1 },
    html: `<style>
.mm-clock{height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;padding:14px 18px;border-radius:22px;background:rgba(255,255,255,.68);border:1px solid rgba(255,255,255,.65);box-shadow:0 10px 24px rgba(31,41,51,.10);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);}
.mm-clock .t{font-size:34px;font-weight:700;letter-spacing:.05em;color:#2b3540;font-variant-numeric:tabular-nums;}
.mm-clock .d{margin-top:2px;font-size:11px;letter-spacing:.12em;color:#8a97a3;}
</style>
<div class="mm-clock"><span class="t" data-widget-clock>--:--</span><span class="d" data-widget-clock-date></span></div>`,
  },
  {
    id: 'polaroid-frame',
    name: '拍立得相框',
    desc: '点按上传照片，白边相纸',
    size: { cols: 2, rows: 2 },
    html: `<style>
.mm-pol{height:100%;box-sizing:border-box;display:flex;flex-direction:column;padding:10px 10px 12px;border-radius:6px;background:#fffdf8;box-shadow:0 8px 20px rgba(90,80,70,.16);transform:rotate(-1.6deg);}
.mm-pol .ph{flex:1;min-height:0;display:grid;place-items:center;border-radius:3px;background:#eceae4 center/cover no-repeat;color:#a39c92;font-size:12px;}
.mm-pol .ph.has-image{color:transparent;}
.mm-pol .cap{margin-top:8px;text-align:center;font-size:12px;color:#7d746a;}
</style>
<div class="mm-pol"><span class="ph" data-widget-image-slot="photo">点按上传照片</span><span class="cap">今天也很好</span></div>`,
  },
  {
    id: 'sticker-slot',
    name: '透明贴纸位',
    desc: '放透明底 PNG 贴纸，无边框',
    size: { cols: 1, rows: 1 },
    html: `<style>
.mm-stk{height:100%;box-sizing:border-box;display:grid;place-items:center;}
.mm-stk .s{width:100%;height:100%;display:grid;place-items:center;border-radius:14px;background:center/contain no-repeat;color:#9aa5ae;font-size:11px;border:1px dashed rgba(150,160,170,.5);}
.mm-stk .s.has-image{border-color:transparent;}
</style>
<div class="mm-stk"><span class="s" data-widget-image-slot="sticker">放贴纸</span></div>`,
  },
  {
    id: 'glass-note',
    name: '玻璃便签',
    desc: '一句话轻卡片，改字在组件代码里',
    size: { cols: 2, rows: 1 },
    html: `<style>
.mm-note{height:100%;box-sizing:border-box;display:flex;align-items:center;padding:12px 16px;border-radius:18px;background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.6);box-shadow:0 8px 18px rgba(31,41,51,.08);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}
.mm-note .x{font-size:13px;line-height:1.6;color:#4a5560;letter-spacing:.02em;}
</style>
<div class="mm-note"><span class="x">在这里写一句想常看到的话 ✦</span></div>`,
  },
  {
    id: 'photo-strip',
    name: '双联相框',
    desc: '两格照片条，各自点按上传',
    size: { cols: 2, rows: 1 },
    html: `<style>
.mm-strip{height:100%;box-sizing:border-box;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px;border-radius:16px;background:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.6);box-shadow:0 8px 18px rgba(31,41,51,.08);}
.mm-strip .ph{display:grid;place-items:center;border-radius:10px;background:#eceae4 center/cover no-repeat;color:#a39c92;font-size:11px;min-height:64px;}
.mm-strip .ph.has-image{color:transparent;}
</style>
<div class="mm-strip"><span class="ph" data-widget-image-slot="left">照片 1</span><span class="ph" data-widget-image-slot="right">照片 2</span></div>`,
  },
  {
    id: 'decor-music-player',
    name: '装饰音乐播放器',
    desc: '可换封面的静态播放器卡片',
    size: { cols: 2, rows: 1 },
    html: `<style>
.mm-player{height:100%;box-sizing:border-box;display:grid;grid-template-columns:58px 1fr;gap:11px;align-items:center;padding:10px 12px;border-radius:18px;background:rgba(255,255,255,.64);border:1px solid rgba(255,255,255,.7);box-shadow:0 8px 20px rgba(45,55,65,.1);color:#43505a;}
.mm-player .cover{width:58px;height:58px;display:grid;place-items:center;border-radius:13px;background:#e7ebed center/cover no-repeat;color:#89949b;font-size:10px;overflow:hidden;}
.mm-player .cover.has-image{color:transparent;}
.mm-player .meta{min-width:0;}.mm-player b,.mm-player small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.mm-player b{font-size:12px;}.mm-player small{margin-top:3px;font-size:9px;color:#89949b;}
.mm-player .line{height:2px;margin:8px 0 7px;border-radius:2px;background:rgba(67,80,90,.14);}.mm-player .line i{display:block;width:38%;height:100%;border-radius:inherit;background:#788b96;}
.mm-player .keys{display:flex;align-items:center;justify-content:space-between;font-size:10px;letter-spacing:.12em;}.mm-player .play{width:22px;height:22px;display:grid;place-items:center;border-radius:50%;background:#788b96;color:white;font-size:8px;}
</style>
<div class="mm-player"><span class="cover" data-widget-image-slot="cover">点按换封面</span><span class="meta"><b>Soft Hours</b><small>decorative player</small><span class="line"><i></i></span><span class="keys"><i>Ⅱ</i><i class="play">▶</i><i>Ⅰ</i></span></span></div>`,
  },
];

export function getBeautifyWidgetTemplate(id) {
  return BEAUTIFY_WIDGET_TEMPLATES.find((item) => item.id === id) || null;
}

/** 交给 AI 或组件作者的独立装饰组件契约，不与整页 CSS 文档混用。 */
export function buildBeautifyWidgetReferenceMarkdown() {
  const polaroid = BEAUTIFY_WIDGET_TEMPLATES.find((item) => item.id === 'polaroid-frame');
  const player = BEAUTIFY_WIDGET_TEMPLATES.find((item) => item.id === 'decor-music-player');
  return `# 棉花糖机 · 主屏装饰组件契约

> 本文用于新建可拖动的主屏装饰组件，不是整页主题 CSS 文档。

## 交付格式

- 只输出一段可直接粘贴到「组件工作台」的 HTML；样式写在同一段的 \`<style>\` 中。
- 不输出 JavaScript、\`<script>\`、\`<iframe>\`、表单或教程文字。
- 组件运行在独立 Shadow DOM；内部 CSS 不会泄漏到主屏，主屏 CSS 也不会改到组件内部。
- 根元素必须使用 \`width:100%\`、\`height:100%\`、\`box-sizing:border-box\`，不写固定像素总宽高。

## 占格与拖动

- 宽、高各可选 1–4 格；占格由工作台字段决定，不写进 HTML。
- 自定义组件在手账、海、窗、相册四套主屏中都按同一图标网格拖动，可与 App 图标换位或跨页移动。
- 小尺寸优先减少文字，不用横向滚动或溢出宿主的绝对定位。

## 可用的原生钩子

- \`data-widget-image-slot="photo"\`：该元素可点按上传图片，图片会持久化并作为它的 \`background-image\`；上传后自动获得 \`.has-image\`。
- 一个组件可使用多个不同 key 的图片槽，如 \`left\`、\`right\`、\`cover\`，最多 12 个。
- \`data-widget-clock\`：显示当前档位世界时间 \`HH:MM\`。
- \`data-widget-clock-date\`：显示当前档位世界日期和星期。
- 装饰播放器不写假的播放逻辑；若只要视觉组件，按静态按键和进度条设计。

## 可选快捷色

海 / 窗主题工作台可开启快捷改色，并选择纯色、透明、轻玻璃或毛玻璃底面及透明度。需要响应时，使用 \`var(--mm-widget-shell-bg)\`、\`var(--mm-widget-text)\`、\`var(--mm-widget-accent)\`；关闭快捷改色时，组件自己的背景、文字和滤镜保持不变。

## 参考一：可上传图片的拍立得（2×2）

\`\`\`html
${polaroid.html}
\`\`\`

## 参考二：可换封面的装饰播放器（2×1）

\`\`\`html
${player.html}
\`\`\`

## 交付前检查

- 上传图片的区域有明确的 \`data-widget-image-slot\` key，并为 \`.has-image\` 处理占位文字。
- 1×1、2×1 和 2×2 下均不溢出，触控区不遮挡主屏长按拖动。
- 已处理 \`prefers-reduced-motion\`；纯装饰不做持续高频动画。
- 不依赖主屏某一套主题的内部类名。`;
}
