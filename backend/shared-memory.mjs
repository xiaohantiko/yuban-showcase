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
const quotedOrInstruction = /(?:忽略|无视).{0,16}(?:指令|规则|提示词)|(?:系统|开发者).{0,4}(?:提示词|指令)|绕过.{0,12}(?:权限|限制)|认领主人|^(?:[/#]\s*)?(?:记住|忘记|查看(?:相处)?记忆|清空记忆|关闭记忆|开启记忆|插件)(?:\s|$)|(?:ignore|disregard).{0,20}(?:instructions?|prompt)|(?:system|developer) prompt|\b(?:curl|sudo)\s|```|^[\s“「『">]*(?:引用|转发|摘录|转录|台词|朋友说|有人说|他说|她说|小宇说|你说)[：:，,\s“「]|^\s*[“「『">]|(?:同事|朋友|他|她)(?:跟我)?说[：:“「『]|假如|假设|虚构|编个故事|小说里|台词是|^\s*(?:如果|要是)|\b(?:imagine|hypothetically|fictional)\b/imu;
const doNotSave = /(?:别|不要|不用|不必|不许)[^忘\r\n]{0,8}(?:记|存|留下)|这段只在这里说|\b(?:don['’]t|do not) (?:save|remember|store)\b/iu;
const negatedMemory = /(?:从未|从没|没有|没|并未)(?:说(?:过)?|讲(?:过)?|约过|约定|约好|答应|同意)|(?:只是|仅是)(?:举例|示例)|\b(?:never (?:said|agreed|promised)|didn['’]t (?:say|agree|promise))\b/iu;
const uncertainMemory = /[?？]|(?:吗|么)\s*[。！!]*$|^\s*(?:你(?:还)?记得|还记得|我不确定|我不太记得|我们(?:是不是|有没有|是否))/iu;
const together = /我们|咱们|我俩|跟你|和你|你和我|一起|\b(?:we|our|together)\b/iu;

function safeSource(text) {
  const check = text.replace(/\p{Cf}/gu, '').normalize('NFKC');
  return !privateData.test(check) && !quotedOrInstruction.test(check) && !doNotSave.test(check)
    && !negatedMemory.test(check) && !uncertainMemory.test(check);
}

function kindsIn(text) {
  const shared = together.test(text);
  const kinds = [];
  if (/(?:以后|今后|从今|咱们|我们).{0,18}(?:把.{1,18}(?:叫|称作)|就叫|简称|暗号|老梗|梗是)|\bour\b.{0,24}\b(?:inside joke|nickname|code word)\b/iu.test(text)) kinds.push('inside-joke');
  if (shared && /每周|每天|每晚|每月|每次|固定|老规矩|惯例|\bevery\s+(?:day|week|night|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.test(text)) kinds.push('ritual');
  if (shared && /约好|约定|下次|改天|下周|下个月|到时候|以后|一起计划|\b(?:next time|we agreed|we planned)\b/iu.test(text)) kinds.push('shared-plan');
  if (/(?:我|我们|咱们)(?:终于|第一次|刚刚)?.{0,10}(?:考上|被录取|毕业了|毕业啦|通过了考试|跑完了|出版了|发布了.{0,5}(?:作品|项目)|完成了.{0,10}(?:项目|作品|比赛)|拿到.{0,8}(?:奖|证书))|\bi (?:finally |just )?(?:graduated|finished my first|won my first|published my first)\b/iu.test(text)) kinds.push('milestone');
  if (/我(?:一直|平时|通常|特别|更|最|一向)(?:喜欢|爱|偏爱|习惯)|我偏爱|我的最爱|\bi (?:always|usually|really) (?:prefer|enjoy|like)\b|\bmy favou?rite\b/iu.test(text)) kinds.push('preference');
  return kinds;
}

export function isSharedMemoryEvidence(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= MAX_EVIDENCE
    && value === value.trim() && /\p{L}/u.test(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && safeSource(value);
}

export function isSharedMemoryDetail(detail) {
  return Boolean(detail && typeof detail === 'object' && !Array.isArray(detail) && Object.keys(detail).length === 2
    && Object.hasOwn(detail, 'kind') && Object.hasOwn(detail, 'evidence')
    && sharedMemoryKinds.includes(detail.kind) && isSharedMemoryEvidence(detail.evidence));
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
  return messages.findLast(message => message?.role === 'user' && typeof message.text === 'string' && message.text.includes(detail.evidence)
    && safeSource(message.text));
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

export function extractSharedMemory(text) {
  if (typeof text !== 'string' || !safeSource(text)) return [];
  const candidates = [];
  const parts = text.slice(0, 512).split(/[。！？!?\r\n]+/u);
  if (text.length > 512) parts.pop();
  for (const part of parts) {
    const evidence = part.trim();
    if (!isSharedMemoryEvidence(evidence)) continue;
    const [kind] = kindsIn(evidence);
    if (kind) candidates.push({ kind, evidence });
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
      || !isSharedMemoryDetail({ kind: moment.kind, evidence: moment.evidence })) continue;
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
  if (!isSharedMemoryDetail(detail) || typeof sourceText !== 'string' || !sourceText.includes(detail.evidence) || !safeSource(sourceText)) return;
  const key = evidenceKey(detail.evidence);
  if (!key) return;
  const source = digest(normalized(sourceText));
  const fingerprint = digest(key);
  const shared = memory.shared ?? { moments: [], forgotten: [], nextId: 1 };
  if (shared.forgotten.some(item => item.key === fingerprint || item.source === source || item.lastSource === source)) return;

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
