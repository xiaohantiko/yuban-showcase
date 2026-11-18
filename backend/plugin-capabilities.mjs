import { handleMemoryCommand, readMemory } from './memory.mjs';

export const dshPluginIDs = Object.freeze(['agent-md', 'remember', 'memory', 'chain']);
const knownPlugins = new Set(dshPluginIDs);
const memoryPlugins = new Set(['remember', 'memory']);
const unsafeImport = /(?:-----\s*(?:BEGIN|END)\s+[^-]*KEY\s*-----|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA)[\w-]{8,}|\b[A-Za-z0-9+/_-]{32,}={0,2}\b|\b(?:authorization|secret|token)\s*[:=]|\bbearer\s+\S|\[[^\]]*\]|[<>]|\b(?:https?|ftp|file|mailto|ssh|git|data)\s*:|\bwww\.|[A-Za-z]:[\\/]|[\\/][\p{L}\p{N}_.~%$-]|^(?:记住|忘记|开启记忆|关闭记忆|查看记忆|清空记忆|插件(?:身份)?)(?:[\s：:。！!]|$)|^(?:[$/>#]|(?:curl|sudo|git clone|npm install|pnpm add|chmod)\s)|(?:忽略|无视).{0,12}(?:指令|提示词)|(?:ignore|disregard).{0,20}(?:instructions?|system prompt))/iu;

export function selectedPlugins(settings) {
  return Array.isArray(settings?.dshPlugins)
    ? [...new Set(settings.dshPlugins.filter(id => knownPlugins.has(id)))].slice(0, dshPluginIDs.length) : [];
}

export function allowsChainChat(settings, text) {
  const managed = settings?.dshChainManaged === true || selectedPlugins(settings).includes('chain');
  return !managed || selectedPlugins(settings).includes('chain')
    || !/^插件\s+chain_about(?:\s|$)/u.test(String(text ?? '').trim());
}

export function pluginCapabilities(settings, { dsh, memoryReady = false } = {}) {
  const personaReady = typeof settings?.companionPersona === 'string' && Boolean(settings.companionPersona.trim());
  const memoryAllowed = settings?.memoryEnabled !== false;
  return selectedPlugins(settings).map(id => {
    if (id === 'chain') return { id, mode: 'gateway', capabilities: ['chain-readonly'],
      status: dsh?.configured === true && dsh.tools?.includes('chain_about') ? 'ready' : 'needs-setup' };
    const capabilities = id === 'agent-md' ? ['persona-import'] : id === 'remember' ? ['memory-import'] : ['persona-import', 'memory-import'];
    const ready = capabilities.includes('persona-import') && personaReady
      || capabilities.includes('memory-import') && memoryAllowed && memoryReady;
    return { id, mode: 'portable', capabilities, status: ready ? 'ready'
      : id === 'agent-md' || id === 'memory' ? 'needs-content' : memoryAllowed ? 'needs-memory' : 'paused' };
  });
}

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

export function importPluginMemory(value, { settings, plugin, notes } = {}) {
  if (!memoryPlugins.has(plugin) || !selectedPlugins(settings).includes(plugin)) fail(409, '请先把这个插件添加到正在使用。');
  if (settings?.memoryEnabled === false) fail(409, '当前账号已暂停记忆。请先在人设与记忆中开启，再从绑定的 QQ 确认。');
  let memory = readMemory(value);
  if (!memory.enabled) fail(409, '请先在本人已绑定的 QQ 单聊发送「开启记忆」，再导入选中的内容。');
  if (!Array.isArray(notes) || notes.length < 1 || notes.length > 8) fail(400, '每次请选择 1 至 8 条记忆。');
  let added = 0;
  let duplicates = 0;
  for (const raw of notes) {
    if (typeof raw !== 'string' || /[\p{C}\p{Zl}\p{Zp}]/u.test(raw)) fail(400, '记忆需要是简短的单行文字。');
    const note = raw.replace(/\s+/gu, ' ').trim();
    if (!note || note.length > 160) fail(400, '每条记忆最多 160 字。');
    if (unsafeImport.test(note.normalize('NFKC'))) fail(400, '选中的内容含链接、路径、指令或疑似凭据，请重新选择普通的日常记忆。');
    if (memory.notes.includes(note)) { duplicates++; continue; }
    if (memory.notes.length >= 48) fail(409, '记忆已满。请在 QQ 查看记忆并删除不需要的内容后重试。');
    const result = handleMemoryCommand(memory, `记住 ${note}`, { allowed: true, privateChat: true });
    if (!result?.memory.notes.includes(note)) fail(400, '选中的内容无法保存。请去掉联系方式、密钥等隐私，再重新选择。');
    memory = result.memory;
    added++;
  }
  return { memory, added, duplicates };
}
