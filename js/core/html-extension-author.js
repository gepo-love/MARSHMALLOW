export const HTML_EXTENSION_STARTERS = Object.freeze([
  {
    id: 'interview',
    label: '访谈问卷',
    prompt: '做一张访谈或问卷记录卡：标题清楚，正文适合呈现多组问答；在窄屏聊天气泡中也要易读，不使用 table 标签。',
  },
]);

export function extractHtmlExtensionBlocks(text = '') {
  const blocks = [];
  const pattern = /```html\s*([\s\S]*?)```/gi;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const html = match[1].trim();
    if (html) blocks.push(html);
  }
  return blocks;
}

export function buildHtmlExtensionAuthorPrompt(options = {}) {
  const request = String(options.request || '').trim();
  const currentTemplate = String(options.currentTemplate || '').trim();
  const characterContext = String(options.characterContext || '').trim();
  return [
    characterContext || '你是有主见的聊天扩展组件设计师，负责设计能嵌入对话与线下叙事的轻量 HTML 卡片。',
    '只输出必要说明和一个 ```html 代码块。代码块必须是单个自包含 HTML 片段，可以含自己的 <style>，不要写 <html>、<head> 或 <body>。',
    '数据契约：可以使用任意语义清楚的 {{字段名}} 占位符，例如 {{时间}}、{{地点}}、{{天气}}、{{衣着}}；需要标题、长正文或角色名时可使用 {{title}}、{{content}}、{{name}}。除 {{name}} 由客户端提供外，其余字段会让 AI 按模板逐项生成，并作为安全纯文本填入。',
    '安全边界：禁止 script、iframe、form、svg、canvas、视频、音频、on* 事件、@import、外链字体、CSS url()、position:fixed、100vw 和 100vh。',
    '允许的结构以 div、span、p、small、strong、section、article、header、footer、标题、列表、details、summary、button、a、img 为主。不要使用 table；表格式内容用 grid 或 flex。',
    '组件运行在独立 Shadow DOM 中。根元素宽度必须为 100%，box-sizing:border-box；按 280–390px 的手机聊天内容宽度响应，不写会横向溢出的固定宽度。',
    '有限交互：展开收起可用 details/summary，或 button data-action="toggle" data-target=".目标"；弹窗可用 data-action="dialog" data-title="标题" data-content="正文"；链接只允许 https、mailto、tel。',
    'CSS 只使用常规颜色、背景、边框、圆角、阴影、盒模型、grid/flex、字体、文字、overflow、opacity、transform 与 transition 属性。不要依赖页面外部 class、变量、脚本或资源。',
    currentTemplate
      ? `这是当前模板，请按用户要求输出完整替换版本：\n${currentTemplate}`
      : '当前模板为空，请从零创作；视觉应服务具体卡片语义，不要套通用设置页或同质化玻璃卡。',
    `用户要求：${request}`,
  ].filter(Boolean).join('\n\n');
}
