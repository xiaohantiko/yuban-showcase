import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function setupFile(file) {
  let records;
  try { records = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    records = {};
  }
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('无法读取加密配置');
  return {
    load: () => records,
    save(kind, payload) {
      const next = { ...records, [kind]: payload };
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      records = next;
    },
  };
}
