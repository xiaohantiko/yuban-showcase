import { createHmac, timingSafeEqual } from 'node:crypto';

const escapes = { '&amp;': '&', '&#91;': '[', '&#93;': ']' };

function messageText(message) {
  if (Array.isArray(message)) {
    return message
      .filter(segment => segment?.type === 'text' && typeof segment.data?.text === 'string')
      .map(segment => segment.data.text)
      .join('');
  }
  if (typeof message !== 'string') return '';
  return message
    .replace(/\[CQ:[a-z0-9_-]+(?:,[^\]]*)?\]/gi, '')
    .replace(/&amp;|&#91;|&#93;/g, escape => escapes[escape]);
}

function qqId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseEvent(body) {
  if (body?.post_type !== 'message' || body.message_type !== 'private' || body.sub_type !== 'friend') return null;

  const selfId = qqId(body.self_id);
  const userId = qqId(body.user_id);
  const messageId = body.message_id;
  const text = messageText(body.message).trim();
  if (!selfId || !userId || selfId === userId || !Number.isSafeInteger(messageId) || !text) return null;

  return {
    id: `${selfId}:${userId}:${messageId}`,
    target: { type: 'c2c', id: String(userId), messageId: String(messageId) },
    text,
  };
}

export function createOneBotAdapter({ apiBase, accessToken, webhookSecret, fetchImpl = fetch } = {}) {
  const token = accessToken?.trim();
  const secret = webhookSecret?.trim();
  const base = URL.canParse(apiBase ?? '') ? new URL(apiBase) : null;
  const validBase = base && ['http:', 'https:'].includes(base.protocol)
    && !base.username && !base.password && !base.search && !base.hash;
  const configured = Boolean(validBase && token && secret);

  function verify(rawBody, headers) {
    if (!configured || (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array))) return false;

    // The OneBot HTTP POST protocol signs the body bytes before JSON decoding.
    const signature = typeof headers?.get === 'function'
      ? headers.get('x-signature')
      : Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'x-signature')?.[1];
    const received = typeof signature === 'string' && /^sha1=([a-f0-9]{40})$/i.exec(signature);
    if (!received) return false;

    const expected = createHmac('sha1', secret).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(received[1], 'hex'));
  }

  async function send(target, { text, audio } = {}) {
    if (!configured) throw new Error('OneBot 尚未配置。');

    // The same action can send a reply or a proactive message. It only needs the recipient ID.
    const userId = target?.type === 'c2c' && qqId(target.id);
    if (!userId) throw new Error('OneBot 仅支持向 QQ 私聊好友发送消息。');

    const voice = audio?.bytes instanceof Uint8Array && audio.bytes.byteLength > 0;
    const content = typeof text === 'string' ? text.trim() : '';
    if (!voice && !content) throw new Error('OneBot 消息内容不能为空。');
    const message = voice
      ? { type: 'record', data: { file: `base64://${Buffer.from(audio.bytes).toString('base64')}` } }
      : { type: 'text', data: { text: content } };

    const endpoint = `${base.href.replace(/\/+$/, '')}/send_private_msg`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, message: [message] }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OneBot HTTP 请求失败（${response.status}）。`);

    const result = await response.json();
    if (result?.status !== 'ok' || result.retcode !== 0) {
      const code = Number.isInteger(result?.retcode) ? `（${result.retcode}）` : '';
      throw new Error(`OneBot 未确认发送成功${code}。`);
    }

    return { messageId: result.data?.message_id, voice };
  }

  return { configured, verify, parseEvent, send, capabilities: { text: true, voice: true, proactive: true, group: false } };
}
