import { isPersonalityCue, personalityContext, personalityLabel, personalityTraits, reciprocalPersonalityCue, validatePersonalityObservation } from './personality.mjs';
import {
  extractSharedMemory, forgetSharedMemory, readSharedMemory, rememberSharedMemory, sharedMemoryLabels,
  sharedMemorySource, validateSharedMemoryDetails,
} from './shared-memory.mjs';

const MAX_NOTES = 48;
const MAX_NOTE_LENGTH = 160;
const NOTE_PAGE_SIZE = 8;
const CONTEXT_NOTE_LIMIT = 4;
const CONTEXT_NOTE_CHARS = 400;
const QUERY_CHAR_LIMIT = 512;
const MAX_NOTE_ID = 999_999_999;
const LEARN_AT = 3;
const MAX_SCORE = 6;
const CORRECTED_SCORE = -2;
const SAMPLE_EVERY = 5;
const SAMPLE_TIMEOUT = 4_000;

const habits = {
  brief: { label: '偏好简短的回复', cue: /简短|简洁|精简|短一点|说重点|言简意赅/u, negative: /(?:可以|希望|请|能不能)?说(?:得)?详细(?:一?点|一些)|想听(?:更)?完整的/u },
  gentle: { label: '偏好温柔的语气', cue: /温柔|柔和|温和|轻声/u },
  playful: { label: '偏好轻松幽默的语气', cue: /幽默|俏皮|轻松一点|好笑|逗趣|开玩笑/u, negative: /(?:别|不要|不用)(?:再|老)?开玩笑|(?:这个|这时候)不适合开玩笑/u },
  practical: { label: '偏好具体实用的建议', cue: /实用|具体建议|直接(?:给|说).*建议|具体步骤|可执行|解决办法/u, negative: /(?:先别|不用|不想听|不要).{0,4}(?:建议|解决办法)/u },
  listening: {
    label: '偏好先被倾听，想要时再听建议',
    direct: /^(?:我(?:今天|现在|暂时|这会儿)?\s*)?(?:只想(?:吐槽|说说|倾诉)|(?:请你|可以)?先听我说|(?:不用|先别|暂时不需要)(?:给我|给|提)?建议)/u,
    negative: /(?:别|不要|不用)(?:再)?(?:只|光)听/u,
  },
};

