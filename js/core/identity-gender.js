function cleanIdentityField(value = '', limit = 24) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizedGenderKind(value = '') {
  const text = cleanIdentityField(value).toLowerCase().replace(/[\s_-]+/g, '');
  if (!text) return '';
  if (/^(?:女|女性|女人|女孩|女生|female|woman|girl|she\/her|she|她|f)(?:$|[（(\/])/.test(text)) return 'female';
  if (/^(?:男|男性|男人|男孩|男生|male|man|boy|he\/him|he|他|m)(?:$|[（(\/])/.test(text)) return 'male';
  if (/^(?:非二元|无性别|中性|性别流动|nonbinary|agender|genderfluid|they\/them|ta)(?:$|[（(\/])/.test(text)) return 'neutral';
  return 'custom';
}

export function resolveStructuredGenderPronouns(profile = {}) {
  const gender = cleanIdentityField(profile?.gender);
  const pronouns = cleanIdentityField(profile?.pronouns);
  return {
    gender,
    pronouns,
    kind: normalizedGenderKind(pronouns) || normalizedGenderKind(gender),
  };
}

/** 普通聊天、心声与记忆共用的身份硬约束；只认用户明确填写的结构化字段。 */
export function buildGenderPronounRuleLine(profile = {}, subject = '此人') {
  const label = cleanIdentityField(subject, 80) || '此人';
  const identity = resolveStructuredGenderPronouns(profile);
  if (!identity.gender && !identity.pronouns) {
    return `${label}未明确填写性别与代词；只能用名字、“TA”或自然省略主语，禁止根据姓名、头像、关系、题材、职业、外观或语气猜成“他/她”。`;
  }
  const facts = [
    identity.gender ? `性别=${identity.gender}` : '',
    identity.pronouns ? `第三人称代词=${identity.pronouns}` : '',
  ].filter(Boolean).join('；');
  if (identity.kind === 'male') {
    return `${label}的明确身份字段：${facts}。提到${label}时使用“${identity.pronouns || '他'}”或名字，禁止写成“她”。`;
  }
  if (identity.kind === 'female') {
    return `${label}的明确身份字段：${facts}。提到${label}时使用“${identity.pronouns || '她'}”或名字，禁止写成“他”。`;
  }
  return `${label}的明确身份字段：${facts}。严格沿用所填代词；没有可用代词时只用名字、“TA”或自然省略主语，不得强行二元化。`;
}
