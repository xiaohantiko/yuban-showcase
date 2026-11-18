import { isOwnerMemoryStatement } from './shared-memory.mjs';
import { localTimeContext } from './time-context.mjs';

// Match an attribution to the user, rather than all emotional language. The
// companion can express her own feelings or acknowledge that an event was hard.
const families = {
  joy: /心情(?:也|还|真|挺|很|特别|蛮|非常|这么|这么的|看着|似乎|确实|好像|好像还|肯定|一定|应该|大概|可能|也许|看来|估计|特别|相当|真是)*(?:不错|很好|挺好|好)|开心|高兴|快乐|愉快|幸福|美滋滋|乐呵|兴高采烈|兴奋|雀跃/u,
  ease: /轻松|放松|松了?口气|如释重负|自在|惬意/u,
  leisure: /悠闲|闲适|闲情|闲心|有闲工夫/u,
  interest: /有(?:闲)?兴致|兴致(?:很|挺)?高|兴致勃勃/u,
  sad: /难过|难受|伤心|低落|失落|沮丧|郁闷|委屈|心酸|想哭|不好受|心情(?:很|挺|特别|不太)?(?:差|糟|不好)/u,
  anxious: /焦虑|紧张|忐忑|担心|不安|心慌|害怕|发怵/u,
  angry: /生气|气愤|恼火|烦躁|烦闷|烦心|憋屈|窝火/u,
  other: /满意|得意|自豪|踏实|平静|平和|释然|满足|失望|无聊|孤单|感动|骄傲|期待|好奇|心事重重/u,
};
const moodWords = new RegExp(Object.values(families).map(regex => regex.source).join('|'), 'gu');
const uncertain = /看(?:起|得|上)来|看得出|听(?:起来|得出)|感觉你|想必|八成|多半|应该|一定|肯定|大概|或许|可能|说不定|像是|似乎|好像|估计|想来|猜(?:你|是)|难怪|不像|貌似|看来/u;
const temporal = /昨晚|昨夜|昨天(?:晚上|夜里|上午|早上|下午|中午)?|昨儿|今早|今晚|今夜|今天(?:晚上|夜里|上午|早上|下午|中午)?|现在|这会儿|此刻|刚才/u;
const recall = /记不记得|记得|还记着|说过|提过|当时|那会儿?|那天|那(?:一)?次|之前|那时候|昨晚|昨天|昨夜|当初|以前/u;
const moodQuestion = /(?:心情|情绪|感受|心境|感觉|心里|当时.{0,6}怎么想|当时.{0,6}什么滋味)/u;
const question = /[?？]|[吗嘛么]$|是不是|有没有|什么|怎么样|如何|究竟|到底|哪种/u;
const openQuestion = /(?:什么|怎样|怎么样|怎么想|如何|怎么形容|说说|讲讲|愿意聊|想聊)[^。！？]{0,18}(?:感[觉受]|心情|心里|情绪|想法|滋味)|(?:感觉|感受|心里|心情|当时|那会儿)[^。！？]{0,18}(?:怎么样|怎么想|什么|如何|怎样|怎么形容)/u;
const admitsUnknown = /(?:我|这[个点]?)?[^。！？]{0,5}(?:不(?:太)?确定|不(?:太)?清楚|不知道|拿不准|记不清|没(?:听|看)到|没听你|猜不[到出]|不(?:敢|想|能)替你(?:猜|说|决定))|(?:没(?:有)?|还没|没怎么)(?:和我|跟我|具体)?(?:说|讲|提|聊)|只有你(?:自己)?知道/u;
const comparison = /比(?:昨|今|上|之|刚|从|以|先|那|前)|比.{0,8}(?:轻松|开心|难过)|还是那么|又开始|好(?:点|多|些)了|缓过来/u;
const thoughtGuess = /(?:我(?:猜(?:测)?|估计|敢说|打赌)你(?:自己|当时|心里|那会儿|现在|肯定|一定|应该|可能|其实|多半|也|是)*|你(?:当时|心里|自己|那会儿|现在|这会儿)*(?:肯定|一定|多半|八成|应该|大概)(?:心里|当时|其实|就|也|是)*|(?:^|[，,])\s*(?:多半|八成|肯定|一定)(?:也|就|是)*)(?:在想|心想|觉得|以为|打算|希望|想要|想|为了)[：:“「]?([^，,；;。！？!?\n”」]{1,80})/u;
const duration = /(?:整整)?(?:大半天|半天|半个晚上|整天|整晚|整夜|一整(?:个)?(?:天|夜|晚(?:上)?|上午|下午)|一(?:天|宿|夜|晚(?:上)?|上午|下午)|整个(?:晚上|上午|下午)|从早到晚)/u;
const afterFeeling = new RegExp('^(?:了|上了|过了)?(' + duration.source + ')', 'u');
const beforeFeeling = new RegExp('(' + duration.source + ')(?:都|一直|还|很|挺|特别|有点)*$', 'u');
const quotes = /“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"]*(?:"|$)/gu;
const clauseBoundary = /[，,；;。！？!?\n]/u;
const otherSpeaker = /我的?(?:朋友|同事|同学|室友|家人)|你(?:的)?(?:朋友|同事|同学|室友|家人)|朋友|同事|同学|室友|角色|主角|主人公|[他她它]|自己|我|你/gu;
const negation = /(?:不(?:是|算|太)?|没有|并非|谈不上|说不上|没)(?:真的|特别|很|那么|非常|觉得|感到|那么的)*$/u;
const topicNoise = /[我你他她们的了这那是么很挺呀啊呢吧啦嘛也都还就]/gu;
const topicFiller = /心情|感觉|感受|情绪|当时|之前|上次|什么|怎样|怎么|如何|哪种|哪件|可以|好像|其实|今天|昨天|晚上|昨晚|那会儿|刚才|现在|记得|说过|提过|难过|开心|高兴|自己|有点|名字|叫做|是不是|记不记得|说的|提的|我还|昨晚|的感受|那时候|是什么样|那种|我那时|昨夜/gu;

