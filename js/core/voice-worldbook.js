export const VOICE_WORLD_BOOK_SURFACES = Object.freeze({
  VOICE_BUBBLE: 'voice_bubble',
  VOICE_CALL: 'voice_call',
  VIDEO_CALL: 'video_call',
  COMPANION: 'companion',
  DIALOGUE: 'dialogue',
  STREAMER: 'streamer',
  RADIO: 'radio',
  OFFLINE: 'offline',
  AU: 'au',
});

const BASE_RULES = [
  '语音表演只改变怎么说，不得借隐藏标签增删、改写或翻译可见正文。',
  '先判断人物此刻的情绪强度、身体状态、距离和真实说话气口；平静时保持平静，不为“自然”强行添加喘息、笑声或语气词。',
  'emotion 只是情绪方向，intensity 才是强度。日常亲密、暧昧、吃醋、压低声线或认真起来通常仍是 0.15～0.35 的克制表达；只有明确争吵、喊叫、惊吓或失控才可到 0.75 以上。',
  '声线一致性高于单条情绪冲击：相邻气泡默认承接前一条的音量、速度和情绪力度，普通转折的 intensity 变化尽量不超过 0.2，不要每个气泡重新“开演”。',
  '把角色声线与表演层分开：年龄感、共鸣位置、口音、基础音高和音色始终属于同一个人；只让语速、力度、呼吸、停顿与情绪方向沿场景连续变化，不能靠突然拔高音调或换腔制造情绪。',
  '整轮先形成一条连续呼吸曲线：开头确有需要时入气，中段在长句、犹豫或动作后自然换气，结尾按情绪选择收住、吐气、叹息或轻笑；不要让每个气泡各自重新吸气，也不要把所有位置都退化成同一种 (breath)。',
  '换气、停顿与拟声要有场景依据，但不要因过度保守而全部省略：亲密、犹豫、低声、长句重新开口或明显身体状态适合时，短句可选一个呼吸提示，长段通常可在不同气口选一到两个；连续多句仍不要每句重新吸气。',
  '真实的卡顿、找词或改口可以使用一次 (emm)，它更接近“呃……”而不是应声的“嗯……”；轻声笑气用 (chuckle)，松开一口气用 (exhale) 或 (breath)。不要用 (emm) 替换表示回应、赞同或若有所思的“嗯”。',
  '过渡音要接在真实气口上，不要独立成一段响亮表演，也不要连续堆叠；单句通常至多一个，多句气泡最多保留两个位于不同气口的提示。同一句已有“呃……”或“哈……”时不再重复补同类声音。',
  '可见正文里的连续省略号通常代表犹豫、吞回半句或重新起句：只是停住思考时用 <#0.25#>～<#0.5#>；停顿后像重新换一口气开口时，可积极选择一次 (inhale) 或 (breath)。句首句尾仍不机械补标签。',
  '可用提示限于 (breath) (inhale) (exhale) (gasps) (pant) (sighs) (laughs) (chuckle) (coughs) (clear-throat) (humming) (emm) 与 <#0.1#>～<#0.8#>。',
  '不同声音提示承担不同生理动作：(inhale) 是开口前吸气，(breath) 是自然换气，(exhale) 是松下一口气，(sighs) 是疲惫或无奈，(chuckle) 是压低的笑气，(pant)/(gasps) 只承接真实喘息或骤然受惊；按场景选对类型比增加数量更自然。',
  'pant/gasps 只用于奔跑、哭泣、惊吓、疼痛或明确喘息；轻声、贴近和 ASMR 感优先依靠更慢语速、留白和自然呼吸，不自动色情化。',
  '情绪、语速和音高变化以完整气泡或自然句为单位保持连续；句尾上扬主要交给疑问语义、标点和模型语调，不用夸张的全句升调代替。',
];

