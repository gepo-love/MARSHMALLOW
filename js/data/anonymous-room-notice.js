/** 匿名聊天室使用须知（教程、入口问号弹卡、首次强制弹窗共用） */
export const ANON_ROOM_CAUTION_TITLE = '匿名聊天室使用须知';

/** 首次强制须知确认标记；文案大改时递增后缀，让老用户再看一次。 */
export const ANON_ROOM_NOTICE_ACK_KEY = '__mm_anon_room_notice_ack_v2__';

export const ANON_ROOM_CAUTION_INTRO =
  '在匿名聊天之前你需要知道：为了保证体验，如无特殊标注，你本人（外界个人空间的user设定）和匿名马甲在AI的认知里是两个人。';

export const ANON_ROOM_CAUTION_IDENTITY =
  '如果想体验被匿名char引诱【本体】，建议在匿名资料这里写同一个id、标明自己就是user；如果想慢慢掉马，自爆或者戳穿他的马甲也是玩法之一。';

export const ANON_ROOM_CAUTION_TEXT =
  '而如果是纯匿名的情况下，无论在哪个模式，纯爱派或者有情感洁癖请务必不要尝试高强度“情感测试”（比如扮成别人去引诱他），否则根据AI幻觉或者底色有可能会成功；由于也有用户玩匿名是为了寻求匿名恋爱的刺激，所以聊天室本身没有这种不许恋爱的兜底，用户需要自行注意或者增加角色只爱你本人的提示词！但还是不能保证，毕竟如果模型是Gemini3.1pro之类的会非常自来熟，需要慎重！';

export const ANON_ROOM_CAUTION_MATCH_TEXT =
  '如非兴趣，不建议选「想搞点暧昧」等暧昧向一对一随机匹配。随机匹配默认是角色与用户双向匹配——双方志愿都被标成对暧昧/陪伴等关系开放，设定上不会做这种事的char容易产生OOC的风险。';

export const ANON_ROOM_CAUTION_FULL = [
  ANON_ROOM_CAUTION_INTRO,
  ANON_ROOM_CAUTION_IDENTITY,
  ANON_ROOM_CAUTION_TEXT,
  ANON_ROOM_CAUTION_MATCH_TEXT,
].join('\n\n');