function topicWords(text) {
  const words = new Set();
  for (const word of text.replace(topicFiller, ' ').replace(topicNoise, ' ').match(/[\p{L}\d]+/gu) ?? []) {
    for (let i = 0; i + 1 < word.length; i++) words.add(word.slice(i, i + 2));
  }
  return words;
}

function overlaps(text, terms) {
  return [...topicWords(text)].some(term => terms.has(term));
}

function feelings(text) {
  const result = [...text.matchAll(moodWords)].map(({ 0: word, index }) => {
    const family = Object.keys(families).find(key => families[key].test(word));
    return { word, key: family === 'other' ? word : family, negative: negation.test(text.slice(0, index)), index };
  });
  // A speaker can invent adjectives, too. Recognise a hedged judgement of
  // someone's state without treating an ordinary question about an activity as one.
  for (const match of text.matchAll(/(?:你(?:最近|当时|那会儿|今天|昨晚|现在|这会儿)?|(?:^|[，,])\s*)(?:看起来|显得|应该(?:是)?|想必|肯定|一定|看上去)(?:还|也)?(?:挺|蛮|很|特别)([\p{Script=Han}]{1,8}?)(?:的(?:状态|样子)?(?:吧|嘛)|的状态|的心情)(?=[。！？!?，,\s]|$)/gu)) {
    const word = match[1];
    const index = match.index + match[0].lastIndexOf(word);
    if (!result.some(item => Math.abs(item.index - index) <= 1)) result.push({ word, key: word, negative: false, index });
  }
  return result;
}

// Keep an unfamiliar feeling in the user's own words as well. Require an
// explicit frame; an action such as “我刚拿到了奖” carries no mood on its own.
function statedFeelings(text) {
  const found = feelings(text);
  const frame = /(?:[我你](?:当时|那时(?:候)?|那会儿|今天|昨天|昨晚|刚才|现在|这会儿|其实)?(?:的?(?:感受|感觉|心情|情绪)(?:就是|真的很|是|有些|有点|很|挺)|(?:感到|觉得自己)(?:真的|有点|有些|很|挺)?|(?:当时|那会儿|那时(?:候)?)(?:有点|有些|很|挺)|(?:有点|有些|挺)))([\p{Script=Han}]{1,12}?)(?:的|了|呀|啊|呢|吧)?(?=[，,。！？!?；;\s]|$)/gu;
  for (const match of text.matchAll(frame)) {
    const word = match[1];
    const index = match.index + match[0].lastIndexOf(word);
    if (!found.some(item => item.index >= index && item.index < index + word.length)) {
      found.push({ word, key: word, negative: negation.test(text.slice(0, index)), index });
    }
  }
  return found;
}

function subject(text, index) {
  const prefix = text.slice(0, index);
  const part = prefix.split(clauseBoundary).at(-1);
  return { part, speaker: [...part.matchAll(otherSpeaker)].at(-1)?.[0] };
}

