const DSH_PORTABLE = (() => {
  const personaLimit = 1000;
  const noteLimit = 160;
  const noteCount = 8;
  const lineBreaks = /\r\n|[\r\n\u0085\u2028\u2029]/u;
  const fenceStart = /^(`{3,}|~{3,})(.*)$/u;
  const listMarker = /^(?:[-+*]|\d{1,4}[.)])\s+/u;
  const horizontalRule = /^(?:(?:[-*_]\s*){3,}|={3,})$/u;

  // Mirror the private-note checks on the relay, with extra filters for imports.
  const privateData = /密码|口令|验证码|密钥|秘钥|访问令牌|身份证|护照号|银行卡|信用卡|手机号|电话号码|住址|家庭地址|家里地址|详细地址|电子邮箱|邮箱地址|私人病历|医疗记录|确诊|患有|\b(?:password|passcode|api[ _-]*key|private[ _-]*key|client[ _-]*secret|access[ _-]*token|refresh[ _-]*token|credit[ _-]*card|phone[ _-]*number|passport[ _-]*number)\b|\b(?:authorization|secret|token)\s*[:=]|\bbearer\s+\S|\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b|[0-9]{8,}/iu;
  const credential = /(?:-----\s*(?:BEGIN|END)\s+[^-]*KEY\s*-----|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA)[\w-]{8,}|\b[A-Za-z0-9+/_-]{32,}={0,2}\b|^(?:export\s+)?[A-Za-z][\w-]*_(?:key|token|secret|password)\s*[:=])/iu;
  const secretLabel = /^(?:密码|口令|验证码|密钥|password|passcode|(?:api|private)[ _-]*key|secret|token)\s*[:=]\s*$/iu;
  const link = /\[[^\]]*\]|[<>]|\b(?:https?|ftp|file|mailto|ssh|git|data)\s*:|\b(?:www\.|[a-z0-9-]+\.(?:[a-z]{2,24}|xn--[a-z0-9-]+)\b|(?:\d{1,3}\.){3}\d{1,3}\b)/iu;
  const path = /[A-Za-z]:[\\/]|[\\/][\p{L}\p{N}_.~%$-]|[\p{L}\p{N}_.-]+\.(?:md|txt|jsonl?|ya?ml|ini|env|sqlite3?|db|csv|pem|key|pdf|docx?|sh|ps1|m?[jt]sx?|jpe?g|png|svg)\b|(?:^|\s)\.(?:env|ssh|dsh)\b/iu;
  const command = /^(?:记住|忘记|开启记忆|关闭记忆|查看记忆|清空记忆|插件(?:身份)?)(?:[\s：:。！!]|$)|^(?:[$/>#]|(?:curl|sudo|git clone|npm install|pnpm add|chmod)\s)|(?:忽略|无视).{0,12}(?:指令|提示词)|(?:ignore|disregard).{0,20}(?:instructions?|system prompt)/iu;

  function prefix(text, maxLength) {
    const preview = text.slice(0, maxLength);
    return preview.replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
  }

  function parsePersona(raw) {
    const text = typeof raw === 'string' ? raw.replace(/\r\n?/gu, '\n').trim() : '';
    const originalLength = text.length;
    const truncated = originalLength > personaLimit;
    return { text: truncated ? prefix(text, personaLimit) : text, originalLength, truncated };
  }

  function unsafeNote(text) {
    const check = text.replace(/\p{Cf}/gu, '').normalize('NFKC');
    return /\p{Cc}/u.test(check) || privateData.test(check) || credential.test(check)
      || link.test(check) || path.test(check) || command.test(check);
  }

  function plainNote(line) {
    if (!line || /^#{1,6}(?:\s|$)/u.test(line) || horizontalRule.test(line) || line.startsWith('|')) return '';
    const content = line.replace(/^\[[ xX]\]\s+/u, '').replace(/\t/gu, ' ');
    if (unsafeNote(content)) return '';
    const clean = content
      .replace(/~~[^~]+~~/gu, '')
      .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/gu, '$2')
      .replace(/[\p{Cf}`]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!/\p{L}/u.test(clean) || unsafeNote(clean)) return '';
    return clean.length > noteLimit ? `${prefix(clean, noteLimit - 1)}…` : clean;
  }

  function parseMemory(raw) {
    const source = typeof raw === 'string' ? raw : '';
    const sourceLines = source.split(lineBreaks);
    const lines = source.replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) => comment.replace(/[^\r\n\u0085\u2028\u2029]/gu, ' ')).split(lineBreaks);
    const first = lines.findIndex((line) => line.trim());
    let frontMatter = first >= 0 && lines[first].trim() === '---';
    let fence = null;
    let secretContinues = false;
    let skipped = 0;
    let capped = false;
    const seen = new Set();
    const candidates = [];

    for (const [index, rawLine] of lines.entries()) {
      if (!sourceLines[index].trim()) continue;
      const unquoted = rawLine.trim().replace(/^(?:>\s*)+/u, '');
      const line = unquoted.replace(listMarker, '').trim();
      const match = (fence ? unquoted : line).match(fenceStart);
      let note = '';
      if (frontMatter && index >= first) {
        if (index > first && /^(?:---|\.\.\.)\s*$/u.test(rawLine)) frontMatter = false;
      } else if (fence) {
        if (match && match[1].startsWith(fence) && !match[2].trim()) fence = null;
      } else if (match) {
        fence = match[1];
      } else if (secretContinues) {
        if (line) secretContinues = false;
      } else if (secretLabel.test(line.normalize('NFKC'))) {
        secretContinues = true;
      } else if (!/^(?: {4}|\t)/u.test(rawLine) && !/^(?:=+|-+)\s*$/u.test(lines[index + 1]?.trim() ?? '')) {
        note = plainNote(line);
      }

      const key = note.normalize('NFKC').toLowerCase().replace(/[.!?。！？\s]+$/u, '');
      if (!note || seen.has(key)) {
        skipped += 1;
        continue;
      }
      if (candidates.length >= noteCount) {
        capped = true;
        continue;
      }
      seen.add(key);
      candidates.push({ text: note, command: `记住 ${note}` });
    }
    return { candidates, skipped, capped };
  }

  return Object.freeze({ parsePersona, parseMemory });
})();
