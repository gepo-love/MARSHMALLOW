function clean(value = '') {
  return String(value ?? '').trim();
}

export function formatNudgeSystemText(event = {}, nameCtx = {}) {
  const fromName = clean(nameCtx.fromName) || '有人';
  const targetName = clean(nameCtx.targetName || nameCtx.userName) || '用户';
  const customText = clean(event.text || event.body);

  if (customText) {
    // 「拍了拍你…」把「你」换成对方名字但保留后缀变体（拍了拍你的脑袋 → A拍了拍B的脑袋）。
    if (/拍了拍你/.test(customText)) {
      const replaced = customText.replace('拍了拍你', `拍了拍${targetName}`);
      return replaced.startsWith(fromName) ? replaced : `${fromName}${replaced}`;
    }
    if (/拍了拍/.test(customText)) {
      if (customText.startsWith(fromName)) return customText;
      return `${fromName}${customText}`;
    }
    if (customText.includes(fromName)) return customText;
    if (/nudged/i.test(customText)) return `${fromName}拍了拍${targetName}`;
    // 其它变体（晃了晃你、戳了戳你的腰…）统一成微信式第三人称：把「你」换成对方名字。
    const normalized = customText.includes('你') ? customText.replace('你', targetName) : customText;
    return `${fromName}${normalized}`;
  }

  return `${fromName}拍了拍${targetName}`;
}
