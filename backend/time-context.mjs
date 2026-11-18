const MINUTE = 60_000;
const ACTIVE_GAP = 20 * MINUTE;
const REMINDER_AFTER = 60 * MINUTE;
const formatters = new Map();
const working = /(?:^|[。！？\n])(?:我(?!朋友|同事|室友|家人)|今晚|今天|现在|这会儿?|还在|正在)[^。！？\n]{0,12}(?:夜班|值班|赶工|赶稿|赶作业|赶报告|赶方案|赶论文|赶项目|赶进度|赶截止|deadline|ddl)/iu;
const distress = /(?:我|今天|现在|这会儿?|真的|有点|好|很)[^。！？\n]{0,10}(?:难过|委屈|想哭|焦虑|恐慌|崩溃|难受|害怕|心烦|烦躁|不开心|不高兴|撑不住|受不了)|^(?:难过|想哭|委屈|焦虑|难受|害怕|心烦|烦躁|崩溃|撑不住|救命|着火了)|自杀|想死|不想活|伤害自己|不安全|有危险|叫救护车/u;
const stopReminder = /(?:别|不要|不用|不需要|不想)[^。！？\n]{0,12}(?:催|劝|提醒)(?:我)?[^。！？\n]{0,8}(?:睡|休息)|(?:别|不要|不用|不需要)[^。！？\n]{0,8}(?:催我|提醒我)|(?:今晚|今天)[^。！？\n]{0,6}(?:别催|别提醒)/u;
const permanent = /(?:以后|永远|从今以后|今后)[^。！？\n]{0,8}(?:别|不要|不用|不需要|不想)[^。！？\n]{0,12}(?:催|劝|提醒)|再也(?:别|不要)[^。！？\n]{0,12}(?:催|劝|提醒)/u;
const allowReminder = /(?:可以|允许|愿意让|希望|需要)[^。！？\n]{0,8}(?:你)?(?:再)?(?:提醒|劝)(?:我)?[^。！？\n]{0,6}(?:睡|休息)|(?:恢复|开启)(?:睡觉|休息)?提醒/u;

export function validTimeZone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\/-]{0,79}$/u.test(value)) return false;
  if (formatters.has(value)) return true;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function formatter(timeZone) {
  let zone = typeof timeZone === 'string' && timeZone.length <= 80 ? timeZone : 'Asia/Shanghai';
  if (!formatters.has(zone)) {
    let value;
    try { value = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
    catch { zone = 'Asia/Shanghai'; value = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
    if (formatters.size >= 16) formatters.delete(formatters.keys().next().value);
    formatters.set(zone, value);
  }
  return { zone, value: formatters.get(zone) };
}

export function localTimeContext(at = Date.now(), timeZone = 'Asia/Shanghai') {
  const { zone, value } = formatter(timeZone);
  const parts = Object.fromEntries(value.formatToParts(at).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  return { timeZone: zone, localDate: `${parts.year}-${parts.month}-${parts.day}`, localTime: `${parts.hour}:${parts.minute}`,
    daypart: hour >= 23 || hour < 6 ? 'late-night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening' };
}

function nightKey(local) {
  if (Number(local.localTime.slice(0, 2)) >= 6) return local.localDate;
  return new Date(Date.parse(`${local.localDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function valid(value) {
  return value?.version === 1 && typeof value.zone === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.nightKey)
    && Number.isSafeInteger(value.lastAt) && value.lastAt >= 0
    && Number.isSafeInteger(value.activeMs) && value.activeMs >= 0 && value.activeMs <= REMINDER_AFTER
    && Number.isInteger(value.turns) && value.turns >= 0 && value.turns <= 64
    && ['firstHandled', 'reminded', 'suppressed', 'muted', 'late'].every(key => typeof value[key] === 'boolean');
}

const stateKeys = ['version', 'zone', 'nightKey', 'firstHandled', 'activeMs', 'lastAt', 'turns', 'reminded', 'suppressed', 'muted', 'late'];

export function prepareTimeContext(previous, { at = Date.now(), timeZone = 'Asia/Shanghai', text = '', eligible = true } = {}) {
  const local = localTimeContext(at, timeZone);
  const old = valid(previous) ? Object.fromEntries(stateKeys.map(key => [key, previous[key]])) : null;
  if (!eligible) return { state: old, context: { ...local, nightCue: 'none', remindersSuppressed: true, continuing: false } };
  const key = nightKey(local);
  const sameNight = old?.zone === local.timeZone && old.nightKey === key;
  const late = local.daypart === 'late-night';
  const gap = old ? at - old.lastAt : Infinity;
  const continuing = Boolean(old?.zone === local.timeZone && gap >= 0 && gap <= ACTIVE_GAP);
  const next = sameNight ? { ...old } : { version: 1, zone: local.timeZone, nightKey: key, firstHandled: false,
    activeMs: 0, lastAt: at, turns: 0, reminded: false, suppressed: false, muted: old?.muted === true, late: false };
  const input = String(text).slice(0, 6000);
  const stopped = stopReminder.test(input);
  if (stopped) {
    next.suppressed = true;
    if (permanent.test(input)) next.muted = true;
  } else if (allowReminder.test(input)) {
    next.muted = false;
    next.suppressed = false;
  }
  if (working.test(input) || (late && distress.test(input))) next.suppressed = true;
  const suppressed = next.suppressed || next.muted || distress.test(input);
  let nightCue = 'none';
  if (late) {
    next.activeMs = sameNight && old.late && continuing ? Math.min(REMINDER_AFTER, old.activeMs + gap) : 0;
    next.turns = sameNight && old.late && continuing ? Math.min(64, old.turns + 1) : 1;
    if (!next.firstHandled) {
      next.firstHandled = true;
      if (!suppressed) nightCue = 'first';
    } else if (!suppressed && !next.reminded && next.activeMs >= REMINDER_AFTER && next.turns >= 4) {
      next.reminded = true;
      nightCue = 'reminder';
    }
  } else {
    next.activeMs = 0;
    next.turns = 0;
  }
  next.lastAt = at;
  next.late = late;
  return { state: next, context: { ...local, nightCue, remindersSuppressed: Boolean(suppressed), continuing } };
}
