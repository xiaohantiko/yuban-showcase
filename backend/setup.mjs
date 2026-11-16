import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { chatCompletionBody } from './model-request.mjs';
import { meterModelRequest } from './usage.mjs';

export const setupRoute = '/api/setup';
export const setupModelRoute = `${setupRoute}/model`;
export const setupQQRoute = `${setupRoute}/qq`;

const modelBases = new Set([
  'https://api.deepseek.com',
  'https://api.deepseek.com/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://api.moonshot.cn/v1',
  'https://ark.cn-beijing.volces.com/api/v3',
  'https://api.openai.com/v1',
]);
const QQ_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function keyFor(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) return null;
  return Buffer.from(hkdfSync('sha256', token, 'yuban setup v1', 'authenticated setup credentials', 32));
}

function encrypt(kind, data, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(kind));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return `1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function decrypt(kind, data, key) {
  const parts = typeof data === 'string' ? /^1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{22})$/.exec(data) : null;
  if (!parts || !key) return null;
  try {
    const [nonce, ciphertext, tag] = parts.slice(1).map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(kind));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch { return null; }
}

function modelBase(value, httpsOnly = true) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

const configuredSecret = (value) => typeof value === 'string' && value.trim().length > 0;
const validSecret = (value) => typeof value === 'string' && /^[\x21-\x7e]{8,512}$/.test(value);

function credentials(kind, payload, env) {
  if (kind === 'model') {
    const baseUrl = modelBase(payload.baseUrl);
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
    // Only known vendor endpoints and a deployment-admin's exact configured custom gateway may receive a secret.
    if (!baseUrl || (!modelBases.has(baseUrl) && baseUrl !== modelBase(env.AI_BASE_URL))) {
      fail(400, '请选择支持的 HTTPS 模型地址。自定义网关需由部署管理员配置。');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) fail(400, '请输入有效的模型 ID。');
    if (!validSecret(apiKey)) fail(400, '请输入模型服务的 API Key。');
    return { baseUrl, model, apiKey };
  }
  if (kind !== 'qq') fail(404, '找不到这个配置。');
  const appId = typeof payload.appId === 'string' ? payload.appId.trim() : '';
  const clientSecret = typeof payload.clientSecret === 'string' ? payload.clientSecret.trim() : '';
  if (!/^[0-9]{4,32}$/.test(appId)) fail(400, '请输入 QQ 开放平台的数字 AppID。');
  if (!validSecret(clientSecret)) fail(400, '请输入 QQ 开放平台的 ClientSecret。');
  return { appId, clientSecret };
}

async function verify(kind, value, fetchImpl, onUsage) {
  const model = kind === 'model';
  const url = model ? `${value.baseUrl}/chat/completions` : QQ_TOKEN_URL;
  try {
    async function request(reportUsage) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(model ? { Authorization: `Bearer ${value.apiKey}` } : {}) },
        body: model ? chatCompletionBody(url, value.model, [{ role: 'user', content: '请只回复 OK。' }])
          : JSON.stringify({ appId: value.appId, clientSecret: value.clientSecret }),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (model) reportUsage(result?.usage);
      if (model ? !configuredSecret(result?.choices?.[0]?.message?.content)
        : !configuredSecret(result?.access_token) || !Number.isFinite(Number(result?.expires_in)) || Number(result.expires_in) <= 0) throw new Error();
    }
    if (model) {
      const label = value.model === value.apiKey ? null : value.model;
      await meterModelRequest({ onUsage, endpoint: url, model: label }, request);
    } else await request();
  } catch {
    fail(502, model ? '模型测试未通过，请检查 API Key、模型 ID 和调用权限。' : 'QQ 凭据测试未通过，请检查 AppID 和 ClientSecret。');
  }
}

export function createSetup(env, store, { fetchImpl = fetch, clock = Date.now, onUsage } = {}) {
  const key = keyFor(env.YUBAN_ADMIN_TOKEN);
  const canSave = Boolean(key);

  async function runtime() {
    const records = await store.load();
    const model = decrypt('model', records.model, key);
    const qq = decrypt('qq', records.qq, key);
    const modelSource = records.model !== undefined ? 'console' : env.AI_BASE_URL || env.AI_MODEL ? 'environment' : 'none';
    const qqSource = records.qq !== undefined ? 'console' : env.QQ_APP_ID || env.QQ_CLIENT_SECRET ? 'environment' : 'none';
    const modelNeedsRecovery = modelSource === 'console' && !model;
    const qqNeedsRecovery = qqSource === 'console' && !qq;
    const runtimeEnv = {
      ...env,
      AI_BASE_URL: modelSource === 'console' ? model?.baseUrl : env.AI_BASE_URL,
      AI_MODEL: modelSource === 'console' ? model?.model : env.AI_MODEL,
      AI_API_KEY: modelSource === 'console' ? model?.apiKey : env.AI_API_KEY,
      QQ_APP_ID: qqSource === 'console' ? qq?.appId : env.QQ_APP_ID,
      QQ_CLIENT_SECRET: qqSource === 'console' ? qq?.clientSecret : env.QQ_CLIENT_SECRET,
    };
    const baseUrl = modelBase(runtimeEnv.AI_BASE_URL, false);
    const qqConfigured = Boolean(configuredSecret(runtimeEnv.QQ_APP_ID) && configuredSecret(runtimeEnv.QQ_CLIENT_SECRET));
    const qqScope = qq?.appId && qq.appId !== env.QQ_APP_ID ? qq.appId : null;
    const qqVerifiedKey = qq ? `qq:${createHash('sha256').update(JSON.stringify([qq.appId, qq.clientSecret])).digest('hex')}` : 'qq';
    return {
      env: runtimeEnv,
      qqScope,
      qqVerifiedKey,
      status: {
        canSave,
        model: {
          configured: Boolean(baseUrl && configuredSecret(runtimeEnv.AI_MODEL)), source: modelSource,
          baseUrl: modelBases.has(baseUrl) ? baseUrl : null, model: runtimeEnv.AI_MODEL || null,
          hasApiKey: configuredSecret(runtimeEnv.AI_API_KEY), testedAt: model?.testedAt ?? null,
          needsRecovery: modelNeedsRecovery,
        },
        qq: {
          configured: qqConfigured, source: qqSource, appId: runtimeEnv.QQ_APP_ID || null,
          testedAt: qq?.testedAt ?? null, needsRecovery: qqNeedsRecovery,
        },
      },
    };
  }

  async function save(kind, payload) {
    if (!canSave) fail(503, '请先配置至少 32 位随机字符的管理台口令。');
    const data = credentials(kind, payload, env);
    await verify(kind, data, fetchImpl, onUsage);
    await store.save(kind, encrypt(kind, { ...data, testedAt: clock() }, key));
    return (await runtime()).status;
  }

  return { runtime, save };
}
