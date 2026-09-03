const TEXT_KEYS = [
  'text', 'voiceText', 'voice', 'speech', 'say', 'content',
  'bubble', 'bubbles', 'voices', 'segments', 'lines',
];

export function extractCompanionText(value, options = {}) {
  const max = Math.max(1, Number(options.max || 2000) || 2000);
  const joiner = options.joiner == null ? '\n' : String(options.joiner);
  const seen = new Set();

  const visit = (input) => {
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (!input || typeof input !== 'object' || seen.has(input)) return '';
    seen.add(input);
    if (Array.isArray(input)) return input.map(visit).filter(Boolean).join(joiner);
    for (const key of TEXT_KEYS) {
      if (input[key] == null) continue;
      const text = visit(input[key]);
      if (text.trim()) return text;
    }
    return '';
  };

  return visit(value).replace(/\[object Object\]/g, '').trim().slice(0, max);
}

const PERFORMANCE_HINT_WORDS = /\b(?:breath|breathe|breathing|inhale|exhale|chuckle|laugh|laughter|giggle|sigh|whisper|whispering|murmur|murmuring|voice|voiced|tone|soft|softly|soothing|gentle|gently|quiet|quietly|low|warm|calm|calmly|tender|tenderly|sleepy|hushed|helpless|pause|smile|smiling|slow|slowly)\b/i;
const MINIMAX_PAUSE_TAG_RE = /<\s*#\s*\d+(?:\.\d+)?\s*#\s*>/gi;
const MINIMAX_SOUND_TAG_RE = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi;

function isPerformanceHint(value = '') {
  const hint = String(value || '').trim();
  return !!hint
    && hint.length <= 96
    && /[A-Za-z]/.test(hint)
    && !/[\u3400-\u9fff]/u.test(hint)
    && PERFORMANCE_HINT_WORDS.test(hint);
}

// 部分模型会把本该写进 emotion / pace 的英文表演提示塞回台词任意位置，
// 例如 [soft chuckle]、[soothing, low voice]、(breath)、<#0.3#>。
// 这些既不应展示，也不应交给 TTS 朗读。
export function sanitizeCompanionSpeechText(value, options = {}) {
  const max = Math.max(1, Number(options.max || 2000) || 2000);
  const text = extractCompanionText(value, { ...options, max: Math.max(max * 2, 400) });
  return text
    .replace(MINIMAX_PAUSE_TAG_RE, '')
    .replace(MINIMAX_SOUND_TAG_RE, '')
    .replace(/\[([^\]\r\n]{1,96})\]|\(([^)\r\n]{1,96})\)/g, (whole, squareHint, roundHint) => (
      isPerformanceHint(squareHint || roundHint) ? '' : whole
    ))
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(0, max);
}

export function normalizeCompanionAvatarUrl(value, options = {}) {
  // 与头像后台压缩阈值保持同一量级；旧 120KB 限制会把大量正常角色头像静默降级成首字。
  const maxDataLength = Math.max(1024, Number(options.maxDataLength || 480000) || 480000);
  const candidate = typeof value === 'string'
    ? value
    : (value?.url || value?.dataUrl || value?.src || value?.avatar || '');
  if (candidate && typeof candidate === 'object') {
    return normalizeCompanionAvatarUrl(candidate, options);
  }
  let url = typeof candidate === 'string' ? candidate.trim() : '';
  if (/^data:image\//i.test(url)) return url.length <= maxDataLength ? url : '';
  if (url.startsWith('//')) url = `https:${url}`;
  else if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  if (/^https:\/\//i.test(url)) return url.slice(0, 4096);
  if (options.allowBlob === true && /^blob:/i.test(url)) return url;
  return '';
}
