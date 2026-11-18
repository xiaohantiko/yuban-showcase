const balanceURL = 'https://api.deepseek.com/user/balance';
const credentialPattern = /^[a-f0-9]{64}$/;
const receiptPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const responseLimit = 16 * 1024;

function configuration(env) {
  try {
    const url = new URL(env?.AI_BASE_URL);
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash
      || !['/', '/v1', '/v1/'].includes(url.pathname)) return { status: 'unsupported' };
  } catch { return { status: 'unsupported' }; }
  const key = typeof env?.AI_API_KEY === 'string' ? env.AI_API_KEY.trim() : '';
  return /^[\x21-\x7e]{8,512}$/.test(key) ? { key } : { status: 'unconfigured' };
}

async function credentialId(key) {
  const input = new TextEncoder().encode(`yuban/model-balance/v1\0${key}`);
  try {
    const digest = await crypto.subtle.digest('SHA-256', input);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { input.fill(0); }
}

export async function balanceCredentialId(env) {
  const config = configuration(env);
  return config.key ? credentialId(config.key) : null;
}

function amount(value) {
  const parts = typeof value === 'string' ? /^(-?)(\d{1,18})(?:\.(\d{1,18}))?$/.exec(value) : null;
  if (!parts) return null;
  const whole = BigInt(parts[2]);
  const fraction = (parts[3] ?? '').replace(/0+$/, '');
  const negative = parts[1] === '-' && (whole !== 0n || Boolean(fraction));
  return { text: `${negative ? '-' : ''}${whole}.${fraction.padEnd(2, '0')}`, low: negative || whole < 5n };
}

async function readJSON(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || Number(response.headers.get('content-length')) > responseLimit || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function readModelBalance(env, { fetchImpl = fetch, clock = Date.now, signal } = {}) {
  const config = configuration(env);
  if (config.status) return { status: config.status, checkedAt: clock() };
  const id = await credentialId(config.key);
  const unavailable = error => ({ status: 'unavailable', checkedAt: clock(), credentialId: id, error });
  const timeout = AbortSignal.timeout(4_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let parsing = false;
  try {
    const response = await fetchImpl(balanceURL, {
      method: 'GET', headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json' },
      redirect: 'manual', signal: requestSignal,
    });
    if (response.status !== 200) {
      const errors = new Map([[401, 'authentication'], [403, 'forbidden'], [429, 'rate-limit'], [408, 'timeout'], [504, 'timeout']]);
      return unavailable(errors.get(response.status) ?? 'upstream');
    }
    parsing = true;
    const value = await readJSON(response);
    if (typeof value?.is_available !== 'boolean' || !Array.isArray(value.balance_infos) || value.balance_infos.length > 8) {
      return unavailable('invalid-response');
    }
    const cny = value.balance_infos.filter(entry => entry?.currency === 'CNY');
    if (!cny.length) return unavailable('currency');
    const balance = cny.length === 1 ? amount(cny[0].total_balance) : null;
    if (!balance) return unavailable('invalid-response');
    return { status: 'ok', checkedAt: clock(), credentialId: id, currency: 'CNY', totalBalance: balance.text,
      low: balance.low, isAvailable: value.is_available };
  } catch (error) {
    const timedOut = timeout.aborted || error?.name === 'TimeoutError'
      || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error?.cause?.code);
    return unavailable(timedOut ? 'timeout' : parsing ? 'invalid-response' : 'network');
  }
}

function validScope(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

function alertState(value) {
  if (value?.version !== 1 || !validScope(value.scope) || typeof value.credentialId !== 'string' || !credentialPattern.test(value.credentialId)
    || typeof value.low !== 'boolean' || typeof value.notified !== 'boolean'
    || (value.low ? typeof value.receipt !== 'string' || !receiptPattern.test(value.receipt) : value.receipt !== null || value.notified)) return null;
  if (Object.keys(value).length === 6) return value;
  const { version, scope, credentialId, low, notified, receipt } = value;
  return { version, scope, credentialId, low, notified, receipt };
}

function noticeText(value, companionName, companionPersona) {
  const name = typeof companionName === 'string' ? companionName.trim() : '';
  const speaker = name && name.length <= 20 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(name)
    && !/deepseek|openai|gpt|kimi|qwen|api|token|千问|通义|豆包|服务商|充值|官方/i.test(name) ? name : '我';
  const persona = typeof companionPersona === 'string' ? companionPersona.slice(0, 1000) : '';
  const sister = /邻家(?:大)?姐姐|大姐姐|姐姐(?:型|身份|人设|角色)|\b(?:older|elder|big)\s+sister\b/i.test(persona);
  const rejectsSister = /(?:不要|不用|不再|别|禁止|避免|拒绝|取消|不是|并非|不扮演)[^，。！？；\n]{0,18}(?:姐姐|姐系)|\b(?:no|not|without|avoid|don't|do not)\b[^.!?\n]{0,32}\bsister\b/i.test(persona);
  if (value.text === '0.00' || value.text.startsWith('-')) {
    return sister && !rejectsSister
      ? `咱们聊天的小零钱用完啦，${speaker}先跟你说一声。`
      : `聊天用的零钱用完了，${speaker}跟你说一声。`;
  }
  return sister && !rejectsSister
    ? `诶，咱们聊天的小零钱是不是快见底啦？${speaker}刚看了一眼，连五块都不到了。`
    : `${speaker}刚看了一眼，聊天用的零钱不到五块了，跟你说一声。`;
}

export function prepareBalanceNotice(previous, { balance, scope, companionName, companionPersona }) {
  const current = alertState(previous);
  let state = current?.scope === scope && current.credentialId === balance?.credentialId ? current : null;
  const result = () => ({ state, notice: null, receipt: null });
  if (!validScope(scope) || typeof balance?.credentialId !== 'string' || !credentialPattern.test(balance.credentialId)) return { state: null, notice: null, receipt: null };
  if (balance.status !== 'ok') return result();
  const value = balance.currency === 'CNY' ? amount(balance.totalBalance) : null;
  if (!value || value.low !== balance.low) return result();
  if (!value.low) {
    state = state?.low === false ? state : { version: 1, scope, credentialId: balance.credentialId, low: false, notified: false, receipt: null };
    return result();
  }
  state ??= { version: 1, scope, credentialId: balance.credentialId, low: false, notified: false, receipt: null };
  if (!state.low) state = { ...state, low: true, notified: false, receipt: crypto.randomUUID() };
  if (state.notified) return result();
  return { state, receipt: state.receipt,
    notice: noticeText(value, companionName, companionPersona) };
}

export function confirmBalanceNotice(value, receipt) {
  const state = alertState(value);
  return state?.low && !state.notified && state.receipt === receipt ? { ...state, notified: true } : state;
}
