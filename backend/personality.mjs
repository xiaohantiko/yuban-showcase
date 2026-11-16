export const personalityTraits = Object.freeze({
  venting: Object.freeze(['listening', 'gentle', 'brief']),
  planning: Object.freeze(['practical', 'brief', 'gentle']),
  casual: Object.freeze(['playful', 'gentle', 'brief']),
  celebration: Object.freeze(['playful', 'gentle', 'brief']),
  affection: Object.freeze(['gentle', 'playful']),
  disagreement: Object.freeze(['gentle', 'practical', 'listening']),
});

const contextLabels = {
  venting: '倾诉时', planning: '讨论计划时', casual: '日常闲聊时', celebration: '分享好消息时',
  affection: '双方愿意亲昵互动时', disagreement: '发生分歧时',
};
const traitLabels = { listening: '先听我说', gentle: '语气温柔', brief: '回复简短', practical: '建议具体', playful: '轻松幽默' };

export function isPersonalityCue(cue) {
  return Boolean(cue && typeof cue === 'object' && !Array.isArray(cue) && Object.keys(cue).length === 2
    && Object.hasOwn(cue, 'context') && Object.hasOwn(cue, 'trait')
    && typeof cue.context === 'string' && Object.hasOwn(personalityTraits, cue.context)
    && personalityTraits[cue.context].includes(cue.trait));
}

export function validatePersonalityObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'signals') || !Array.isArray(value.signals) || value.signals.length > 2) return [];
  const seen = new Set();
  const signals = [];
  for (const cue of value.signals) {
    if (!isPersonalityCue(cue)) return [];
    const key = `${cue.context}:${cue.trait}`;
    if (seen.has(key)) return [];
    seen.add(key);
    signals.push({ context: cue.context, trait: cue.trait });
  }
  return signals;
}

export function personalityLabel({ context, trait }) {
  return `${contextLabels[context]}${traitLabels[trait]}`;
}

export function personalityContext(text) {
  if (/不是这个意思|你(?:误会|理解错|说错)|不太同意|意见不一样|理解偏了|说清楚分歧/u.test(text)) return 'disagreement';
  if (/撒娇|贴贴|抱抱|语气亲昵|可爱一点|软乎乎/u.test(text)) return 'affection';
  if (/好消息|升职了|通过了|考上了|录取了|终于完成了|成功了|庆祝|很开心|太开心|好耶/u.test(text)) return 'celebration';
  if (/吐槽|倾诉|难受|委屈|难过|想哭|压力大|受不了|被误会|焦虑|糟心|撑不住|心情不好/u.test(text)) return 'venting';
  if (/做计划|讨论计划|怎么开始|怎么办|怎么做|给.{0,3}建议|制定|安排行程|下一步|帮我理/u.test(text)) return 'planning';
  if (/日常|闲聊|聊聊天|周末|猫|咖啡|奶茶|追剧|电影|早餐|哈哈|[😂🤣😆]/u.test(text)) return 'casual';
  return null;
}

export function reciprocalPersonalityCue(previousUser, assistant, text) {
  const context = personalityContext(previousUser);
  const positive = /^(?:是啊|对呀|嗯嗯|确实|对的|谢谢|哈哈)|听你这么说|这样挺好|有道理|我也觉得|接着说/u.test(text);
  if (context === 'affection' && /撒娇|贴贴|抱抱|软乎乎/u.test(assistant)
      && /喜欢.{0,5}(?:这样|贴贴|抱抱|撒娇)|这样(?:很可爱|我喜欢)|好耶.{0,5}(?:贴贴|抱抱)|(?:想|再来|再给我).{0,4}(?:贴贴|抱抱)/u.test(text)) {
    return { context, trait: /贴贴|撒娇|软乎乎/u.test(assistant) ? 'playful' : 'gentle' };
  }
  if (context === 'disagreement' && /刚才.{0,5}(?:理解错|误会|说错)|谢谢你?纠正|我重新说|按你的意思/u.test(assistant)
      && /(?:这样|现在).{0,5}(?:说清楚|说对|明白)|这就是我的意思|对.{0,3}就是这个意思|可以接着说/u.test(text)) {
    return { context, trait: /重新说|按你的意思/u.test(assistant) ? 'practical' : 'gentle' };
  }
  if (context === 'venting' && /我在听|慢慢说|想说|听着|那会儿|挺难|不好受/u.test(assistant)
      && (positive || personalityContext(text) === 'venting')) return { context, trait: 'listening' };
  if (context === 'planning' && /可以先|先从|第一步|试着|接下来|分成|先.{1,20}再/u.test(assistant)
      && /那我先|我先试|我准备|我打算|我就按|这样做|这个办法|有道理|我试试/u.test(text)) return { context, trait: 'practical' };
  if (context === 'casual' && /哈哈|逗|好笑|可爱|[😂🤣😆]/u.test(assistant)
      && /哈哈|笑死|太逗|好笑|[😂🤣😆]/u.test(text)) return { context, trait: 'playful' };
  if (context === 'celebration' && /恭喜|真好|真棒|太棒|开心|庆祝|值得/u.test(assistant)
      && (positive || /开心|高兴|想庆祝|嘿嘿/u.test(text))) return { context, trait: 'gentle' };
  return null;
}
