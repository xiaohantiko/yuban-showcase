// Blank paragraphs in a personal QQ chat are separate messages. Keep lists,
// code, voice and non-conversational responses together.
export function chatParagraphs(message) {
  const text = message.text;
  if (message.kind !== 'chat' || message.voice || message.sources?.length
    || /(?:^```|^~~~|^\s*(?:[-*]|\d+[.)、])\s)/mu.test(text)) return [text];
  let parts = text.trim().split(/\n[\t ]*\n+/u).map(p => p.trim()).filter(Boolean);
  if (parts.length === 1 && text.length >= 52 && !/[“”「」『』"`]|https?:\/\//u.test(text)) {
    // A long conversational paragraph can contain a response followed by a
    // separate invitation. Preserve continuous narrative as one message.
    parts = text.split(/(?<=[。！？])\s*(?=要不|你愿意|你想|你觉得|我有时|换作我|我刚才|说起来)/u);
  }
  if (parts.length < 2) return [text];
  return parts.length <= 3 ? parts : [...parts.slice(0, 2), parts.slice(2).join('\n\n')];
}

export async function deliverReply({ adapter, target, message, text, audio, proactive, notice, isCurrent }) {
  const parts = !proactive && !audio && target.type === 'c2c' && message.kind === 'chat' ? chatParagraphs(message) : [text];
  let result;
  for (const [index, part] of parts.entries()) {
    if (index && !await isCurrent()) return null;
    const content = notice && index === parts.length - 1 ? part + '\n\n' + notice : part;
    result = await adapter.send(target, { text: content, audio, proactive, ...(index ? { sequence: index + 1 } : {}) });
  }
  return { voice: result?.voice };
}
