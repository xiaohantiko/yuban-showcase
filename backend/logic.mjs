import { randomUUID } from 'node:crypto';
import { companionGreeting, companionTurnContext, validGreeting } from './companion.mjs';
import { boundedChatContext, MAX_STORED_MESSAGES } from './history.mjs';
import { dshPluginIDs, selectedPlugins } from './plugin-capabilities.mjs';
import { localTimeContext, validTimeZone } from './time-context.mjs';

export const defaultSettings = Object.freeze({
  enabled: true, afterMinutes: 360, quietEnabled: true, quietStart: '23:00', quietEnd: '08:00',
  timeZone: 'Asia/Shanghai', voiceReplies: false,
  companionName: '', companionPersona: '', memoryEnabled: true,
  dshPlugins: Object.freeze([]),
  dshChainManaged: false,
});
export const newThread = () => ({ messages: [], lastUserAt: null, attemptedFor: null, optedIn: false, target: null });
export const newMessage = (role, text, options = {}) => ({
  id: randomUUID(), role, text, at: Date.now(), ...options,
});

export function addMessage(thread, message) {
  thread.messages.push(message);
  if (thread.messages.length > MAX_STORED_MESSAGES) thread.messages.splice(0, thread.messages.length - MAX_STORED_MESSAGES);
  return message;
}

const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const validDshPlugins = new Set(dshPluginIDs);
export function readSettings(current) {
  const settings = { ...defaultSettings, ...current };
  delete settings.companionStyle;
  settings.timeZone = validTimeZone(settings.timeZone) ? settings.timeZone : 'Asia/Shanghai';
  settings.dshPlugins = selectedPlugins(settings);
  settings.dshChainManaged = settings.dshChainManaged === true || settings.dshPlugins?.includes('chain') === true;
  return settings;
}

export function mergeSettings(current, input) {
  const next = readSettings(current);
  if ('timeZone' in input) {
    if (!validTimeZone(input.timeZone)) throw new Error('请选择有效的时区，例如 Asia/Shanghai');
    next.timeZone = input.timeZone;
  }
  if ('dshPlugins' in input) {
    const plugins = input.dshPlugins;
    if (!Array.isArray(plugins) || plugins.length > validDshPlugins.size
        || [...plugins].some((id) => !validDshPlugins.has(id)) || new Set(plugins).size !== plugins.length) {
      throw new Error('请选择有效且不重复的 DSH 插件');
    }
    // Keep old independently authorized tools working until this item is explicitly managed.
    if (plugins.includes('chain') || next.dshPlugins.includes('chain')) next.dshChainManaged = true;
    next.dshPlugins = [...plugins];
  }
  if ('companionName' in input) {
    const name = typeof input.companionName === 'string' ? input.companionName.trim() : null;
    if (name === null || name.length > 20 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) {
      throw new Error('陪伴昵称需为单行文本，最多 20 个字符');
    }
    next.companionName = name;
  }
  if ('companionPersona' in input) {
    const persona = typeof input.companionPersona === 'string' ? input.companionPersona.trim() : null;
    if (persona === null || persona.length > 1_000) throw new Error('角色设定需为文本，最多 1000 个字符');
    next.companionPersona = persona;
  }
  for (const key of ['enabled', 'quietEnabled', 'voiceReplies', 'memoryEnabled']) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') throw new Error('开关值无效');
    next[key] = input[key];
  }
  if ('afterMinutes' in input) {
    if (!Number.isInteger(input.afterMinutes) || input.afterMinutes < 1 || input.afterMinutes > 10080) {
      throw new Error('等待时间须在 1 分钟到 7 天之间');
    }
    next.afterMinutes = input.afterMinutes;
  }
  for (const key of ['quietStart', 'quietEnd']) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'string' || !validTime.test(input[key])) throw new Error('时间格式无效');
    next[key] = input[key];
  }
  if (next.quietEnabled && next.quietStart === next.quietEnd) throw new Error('免打扰开始和结束时间需要不同');
  return next;
}

