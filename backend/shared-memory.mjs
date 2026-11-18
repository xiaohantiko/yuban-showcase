import { createHash } from 'node:crypto';

export const sharedMemoryKinds = Object.freeze(['inside-joke', 'ritual', 'shared-plan', 'milestone', 'preference']);
export const sharedMemoryLabels = Object.freeze({
  'inside-joke': '共同玩笑', ritual: '相处习惯', 'shared-plan': '共同约定', milestone: '重要小事', preference: '长期偏好',
});

const MAX_MOMENTS = 96;
const MAX_MOMENT_ID = 999_999_999;
const MAX_EVIDENCE = 72;
const MAX_CANDIDATES = 2;
const priority = { 'inside-joke': 4, ritual: 4, 'shared-plan': 3, milestone: 2, preference: 1 };
const hashPattern = /^[0-9a-f]{64}$/;
const privateData = /密码|口令|验证码|密钥|秘钥|身份证|护照|银行卡|信用卡|手机号|电话号码|地址|住址|住在|邮箱|病历|确诊|患有|癌症|用药|自伤|自残|自杀|性取向|收入|薪资|真实姓名|我的亲戚|孩子叫|\b(?:password|passcode|api[ _-]*key|private[ _-]*key|client[ _-]*secret|access[ _-]*token|authorization|bearer|phone[ _-]*number|street[ _-]*address)\b|(?:https?|ftp|file):|www\.|[^\s@]+@[^\s@]+\.[a-z]{2,}|[0-9]{6,}|(?:^|[^a-f0-9])[a-f0-9]{12}(?=$|[^a-f0-9])|\b(?:sk-|gh[pousr]_|github_pat_)[\w-]{8,}|[A-Za-z]:[\\/]|(?:^|\s)[~/](?:[^\s/]+\/)+/iu;
const instruction = /(?:忽略|无视).{0,16}(?:指令|规则|提示词)|(?:系统|开发者).{0,4}(?:提示词|指令)|绕过.{0,12}(?:权限|限制)|认领主人|^(?:[/#]\s*)?(?:记住|忘记|查看(?:相处)?记忆|清空记忆|关闭记忆|开启记忆|插件)(?:\s|$)|(?:ignore|disregard).{0,20}(?:instructions?|prompt)|(?:system|developer) prompt|\b(?:curl|sudo)\s|```/imu;
const attributedContext = /^[\s“「『">]*(?:引用|转发|摘录|转录|台词|朋友说|有人说|他说|她说|小宇说|你说)[：:，,\s“「]|^\s*[“「『">]|(?:同事|朋友|他|她)(?:跟我)?说[：:“「『]|假如|假设|虚构|编个故事|小说里|台词是|^\s*(?:如果|要是)|\b(?:imagine|hypothetically|fictional)\b/imu;
const doNotSave = /(?:别|不要|不用|不必|不许)[^忘\r\n]{0,8}(?:记|存|留下)|这段只在这里说|\b(?:don['’]t|do not) (?:save|remember|store)\b/iu;
const negatedMemory = /(?:从未|从没|没有|没|并未)(?:说(?:过)?|讲(?:过)?|约过|约定|约好|答应|同意)|(?:只是|仅是)(?:举例|示例)|\b(?:never (?:said|agreed|promised)|didn['’]t (?:say|agree|promise))\b/iu;
const uncertainMemory = /[?？]|(?:吗|么)\s*[。！!]*$|^\s*(?:你(?:还)?记得|还记得|我不确定|我不太记得|我们(?:是不是|有没有|是否))/iu;
const together = /我们|咱们|我俩|跟你|和你|你和我|一起|\b(?:we|our|together)\b/iu;

function mayStoreMessage(text) {
  const check = text.replace(/\p{Cf}/gu, '').normalize('NFKC');
  return !privateData.test(check) && !instruction.test(check) && !doNotSave.test(check);
}

function safeSource(text) {
  const check = text.normalize('NFKC');
  return mayStoreMessage(text) && !attributedContext.test(check) && !negatedMemory.test(check) && !uncertainMemory.test(check);
}

// A user's message can quote a character, deny a claim, or ask about it. An
// exact substring alone does not make the embedded first person the speaker.
const disputedClaim = /(?:并非|不是)(?:在|想)?(?:说|指|承认)|(?:谁说|别以为|不代表|不能说明)|(?:以为|猜测|猜想|误会|猜)(?:过|想|的)?(?:我|我们|自己)|(?:我|我们)(?:到底|究竟)?(?:是不是|是否|有没有)|\b(?:not saying|did not mean|thought (?:that )?I|guessed (?:that )?I|whether I)\b/iu;
const reportedClaim = /(?:说(?:过|道)?|写道|讲过|表示|提到(?:过)?|告诉我|问我)\s*[：:，,]?\s*(?=[“「『"]|(?:其实|原来|当时|昨晚)?(?:我|自己|咱们))/gu;
const selfAsSpeaker = /(?:^|[。！？!?,，；;])\s*(?:其实|之前|以前|刚才|昨天|昨晚|当时|那天|上次)*我(?:自己|之前|曾经|早就|一直|刚才|昨天|昨晚|当时|那天|上次|跟你|对你|和你|也|刚|就)*$/u;
const otherAsSubject = /(?:^|[。！？!?,，；;])\s*(?:我的?|我们(?:的)?)?(?:朋友|同事|同学|室友|同桌|家人|邻居|[他她]们?)(?:自己|其实|一直|最|更|特别|平时|终于|刚刚|昨天|昨晚|今天|很|非常|也|刚|才)*(?:喜欢|偏爱|习惯|考上|毕业|被录取|拿到|完成|跑完|难过|伤心|开心)|\b(?:he|she|they|my (?:friend|colleague|roommate))\s+(?:said|says|wrote|asked|told|prefers?|likes?|loves?)\b/iu;
const characterVoice = /(?:故事|小说|剧本|游戏|设定|台词|角色扮演)(?:中|里|中的|里的|设定中|设定里)(?:的)?(?:我|我们|自己)|(?:随口|临时|瞎|胡乱)编的/iu;
const quoteLiteral = /“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"]*(?:"|$)/gu;
const outsideQuotes = text => text.replace(quoteLiteral, '〔〕');

export function isOwnerMemoryStatement(text) {
  if (disputedClaim.test(text) || otherAsSubject.test(text) || characterVoice.test(text)) return false;
  const outside = outsideQuotes(text);
  if (outside !== text && !kindsIn(outside).length && [...text.matchAll(quoteLiteral)].some(([quote]) => /我|咱|\b(?:I|we|my|our)\b/iu.test(quote))) return false;
  for (const report of text.matchAll(reportedClaim)) {
    if (!selfAsSpeaker.test(text.slice(0, report.index))) return false;
  }
  return true;
}

// Keep quoted sentences together. A later affirmative correction in the
// speaker's own voice can still be learned from the same message.
function statements(text) {
  const closers = { '“': '”', '「': '」', '『': '』', '"': '"' };
  const quotes = [];
  const parts = [];
  let start = 0;
  for (const token of text.matchAll(/[“”「」『』"。！？!?\r\n；;]|[，,](?=\s*(?:(?:但(?:是)?|不过|实际上)(?:我|对我来说)|我(?:自己|本人)(?:更|最|偏爱|喜欢)))/gu)) {
    const mark = token[0];
    if (quotes.length && mark === quotes.at(-1)) {
      quotes.pop();
      const end = token.index + mark.length;
      if (!quotes.length && /^\s*(?:我自己|我本人|但我|不过我)/u.test(text.slice(end))) {
        parts.push(text.slice(start, end));
        start = end;
      }
    }
    else if (Object.hasOwn(closers, mark)) quotes.push(closers[mark]);
    else if (!quotes.length && !['”', '」', '』'].includes(mark)) {
      parts.push(text.slice(start, token.index + (/[?？]/u.test(mark) ? 1 : 0)));
      start = token.index + mark.length;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function ownerStatements(text) {
  const clearContext = safeSource(text);
  return statements(text).filter(part => (clearContext || /^\s*(?:我自己|我本人|但(?:是)?我|不过我)/u.test(part))
    && safeSource(part) && isOwnerMemoryStatement(part));
}

function kindsIn(text) {
  const shared = together.test(text);
  const kinds = [];
  if (/(?:以后|今后|从今|咱们|我们).{0,18}(?:把.{1,18}(?:叫|称作)|就叫|简称|暗号|老梗|梗是)|\bour\b.{0,24}\b(?:inside joke|nickname|code word)\b/iu.test(text)) kinds.push('inside-joke');
  if (shared && /每周|每天|每晚|每月|每次|固定|老规矩|惯例|\bevery\s+(?:day|week|night|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.test(text)) kinds.push('ritual');
  if (shared && /约好|约定|下次|改天|下周|下个月|到时候|以后|一起计划|\b(?:next time|we agreed|we planned)\b/iu.test(text)) kinds.push('shared-plan');
  if (/(?:我|我们|咱们)(?:终于|第一次|刚刚)?.{0,10}(?:考上|被录取|毕业了|毕业啦|通过了考试|跑完了|出版了|发布了.{0,5}(?:作品|项目)|完成了.{0,10}(?:项目|作品|比赛)|拿到.{0,8}(?:奖|证书))|\bi (?:finally |just )?(?:graduated|finished my first|won my first|published my first)\b/iu.test(text)) kinds.push('milestone');
  if (/我(?:自己|本人)?(?:一直|平时|通常|特别|更|最|一向)(?:喜欢|爱|偏爱|习惯)|我(?:自己|本人)?偏爱|我的最爱|\bi (?:always|usually|really) (?:prefer|enjoy|like)\b|\bmy favou?rite\b/iu.test(text)) kinds.push('preference');
  return kinds;
}

export function isSharedMemoryEvidence(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= MAX_EVIDENCE
    && value === value.trim() && /\p{L}/u.test(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && safeSource(value);
}

function validStoredDetail(detail) {
  return Boolean(detail && typeof detail === 'object' && !Array.isArray(detail) && Object.keys(detail).length === 2
    && Object.hasOwn(detail, 'kind') && Object.hasOwn(detail, 'evidence')
    && sharedMemoryKinds.includes(detail.kind) && isSharedMemoryEvidence(detail.evidence));
}

export function isSharedMemoryDetail(detail) {
  return validStoredDetail(detail) && isOwnerMemoryStatement(detail.evidence);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function evidenceKey(text) {
  return normalized(text).replace(/^(?:以后|今后|从今以后|从今)?(?:我们|咱们|我俩)?(?:就)?(?:把)?/u, '').replace(/[吧呀啦呢。]+$/u, '');
}

export function sharedMemorySource(detail, messages) {
  return messages.findLast(message => message?.role === 'user' && typeof message.text === 'string'
    && authorizesExcerpt(message.text, detail.evidence));
}

function authorizesExcerpt(source, evidence) {
  if (!source.includes(evidence) || !mayStoreMessage(source)) return false;
  const content = evidence.replace(/[。；;！!]+$/u, '');
  return ownerStatements(source).some(part => part.includes(content) && outsideQuotes(part).includes(outsideQuotes(content)));
}

export function validateSharedMemoryDetails(details, messages) {
  if (!Array.isArray(details) || details.length > MAX_CANDIDATES || !Array.isArray(messages)) return [];
  const seen = new Set();
  return details.filter(detail => {
    if (!isSharedMemoryDetail(detail) || !sharedMemorySource(detail, messages)) return false;
    const key = evidenceKey(detail.evidence);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Require the same named activity and an explicitly retired nickname before replacing a memory.
function sharedAlias(text) {
  return /(?:我们|咱们|我俩)(?:就)?把([^，。！？,!?；;]{1,24}?)(?:称作|叫作|叫做|叫)([^，。！？,!?；;]{1,20})/u.exec(text);
}

function explicitAliasCorrection(text) {
  const alias = sharedAlias(text);
  if (!alias) return null;
  const retired = /^[，,]\s*([^，。！？,!?；;]{1,20}?)(?:这个(?:说法|名字|叫法|暗号))?(?:作废|不用了|不再用)/u.exec(text.slice(alias.index + alias[0].length));
  if (!retired || evidenceKey(alias[2]) === evidenceKey(retired[1])) return null;
  return { subject: normalized(alias[1]), retired: evidenceKey(retired[1]), evidence: alias[0] };
}

export function extractSharedMemory(text) {
  if (typeof text !== 'string' || !mayStoreMessage(text)) return [];
  const candidates = [];
  const parts = ownerStatements(text.slice(0, 512));
  // A clipped suffix cannot authorize evidence, even after attribution filtering.
  if (text.length > 512 && parts.length && text.slice(0, 512).endsWith(parts.at(-1))) parts.pop();
  for (const part of parts) {
    const evidence = part.trim();
    if (!isSharedMemoryEvidence(evidence)) continue;
    const [kind] = kindsIn(outsideQuotes(evidence));
    if (kind) candidates.push({ kind, evidence: kind === 'inside-joke' ? explicitAliasCorrection(evidence)?.evidence ?? evidence : evidence });
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return candidates;
}

export function readSharedMemory(value) {
  const moments = [];
  const forgotten = [];
  let previous = 0;
  for (const moment of Array.isArray(value?.moments) ? value.moments.slice(0, MAX_MOMENTS) : []) {
    if (!moment || !Number.isInteger(moment.id) || moment.id <= previous || moment.id > MAX_MOMENT_ID
      || !validStoredDetail({ kind: moment.kind, evidence: moment.evidence })) continue;
    previous = moment.id;
    moments.push({
      id: moment.id, kind: moment.kind, evidence: moment.evidence,
      count: Number.isInteger(moment.count) ? Math.max(1, Math.min(8, moment.count)) : 1,
      at: Number.isSafeInteger(moment.at) ? moment.at : 0,
      source: typeof moment.source === 'string' && hashPattern.test(moment.source) ? moment.source : null,
      lastSource: typeof moment.lastSource === 'string' && hashPattern.test(moment.lastSource) ? moment.lastSource : null,
    });
  }
  for (const item of Array.isArray(value?.forgotten) ? value.forgotten.slice(-MAX_MOMENTS) : []) {
    if (!item || typeof item.key !== 'string' || !hashPattern.test(item.key)) continue;
    forgotten.push({
      key: item.key,
      source: typeof item.source === 'string' && hashPattern.test(item.source) ? item.source : null,
      lastSource: typeof item.lastSource === 'string' && hashPattern.test(item.lastSource) ? item.lastSource : null,
    });
  }
  const storedNextId = Number.isSafeInteger(value?.nextId) && value.nextId <= MAX_MOMENT_ID + 1 ? value.nextId : 1;
  const nextId = Math.max(previous + 1, storedNextId);
  return nextId > 1 || forgotten.length ? { moments, forgotten, nextId } : undefined;
}

function retentionScore(moment) {
  return priority[moment.kind] + Math.min(2, moment.count - 1);
}

export function rememberSharedMemory(memory, detail, sourceText, at, renew = false) {
  if (!isSharedMemoryDetail(detail) || typeof sourceText !== 'string' || !authorizesExcerpt(sourceText, detail.evidence)) return;
  const key = evidenceKey(detail.evidence);
  if (!key) return;
  const source = digest(normalized(sourceText));
  const fingerprint = digest(key);
  const shared = memory.shared ?? { moments: [], forgotten: [], nextId: 1 };
  if (shared.forgotten.some(item => item.key === fingerprint || item.source === source || item.lastSource === source)) return;

  if (renew && detail.kind === 'inside-joke') {
    const correction = explicitAliasCorrection(sourceText);
    if (correction && correction.evidence === detail.evidence) {
      for (const moment of [...shared.moments]) {
        const alias = moment.kind === 'inside-joke' && sharedAlias(moment.evidence);
        if (alias && moment.at <= at && normalized(alias[1]) === correction.subject && evidenceKey(alias[2]) === correction.retired) {
          forgetSharedMemory(memory, moment.id);
        }
      }
    }
  }
  const existing = shared.moments.find(moment => {
    const oldKey = evidenceKey(moment.evidence);
    return oldKey === key || (moment.kind === detail.kind && Math.min(oldKey.length, key.length) >= 5
      && (oldKey.includes(key) || key.includes(oldKey)));
  });
  if (existing) {
    if (renew && at > existing.at) {
      existing.count = Math.min(8, existing.count + 1);
      existing.at = at;
      existing.lastSource = source;
    }
    return;
  }
  if (shared.nextId > MAX_MOMENT_ID) return;
  if (shared.moments.length >= MAX_MOMENTS) {
    const weakest = shared.moments.reduce((weakest, moment) => (
      retentionScore(moment) < retentionScore(weakest) || (retentionScore(moment) === retentionScore(weakest) && moment.at < weakest.at)
        ? moment : weakest
    ));
    if (priority[detail.kind] < retentionScore(weakest)) return;
    shared.moments.splice(shared.moments.indexOf(weakest), 1);
  }
  shared.moments.push({ id: shared.nextId++, ...detail, count: 1, at, source, lastSource: null });
  memory.shared = shared;
}

export function forgetSharedMemory(memory, id) {
  const shared = memory.shared;
  const index = shared?.moments.findIndex(moment => moment.id === id) ?? -1;
  if (index < 0) return false;
  const [moment] = shared.moments.splice(index, 1);
  shared.forgotten.push({ key: digest(evidenceKey(moment.evidence)), source: moment.source, lastSource: moment.lastSource });
  if (shared.forgotten.length > MAX_MOMENTS) shared.forgotten.shift();
  return true;
}
