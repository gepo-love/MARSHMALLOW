function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function identityText(character = {}) {
  const lifeProfile = character?.lifeProfile || {};
  return [
    character?.currentRole,
    character?.currentStatus,
    lifeProfile?.habits,
    lifeProfile?.activitySeeds,
  ].map(compact).filter(Boolean).join('；');
}

export function resolveCharacterSocialStage(character = {}) {
  const text = identityText(character);
  const isEducationWorker = /教师|老师|教授|讲师|辅导员|校长|教职|导师/.test(text);
  if (!isEducationWorker && /学生|大学生|中学生|高中生|初中生|小学生|研究生|博士生|在校|校园生活|留学生/.test(text)) {
    return 'student';
  }
  if (/退休|离休|养老/.test(text)) return 'retired';
  if (/待业|失业|无业|全职主妇|全职主夫|家庭主妇|家庭主夫|暂未工作/.test(text)) {
    return 'non-working';
  }
  if (/公司|经理|总监|工程师|医生|护士|律师|警察|教师|老师|教授|讲师|辅导员|店员|职员|上班|工作|老板|总裁|助理|秘书|艺人|演员|歌手|设计师|程序员|公务员|军人|教练|记者|编辑|厨师|服务员|主播|员工|同事/.test(text)) {
    return 'working';
  }
  return 'unknown';
}

export function buildIdentitySocialDirective(character = {}, subject = 'TA') {
  const stage = resolveCharacterSocialStage(character);
  if (stage === 'student') {
    return `【身份对应生活圈】${subject} 当前是在校学生。联系人、群聊和话题优先来自同学、室友、社团、课程、导师/辅导员、家人、邻居与校园周边；不要默认生成公司、上司、客户、行政或上班催办。只有资料明确写有实习/兼职时，才可少量出现对应工作关系，并保持“实习/兼职”语境。`;
  }
  if (stage === 'retired') {
    return `【身份对应生活圈】${subject} 当前处于退休生活。联系人、群聊和话题优先来自家人、老友、邻里、兴趣活动、社区与生活服务；不要默认生成现职上司、客户、同事或上班任务，除非资料明确写有返聘/经营等经历。`;
  }
  if (stage === 'non-working') {
    return `【身份对应生活圈】${subject} 当前资料明确不是在职状态。联系人、群聊和话题应围绕家人、朋友、邻里、兴趣、学习与生活事务；不要生成公司、上司、客户或日常上班内容，除非资料明确写有兼职、求职或临时合作。`;
  }
  if (stage === 'working') {
    return `【身份对应生活圈】${subject} 的资料有明确职业线索，可以生成与该职业匹配的同事、合作方或工作群；同时保留家人、朋友、邻里和生活服务等非工作关系，不要让所有聊天都围绕工作。`;
  }
  return `【身份对应生活圈】先根据 ${subject} 的 currentRole、currentStatus、生活习惯与世界设定判断其当前身份和生活阶段，再选择匹配的联系人、群聊与话题；不要把“成年人”自动等同于“在公司上班”。资料没有明确职业线索时，不要擅自生成上司、客户、同事或工作群。`;
}

export function preferredPhoneContactCategories(character = {}) {
  const stage = resolveCharacterSocialStage(character);
  if (stage === 'working') return ['work', 'friend', 'family', 'other', 'rival'];
  if (stage === 'student') {
    return /实习|兼职/.test(identityText(character))
      ? ['friend', 'work', 'family', 'other', 'rival']
      : ['friend', 'family', 'other', 'rival'];
  }
  if (stage === 'retired' || stage === 'non-working') {
    return ['friend', 'family', 'other', 'rival'];
  }
  return ['friend', 'family', 'other', 'rival', 'work'];
}
