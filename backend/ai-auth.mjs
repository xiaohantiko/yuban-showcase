import { createHash, timingSafeEqual } from 'node:crypto';

const validToken = /^[A-Za-z0-9._~-]{32,256}$/;
export const aiRoute = '/api/ai/reply';

export function configuredAIToken(env) {
  const token = env.YUBAN_AI_API_TOKEN;
  return typeof token === 'string' && validToken.test(token) && token !== env.YUBAN_ADMIN_TOKEN ? token : null;
}

export function hasAIBearer(authorization, token) {
  const match = typeof authorization === 'string' && /^Bearer +([A-Za-z0-9._~-]{32,256})$/i.exec(authorization);
  if (!match || !token) return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}

export function isJSONContentType(value) {
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}
