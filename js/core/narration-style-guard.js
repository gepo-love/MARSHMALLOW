/**
 * 线上小剧场与线下音声共用的旁白去模板底座。
 * 这里只约束动作选择与句法，不替各自协议决定篇幅、格式或是否朗读。
 */
export const NARRATION_USER_PERSON_DEFAULT = 'second';

const NARRATION_USER_PERSON_RULES = Object.freeze({
  second: { label: '第二人称（你）', pronoun: '你', kind: '第二人称' },
  third_feminine: { label: '第三人称（她）', pronoun: '她', kind: '第三人称' },
  third_masculine: { label: '第三人称（他）', pronoun: '他', kind: '第三人称' },
  third_neutral: { label: '第三人称（TA）', pronoun: 'TA', kind: '第三人称' },
});

export function normalizeNarrationUserPerson(value = '') {
  const key = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(NARRATION_USER_PERSON_RULES, key)
    ? key
    : NARRATION_USER_PERSON_DEFAULT;
}

export function narrationUserPersonOptions() {
  return Object.entries(NARRATION_USER_PERSON_RULES).map(([value, item]) => ({
    value,
    label: item.label,
  }));
}

export function buildNarrationUserPersonRule(value = NARRATION_USER_PERSON_DEFAULT) {
  const normalized = normalizeNarrationUserPerson(value);
  const selected = NARRATION_USER_PERSON_RULES[normalized];
  const forbidden = ['你', '她', '他', 'TA'].filter((item) => item !== selected.pronoun).join('／');
  return [
    `【旁白用户人称锁定】narration.body 中，用户固定使用${selected.kind}“${selected.pronoun}”。禁止把用户改写成${forbidden}，也禁止为了避免重复在这些人称之间轮换。`,
    '角色仍使用姓名或与其资料一致的第三人称；当角色与用户可能同用“他/她/TA”而产生歧义时，重复角色姓名或明确动作主体，不能偷偷切换用户人称。',
    '这项锁定只约束旁白。角色直接对白中的“你”、称呼与自称仍按角色口吻正常书写，不受旁白人称影响。输出前逐条扫描所有 narration.body，发现混用就改回所选人称。',
  ].join('\n');
}

export function buildNarrationStyleGuard({ surface = 'chat' } = {}) {
  const surfaceRule = surface === 'audio'
    ? '- 音声旁白只保留能改变听觉、空间、距离、接触状态或下一句对白意义的拍点。纯粹供凝视的身体特写、与声音和互动无关的摆拍细节，删掉；把主要情绪交给角色真正说出口的话、停顿与气息。'
    : '- 线上旁白是台词之间的一个有效镜头：一次只写一个可观察变化，写完立刻回到角色对白。不要用身体特写填满气泡之间的空隙，也不要把短旁白扩成微型网文段落。';
  return [
    '【旁白动作去模板｜先选有效镜头，再落句】',
    '- 每一笔动作都要回答“这一拍具体改变了什么”：人物的位置、手中物、接触状态、表情、环境反馈或下一句对白的含义。删掉后毫无信息损失的动作不写；不能只为显得细腻而摸、捏、抬眼、停顿。',
    '- 动作写清主体、落点、方向和可观察结果。力度确实影响结果时，用物体位移、布料变化、声音、对方已明确的反应来呈现；不要用“不轻不重地、不疾不徐地、若有似无地、极轻地、微不可察地”替代结果。',
    '- 禁止自动情色化身体：不用“那一小块软肉、柔软的唇瓣、修长的指节、骨节分明的手、脆弱的后颈、喉结利落地滚动”等公共素材给普通接触加滤镜。亲密场景可以直接写真实接触，但接触位置、动作变化与人物意图必须来自当前关系和现场，不靠“软肉/指腹/占有意味”制造浓度。',
    '- 不给动作配旁白译文：删去“像在宣示主权、透着不容拒绝、显然是在试探、仿佛只是随手、带着某种意味”。让动作、台词与紧随其后的实际反应自行成立。',
    '- 避免悬空身体部位开句和定语套娃。差：“后颈，不轻不重地捏住那一小块软肉。”好：“他按住被风掀起的菜单，杯底在纸页上留下一圈水痕。”好例只说明信息密度与因果，不得照搬情节。',
    '- 写完做一次惯性检查：若这一动作可以无差别套给霸总、年上、恋人或任何角色，换成由本人的习惯、关系、当下目的和现场物件共同决定的动作；没有更具体的选择就删掉。',
    surfaceRule,
  ].join('\n');
}