const minuteOfDay = (time) => time.slice(0, 2) * 60 + Number(time.slice(3));
const timeFormats = new Map();
function clockMinute(at, timeZone) {
  if (!timeFormats.has(timeZone)) {
    if (timeFormats.size >= 16) timeFormats.delete(timeFormats.keys().next().value);
    timeFormats.set(timeZone, new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return minuteOfDay(timeFormats.get(timeZone).format(at));
}
export function isQuiet(at, settings) {
  if (!settings.quietEnabled) return false;
  const time = clockMinute(at, settings.timeZone);
  const start = minuteOfDay(settings.quietStart);
  const end = minuteOfDay(settings.quietEnd);
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function nextGreeting(thread, settings, now = Date.now()) {
  if (!settings.enabled || !thread.lastUserAt || thread.attemptedFor === thread.lastUserAt) return null;
  const at = Math.max(now, thread.lastUserAt + settings.afterMinutes * 60_000);
  if (!isQuiet(at, settings)) return at;
  const delay = (minuteOfDay(settings.quietEnd) - clockMinute(at, settings.timeZone) + 1440) % 1440;
  const expected = Math.floor(at / 60_000) * 60_000 + delay * 60_000;
  if (clockMinute(expected, settings.timeZone) === minuteOfDay(settings.quietEnd)) return expected;
  // DST can skip or repeat local clock minutes. Keep ordinary scheduling O(1),
  // and use a bounded search only when that shortcut crosses an offset change.
  for (let candidate = Math.floor(at / 60_000) * 60_000 + 60_000; candidate <= at + 27 * 60 * 60_000; candidate += 60_000) {
    if (!isQuiet(candidate, settings)) return candidate;
  }
  return expected;
}

export const searchRequest = /^(?:[\s/]*(?:查资料|查一下|帮我查(?:一下)?|搜索|搜一下|帮我搜|search)\s*[:：]?)/i;
export const voiceRequest = /^(?:请|可以)?(?:用|发)?语音(?:回复|回答)?\s*[:：,，]?\s*/;
export const commandOn = /^(?:\/|#)?\s*(?:开启问候|打开问候|启用问候)$/;
export const commandOff = /^(?:\/|#)?\s*(?:关闭问候|停用问候|取消问候|停止问候)$/;

export async function createReply(providers, settings, messages, text, { mode, voice, at = Date.now(), memoryContext, ownerName, timeContext, story = false } = {}) {
  const { companionName, companionPersona, memoryEnabled = true } = settings;
  const wantsVoice = voice || settings.voiceReplies || voiceRequest.test(text);
  const input = text.replace(voiceRequest, '').trim() || '可以陪我聊聊吗？';
  const kind = mode === 'search' || searchRequest.test(input) ? 'search' : 'chat';
  const query = kind === 'search' ? (input.replace(searchRequest, '').trim() || input) : input;
  let result;
  try {
    result = await providers.reply({
      messages: boundedChatContext(kind === 'search' ? [] : messages, query, { story }),
      mode: kind, companionName, companionPersona,
      ...(kind === 'chat' ? { turnContext: companionTurnContext(messages, query) } : {}),
      ...(story && kind === 'chat' ? { story: true } : {}),
      ...(timeContext ? { timeContext } : {}),
      ...(typeof ownerName === 'string' ? { ownerName } : {}),
      memoryContext: memoryEnabled ? memoryContext : undefined,
    });
  } catch {
    result = { text: kind === 'search' ? '这次没能连上资料来源，稍后再试试好吗？' : '刚才没能生成回复。你想接着聊时，可以再发一句。' };
  }
  const sources = Array.isArray(result?.sources) ? result.sources.filter((item) => typeof item?.title === 'string' && /^https?:\/\//i.test(item?.url)).slice(0, 5) : [];
  return newMessage('assistant', result?.text || '怎么啦，想跟我说说吗？', {
    ...(kind === 'chat' && !wantsVoice && !sources.length && ((result?.text?.length ?? 0) >= 52 || /\n\s*\n/u.test(result?.text ?? '')) ? { kind: 'chat' } : {}),
    at, ...(sources.length ? { sources } : {}), ...(wantsVoice && !sources.length ? { voice: true } : {}),
  });
}

export async function createGreeting(providers, settings, messages, options = {}) {
  const { at = Date.now(), ownerName, idleMinutes, memoryContext } = typeof options === 'number' ? { at: options } : options;
  const { companionName, companionPersona, memoryEnabled = true } = settings;
  const context = {
    messages: messages.slice(-8), companionName, companionPersona, idleMinutes,
    ...(typeof ownerName === 'string' ? { ownerName } : {}),
    memoryContext: memoryEnabled && memoryContext ? { traits: memoryContext.traits, personality: memoryContext.personality } : undefined,
    timeContext: localTimeContext(at, settings.timeZone),
  };
  let result;
  try { result = await providers.greeting(context); } catch { /* Use a local greeting. */ }
  return newMessage('assistant', validGreeting(result?.text, context) || companionGreeting(context), { kind: 'greeting', at });
}

export function renderForTransport(message) {
  return [message.text, ...(message.sources ?? []).map((s) => `${s.title}：${s.url}`)].join('\n');
}

export function transportError(err) {
  const code = err?.code;
  if (typeof code === 'number') return `平台返回 ${code}`;
  if (Number.isInteger(err?.status)) return `请求返回 ${err.status}`;
  return '发送失败，请检查平台权限和连接设置';
}