const FISH_BASE_RULES = [
  '语音表演只改变怎么说，不得借隐藏指导增删、改写或翻译可见正文。',
  'Fish S2 使用方括号里的英文自然语言提示；一句通常只保留一个主要表演方向，描述要短、明确并紧贴它控制的句子。',
  '优先描述情绪、力度和传递方式，例如 warm、hesitant、restrained、playful、small pauses between phrases；不要把 MiniMax 的精确停顿标签原样交给 Fish，也不要把呼吸质感当成通用的“自然感”。',
  '只有正文或上下文明确出现贴近、压低声音、怕被听见、只说给对方听等依据时，才使用 whispering softly、in a close quiet whisper；普通亲密对话仍保持自然轻声，不默认全程耳语。',
  '声线一致性高于单条刺激：相邻气泡保持同一个人的年龄感、共鸣、口音和基础音高，只让呼吸、语速、力度和情绪沿上下文渐变。',
  '日常亲密、暧昧、吃醋、认真或调情式不满应使用 restrained、slightly tense、quietly pleased 等轻微方向，不直接升级成 angry、shouting 或突然高亢。',
  '禁止用 growling、snarling、roaring、booming、thunderous 等低吼、咆哮或舞台腔方向制造张力；即使人物严肃、占有欲强或生气，也先用 restrained、low and controlled、quietly tense 等克制表达。',
  '自然停连优先交给标点、语速和 small pauses；只有正文或上下文明确写出呼吸变化、奔跑、哭泣、惊吓或疼痛时，才提示一次具体的 inhale、exhale、panting 或 gasping。低声、贴近、亲密和长句本身都不是喘息依据。',
  '明确亲吻动作前后的台词可以继承角色自身的细微反应，但优先使用 slightly trembling、briefly hesitant 或 soft and restrained；不能把亲吻素材、另一人的呼吸或旁白当成角色发声。',
  '亲吻不自动等于夸张喘息：轻吻通常只需细微颤音、短暂屏息或一次自然换气；只有正文与上下文已经明确出现气息失稳、连续喘息或骤然反应时，才使用 panting / gasping 或 (pant) / (gasps)。',
  '气声或耳语类 direction 只控制有明确依据的局部轻声质感，不能把整句辅音、咬字和高频细节一起压糊；即使轻声也保持 clear but soft articulation。除非人物明确体力透支或持续耳语，不要让整句一直漏气。',
  '笑、叹气、抽泣和喘息只在文本与场景确实发生时使用；短句不要堆叠多个效果，也不要混合互相冲突的情绪。',
  '最后一个说出口的字之后禁止再放 direction、呼吸、叹气、笑声或停顿标签；结尾要在最后一个词上干净收住，不留下无台词承接的尾部表演。',
  '省略号与断句主要交给正文标点和短的 delivery direction；Fish 不保证执行精确秒数，气泡之间的停顿由播放器真实留白。',
  '温度与 Top P 只影响变化度，不替代表演设计；同一角色默认维持稳定声线，丰富感来自准确而克制的呼吸和情绪位置。',
];