function userAttribution(part, index) {
  const { part: before, speaker } = subject(part, index);
  if (/^满意(?:吗|么|不满意)[？?。！!]*$/u.test(part.slice(index)) && !uncertain.test(before) && !/总算|终于|该/u.test(before)) return false;
  if (/替你|为你(?:感到)?$|让人|换[谁作]|如果|假如|假设|要是|无论|即使|不管|希望你|愿你|祝你/u.test(before)) return false;
  if (speaker === '我' && !/我(?:猜你|觉得你|想你)/u.test(before)) return false;
  if (speaker && !['你', '自己'].includes(speaker)) return false;
  if (/^(?:听上去|听起来)?(?:这件事|这事|换成谁|那句话|这种处境|这种事|这段经历|这也|被.{0,8}打断)/u.test(before)
    && !/你/u.test(before)) return false;
  if (speaker === '你' && /(?:你这|你的|你取的|你写的|你说的).{0,12}(?:名字|角色|故事|歌|画|游戏)(?:看起来|听起来|很|挺|真)?$/u.test(before)) return false;
  return speaker === '你' || uncertain.test(before) || /今天|现在|昨晚|昨夜|当时|又|还是|心里|心情|玩得|玩得还|闲心|还[有挺]|一定|该|肯定|应该|比|本来|果然|挺|显得|这么|那么/u.test(before)
    || ((!before.trim() || /^(?:蛮|很|好|应该是|这是|有点)$/u.test(before)) && /[嘛吧]|是不是|呢[?？]/u.test(part));
}

function shiftDay(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

function period(text, at, zone) {
  const label = text.match(temporal)?.[0] ?? '';
  const local = Number.isSafeInteger(at) && at > 0 && at < 253402300799999 ? localTimeContext(at, zone) : null;
  const day = local && shiftDay(local.localDate, /昨/u.test(label) ? -1 : 0);
  let part = /晚|夜/u.test(label) ? 'night' : /早|上午/u.test(label) ? 'morning' : /下午|中午/u.test(label) ? 'afternoon' : '';
  if (!label && local) part = ['evening', 'late-night'].includes(local.daypart) ? 'night' : local.daypart;
  return { day, part, label };
}

function ownReports(messages, memory) {
  const notes = [...(memory?.notes ?? []), ...(memory?.moments ?? []).map(moment => moment.evidence)];
  const entries = notes.filter(text => typeof text === 'string').map(text => ({ role: 'user', text }));
  entries.push(...messages);
  const reports = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.role !== 'user') continue;
    let text = entry.text;
    if (/^(?:是的|对的|没错|对(?:呀|啊)?|是呀)(?:[，,]\s*(?:就是|确实是)(?:这种|那个)?感[觉受])?[。.!！\s]*$/u.test(text)
      && entries[i - 1]?.role === 'assistant') {
      const previous = entries[i - 1].text;
      const items = feelings(previous);
      if (items.length === 1 && userAttribution(previous, items[0].index) && !/还是|或者/u.test(previous)) {
        reports.push({ text: previous, ...items[0], at: entry.at, i, confirmed: true });
      }
      continue;
    }
    text = text.replace(quotes, ' ');
    for (const sentence of text.match(/[^。！？!?\n；;]+[。！？!?；;]?/gu) ?? []) {
      if (/比如|假如|假设|如果|要是|虚构|台词|小说|角色扮演|[?？]|(?:吗|么|嘛)[。！!]*$|是不是|有没有|难道|你猜/u.test(sentence)) continue;
      for (const clause of sentence.split(/[，,](?=\s*(?:但|不过|其实|实际上|我自己|我是|我并|我没有|我不))/u)) {
        if (!isOwnerMemoryStatement(clause) || /(?:说|猜|以为|觉得|误会|认为)我|你说|不代表|谁说|听说|据说/u.test(clause)) continue;
        for (const item of statedFeelings(clause)) {
          const { part, speaker } = subject(clause, item.index);
          if (speaker === '我' || (!speaker && /^(?:(?:昨晚|昨天|今天|当时|现在|这会儿|刚才|真的|其实|有点|有些|特别|很|挺|好|太|不|并没有|感觉|心里|真|玩得|心情))*$/u.test(part.trim()))) {
            reports.push({ ...item, text: clause, at: entry.at, i });
          }
        }
      }
    }
  }
  return { reports: reports.reverse(), latest: entries.length - 1 };
}

