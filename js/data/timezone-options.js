/** 常用 IANA 时区选项（聊天设定下拉用） */
export const TIMEZONE_OPTION_GROUPS = [
  {
    label: '中国及周边',
    options: [
      { id: 'Asia/Shanghai', label: '中国（北京/上海）' },
      { id: 'Asia/Hong_Kong', label: '香港' },
      { id: 'Asia/Taipei', label: '台北' },
      { id: 'Asia/Urumqi', label: '乌鲁木齐' },
      { id: 'Asia/Tokyo', label: '东京' },
      { id: 'Asia/Seoul', label: '首尔' },
    ],
  },
  {
    label: '东南亚 / 南亚',
    options: [
      { id: 'Asia/Singapore', label: '新加坡' },
      { id: 'Asia/Bangkok', label: '曼谷' },
      { id: 'Asia/Jakarta', label: '雅加达' },
      { id: 'Asia/Kuala_Lumpur', label: '吉隆坡' },
      { id: 'Asia/Manila', label: '马尼拉' },
      { id: 'Asia/Kolkata', label: '新德里 / 孟买' },
      { id: 'Asia/Dubai', label: '迪拜' },
    ],
  },
  {
    label: '欧洲',
    options: [
      { id: 'Europe/London', label: '伦敦' },
      { id: 'Europe/Paris', label: '巴黎 / 柏林' },
      { id: 'Europe/Moscow', label: '莫斯科' },
      { id: 'Europe/Istanbul', label: '伊斯坦布尔' },
      { id: 'Europe/Rome', label: '罗马' },
      { id: 'Europe/Madrid', label: '马德里' },
    ],
  },
  {
    label: '美洲',
    options: [
      { id: 'America/New_York', label: '纽约（美东）' },
      { id: 'America/Chicago', label: '芝加哥（美中）' },
      { id: 'America/Denver', label: '丹佛（美山）' },
      { id: 'America/Los_Angeles', label: '洛杉矶（美西）' },
      { id: 'America/Toronto', label: '多伦多' },
      { id: 'America/Vancouver', label: '温哥华' },
      { id: 'America/Sao_Paulo', label: '圣保罗' },
      { id: 'America/Mexico_City', label: '墨西哥城' },
    ],
  },
  {
    label: '大洋洲 / 其他',
    options: [
      { id: 'Australia/Sydney', label: '悉尼' },
      { id: 'Australia/Melbourne', label: '墨尔本' },
      { id: 'Pacific/Auckland', label: '奥克兰' },
      { id: 'Pacific/Honolulu', label: '檀香山' },
    ],
  },
];

export function listAllTimezoneOptions() {
  return TIMEZONE_OPTION_GROUPS.flatMap((group) => group.options.map((opt) => ({ ...opt, group: group.label })));
}

export function findTimezoneOptionLabel(timezoneId = '') {
  const id = String(timezoneId || '').trim();
  if (!id) return '';
  const hit = listAllTimezoneOptions().find((opt) => opt.id === id);
  return hit?.label || id;
}
