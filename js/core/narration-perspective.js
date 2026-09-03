/**
 * 叙事视角 / 人称 · 线下沉浸与番外剧场共用的选项与提示文案。
 */

export const NARRATION_PERSPECTIVES = ['user', 'character', 'omniscient'];
export const NARRATION_PERSONS = ['second', 'first', 'third'];

export const PERSPECTIVE_LABELS = [
  ['user', '用户视角'],
  ['character', '角色第一视角'],
  ['omniscient', '全知旁观'],
];

export const PERSON_LABELS = [
  ['second', '称用户为「你」'],
  ['first', '称用户为「我」'],
  ['third', '称用户为名字 / TA'],
];

export const PERSPECTIVE_TEXT = {
  user: '视角：用户视角——镜头跟随「你」，主要写你的所见、所闻与处境，对方的反应通过你的观察呈现。',
  character: '视角：角色第一视角——叙述者是对方角色本人，角色用「我」叙述自己能感知、想到和做出的事，把「你」当作正在与自己互动的人。',
  omniscient: '视角：全知旁观——以客观第三方镜头描写在场所有人，不偏向任何一方。',
};

export const PERSON_TEXT = {
  second: '用户称呼：正文用「你」指代用户。此项只决定用户一方怎么被称呼；角色第一视角中的角色仍可用「我」自称。',
  first: '用户称呼：正文用「我」指代用户，此时叙述者是用户本人。',
  third: '用户称呼：正文用用户名字或 TA 指代用户；用户资料未明确给出性别或代词时，禁止自行改用“他/她”。',
};

export function normalizePerspective(value, fallback = 'user') {
  return NARRATION_PERSPECTIVES.includes(value) ? value : fallback;
}

export function normalizePerson(value, fallback = 'second') {
  return NARRATION_PERSONS.includes(value) ? value : fallback;
}

/**
 * 「人称」只表示用户在正文里怎样被称呼。
 * 旧版允许 character + first，但两边都会争用「我」；这类旧数据按用户真实意图迁移为
 * character + second，即角色说「我」、用户是「你」。
 */
export function normalizePersonForPerspective(perspective, person, fallback = 'second') {
  const normalizedPerspective = normalizePerspective(perspective);
  const normalizedPerson = normalizePerson(person, fallback);
  return normalizedPerspective === 'character' && normalizedPerson === 'first'
    ? 'second'
    : normalizedPerson;
}

export function perspectiveText(value, person = 'second') {
  const perspective = normalizePerspective(value);
  const normalizedPerson = normalizePersonForPerspective(perspective, person);
  if (perspective === 'character') {
    if (normalizedPerson === 'third') {
      return '视角：角色第一视角——叙述者是对方角色本人，角色用「我」叙述自己能感知、想到和做出的事；用户用名字或 TA 指代，资料未明确时禁止猜测性别。';
    }
    return PERSPECTIVE_TEXT.character;
  }
  if (perspective === 'omniscient') {
    if (normalizedPerson === 'first') {
      return '视角：全知旁观——镜头客观看到在场所有人，但正文仍以第一人称「我」承接用户这一侧正在经历的处境。';
    }
    if (normalizedPerson === 'third') {
      return '视角：全知旁观——以客观第三方镜头描写在场所有人；用户与角色均使用名字或第三人称。';
    }
    return PERSPECTIVE_TEXT.omniscient;
  }
  if (normalizedPerson === 'first') {
    return '视角：用户视角——叙述者是用户本人，主要写「我」的所见、所闻与处境，对方的反应通过「我」的观察呈现。';
  }
  if (normalizedPerson === 'third') {
    return '视角：用户视角——镜头贴近用户这一侧，主要写用户的所见、所闻与处境；用户仍用名字或 TA 指代，资料未明确时禁止猜测性别。';
  }
  return PERSPECTIVE_TEXT.user;
}

export function personText(value, perspective = 'user') {
  const person = normalizePersonForPerspective(perspective, value);
  return PERSON_TEXT[person] || PERSON_TEXT.second;
}

export function personContinuityText(perspective, person) {
  const normalizedPerspective = normalizePerspective(perspective);
  const normalizedPerson = normalizePersonForPerspective(normalizedPerspective, person);
  if (normalizedPerspective === 'character') {
    if (normalizedPerson === 'third') {
      return '人称稳定：叙述者是角色本人，角色自称「我」；用户只用名字或 TA 指代，资料未明确时禁止猜测性别。两者不得互换身份。';
    }
    return '人称稳定：叙述者是角色本人，角色自称「我」，用户称为「你」。这里的第二人称只约束用户称呼，禁止把角色的「我」误判成人称跳转，也不得让「我」与「你」互换身份。';
  }
  if (normalizedPerson === 'first') {
    return '人称稳定：叙述者是用户本人，全文用第一人称「我」指代用户；除角色对白里的自称外，不要新增另一个第一人称叙述者。';
  }
  if (normalizedPerson === 'third') {
    return '人称稳定：用户与在场角色都用名字或 TA 等中性第三人称指代；资料未明确时禁止猜测性别，不要把用户突然叫成「你」，叙述正文也不要突然出现第一人称「我」。';
  }
  return '人称稳定：全文用第二人称「你」指代用户，不要突然改成用户第一人称「我」或用户名字 / 第三人称。角色对白中的自称「我」不受此限制。';
}

/** 给「我」口吻的简短提示，供推进选项生成用。 */
export function perspectiveHintForOptions(perspective, person) {
  const p = normalizePerson(person);
  if (p === 'first') return '以「我」的第一人称口吻写下一步。';
  if (p === 'third') return '用名字 / 第三人称描述我接下来的动作。';
  return '以「我」要做的事来写（第二人称叙事里的用户一方）。';
}
