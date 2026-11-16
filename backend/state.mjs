import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { boundStoredHistory } from './history.mjs';
import { readSettings } from './logic.mjs';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function ownerChannelKey(owner) {
  if (!owner || !Number.isFinite(owner.boundAt) || typeof owner.id !== 'string') return null;
  return hash(['owner', owner.transport, owner.scope, owner.id, owner.boundAt].join('\0'));
}

function writeJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Keep the original write error. */ }
    throw error;
  }
}

export function openState(file) {
  let current;
  try { current = JSON.parse(readFileSync(file, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const state = {
    settings: readSettings(current?.settings),
    channels: Object.assign(Object.create(null), current?.channels),
    owner: current?.owner ?? null,
    ownerClaim: current?.ownerClaim ?? null,
    logs: current?.logs ?? [], seen: current?.seen ?? [],
  };
  function save() {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const activeKey = ownerChannelKey(state.owner);
    const active = activeKey ? state.channels[activeKey] : null;
    const detached = Object.keys(state.channels).filter(key => key !== activeKey);
    const channels = Object.create(null);
    if (active) channels[activeKey] = { ...active, messages: boundStoredHistory(active.messages) };

    if (detached.length) {
      const archive = `${file}.archive`;
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      for (const key of detached) {
        // Preserve detached data before the hot file stops referencing it. These files are never read on a reply.
        writeJSON(join(archive, `${hash(key)}.json`), { key, thread: state.channels[key] });
      }
    }
    writeJSON(file, { ...state, channels });
    if (active) active.messages = channels[activeKey].messages;
    for (const key of detached) delete state.channels[key];
  }

  const activeKey = ownerChannelKey(state.owner);
  const messages = activeKey ? state.channels[activeKey]?.messages : null;
  if (Object.keys(state.channels).some(key => key !== activeKey)
    || (messages && JSON.stringify(messages) !== JSON.stringify(boundStoredHistory(messages)))) save();
  return { state, save };
}
