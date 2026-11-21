import { Buffer } from 'node:buffer';

export const bailianVoiceModel = 'qwen-audio-3.1-tts-flash';
const voicePrefix = `${bailianVoiceModel}-vd-yuban-`;
const sampleRate = 24_000;
const maxWaveBytes = 4 * 1024 * 1024;
const maxResponseBytes = Math.ceil(maxWaveBytes / 3) * 4 + 8192;
const invalidAudio = '百炼返回的试听音频格式不正确或文件过大。';

export function isDesignedVoiceId(value) {
  return typeof value === 'string' && value.length <= 200 && value.startsWith(voicePrefix)
    && /^[a-zA-Z0-9_-]+$/.test(value.slice(voicePrefix.length));
}

export function bailianBeijingOrigin(workspaceId = '') {
  if (workspaceId === '') return 'https://dashscope.aliyuncs.com';
  if (typeof workspaceId !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workspaceId)) return null;
  return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com`;
}

export class PreviewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function previewInput(value, label, min, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  const length = Array.from(text).length;
  if (length < min || length > max) throw new PreviewError(400, `${label}需要 ${min} 至 ${max} 个字符。`);
  if (!/[\p{Script=Han}\p{Script=Latin}]/u.test(text) || /\p{L}/u.test(text.replace(/[\p{Script=Han}\p{Script=Latin}]/gu, ''))
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new PreviewError(400, `请用中文或英文填写${label}。`);
  }
  return text;
}

export function validateDesignPreview(input = {}) {
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!/^[A-Za-z0-9._~+/=-]{1,512}$/.test(apiKey)) throw new PreviewError(400, '请填写本次试听使用的百炼 API Key。');
  const value = input.workspaceId === undefined ? '' : input.workspaceId;
  const workspaceId = typeof value === 'string' ? value.trim() : null;
  if (!bailianBeijingOrigin(workspaceId)) {
    throw new PreviewError(400, '请填写北京地域业务空间的 ID，或留空使用北京通用入口。');
  }
  const description = previewInput(input.description, '声音描述', 1, 500);
  const previewText = previewInput(input.previewText, '试听台词', 15, 200);
  return { apiKey, workspaceId, description, previewText };
}

// Validate RIFF chunk lengths and PCM layout before returning provider bytes to a player.
export function validWave(bytes) {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF'
      || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('latin1', 8, 12) !== 'WAVE') return false;
  let frameSize = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (size > bytes.length - offset) return false;
    if (tag === 'fmt ') {
      if (frameSize || size < 16) return false;
      const encoding = bytes.readUInt16LE(offset);
      const channels = bytes.readUInt16LE(offset + 2);
      const bits = bytes.readUInt16LE(offset + 14);
      if (![1, 2].includes(channels) || !(encoding === 1 && [8, 16, 24, 32].includes(bits)
          || encoding === 3 && bits === 32)) return false;
      frameSize = channels * bits / 8;
      if (bytes.readUInt32LE(offset + 4) !== sampleRate || bytes.readUInt16LE(offset + 12) !== frameSize
          || bytes.readUInt32LE(offset + 8) !== sampleRate * frameSize) return false;
    }
    if (tag === 'data') {
      if (!frameSize || !size || dataSize || size % frameSize) return false;
      dataSize = size;
    }
    offset += size + (size % 2);
  }
  return offset === bytes.length && dataSize > 0;
}

export async function readProviderJson(response, signal, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new PreviewError(502, invalidAudio);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const mime = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (Number(response.headers.get('Content-Length')) > limit
        || (mime !== 'application/json' && mime !== 'application/problem+json')) {
      throw new PreviewError(502, invalidAudio);
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let json = '';
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new PreviewError(502, invalidAudio);
      json += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(json + decoder.decode());
  } catch (error) {
    cancel();
    if (error instanceof PreviewError) throw error;
    throw new PreviewError(502, invalidAudio);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function previewOutput(response, signal) {
  const output = (await readProviderJson(response, signal, maxResponseBytes))?.output;
  const audio = output?.preview_audio;
  const voiceId = output?.voice_id;
  // Creation may omit the model echo. The returned ID must still carry the requested model and prefix.
  if (!output || (Object.hasOwn(output, 'target_model') && output.target_model !== bailianVoiceModel)
      || !isDesignedVoiceId(voiceId)
      || audio?.response_format !== 'wav' || audio.sample_rate !== sampleRate || typeof audio.data !== 'string'
      || audio.data.length > Math.ceil(maxWaveBytes / 3) * 4 || audio.data.length % 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) throw new PreviewError(502, invalidAudio);
  const bytes = Buffer.from(audio.data, 'base64');
  if (bytes.length > maxWaveBytes || !validWave(bytes)) throw new PreviewError(502, invalidAudio);
  return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType: 'audio/wav', voiceId };
}

const invalidKey = '密钥验证失败。请确认使用百炼北京地域的通用 API Key，且密钥仍然有效。';
const permission = '请检查北京业务空间的模型授权和该密钥的可访问模型范围，核对 voice-enrollment 与 qwen-audio-3.1-tts-flash。';
const billing = '百炼账号的计费状态异常。请到阿里云费用中心核对欠费情况和可用余额。';
const quota = '百炼配额已达上限。请检查该账号可用的模型额度和自定义音色数量。';
const inputError = '百炼未接受设计参数。请使用中英文描述声音，试听台词应为 15 至 200 字。';
const throttled = '百炼的请求频率已达上限，请稍后再试听。';
const missing = '当前北京业务空间无法访问所需模型。请核对空间和模型列表中的 voice-enrollment 与 qwen-audio-3.1-tts-flash。';
const unavailable = '百炼暂时无法返回试听，请先到百炼查看本次音色是否已创建。';

// Only known DashScope codes and our own messages may reach the console. In
// particular, the vendor's message and request ID can contain sensitive data.
const explanations = new Map([
  ['InvalidApiKey', invalidKey], ['invalid_api_key', invalidKey],
  ['AccessDenied', permission], ['access_denied', permission], ['Model.AccessDenied', permission],
  ['App.AccessDenied', permission], ['Workspace.AccessDenied', '请检查密钥是否属于填入的北京业务空间，并核对空间成员权限。'],
  ['WorkSpaceNotFound', '未找到北京业务空间，请从百炼北京控制台复制业务空间 ID。'],
  ['AccessDenied.Unpurchased', '百炼服务尚未开通。请用阿里云主账号检查北京地域的服务开通状态。'],
  ['Arrearage', billing], ['AllocationQuota.FreeTierOnly', '百炼的免费额度已用完，账号设置为用完即停。请在百炼查看免费额度与计费设置。'],
  ['Throttling.AllocationQuota', quota], ['insufficient_quota', quota],
  ['Throttling.RateQuota', throttled], ['Throttling.Concurrency', throttled],
  ['InvalidParameter', inputError], ['DataInspectionFailed', '百炼未通过输入内容检查，请调整声音描述或台词。'],
  ['ModelNotFound', missing], ['model_not_found', missing], ['InternalError', unavailable], ['ServiceUnavailable', unavailable],
]);
const httpExplanations = new Map([[400, inputError], [401, invalidKey], [402, billing], [403, permission], [404, missing], [429, throttled]]);

async function vendorError(response, signal) {
  const status = response.status;
  if (status < 400 || status > 599) {
    void response.body?.cancel().catch(() => {});
    return new PreviewError(502, `百炼返回了意外响应（HTTP ${status}），请核对北京业务空间的入口。`);
  }
  const body = await readProviderJson(response, signal, 8192).catch(() => null);
  const code = body?.code ?? body?.error?.code;
  const known = explanations.has(code);
  const advice = known ? explanations.get(code) : httpExplanations.get(status) ?? unavailable;
  return new PreviewError(status, `百炼试听失败（HTTP ${status}${known ? ` · ${code}` : ''}）。${advice}`);
}

export async function designVoicePreview(input = {}, { fetchImpl = fetch, signal } = {}) {
  const { apiKey, workspaceId, description, previewText } = validateDesignPreview(input);
  const url = new URL('/api/v1/services/audio/tts/customization', bailianBeijingOrigin(workspaceId));
  const timeout = AbortSignal.timeout(180_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    requestSignal.throwIfAborted();
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'manual', signal: requestSignal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'voice-enrollment',
        input: {
          action: 'create_voice', target_model: bailianVoiceModel, prefix: 'yuban',
          voice_prompt: description, preview_text: previewText,
          language_hints: [/\p{Script=Han}/u.test(previewText) ? 'zh' : 'en'],
        },
        parameters: { response_format: 'wav', sample_rate: sampleRate },
      }),
    });
    if (!response.ok) throw await vendorError(response, requestSignal);
    return await previewOutput(response, requestSignal);
  } catch (error) {
    if (requestSignal.aborted) throw new PreviewError(504, '试听请求已停止。可以先到百炼查看是否已经生成该音色，再决定是否重试。');
    if (error instanceof PreviewError) throw error;
    throw new PreviewError(502, '暂时无法连接百炼。可以先到百炼查看本次音色的生成结果。');
  }
}
