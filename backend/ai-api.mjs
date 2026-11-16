const textLimit = 2_000;
const historyLimit = 16;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function validateText(value, field) {
  if (typeof value !== 'string' || value.length > textLimit || !value.trim()) {
    fail(400, `${field} 需要是 1–${textLimit} 个字符的文本`);
  }
  return value.trim();
}

function sourcesFor(result) {
  const sources = [];
  for (const source of Array.isArray(result.sources) ? result.sources : []) {
    if (typeof source?.title !== 'string' || !source.title.trim() || typeof source.url !== 'string') continue;
    try {
      const url = new URL(source.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
      sources.push({ title: source.title.trim().slice(0, 240), url: url.href });
      if (sources.length === 5) break;
    } catch { /* Discard malformed upstream links. */ }
  }
  return sources;
}

export async function handleAIReply(providers, payload, { companionName, companionPersona } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, '请求体需要是 JSON 对象');
  const { mode = 'chat', history = [] } = payload;
  if (mode !== 'chat' && mode !== 'search') fail(400, 'mode 必须是 chat 或 search');
  const message = validateText(payload.message, 'message');
  if (!Array.isArray(history) || history.length > historyLimit) fail(400, `history 需要是最多 ${historyLimit} 条消息的数组`);
  const messages = history.map((entry, index) => {
    if (entry?.role !== 'user' && entry?.role !== 'assistant') {
      fail(400, `history[${index}].role 必须是 user 或 assistant`);
    }
    return { role: entry.role, text: validateText(entry.text, `history[${index}].text`) };
  });
  messages.push({ role: 'user', text: message });

  if (mode === 'chat' && !providers.modelConfigured) fail(503, '尚未配置 AI 模型');
  if (mode === 'search' && (!providers.searchConfigured || !providers.searchProvider)) fail(503, '尚未配置资料检索');

  const upstreamError = mode === 'chat' ? 'AI 模型暂时无法回复' : '资料检索暂时无法回复';
  let result;
  try {
    result = await providers.reply({ messages, mode, companionName, companionPersona, strict: true });
  } catch {
    fail(502, upstreamError);
  }
  if (typeof result?.text !== 'string' || !result.text.trim()) fail(502, upstreamError);
  return {
    text: result.text,
    sources: sourcesFor(result),
    mode,
    provider: mode === 'chat' ? 'model' : providers.searchProvider,
  };
}