function applicable(report, sentence, context) {
  const { latest, input, moodInput, zone, at, asksMood, topic } = context;
  const target = period(temporal.test(sentence) ? sentence : moodInput, at, zone);
  const source = period(report.text, report.at, zone);
  if (/现在|这会儿|此刻|这下|总算|终于满意|满意了吧/u.test(sentence)) {
    const statedTime = report.text.slice(0, report.index).match(/现在|这会儿|此刻|如今|刚才|之前|以前|当时|那时候?|那会儿?|昨天|昨晚/gu)?.at(-1);
    if (statedTime && !/现在|这会儿|此刻|如今/u.test(statedTime)) return false;
    if (report.i < latest && !recall.test(sentence)) return false;
  }
  if (target.label && (target.day && source.day ? target.day !== source.day : source.label !== target.label)) return false;
  if (target.label && target.part && target.part !== source.part) return false;
  if (report.i === latest) return true;
  const event = overlaps(report.text, topic);
  if (!target.label && source.day && target.day && source.day !== target.day && !recall.test(sentence + input)) return false;
  if (event) return true;
  // A question about the immediately preceding exchange can say just “那会儿”.
  // An unrelated event in the new message cannot inherit an earlier feeling.
  return (asksMood || (recall.test(input) && question.test(input))) && !topic.size && (report.i >= latest - 2 || Boolean(target.label && source.day))
    || Boolean(target.label && target.day === source.day && /(?:今天|昨天|昨晚|现在)(?:我的?)?心情/u.test(report.text)
      && !topic.size);
}

function hasEvidence(claim, sentence, context) {
  const candidates = context.reports.filter(report => applicable(report, sentence, context));
  const newest = candidates.find(report => report.key === claim.key);
  if (!newest || newest.negative !== claim.negative) return false;
  if (candidates.some(report => report.i > newest.i && /其实|实际上|纠正|改口|说错|不是/u.test(report.text))) return false;
  return !comparison.test(sentence) || comparison.test(newest.text);
}

function attachedDuration(text, item) {
  const end = item.index + item.word.length;
  const after = afterFeeling.exec(text.slice(end));
  if (after) return { start: end, end: end + after[0].length, label: after[1] };
  const before = beforeFeeling.exec(text.slice(0, item.index));
  return before ? { start: before.index, end: item.index, label: before[1] } : null;
}

function trimUnsupportedDuration(chunk, claims, context) {
  let text = chunk;
  for (const claim of [...claims].reverse()) {
    const span = attachedDuration(chunk, claim);
    if (!span) continue;
    const report = context.reports.find(item => item.key === claim.key && item.negative === claim.negative && applicable(item, chunk, context));
    if (!report || attachedDuration(report.text, report)?.label === span.label) continue;
    const degree = report.text.slice(0, report.index).match(/(?:有一点|有些|有点|稍微)$/u)?.[0] ?? '';
    text = text.slice(0, span.start) + (span.end === claim.index ? degree : '') + text.slice(span.end);
    if (span.start >= claim.index && degree && !/(?:有一点|有些|有点|稍微|很|挺|太|特别)$/u.test(chunk.slice(0, claim.index))) {
      text = text.slice(0, claim.index) + degree + text.slice(claim.index);
    }
  }
  return text;
}

function disclosedThought(guess, messages) {
  const thought = guess[1].replace(/[的呢嘛呀啊吧]+$/u, '').trim();
  if (!thought) return false;
  for (const message of messages.slice().reverse()) {
    if (message.role !== 'user') continue;
    const clauses = message.text.replace(quotes, ' ').split(/[，,。！？!?；;\n]/u).reverse();
    for (const clause of clauses) {
      if (!clause.includes(thought)) continue;
      if (!isOwnerMemoryStatement(clause) || /没说|并非|不是|我不(?:是|觉得|想|认为)|我没|别以为|我没有/u.test(clause)) return false;
      if (/[?？]|是不是|有没有|如果|假如|比如/u.test(message.text)) continue;
      if (/我(?:自己|当时|现在|心里|那会儿|其实|确实|真的|本来|确实是|就是|也|是)*(?:在想|心想|觉得|以为|打算|希望|想要|想|为了)/u.test(clause)) return true;
    }
  }
  return false;
}