const action = /^(?:[/#]\s*)?(开启记忆|关闭记忆|清空记忆)[。！!]?$/u;
const viewAction = /^(?:[/#]\s*)?(查看(?:相处)?记忆)(?:[\s:：]+([\s\S]*?))?[。！!]?$/u;
const noteAction = /^(?:[/#]\s*)?(记住|忘记)(?:[\s:：，,]+([\s\S]*))?$/u;
const obviousPrivateData = /密码|口令|验证码|密钥|身份证|护照号|银行卡|信用卡|手机号|电话号码|家庭住址|详细地址|电子邮箱|邮箱地址|私人病历|医疗记录|确诊|患有|\b(?:password|passcode|api[ _-]*key|private[ _-]*key|access[ _-]*token|credit[ _-]*card|phone[ _-]*number|passport[ _-]*number)\b|https?:\/\/|\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b|[0-9]{8,}/iu;
const styleSubject = /回复|回答|说话|语气|表达|建议|步骤|说得|讲得|希望你|请你|喜欢你|偏好|给我/u;
const styleFeedback = /喜欢|偏好|希望|想要|可以|能不能|请|最好|继续|就这样|一点|一些|就好|为主/u;
const styleOpposition = /不喜欢|不想要|不必|不要|不用|^(?:请你|请|你|先)?\s*别|别(?:再|这么|那么|这样|太)|太(?:简短|简洁|温柔|温和|幽默|俏皮)/u;
const affectionOpposition = /(?:(?:别|不要|不用|不能|不可以|不喜欢|不想|没必要).{0,8}|不(?:再)?)(?:撒娇|亲昵|暧昧|贴贴|抱抱)/u;
const affectionApproval = /(?:希望|喜欢|可以|想听|想要|请你).{0,8}(?:撒娇|亲昵|贴贴|抱抱)/u;
const lookup = /^(?:请|帮我)?(?:查资料|查一下|查查|搜索|搜一下|搜搜|检索|search\b|look up\b)/iu;
const voicePrefix = /^(?:请|可以)?(?:用|发)?语音(?:回复|回答)?\s*[:：,，]?\s*/u;

function emptyMemory(enabled = false) {
  return { enabled, notes: [], scores: {} };
}

function safeNote(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_NOTE_LENGTH && !obviousPrivateData.test(text);
}

function readNotes(value, memory) {
  if (!Array.isArray(value.notes)) return;
  const notes = value.notes.slice(0, MAX_NOTES);
  const storedIds = Array.isArray(value.noteIds) ? Array.from(value.noteIds.slice(0, notes.length)) : [];
  const validIds = storedIds.length === notes.length && storedIds.every((id, i) => (
    Number.isSafeInteger(id) && id > (storedIds[i - 1] ?? 0) && id <= MAX_NOTE_ID
  ));
  const ids = [];
  for (const [index, note] of notes.entries()) {
    if (safeNote(note)) {
      memory.notes.push(note);
      ids.push(validIds ? storedIds[index] : index + 1);
    }
  }
  const previousId = validIds ? (storedIds.at(-1) ?? 0) : notes.length;
  const storedNextId = Number.isSafeInteger(value.nextNoteId) && value.nextNoteId <= MAX_NOTE_ID + 1 ? value.nextNoteId : 1;
  const nextNoteId = Math.max(previousId + 1, storedNextId);
  if (nextNoteId > 1) {
    memory.noteIds = ids;
    memory.nextNoteId = nextNoteId;
  }
}

function readPersonality(value) {
  const scores = {};
  for (const [context, traits] of Object.entries(personalityTraits)) {
    for (const trait of traits) {
      const score = value?.scores?.[context]?.[trait];
      if (Number.isInteger(score) && score !== 0) {
        (scores[context] ??= {})[trait] = Math.max(CORRECTED_SCORE, Math.min(score, MAX_SCORE));
      }
    }
  }
  const turns = Number.isInteger(value?.turns) ? Math.max(0, Math.min(value.turns, SAMPLE_EVERY - 1)) : 0;
  return { scores, turns };
}

function storePersonality(memory, profile) {
  if (profile.turns || Object.keys(profile.scores).length) memory.personality = profile;
  else delete memory.personality;
}

export function readMemory(value, { includeNotes = true } = {}) {
  const memory = emptyMemory(value?.enabled === true);
  if (!memory.enabled) return memory;
  if (includeNotes) {
    readNotes(value, memory);
    const shared = readSharedMemory(value.shared);
    if (shared) memory.shared = shared;
  }
  for (const key of Object.keys(habits)) {
    const score = value.scores?.[key];
    if (Number.isInteger(score) && score > 0) memory.scores[key] = Math.min(score, MAX_SCORE);
  }
  storePersonality(memory, readPersonality(value.personality));
  return memory;
}

function preferredTraits(memory) {
  return Object.entries(habits).filter(([key]) => memory.scores[key] >= LEARN_AT).map(([, habit]) => habit.label);
}

function preferredPersonality(memory) {
  return Object.entries(memory.personality?.scores ?? {}).flatMap(([context, traits]) => (
    Object.entries(traits).filter(([, score]) => score >= LEARN_AT).map(([trait, score]) => ({ context, trait, score }))
  )).sort((a, b) => b.score - a.score).slice(0, 8).map(({ context, trait }) => ({ context, trait }));
}

function replyFeedback(text) {
  const clauses = text.split(/[。！？；，、,.!?;\r\n]+/u);
  const found = {};
  for (const [key, { cue, direct, negative }] of Object.entries(habits)) {
    const feedback = cue ? clauses.filter((clause) => cue.test(clause) && styleSubject.test(clause)) : [];
    if (feedback.some((clause) => styleOpposition.test(clause)) || (negative && clauses.some((clause) => negative.test(clause)))) found[key] = -1;
    else if (feedback.some((clause) => styleFeedback.test(clause)) || (direct && clauses.some((clause) => direct.test(clause.trim())))) found[key] = 1;
  }
  return found;
}

export function observeMemory(value, text, { allowed, privateChat }) {
  const memory = readMemory(value);
  if (!allowed || !privateChat || !memory.enabled) return memory;

  // Learn from feedback about the reply itself. Ordinary conversation never becomes a note.
  const profile = readPersonality(memory.personality);
  if (affectionOpposition.test(text)) {
    for (const trait of personalityTraits.affection) (profile.scores.affection ??= {})[trait] = CORRECTED_SCORE;
  }
  for (const [trait, direction] of Object.entries(replyFeedback(text))) {
    if (direction > 0) memory.scores[trait] = Math.min(MAX_SCORE, (memory.scores[trait] ?? 0) + 1);
    else {
      delete memory.scores[trait];
      for (const [context, traits] of Object.entries(personalityTraits)) {
        if (traits.includes(trait)) (profile.scores[context] ??= {})[trait] = CORRECTED_SCORE;
      }
    }
  }
  storePersonality(memory, profile);
  return memory;
}

function recentPairs(messages) {
  const pairs = [];
  let previous;
  for (const message of Array.isArray(messages) ? messages.slice(-20) : []) {
    if (message?.role === 'user') {
      const text = typeof message.text === 'string' ? message.text.trim().replace(voicePrefix, '') : '';
      previous = !message.kind && text && !lookup.test(text) ? text : undefined;
    } else if (message?.role === 'assistant' && message.kind !== 'greeting') {
      if (previous && !message.kind && !message.sources?.length && typeof message.text === 'string' && message.text.trim()) {
        pairs.push([{ role: 'user', text: previous }, { role: 'assistant', text: message.text.trim() }]);
      }
      previous = undefined;
    }
  }
  return pairs.slice(-(SAMPLE_EVERY - 1));
}

function textKey(text) {
  return text.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

async function analyzeConversation(providers, messages) {
  let timer;
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), SAMPLE_TIMEOUT); });
    const combined = typeof providers.learnConversation === 'function';
    const request = combined ? providers.learnConversation({ messages }) : providers.learnPersonality({ messages });
    const result = await Promise.race([request, timeout]);
    if (!combined) return { signals: validatePersonalityObservation(result), details: [] };
    if (!result || Object.keys(result).length !== 2 || !Object.hasOwn(result, 'signals') || !Object.hasOwn(result, 'details')) {
      return { signals: [], details: [] };
    }
    return {
      signals: validatePersonalityObservation({ signals: result.signals }),
      details: validateSharedMemoryDetails(result.details, messages),
    };
  } catch {
    return { signals: [], details: [] };
  } finally {
    clearTimeout(timer);
  }
}

function creditCues(profile, cues, credited = new Set()) {
  for (const { context, trait } of cues) {
    const cue = `${context}:${trait}`;
    if (credited.has(cue)) continue;
    credited.add(cue);
    const scores = profile.scores[context] ??= {};
    scores[trait] = Math.min(MAX_SCORE, (scores[trait] ?? 0) + 1);
    if (scores[trait] === 0) delete scores[trait];
    if (!Object.keys(scores).length) delete profile.scores[context];
  }
  return credited;
}

export function startMemoryLearning(value, { text, messages, providers, allowed, privateChat, at = Date.now() }) {
  const memory = readMemory(value);
  const unchanged = () => ({ memory, completion: null });
  if (!allowed || !privateChat || !memory.enabled || typeof text !== 'string' || obviousPrivateData.test(text) || lookup.test(text)) return unchanged();
  const current = text.trim();
  for (const detail of extractSharedMemory(current)) rememberSharedMemory(memory, detail, current, at, true);
  const key = textKey(current);
  if (key.length < 4 || affectionOpposition.test(current)) return unchanged();
  const pairs = recentPairs(messages);
  if (pairs.some(([user]) => textKey(user.text) === key)) return unchanged();

  const profile = readPersonality(memory.personality);
  const last = pairs.at(-1);
  const feedback = replyFeedback(current);
  const traits = Object.keys(feedback);
  const cues = [];
  let sample;
  let recent;
  if (traits.length || affectionApproval.test(current)) {
    const context = personalityContext(current) ?? personalityContext(last?.[0].text ?? '');
    for (const trait of traits) {
      if (feedback[trait] > 0 && isPersonalityCue({ context, trait })) cues.push({ context, trait });
    }
    if (affectionApproval.test(current)) cues.push({ context: 'affection', trait: /抱抱/u.test(current) ? 'gentle' : 'playful' });
  } else {
    const local = last && reciprocalPersonalityCue(last[0].text, last[1].text, current);
    if (local) cues.push(local);
    if (providers?.modelConfigured !== false && (typeof providers?.learnConversation === 'function' || typeof providers?.learnPersonality === 'function')) {
      profile.turns = (profile.turns + 1) % SAMPLE_EVERY;
      if (profile.turns === 0 && pairs.length === SAMPLE_EVERY - 1) {
        recent = [...pairs.flat(), { role: 'user', text: current }];
        if (!recent.some(message => obviousPrivateData.test(message.text))) {
          sample = recent.map(message => ({ ...message, text: message.text.slice(0, 360) }));
        }
      }
    }
  }

  const credited = creditCues(profile, cues);
  storePersonality(memory, profile);
  if (!sample) return unchanged();

  let pending;
  const completion = () => pending ??= (async () => {
    const { signals, details } = await analyzeConversation(providers, sample);
    if (!signals.length && !details.length) return memory;
    const learned = readMemory(memory);
    const learnedProfile = readPersonality(learned.personality);
    const affectionEvidence = pairs.filter(([user, assistant], index) => reciprocalPersonalityCue(
      user.text, assistant.text, pairs[index + 1]?.[0].text ?? current,
    )?.context === 'affection').length;
    creditCues(learnedProfile, signals.filter(cue => cue.context !== 'affection' || affectionEvidence >= 2), credited);
    storePersonality(learned, learnedProfile);
    for (const detail of details) {
      const source = sharedMemorySource(detail, sample);
      const fullSource = recent[sample.lastIndexOf(source)];
      if (fullSource && sharedMemorySource(detail, [fullSource])) rememberSharedMemory(learned, detail, fullSource.text, at);
    }
    return learned;
  })();
  return { memory, completion };
}

export async function evolvePersonality(value, options) {
  const { memory, completion } = startMemoryLearning(value, options);
  return completion ? completion() : memory;
}

const commonTerms = new Set([
  '你好', '谢谢', '什么', '怎么', '一下', '可以', '想要', '喜欢', '我喜', '我想', '我在', '我们', '今天', '昨天', '明天',
  '请问', '关于', '知道', '记得', '有没', '没有', '随便', '聊聊', '以后', '一起', '咱们', '每周',
  'the', 'and', 'you', 'your', 'was', 'were', 'are', 'with', 'about', 'for', 'can', 'could', 'would', 'what', 'which', 'how', 'remember', 'like',
]);

function memoryTerms(text) {
  const terms = new Set();
  const input = text.normalize('NFKC').toLowerCase();
  for (const run of input.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = Array.from(run);
    for (let i = 1; i < characters.length; i++) {
      const term = characters[i - 1] + characters[i];
      if (!commonTerms.has(term)) terms.add(term);
    }
  }
  for (const term of input.match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (!commonTerms.has(term)) terms.add(term);
  }
  return terms;
}

function requestedMomentKind(query) {
  if (typeof query !== 'string') return null;
  if (/暗号|老梗|我们的梗|共同玩笑|\b(?:inside joke|code word)\b/iu.test(query)) return 'inside-joke';
  if (/老规矩|固定习惯|相处习惯|\bour (?:ritual|routine)\b/iu.test(query)) return 'ritual';
  if (/约好|约定|共同计划|\b(?:what we agreed|our plans?)\b/iu.test(query)) return 'shared-plan';
  return null;
}

// These words identify a category, rather than the particular memory being asked about.
const recallScaffolding = /(?:还记得|你记得|记不记得|之前的?|以前的?|我们的|咱们的|我们的梗|那个|那件事|请问|告诉我|是什么|是啥|我们|咱们|一起|下次|暗号|老梗|共同玩笑|老规矩|固定习惯|相处习惯|约好|约定|共同计划)|\b(?:inside joke|code word|our (?:ritual|routine|plans?)|what we agreed|again|please|tell me)\b/giu;

function recallDetails(notes, moments, terms, kindHint) {
  let ranked;
  if (terms === undefined) {
    ranked = notes.slice(-CONTEXT_NOTE_LIMIT).reverse().map(evidence => ({ evidence }));
  } else {
    const rows = [...notes.map((evidence, index) => ({ evidence, index })), ...moments.map(moment => ({ ...moment, index: moment.id }))];
    const candidates = rows.flatMap(row => {
      let score = 0;
      for (const term of memoryTerms(row.evidence)) if (terms.has(term)) score++;
      const hinted = kindHint !== null && row.kind === kindHint;
      return score || hinted ? [{ ...row, score, hinted }] : [];
    });
    candidates.sort((a, b) => b.score - a.score || Number(b.hinted) - Number(a.hinted)
      || Number(Boolean(a.kind)) - Number(Boolean(b.kind)) || (b.at ?? 0) - (a.at ?? 0) || b.index - a.index);
    ranked = candidates;
  }
  const selected = { notes: [], moments: [] };
  const seen = new Set();
  let remaining = CONTEXT_NOTE_CHARS;
  for (const { evidence, kind } of ranked) {
    const key = textKey(evidence);
    if (evidence.length > remaining || seen.has(key)) continue;
    seen.add(key);
    if (kind) selected.moments.push({ kind, evidence });
    else selected.notes.push(evidence);
    remaining -= evidence.length;
    if (seen.size === CONTEXT_NOTE_LIMIT) break;
  }
  return selected;
}

export function memoryContextFor(value, { allowed, privateChat, query, includeNotes = true }) {
  if (!allowed || !privateChat || value?.enabled !== true) return undefined;
  const boundedQuery = typeof query === 'string' ? query.slice(0, QUERY_CHAR_LIMIT) : '';
  const kindHint = includeNotes ? requestedMomentKind(boundedQuery) : null;
  const topic = kindHint ? boundedQuery.replace(recallScaffolding, ' ') : boundedQuery;
  const terms = includeNotes && query !== undefined ? memoryTerms(topic) : undefined;
  const fallbackKind = kindHint && terms?.size === 0 ? kindHint : null;
  const loadNotes = includeNotes && (terms === undefined || terms.size > 0 || fallbackKind !== null);
  const memory = readMemory(value, { includeNotes: loadNotes });
  const traits = preferredTraits(memory);
  const personality = preferredPersonality(memory);
  const { notes, moments } = loadNotes ? recallDetails(memory.notes, memory.shared?.moments ?? [], terms, fallbackKind) : { notes: [], moments: [] };
  return traits.length || notes.length || personality.length || moments.length
    ? { traits, notes, ...(personality.length ? { personality } : {}), ...(moments.length ? { moments } : {}) }
    : undefined;
}

export function handleMemoryCommand(value, text, { allowed, privateChat }) {
  const match = action.exec(text) ?? viewAction.exec(text) ?? noteAction.exec(text);
  if (!match) return null;

  const memory = readMemory(value);
  const result = (message, { next = memory, clearHistory = false } = {}) => ({ text: message, memory: next, clearHistory });
  if (!privateChat) return result('个人记忆只在 QQ 私聊里可用。');

  const [, command, argument] = match;
  if (command === '关闭记忆') return result('长期记忆已关闭，记住的内容、回复习惯和之前的对话上下文都已清除。', { next: emptyMemory(), clearHistory: true });
  if (command === '清空记忆') return result('记住的内容、回复习惯和之前的对话上下文都已清空。', { next: emptyMemory(memory.enabled), clearHistory: true });
  if (command === '开启记忆') {
    if (!allowed) return result('管理员已暂停长期记忆。恢复后，可以再发「开启记忆」。');
    if (memory.enabled) return result('长期记忆已经开启。发「查看记忆」可以看看我记住了什么。');
    return result('长期记忆已开启。以后照常聊就好，我会慢慢记下我们的约定、梗和习惯。发「查看相处记忆」可查看，也可以随时清空或关闭。特别想留住的内容，仍可以发「记住 内容」。', { next: emptyMemory(true) });
  }
  if (!memory.enabled) return result('长期记忆还没开启。你可以发「开启记忆」来启用。');

  if (command === '查看记忆' || command === '查看相处记忆') {
    const viewingMoments = command === '查看相处记忆';
    const moments = memory.shared?.moments ?? [];
    const entries = viewingMoments ? moments : memory.notes;
    const pages = Math.max(1, Math.ceil(entries.length / NOTE_PAGE_SIZE));
    const rawPage = argument?.trim();
    const page = rawPage ? (/^[1-9]\d*$/.test(rawPage) ? Number(rawPage) : 0) : 1;
    if (!Number.isInteger(page) || page < 1 || page > pages) {
      return result(`页码无效。当前共 ${pages} 页，请发「${command} 1」开始查看。`);
    }
    const start = (page - 1) * NOTE_PAGE_SIZE;
    const traits = viewingMoments ? [] : [...preferredTraits(memory), ...preferredPersonality(memory).map(personalityLabel)];
    const notes = viewingMoments
      ? moments.slice(start, start + NOTE_PAGE_SIZE).map(moment => `小事${moment.id} · ${sharedMemoryLabels[moment.kind]}：${moment.evidence}`)
      : memory.notes.slice(start, start + NOTE_PAGE_SIZE).map((note, index) => `${memory.noteIds[start + index]}. ${note}`);
    return result([
      allowed ? '长期记忆已开启。' : '长期记忆已暂停，目前不会用这些内容生成回复。',
      ...(notes.length ? [`${viewingMoments ? '相处记忆' : '手动记忆'} 第 ${page}/${pages} 页，共 ${entries.length} 条。`] : []),
      ...notes,
      ...(traits.length ? [`回复习惯：${traits.join('、')}`] : []),
      ...(!notes.length && !traits.length ? [viewingMoments ? '还没有相处记忆。' : '还没有记住的内容。'] : []),
      ...(page < pages ? [`发「${command} ${page + 1}」看下一页。`] : []),
      ...(notes.length ? [`发「忘记 ${viewingMoments ? `小事${moments[start].id}` : memory.noteIds[start]}」可删除对应编号的记忆。`] : []),
      ...(!viewingMoments ? [`发「查看相处记忆」看自动记下的小事${moments.length ? `（${moments.length} 条）` : ''}。`] : []),
    ].join('\n'));
  }
  if (command === '忘记') {
    const input = argument?.trim() ?? '';
    const moment = /^小事\s*([1-9]\d{0,8})$/.exec(input);
    if (moment) {
      return result(forgetSharedMemory(memory, Number(moment[1])) ? '这条相处记忆已删除。' : '没有找到这条相处记忆。请发「查看相处记忆」核对编号。');
    }
    const index = /^[1-9]\d{0,8}$/.test(input) ? (memory.noteIds?.indexOf(Number(input)) ?? -1) : -1;
    if (index < 0) return result('请先发「查看记忆」，再发「忘记 编号」，例如「忘记 1」。');
    memory.notes.splice(index, 1);
    memory.noteIds.splice(index, 1);
    return result('这条长期记忆已删除。');
  }

  if (!allowed) return result('长期记忆已暂停，暂时不能新增记忆。');
  const note = argument?.replace(/\s+/gu, ' ').trim() ?? '';
  if (!safeNote(note)) return result('请发「记住 内容」，例如「记住 我喜欢在雨天听钢琴」。内容最多 160 字，请别把密码、联系方式等隐私写进记忆。');
  if (memory.notes.includes(note)) return result('这条我已经记住了。');
  if (memory.notes.length >= MAX_NOTES) return result(`已经记了 ${MAX_NOTES} 条。可以发「查看记忆」，先删除一条再新增。`);
  const id = memory.nextNoteId ?? 1;
  if (id > MAX_NOTE_ID) return result('记忆编号已用完。可以先保存需要的内容，再发「清空记忆」重置编号。');
  memory.notes.push(note);
  (memory.noteIds ??= []).push(id);
  memory.nextNoteId = id + 1;
  return result('这条我记住了。');
}
