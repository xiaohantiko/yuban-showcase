export const STORY_PAUSE_MS = 8_000;
const MAX_STORY_CHARS = 6_000;
const MAX_STORY_PARTS = 64;
const omitted = '〔中间部分已略去〕';
const explicit = /^(?:(?:我(?:想|要)?(?:分几条|慢慢|先)(?:说|讲|发)(?:个故事|件事)?|我还(?:没|没有)(?:说|讲|发)完)[，,。\s]*)?(?:你)?(?:先(?:别|不用|不要)(?:急着)?(?:回(?:复|答)?|说话)|先听我(?:说|讲)(?:完)?|等我(?:把(?:事情|故事))?(?:说|讲|发)完(?:了)?再(?:回|说)|让我(?:先)?(?:把话)?(?:讲|说)完)/u;
const narrative = /^(?:我(?:来|想|要|先)?(?:给你|跟你|和你)(?:讲|说|聊)(?:一下|个|一件|件|一段|段)(?:我.{0,6}的)?(?:事|故事|经历)|我分(?:几|两|三)条(?:跟你)?(?:说|讲|发)|这事(?:儿)?说来话长|说来话长|事情是这样的|这件事(?:儿)?得从.{0,12}说起)/u;
const done = /^(?:好[啦了][，,\s]*)?(?:(?:我)?(?:讲|说|发)完(?:了|啦|了呀)?|(?:事情|故事)(?:就是这样|到这儿了)|就(?:是)?这些(?:了)?|(?:现在)?(?:你(?:可以)?(?:说吧|说了|回了|回复了)|轮到你(?:了|啦)))(?:[。.!！？，,\s]|$)/u;
const handover = /(?:^|[。！？,，\s])(?:你怎么看|你觉得呢|你觉得我该怎么办|你有什么想法)(?:[？?。！!\s]*$)/u;
const cancel = /^(?:算了[，,\s]*)?(?:取消讲述|不(?:想)?(?:说|讲)了|别提这件事了|换个话题)[吧啦了。！!\s]*$/u;
const urgent = /(?:我(?:现在|马上|真的)?(?:想自杀|想死|不想活|要伤害自己|不安全)|救救我|我现在有危险|快帮我叫救护车)/u;
const direct = /[？?]\s*$|(?:陪我|^(?:请)?(?:给我|帮我)|你(?:可以)?(?:给我|帮我)|你能|你可以|你会不会|你觉得|你认为|你说呢|你怎么看|我该怎么办|回一句|回复我)|^(?:你好|谢谢|早安|晚安|好消息|我(?:一直|特别|平时|最)?喜欢|我(?:偏爱|需要|希望你|想听|想要)|记住|以后我们|我们约好|请|用语音)/u;
const event = /^(?:然后|后来|结果|当时|本来|谁知道|没想到|对了还|说起来|那天|昨天|前天|今天我|刚才我|上周)|(?:一到|一进|刚进|走到|走进|路过|碰到|遇到|回到|走出|才发现|没料到|没想到|转过身|的时候|那会儿|递给|告诉我|跟我说|喊住|拦住|打断|塞给|推开|拉住)|(?:同事|室友|经理|老板|老师|朋友|他|她).{0,8}(?:说|问|把|拿|来|突然|忘了)|把.{1,8}(?:放|推|塞|扔|递|拿|收)/u;
const unfinished = /(?:[，,、…：:]|\.{2,}|可是|但是|然后|突然|结果|正要|本来|我还以为|没想到)\s*$/u;

function pauseFor(text, previous, now) {
  if (unfinished.test(text)) return 12_000;
  if (!previous) return narrative.test(text) || event.test(text) ? STORY_PAUSE_MS : 3_000;
  // Leave room for someone typing several messages at their own pace.
  const gap = Math.max(0, now - previous.updatedAt);
  return Math.min(15_000, Math.max(STORY_PAUSE_MS, gap + 2_000));
}

function compact(parts) {
  if (parts.length <= MAX_STORY_PARTS && parts.join('\n').length <= MAX_STORY_CHARS) return parts;
  const text = parts.filter(p => p !== omitted).join('\n');
  const head = text.slice(0, 1700).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = text.slice(-(MAX_STORY_CHARS - head.length - omitted.length - 2)).replace(/^[\uDC00-\uDFFF]/u, '');
  return text.length <= MAX_STORY_CHARS ? [text] : [head, omitted, tail];
}

function valid(state) {
  return state && ['explicit', 'narrative'].includes(state.mode) && Array.isArray(state.parts)
    && state.parts.length <= MAX_STORY_PARTS && state.parts.every(part => typeof part === 'string' && part.length <= MAX_STORY_CHARS)
    && Number.isSafeInteger(state.updatedAt);
}

export function dueStory(state, now = Date.now()) {
  return valid(state) && state.mode === 'narrative' && Number.isFinite(state.nextFlushAt) && now >= state.nextFlushAt
    ? state.parts.join('\n') || null : null;
}

export function observeStory(previous, input, { now = Date.now() } = {}) {
  const text = String(input ?? '').trim();
  const state = valid(previous) ? previous : null;
  if (urgent.test(text)) return { action: 'reply', state: state && { ...state, mode: 'explicit', nextFlushAt: null }, text };
  if (state && cancel.test(text)) return { action: 'cancel', state: null };
  if (state && (done.test(text) || handover.test(text) || (state.mode === 'narrative' && /^(?:那你|你觉得|你说我|你会怎么|要是你|换作你)/u.test(text)))) {
    return state.parts.length ? { action: 'flush', state: null, text: compact([...state.parts, text]).join('\n') }
      : { action: 'reply', state: null, text };
  }
  const hold = explicit.test(text);
  if (!state && !hold && (direct.test(text) || !(narrative.test(text) || event.test(text) || unfinished.test(text) || ([...text].length >= 12 && !/[。！.!]$/u.test(text))))) {
    return { action: 'reply', state: null, text };
  }
  const mode = hold || state?.mode === 'explicit' ? 'explicit' : 'narrative';
  const parts = compact([...(state?.parts ?? []), text].filter(Boolean));
  return { action: 'buffer', state: { mode, parts, updatedAt: now, nextFlushAt: mode === 'narrative' ? now + pauseFor(text, state, now) : null } };
}
