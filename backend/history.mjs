export const MAX_STORED_MESSAGES = 40;
export const MAX_CHAT_MESSAGES = 20;
export const MAX_CHAT_CHARACTERS = 6_000;
const MAX_STORED_TEXT = 2_000;

function clip(text, max) {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

function isMessage(message) {
  return (message?.role === 'user' || message?.role === 'assistant') && typeof message.text === 'string' && message.text.length > 0;
}

export function boundStoredHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_STORED_MESSAGES).filter(isMessage).map(({ id, role, text, at, kind, voice, sources }) => ({
    ...(typeof id === 'string' ? { id: clip(id, 80) } : {}),
    role, text: clip(text, MAX_STORED_TEXT),
    ...(Number.isFinite(at) ? { at } : {}),
    ...(kind === 'greeting' || kind === 'search' ? { kind } : {}),
    ...(voice === true ? { voice } : {}),
    ...(Array.isArray(sources) && sources.length ? {
      sources: sources.slice(0, 5).filter((source) => typeof source?.title === 'string'
        && typeof source.url === 'string' && source.url.length <= 2_048 && /^https?:\/\//i.test(source.url))
        .map(({ title, url }) => ({ title: clip(title, 160), url })),
    } : {}),
  }));
}

export function boundedChatContext(messages, latestText, { story = false } = {}) {
  const latest = clip(latestText, story ? MAX_CHAT_CHARACTERS : MAX_STORED_TEXT);
  const recent = [{ role: 'user', text: latest }];
  let remaining = MAX_CHAT_CHARACTERS - latest.length;
  const oldest = Math.max(0, messages.length - (MAX_CHAT_MESSAGES - 1));
  for (let index = messages.length - 1; index >= oldest && remaining > 0; index--) {
    const message = messages[index];
    if (!isMessage(message)) continue;
    const text = clip(message.text, Math.min(MAX_STORED_TEXT, remaining));
    if (!text) break;
    recent.push({ role: message.role, text, ...(message.kind === 'greeting' ? { kind: message.kind } : {}) });
    remaining -= text.length;
  }
  return recent.reverse();
}