export function groundedReply(text, messages, { memoryContext, timeContext, fallback, proactive = false } = {}) {
  const last = messages.findLast(message => message.role === 'user');
  if ((!last && !proactive) || !text) return text;
  const input = proactive ? '' : last.text;
  const asksMood = /我|当时|那会儿|自己/u.test(input) && question.test(input)
    && (moodQuestion.test(input) || (recall.test(input) && feelings(input).length > 0))
    && !/你(?:自己|当时|昨晚|现在|的)?(?:怎么想|什么感[觉受]|心情|感[觉受])|我(?:的)?(?:同事|朋友|室友)[^。！？]{0,8}(?:心情|感[觉受])/u.test(input);
  if (!asksMood && !feelings(text).length && !thoughtGuess.test(text)) return text;
  const { reports, latest } = proactive ? { reports: [], latest: -1 } : ownReports(messages, memoryContext);
  // A mixed question may ask for a name *now* and a feeling *then*.
  const moodInput = (asksMood && input.split(/[。！？!?，,；;]/u).findLast(part => moodQuestion.test(part) || feelings(part).length)) || input;
  const topic = topicWords(input.replace(/(?:记得)?我(?:当时|昨晚)?(?:说过)?[^。！？,，]{0,4}(?:心情|感受|感觉)/gu, ' '));
  const context = { reports, latest, input, moodInput, topic, at: last?.at, zone: timeContext?.timeZone, asksMood };
  const unknownMood = asksMood && !reports.some(report => applicable(report, '', context));
  const ownTopics = new Set();
  if (unknownMood) {
    for (const message of messages) {
      if (message.role !== 'user') continue;
      for (const statement of message.text.match(/[^，,。！？!?\n]+[，,。！？!?]?/gu) ?? []) {
        if (/^[“「]|[?？]|是不是|有没有|记得|心情|什么|感觉怎样/u.test(statement) || !isOwnerMemoryStatement(statement)) continue;
        for (const term of topicWords(statement)) ownTopics.add(term);
      }
    }
  }
  let dropped = false;
  let hasOpenQuestion = false;
  const paragraphs = text.split(/\n\s*\n/u).map(paragraph => {
    const kept = [];
    for (const [unit] of paragraph.matchAll(/[^。！？!?；;\n]+[。！？!?；;]*|\n/gu)) {
      // Keep “you haven't said” as its own thought before a pivot into a guess.
      const chunks = unit.split(/(?<=[，,])(?=\s*(?:不过|但是|但看|但我猜|可我猜|我(?:猜|估计|敢说)你|你(?:当时|现在|心里)*(?:一定|肯定|多半)|(?:你)?(?:现在|这下|总算)?(?:该|挺|很)?(?:不)?满意))/u);
      for (const chunk of chunks) {
        const outside = chunk.replace(quotes, quote => ' '.repeat(quote.length));
        const claims = feelings(outside).filter(item => userAttribution(outside, item.index));
        const open = (openQuestion.test(outside) || /(?:要不要|愿不愿意|想不想|愿意|想跟我)[^，。！？]{0,8}(?:说说|讲讲|聊聊)/u.test(outside)) && question.test(outside);
        const guess = thoughtGuess.exec(chunk);
        const unsupported = claims.some(item => !hasEvidence(item, outside, context))
          || (guess && (proactive || !disclosedThought(guess, messages)));
        const speculative = unknownMood && !(admitsUnknown.test(outside) && !uncertain.test(outside)) && !open
          && (uncertain.test(outside) || /(?:你当时|你那会儿|那时你|当时应该|的状态|的心情|种感觉).*?(?:是|吧|嘛)/u.test(outside)
            || !overlaps(chunk, ownTopics));
        if (unsupported || speculative) { dropped = true; continue; }
        if (open) hasOpenQuestion = true;
        const revised = trimUnsupportedDuration(chunk, claims, context);
        if (revised !== chunk) dropped = true;
        kept.push(revised);
      }
    }
    return kept.join('').trim().replace(/[，,]+$/u, '。');
  }).filter(Boolean);
  if (!dropped && (!unknownMood || hasOpenQuestion)) return text;
  const result = paragraphs.join('\n\n');
  if (result && (!unknownMood || hasOpenQuestion)) return result;
  if (!result && fallback) return fallback();
  const when = recall.test(input) || /刚|取名|起名|当时/u.test(input) ? '那会儿' : '这会儿';
  const ask = thoughtGuess.test(text) && !asksMood ? `你${when}是怎么想的呀？` : `你${when}是什么感觉呀？`;
  return result ? `${result}\n\n${ask}` : ask;
}