const SURFACE_RULES = Object.freeze({
  voice_bubble: [
    '当前是手机语音条：像按住录音后一次自然说完，可以短促、改口或连发，但每条都应是完整气口。',
    '麦克风距离按普通手机收音处理；不要默认耳语、贴耳或录音棚播报。',
  ],
  voice_call: [
    '当前是实时语音电话：同一轮的一到三句属于连续口语，呼吸和情绪跨句承接，不要每句重新开场。',
    '少用精确停顿标签，优先让正常标点和口语节奏工作；不要把电话说成一串互不相干的语音条。',
  ],
  video_call: [
    '当前是实时视频电话：口语连续性与语音电话相同，允许因看到对方画面产生即时语气变化。',
    '镜头、表情和身体动作只属于画面，不得读成旁白；只有真正说出口的词句和必要声音提示进入语音。',
  ],
  companion: [
    '当前是持续陪伴语音：整体低打扰、松弛、靠近日常连麦，可以有较轻的音量与较慢的节奏，但不默认全程耳语。',
    '空白期短句要像人在旁边偶尔开口；不要用密集呼吸、哼声或叹息填满安静。',
  ],
  dialogue: [
    '当前是文字气泡的隐藏表演轨：去掉标签后必须与气泡正文逐字一致；没有必要表演时直接使用正文。',
    '相邻气泡是同一段表演的连续气口，情绪和速度可渐变，但不要为了制造变化频繁换挡。',
    '同一轮多个气泡要像一次连续说话：第一条到最后一条共享声线和身体状态，气泡边界可以换一口气，却不能把边界演成每次重新拿起麦克风。',
    '浪漫或亲密互动里的严肃、占有欲、嘴硬和调情式不满不能直接等同于强怒；可以选择 angry 作为细微方向，但 intensity 通常保持 0.2～0.35，让文本和停顿承担情趣，不调用浮夸的整句爆发。',
    '角色明显卡顿、找词或改口时，可以选择一次 (emm)；只是犹豫、吞回半句或隔着省略号重新开口时优先用停顿、(breath) 或 (exhale)。轻声“哈……”应是 (chuckle) 的气声感，不要把“哈”顶成突兀的重音。',
    '正文中间出现“……”或“...”时，speech 通常要把这次停顿明确演出来；停顿后像重新开口时可选择 (inhale) 或 (breath)，只是犹豫时使用精确停顿。不要因为规则强调克制就完全省略合适的自然呼吸，也不要把每个省略号都变成喘息。',
  ],
  streamer: [
    '当前是直播中的主播台词：像面对麦克风和屏幕即时开口，保留直播类型与人物说话习惯，不要演成广告配音或舞台独白。',
    '闲聊保持自然手机/桌面麦克风距离；助眠或 ASMR 场景可以更轻、更慢、更贴近，但只在场景明确时使用耳语和细微呼吸。',
    '括号里的镜头动作不朗读；表演提示只服务真正说出口的 streamerLine，不能把弹幕、画面或动作混进声音。',
  ],
  radio: [
    '当前是角色独自完成的一期长音声电台：不是面对一群观众播报，而是把麦克风当成与熟悉的用户保持连接，像线上语音或线下相处时那样直接对“你”持续讲述。',
    '同一章共享一条连续的呼吸与情绪曲线，但连续不等于从头到尾同一种语气；内容转折时可以自然变快或放慢、笑出来、迟疑、改口、压低或放松声音，并承接角色此刻真实的关系和身体状态。',
    '优先保留角色日常对话中的口吻、脾气和反应方式：会嘴硬的人仍会嘴硬，会活泼吐槽的人可以有明显笑意，会认真或难过的人也允许情绪真正落下来；“不要播音腔”不等于一律平静克制。',
    '段落边界可以换气和短暂停住，却不要每段重新报幕；讲故事、自白或小课堂都应像这个角色正在对用户说话，而不是朗读一篇已经写好的稿件。',
    '正文中的括号动描、翻译和环境说明不进入语音；只为角色真正讲出的正文设计表演。',
  ],
  offline: [
    '当前是线下沉浸叙事中的角色直接对白：只为角色真正说出口的引语设计表演，旁白、动作、心理、用户台词和翻译全部保持静音。',
    '角色身处真实连续场景，呼吸、距离、体力和情绪要承接正文动作；不要像拿起手机录语音条一样每句重新开场。',
    '同一角色连续几句共享一条呼吸和情绪曲线；多人在场时每人的声线与身体状态分别保持连续。',
  ],
  au: [
    '当前是番外/异世界叙事中的角色直接对白：世界身份可以变化，但角色本人的声线、口吻与关系底色保持一致。',
    '只朗读角色真正说出口的引语，旁白、动作、心理、用户台词和翻译保持静音；不要把宏大场景演成夸张舞台腔。',
    '情绪强度服从当前番外情境，但普通紧张、浪漫和严肃仍以克制、连续的气口为主。',
  ],
});

