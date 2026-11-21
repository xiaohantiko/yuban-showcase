import { localTimeContext } from './time-context.mjs';

const minute = 60_000;
const hour = 60 * minute;
const acknowledgement = /^(?:嗯+|哦+|好(?:的|啊|呀|吧|嘞)?|收到|(?:我)?(?:知道|明白|懂)(?:啦|了)|原来(?:是)?这样[啊呀]?|这我知道|行吧|没事|没什么|谢谢(?:你)?|哈哈+|ok(?:ay)?|thanks|bye)[\p{P}\p{S}\s]*$/iu;
const command = /^(?:[/#]|(?:绑定|认领|解绑)(?:主人|账号|码)?(?:\s|[:：])|(?:查看|开启|关闭|清空|删除|导入)(?:记忆|问候|相处记忆|主动找我)|(?:帮我查|查资料|搜索|语音回复))/u;
const userPause = /别(?:再)?(?:催|问|找我|来找我|打扰|联系)|不要(?:再)?(?:催|问|打扰|来找我|联系)|不(?:用|想)(?:再)?(?:聊|联系|来找我|打扰)|等我(?:主动)?(?:来)?(?:找你|回你|回复|联系你)|过(?:几|两|两三|一两)天(?:再)?(?:讲|聊|说)|别等我|不用回|不方便(?:聊|回)|我先走|我在忙|正忙|在(?:开会|开车|上课|考试)|想(?:一个人|静静|独处)|(?:先|就|暂时)不(?:聊|说|讲)|暂时没空|我(?:先)?接(?:个|一下)?电话|下次再|不聊啦|回头(?:再)?聊|改天(?:再)?聊|之后再聊|晚点(?:再)?(?:聊|说)|明天(?:再)?(?:聊|说)|说完了|讲完了|就(?:说到这|到这|这样)|(?:我(?:要|先|去)|准备|先去|该|要去|得去|现在在|正在)(?:先)?(?:去)?(?:睡|休息|开会|上课|工作|忙|考试|开车)|(?:要|先|太|有点)忙|忙着|睡了|晚安|拜拜|再见|good\s?night|talk later|don.t (?:text|message)|gotta go/iu;
const explicitEnding = /(?:先|今天|今晚|就)(?:讲|说|聊)到这(?:里|儿)?(?:吧|啦|了|哈)?(?=$|[，,。.!！?？；;\s])|到此为止(?:吧|啦|了)?(?=$|[，,。.!！?？；;\s])/u;
const defersReply = /等我(?:忙完|开完会|下课|有空)(?:了)?(?:再|以后)|(?:晚点|晚些|回头|改天)(?:我)?(?:再)?(?:回你|回复你|找你)|(?:我|先|要|得)(?:先)?(?:去)?开(?:一?个|一下)会/u;
function pausesConversation(text) {
  return userPause.test(text) || explicitEnding.test(text) || defersReply.test(text);
}
const assistantClose = /晚安|好好休息|先去忙|那你(?:先)?(?:忙|休息)|下次(?:再)?聊|明天(?:再)?聊|改天(?:再)?聊|不打扰/u;
const briefErrand = /^(?:(?:等一下|等我一下)[，,\s]*)?(?:我(?:先|要)?|先)?(?:去|去趟)?(?:(?:接|拿|倒|喝)(?:一?[杯口]|点)?水|(?:拿|找)(?:一下|个)?耳机)(?:去了?|哈|呀|啦)?[。！!\s]*$/u;
const unfinished = /^(?:(?:其实|不过|对了|而且|我(?:们)?(?:这个故事|刚才那段|的故事)?|刚才那个故事))*?(?:还没(?:有)?(?:讲|说)完|(?:才|只)(?:讲|说)到一半|还有(?:个?后续|[后下]半段|(?:一点|一件事|件事|一段|个细节)(?:想|要|没)(?:跟你)?(?:说|讲))|(?:接着|继续|还要|再)(?:跟你|给你)?(?:讲|说|聊)|(?:等我|一会儿?)?回来(?:再)?(?:接着|继续)(?:讲|说|聊)|你猜猜?(?:看)?(?:后来|后面|发生了什么|结果))/u;
function hasMore(text) {
  const clauses = text.split(/[，,。！？!?；;：:\n]/u).map(part => part.trim()).filter(Boolean);
  return clauses.some(part => unfinished.test(part) || /^(?:there.s more|(?:i.m )?not finished yet)\b/iu.test(part))
    || /^(?:然后|结果|没想到)[…\.\s]*$/u.test(clauses.at(-1) ?? '');
}
const topic = /听歌|歌曲|新歌|歌单|音乐|演唱会|电影|剧(?:情|集)|追剧|小说|这本书|游戏|漫画|零食|甜品|口味|薯片|画画|照片|故事|手工|我喜欢|我更喜欢|我在想|我觉得|当时|没想到|后来|结果他|结果她|让我想起|有意思|好玩的/u;
const asksBack = /[？?][\p{P}\p{S}\s]*$|(?:吗|呢|好不好|怎么样|是不是)[呀啊嘛]?[。！!\s]*$/u;

function substantial(text) {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4 && !acknowledgement.test(text) && !command.test(text);
}

// Inspect one recent conversation. Commands, one-sided traffic and prior nudges cannot start a new one.
function recentPairs(messages, anchor, now, timeZone, localDate) {
  let pending;
  const pairs = [];
  for (const m of (Array.isArray(messages) ? messages.slice(-24) : [])) {
    if (!m) continue;
    if (m.role === 'assistant' && m.kind === 'greeting' && m.at >= anchor) continue;
    const text = typeof (m.text ?? m.content) === 'string' ? (m.text ?? m.content).trim().slice(0, 3000) : '';
    if (!['user', 'assistant'].includes(m.role) || (m.kind && !['chat', 'reply'].includes(m.kind)) || !text || command.test(text)
      || !Number.isSafeInteger(m.at) || m.at < anchor - 2 * hour || m.at > now || m.confirmedChat === false) {
      pairs.length = 0; pending = undefined; continue;
    }
    if (m.role === 'user') {
      if (pairs.length && (m.at - pairs.at(-1).userAt > 40 * minute || pausesConversation(pairs.at(-1).user) || assistantClose.test(pairs.at(-1).reply))) pairs.length = 0;
      pending = { user: text, userAt: m.at };
    } else if (pending) {
      pairs.push({ ...pending, reply: text, replyAt: m.at });
      pending = undefined;
    }
  }
  if (pending) return [];
  while (pairs.length && localTimeContext(pairs[0].userAt, timeZone).localDate !== localDate) pairs.shift();
  return pairs;
}

// Limit the reminder prompt to the same conversation that qualified it for delivery.
export function followupMessages(messages, plan, timeZone, now) {
  const date = localTimeContext(plan.anchor, timeZone).localDate;
  const history = recentPairs(messages, plan.anchor, now, timeZone, date).slice(-4).flatMap(pair => [
    { role: 'user', text: pair.user, at: pair.userAt },
    { role: 'assistant', text: pair.reply, at: pair.replyAt },
  ]);
  const previous = messages.findLast(m => m?.role === 'assistant' && m.kind === 'greeting' && m.at >= plan.anchor && m.at <= now);
  if (previous) history.push(previous);
  return history;
}

export function planFollowup(thread, settings, now = Date.now()) {
  const anchor = thread?.lastUserAt;
  if (!thread?.optedIn || thread.storyTurn || settings?.enabled === false || !Number.isSafeInteger(anchor)
    || !Number.isSafeInteger(now) || now < anchor || now - anchor >= 5 * hour) return null;
  const start = localTimeContext(anchor, settings?.timeZone), current = localTimeContext(now, settings?.timeZone);
  if (start.localDate !== current.localDate) return null;
  // A late-night exchange does not become a morning reminder when overnight quiet hours end.
  if (settings?.quietEnabled && settings.quietStart > settings.quietEnd
    && start.localTime < settings.quietEnd && current.localTime >= settings.quietEnd) return null;

  const pairs = recentPairs(thread.messages, anchor, now, settings?.timeZone, start.localDate), last = pairs.at(-1);
  if (!last || last.userAt < anchor - 5 || last.userAt > anchor + 3 * minute
    || pausesConversation(last.user) || assistantClose.test(last.reply)) return null;
  const brief = briefErrand.test(last.user);
  const real = pairs.filter(pair => substantial(pair.user) && substantial(pair.reply) && !briefErrand.test(pair.user));
  if (real.length < 2 || (!brief && real.at(-1) !== last)) return null;
  const open = hasMore(last.user) || (brief && real.at(-1) === pairs.at(-2) && hasMore(real.at(-1).user));
  if (brief && !open) return null;
  if (!open && (real.length < 3 || !topic.test(last.user) || !asksBack.test(last.reply))) return null;
  const reason = open ? 'open' : 'conversation';
  const previous = thread.followup?.anchor === anchor ? thread.followup : null;
  if (!previous && thread.attemptedFor === anchor) return null;
  if (previous) {
    if (!open || previous.stage !== 1 || !Number.isSafeInteger(previous.at) || previous.at < anchor || previous.at > now
      || previous.delivered === false || (previous.delivered !== true && !thread.messages.some(m => m?.kind === 'greeting' && m.role === 'assistant' && m.at >= anchor))) return null;
    const dueAt = previous.at + 2 * hour, expiresAt = anchor + 5 * hour;
    return now < expiresAt && dueAt < expiresAt && localTimeContext(dueAt, settings?.timeZone).localDate === start.localDate ? { anchor, stage: 2, reason, dueAt, expiresAt } : null;
  }
  const gaps = [];
  for (let i = 1; i < real.length; i++) {
    const wait = real[i].userAt - real[i - 1].replyAt;
    if (wait > 0 && wait <= 40 * minute) gaps.push(wait / minute);
  }
  gaps.sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : 4;
  const delay = Math.max(open ? 15 : 30, Math.min(75, Math.ceil(typical * 3 + (open ? 5 : 15))));
  const dueAt = anchor + delay * minute, expiresAt = dueAt + 55 * minute;
  return now < expiresAt && localTimeContext(dueAt, settings?.timeZone).localDate === start.localDate ? { anchor, stage: 1, reason, dueAt, expiresAt } : null;
}
