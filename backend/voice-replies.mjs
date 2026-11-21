export function voiceModeFor(settings) {
  const mode = settings?.voiceReplyMode;
  return ['text', 'occasionally', 'mixed', 'voice'].includes(mode) ? mode : settings?.voiceReplies === true ? 'voice' : 'text';
}

// Kept separate from ordinary discussion of voice models, settings or messages.
export const voiceRequest = /^(?:(?:请你?|可以|能不能|麻烦你?)\s*)?(?:(?:用语音(?:来)?(?:回复|回答|告诉我|说|讲|念)|发(?:一?[条段个])?语音(?:回复|回答)?|语音(?:回复|回答)(?!功能|设置|模型|接口|服务|模式|怎么|是什么)|语音(?=$|[\s：:,，])))[\s：:,，]*/u;
const prefersText = /(?:别|不要|不用|先别|暂时别|不想|不方便|没法|不能)(?:再|给我|用|发|听|你的?|收|放|播|播放){0,4}语音|(?:只|直接|请|麻烦|还是|改用|用|发)(?:发|用)?文字(?:回复|回答|说|吧|就行|就好)?|(?:打字|文字)(?:回复|回答|说|就好|即可|就行|给我|发给我|发我)|能打字吗/u;
const asksToHear = /^(?:(?:我(?:就)?)?(?:想|好想|想要)听(?:听|一下)?(?:你(?:的)?(?:声音|语音)|你(?:亲口|用语音)(?:跟我|和我|给我)?说)|(?:你)?(?:能不能|可不可以|可以|能|请|麻烦)?(?:给我|帮我)?(?:发(?:一?[个条段])?语音|用语音(?:回复|回答|说|讲|念)))/u;
const formatQuestion = /^(?:(?:你)?(?:可以|能不能|可不可以|方便|能)(?:用)?语音|(?:能不能|可以|给我)?来(?:一?[条段个])语音)(?:吗|么|呀|吧|啊)?$/u;
export function requestedVoice(text) {
  const preference = text.replace(/(?:别|不要|不用|不想)(?:再|用|发|看)?(?:文字|打字)(?:回复)?/gu, '');
  if (prefersText.test(preference) || /(?:不方便|没法)听[。！!，,\s]*$/u.test(preference)) return false;
  if (narratedQuote.test(text)) return undefined;
  if (text.split(/[，,。！？!?；;\n]/u).some(part => {
    const phrase = part.trim();
    return voiceRequest.test(phrase) || asksToHear.test(phrase) || formatQuestion.test(phrase);
  })) return true;
  return undefined;
}

const quietContent = /验证码|校验码|取件码|身份证|银行卡|手机号|密码|密钥|口令|自残|自杀|不想活|诊断|检查报告|https?:\/\/|\d{4,}|```/iu;
const factual = /查资料|帮我查|查一下|搜索|天气|气温|预报|多少度|几度|要带伞|带不带伞|要不要带伞/u;
const warmMoment = /^(?:晚安|好梦)(?:呀|啦|哦|啊|咯|了)?(?:姐姐?|哥哥?|朋友)?$|^(?:跟你|给你)(?:说|道)(?:个|声)?晚安|^(?:那|今天|我){0,3}(?:我(?:先|要|准备)|先去|准备|该去)(?:睡觉|睡)(?:了|啦|咯|喽)|^我(?:今天|现在|刚才|终于|真的|好|太|很|有点|特别){0,5}(?:开心|高兴|激动)|^(?:今天|真的|太|好|超|特别){1,4}(?:开心|高兴|激动)|^我(?:终于|总算)(?:.+)?(?:抢到|拿到|通过|考过|做完|完成)|^我(?:刚刚?)?(?:抢到了|拿到了|考过了|赢了|被录取了)|^(?:可以|能不能|你能|想让你|我想让你)?(?:给我打打气|安慰我一下|抱抱我|哄我一下)/u;

const sharedLaughter = /^(?:(?:真的?|快|要|刚刚?)?笑死我了|我(?:笑得|笑到)(?:肚子疼|停不下来|眼泪都|打鸣)|(?:刚才那个|这个梗|这句|这也)(?:真的?|也)?太好笑了|(?:刚才那个|这个梗|这句)我(?:能|可以)笑(?:一天|半天|好久))/u;
const narratedQuote = /(?:他|她|朋友|同事|对方)(?:刚刚?|刚才)?(?:说|发来|写道)(?:了句)?[：:，,「“"]/u;
const dampened = /开心不起来|高兴不起来|才怪|假装开心|没(?:有|能)?(?:抢到|拿到|考过|通过)|一点也不开心/u;

function wasVoice(message) {
  return message?.voiceDelivered === true || (message?.voiceDelivered == null && message?.voice === true);
}

export function mixedVoice({ messages, input, reply, searching, weather, story }) {
  if (searching || weather || story || reply.length > 240 || !reply.trim()
    || quietContent.test(input) || quietContent.test(reply) || factual.test(input)) return false;
  // One delivered turn counts once, including a text reply split into multiple QQ bubbles.
  const previous = messages.findLast(m => m?.role === 'assistant' && !m.pendingDelivery
    && (!m.kind || m.kind === 'chat' || m.kind === 'reply') && typeof m.text === 'string' && m.text.trim());
  return !wasVoice(previous);
}

export function selectedVoice(providers, settings, fallback = 'none') {
  if (providers.bailianVoiceSelected) return providers.bailianVoiceAvailable ? 'bailian' : 'none';
  if (settings.useDeepseekVoice) return providers.deepseekVoiceAvailable ? 'deepseek' : 'none';
  return providers.voiceProvider ?? (providers.voiceConfigured ? 'remote' : fallback);
}

export function voiceAvailableFor(providers, settings) {
  if (providers.bailianVoiceSelected) return providers.bailianVoiceAvailable === true;
  if (settings.useDeepseekVoice) return providers.deepseekVoiceAvailable === true;
  return providers.voiceAvailable === true || providers.voiceConfigured === true;
}

export function occasionalVoice({ messages, input, reply, at, quiet, searching, weather, story, companionName }) {
  if (quiet || searching || weather || story || input.length > 110 || reply.length > 100 || !reply.trim()
    || /\n/u.test(input + reply) || quietContent.test(input) || quietContent.test(reply) || factual.test(input)) return false;
  const clauses = input.split(/[，,。！？!？?；;～~\n]/u);
  if (narratedQuote.test(input) || dampened.test(input)) return false;
  if (!clauses.some(part => {
    const phrase = part.trim();
    return warmMoment.test(phrase) || sharedLaughter.test(phrase) || (companionName && phrase === '晚安' + companionName);
  })) return false;

  const recent = messages.slice(-32).filter(m => m && !m.pendingDelivery && Number.isFinite(m.at) && m.at <= at
    && m.at >= at - 24 * 3_600_000 && (!m.kind || ['chat', 'reply'].includes(m.kind)));
  const replies = recent.filter(m => m.role === 'assistant' && typeof m.text === 'string' && m.text.trim());
  const shared = recent.filter(m => m.role === 'user' && m.at >= at - 90 * 60_000 && typeof m.text === 'string' && m.text.trim());
  if (replies.length < 4 || shared.length < 2) return false;
  // An older message may predate delivery receipts. Preserve its recorded voice intent conservatively.
  return !replies.slice(-4).some(wasVoice) && !replies.some(m => wasVoice(m) && at - m.at < 90 * 60_000);
}
