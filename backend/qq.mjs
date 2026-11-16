import { createPrivateKey, createPublicKey, sign, verify as verifySignature } from 'node:crypto';

const API_BASE = 'https://api.bot.qq.com';
const ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const MAX_VOICE_BYTES = 5_000_000;
const CHALLENGE_TOKEN = /^[a-z0-9_-]{1,256}$/i;
const TIMESTAMP = /^\d{1,16}$/;
const VOICE_EXTENSIONS = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/silk': 'silk' };

function qqError(message, code, status, cause) {
  return Object.assign(new Error(message, { cause }), { code, status });
}

function getHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === 'string' ? entry[1] : null;
}

function privateKeyFor(secret) {
  const bytes = Buffer.from(secret);
  const seed = Buffer.alloc(32, bytes);
  return createPrivateKey({
    key: Buffer.concat([ED25519_SEED_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function parseEvent(body) {
  if (body?.op !== 0 || !body.d || body.d.author?.bot) return null;
  const { id: messageId, author, content, group_openid: groupId, timestamp } = body.d;
  if (typeof messageId !== 'string' || !messageId || typeof content !== 'string' || !content.trim()) return null;

  const isDirect = body.t === 'C2C_MESSAGE_CREATE';
  const isGroup = body.t === 'GROUP_AT_MESSAGE_CREATE';
  if (!isDirect && !isGroup) return null;
  const senderId = (isDirect ? author?.user_openid : author?.member_openid) || author?.id;
  const targetId = isDirect ? senderId : groupId;
  if (typeof senderId !== 'string' || !senderId || typeof targetId !== 'string' || !targetId) return null;

  return {
    id: messageId,
    senderId,
    timestamp: typeof timestamp === 'string' ? timestamp : undefined,
    target: {
      type: isDirect ? 'c2c' : 'group',
      id: targetId,
      messageId,
      eventId: typeof body.id === 'string' ? body.id : undefined,
    },
    text: content.trim(),
  };
}

function voiceFilePayload(audio) {
  const source = typeof audio === 'string' ? audio : audio?.url;
  if (source) {
    const url = URL.parse(source);
    if (!url || url.protocol !== 'https:' || url.username || url.password) {
      throw qqError('QQ 语音需要可访问的 HTTPS 地址。', 'QQ_INVALID_AUDIO');
    }
    return { url: url.href };
  }

  const bytes = audio instanceof Uint8Array ? audio : audio?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length >= MAX_VOICE_BYTES) {
    throw qqError('QQ 语音直传需要小于 5 MB 的音频。', 'QQ_INVALID_AUDIO');
  }
  const fileName = audio.filename ?? audio.fileName ?? '';
  const suppliedExtension = fileName.match(/\.(mp3|wav|silk|ogg)$/i)?.[1];
  const contentType = (audio.contentType ?? audio.mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
  const extension = suppliedExtension ?? VOICE_EXTENSIONS[contentType] ?? 'mp3';
  return { file_name: `voice.${extension.toLowerCase()}`, file_data: Buffer.from(bytes).toString('base64') };
}

export function createQQAdapter({ appId = '', clientSecret = '', apiBase = API_BASE, fetchImpl = fetch } = {}) {
  const configured = Boolean(appId && clientSecret);
  const privateKey = configured ? privateKeyFor(clientSecret) : null;
  const publicKey = privateKey && createPublicKey(privateKey);
  const base = (apiBase || API_BASE).replace(/\/+$/, '');
  const capabilities = Object.freeze({
    transport: 'webhook',
    text: true,
    direct: true,
    group: true,
    voice: true,
    proactive: true,
    proactiveScope: 'c2c',
    proactiveMaxIdleDays: 30,
  });
  let accessToken;
  let refreshAt = 0;
  let refreshing;

  function verify(rawBody, headers) {
    if (!publicKey || (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array))) return false;
    const callbackAppId = getHeader(headers, 'x-bot-appid');
    if (callbackAppId !== null && callbackAppId !== String(appId)) return false;
    const timestamp = getHeader(headers, 'x-signature-timestamp');
    const signature = getHeader(headers, 'x-signature-ed25519');
    if (!TIMESTAMP.test(timestamp ?? '') || !/^[a-f0-9]{128}$/i.test(signature ?? '')) return false;
    const signed = Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]);
    return verifySignature(null, signed, publicKey, Buffer.from(signature, 'hex'));
  }

  function handshake(body, headers) {
    const { plain_token: token, event_ts: timestamp } = body?.d ?? {};
    if (!privateKey || body?.op !== 13 || typeof token !== 'string' || typeof timestamp !== 'string') return null;
    if (headers && getHeader(headers, 'x-bot-appid') !== String(appId)) return null;
    // A callback challenge must never let an unsigned caller sign a JSON event.
    if (!CHALLENGE_TOKEN.test(token) || !TIMESTAMP.test(timestamp)) return null;
    return { plain_token: token, signature: sign(null, Buffer.from(timestamp + token), privateKey).toString('hex') };
  }

  async function post(path, payload, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `QQBot ${token}`;
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw qqError('无法连接 QQ 机器人接口。', 'QQ_NETWORK_ERROR', undefined, cause);
    }
    const data = await response.json().catch(() => null);
    const upstreamCode = Number(data?.err_code ?? data?.code);
    if (!response.ok || upstreamCode) {
      if (token && response.status === 401 && accessToken === token) refreshAt = 0;
      const detail = upstreamCode ? `错误码 ${upstreamCode}` : `HTTP ${response.status}`;
      throw qqError(`QQ 机器人接口请求失败（${detail}）。`, upstreamCode || 'QQ_HTTP_ERROR', response.status);
    }
    if (!data || typeof data !== 'object') {
      throw qqError('QQ 机器人接口返回了无效响应。', 'QQ_INVALID_RESPONSE', response.status);
    }
    return data;
  }

  async function tokenForSend() {
    if (accessToken && Date.now() < refreshAt) return accessToken;
    refreshing ??= post('/app/getAppAccessToken', { appId: String(appId), clientSecret }).then((data) => {
      const seconds = Number(data.expires_in);
      if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(seconds) || seconds <= 0) {
        throw qqError('QQ 机器人接口未返回有效访问凭证。', 'QQ_INVALID_RESPONSE');
      }
      accessToken = data.access_token;
      refreshAt = Date.now() + (seconds - Math.min(60, seconds / 2)) * 1000;
      return accessToken;
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  async function send(target, { text, audio, proactive = false, sequence = 1 } = {}) {
    if (!configured) throw qqError('尚未配置 QQ 机器人。', 'QQ_NOT_CONFIGURED');
    if (!['c2c', 'group'].includes(target?.type) || typeof target.id !== 'string' || !target.id) {
      throw qqError('QQ 消息缺少有效的会话。', 'QQ_INVALID_TARGET');
    }
    if (proactive && target.type !== 'c2c') {
      throw qqError('主动问候仅用于 QQ 单聊。', 'QQ_UNSUPPORTED_PROACTIVE');
    }
    if (!proactive && (typeof target.messageId !== 'string' || !target.messageId)) {
      throw qqError('QQ 回复缺少原消息 ID。', 'QQ_INVALID_TARGET');
    }
    if (!audio && (typeof text !== 'string' || !text.trim())) {
      throw qqError('QQ 消息内容为空。', 'QQ_EMPTY_MESSAGE');
    }

    const endpoint = `/v2/${target.type === 'c2c' ? 'users' : 'groups'}/${encodeURIComponent(target.id)}`;
    const reply = proactive ? { is_wakeup: true } : { msg_id: target.messageId, msg_seq: sequence };
    const voice = audio && voiceFilePayload(audio);
    const token = await tokenForSend();
    let payload;
    if (voice) {
      const file = await post(`${endpoint}/files`, { ...voice, file_type: 3, srv_send_msg: false }, token);
      if (typeof file.file_info !== 'string' || !file.file_info) {
        throw qqError('QQ 语音上传未返回文件信息。', 'QQ_INVALID_RESPONSE');
      }
      payload = { msg_type: 7, content: ' ', media: { file_info: file.file_info } };
    } else {
      payload = { msg_type: 0, content: text.trim() };
    }
    const result = await post(`${endpoint}/messages`, { ...reply, ...payload }, token);
    if (typeof result.id !== 'string' || !result.id) {
      throw qqError('QQ 接口未确认消息已发送。', 'QQ_INVALID_RESPONSE');
    }
    return { messageId: result.id, voice: Boolean(voice) };
  }

  return { configured, capabilities, verify, handshake, parseEvent, send };
}
