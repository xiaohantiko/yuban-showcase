import { isJSONContentType } from './ai-auth.mjs';
import { designVoicePreview, PreviewError, validateDesignPreview } from './bailian-voice-preview.mjs';

export const voiceDesignRoute = '/api/voice/design-preview';
const cooldown = 15_000;
const day = 86_400_000;
const dailyLimit = 12;

// Each Node tenant and each single-account Worker has its own timestamp list.
// A reservation survives failed or interrupted calls which may have created a billed voice.
export function previewReservation(attempts, now) {
  const recent = attempts.filter(at => at > now - day);
  const next = Math.max((recent.at(-1) ?? -Infinity) + cooldown,
    recent.length >= dailyLimit ? recent[0] + day : -Infinity);
  if (next > now) return { retryAfter: Math.ceil((next - now) / 1000) };
  return { attempts: [...recent, now] };
}

function errorResponse(status, error, headers = {}) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export async function voiceDesignResponse({ method, username, accountHint, trustedOrigin, contentType, readInput, reserve, fetchImpl, signal }) {
  if (!username || (accountHint && accountHint !== encodeURIComponent(username))) {
    return errorResponse(401, '请先登录宇伴账号。', { 'X-Yuban-Login': '1' });
  }
  if (method !== 'POST') return errorResponse(405, '请使用 POST 请求。', { Allow: 'POST' });
  if (!trustedOrigin) return errorResponse(403, '请在自己的宇伴管理台申请试听。');
  if (!isJSONContentType(contentType)) return errorResponse(415, '需要 application/json');
  const data = await readInput();
  if (Object.keys(data).some(name => !['apiKey', 'workspaceId', 'description', 'previewText'].includes(name))) {
    return errorResponse(400, '试听表单包含不支持的字段。');
  }
  let input;
  try { input = validateDesignPreview(data); }
  catch (error) {
    return errorResponse(400, error instanceof PreviewError && error.status === 400 ? error.message : '请检查百炼试听表单。');
  }
  if (signal?.aborted) return errorResponse(408, '试听请求已取消。');
  let retryAfter;
  try { ({ retryAfter } = await reserve()); }
  catch (error) {
    if (error?.status === 403) return errorResponse(403, '当前账号无法发起试听。');
    return errorResponse(503, '暂时无法登记试听次数，请稍后再试。');
  }
  if (retryAfter) return errorResponse(429, '请稍后再试听。同一账号每 15 秒可生成一次，滚动 24 小时内最多 12 次。', { 'Retry-After': String(retryAfter) });
  try {
    const result = await designVoicePreview(input, { fetchImpl, signal });
    return new Response(result.bytes, { headers: {
      'Content-Type': result.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Yuban-Voice-Id': result.voiceId,
    } });
  } catch (error) {
    // Only this adapter can translate an upstream failure into a user-visible local message.
    if (error instanceof PreviewError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      return errorResponse(error.status, error.message);
    }
    return errorResponse(502, '暂时无法取得试听音频，请稍后在百炼控制台查看生成结果。');
  }
}