const FISH_SURFACE_RULES = Object.freeze({
  ...SURFACE_RULES,
  dialogue: [
    '当前是文字气泡的 Fish 隐藏表演轨：speech.text 去掉声音提示后必须与气泡正文逐字一致；direction 只写简短英文表演指导。',
    '每个气泡会独立合成以保留短句表现，播放器再按用户设置插入真实间隔；不要在气泡结尾伪造长串省略号来冒充间隔。',
    'direction 优先写情绪、力度和停连，例如 soft and slightly hesitant, with small pauses between phrases, clear articulation。没有明确表演需求时留空，让正文和声线自然工作；不要把气声当成亲密、轻声或自然的同义词。',
    '确有贴近耳语的语义时可写 whispering softly at close distance, restrained and natural；不要只因场景浪漫就自动耳语。',
    '需要局部呼吸、轻笑或叹息时，可以在 speech.text 的真实发生位置使用一次对应声音提示；不要为了“更有感觉”在每条开头都吸气。',
    '明确亲吻旁白紧邻的台词可以轻微发颤、短暂迟疑或放软，但轻吻与亲密场景不自动产生可听见的喘息；只有正文已明确喘息时才用 panting / gasping。',
    '一轮多个气泡的 direction 要承接前文，普通变化保持克制；浪漫场景里的严肃、占有欲与嘴硬不等于强怒，更不写低吼、咆哮或戏剧化舞台腔。',
  ],
  radio: [
    '当前是 Fish 长音声电台：章级 direction 只维持共同声线、麦克风距离和基础气口；真正的调侃、迟疑、认真、放软等变化必须用贴在对应句段前的局部英文 direction 表达，不能只靠一条整章 trajectory。',
    '局部 direction 应控制紧随其后的 1～3 句，并在语气真实变化处更新；像线上语音和线下对白一样服务角色正在对用户说话的感觉，不默认使用朗读腔、纪录片旁白腔或过分平稳的“电台声”。',
    '根据正文与人物关系积极选择 conversational、playful、dryly amused、quietly excited、hesitant、tender、earnest、slightly flustered 等具体对话感；只有角色此刻确实在压住情绪时才使用 restrained。',
    '同一章保持同一个人的声线，但麦克风距离、速度、力度和呼吸可以随内容细微移动；允许自然轻笑、短暂卡顿、改口与重新开口，不要为了稳定性把所有变化磨平。',
    '电台是整章合成，不像线上气泡会由播放器自动留出句间空隙；正文必须用完整标点和真正的段落转折留下停连，direction 使用 clear phrase breaks 与 clean paragraph phrase resets，不能把段落边界写成可听见的吸气。',
    '仍然禁止 dramatic narration、theatrical、announcer voice、booming 或逐句夸张起伏；避免舞台腔不等于避免真实情绪。',
    '长段即使轻声也要保持 clear natural articulation；不要让气声或耳语方向覆盖整章并造成含混。',
  ],
});

function cleanCustomVoiceWorldBookText(value = '') {
  return String(value || '')
    .replace(/<<<\/?(?:THINKING|END_THINKING|MARSHMALLOW_CHAT_V2|END_MARSHMALLOW_CHAT_V2)>>>/gi, '')
    .trim()
    .slice(0, 6000);
}

export function getBuiltInVoiceWorldBookText(surface = VOICE_WORLD_BOOK_SURFACES.VOICE_BUBBLE, {
  includeBase = true,
  provider = 'minimax',
} = {}) {
  const fish = String(provider || '').trim().toLowerCase() === 'fish';
  const providerSurfaceRules = fish ? FISH_SURFACE_RULES : SURFACE_RULES;
  const surfaceRules = providerSurfaceRules[surface] || providerSurfaceRules.voice_bubble;
  return [
    ...(includeBase ? (fish ? FISH_BASE_RULES : BASE_RULES) : []),
    ...surfaceRules,
  ].map((line) => `- ${line}`).join('\n');
}

export function buildVoiceWorldBookPrompt(surface, {
  customText = '',
  includeBase = true,
  includeCustom = true,
  heading = '语音世界书',
  provider = 'minimax',
} = {}) {
  const builtIn = getBuiltInVoiceWorldBookText(surface, { includeBase, provider });
  const custom = includeCustom ? cleanCustomVoiceWorldBookText(customText) : '';
  const providerLabel = String(provider || '').trim().toLowerCase() === 'fish' ? 'Fish' : 'MiniMax';
  return [
    `【${heading}｜${providerLabel} 内置表演指导】`,
    builtIn,
    custom ? '【用户补充规则】' : '',
    custom,
  ].filter(Boolean).join('\n');
}
