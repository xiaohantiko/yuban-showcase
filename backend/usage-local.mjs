import { setupFile } from './setup-local.mjs';
import { usageMaxModelsPerDay, usageOverflowModel, usageOverflowProvider } from './usage.mjs';

const counterNames = ['requests', 'reported', 'unreported', 'failed', 'inputTokens', 'outputTokens', 'totalTokens'];

export function usageFile(file) {
  let storage;
  function read() {
    storage ??= setupFile(file);
    const rows = storage.load().rows ?? [];
    if (!Array.isArray(rows)) throw new Error('无法读取模型用量记录');
    return rows;
  }

  return {
    record(date, model, entry) {
      const first = new Date(Date.parse(`${date}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      const rows = read().filter((row) => row.date >= first && row.date <= date);
      const day = rows.filter((row) => row.date === date);
      let provider = entry.provider;
      let index = rows.findIndex((row) => row.date === date && row.provider === provider && row.model === model);
      const named = day.filter((row) => row.model !== usageOverflowModel).length;
      if (index === -1 && named >= usageMaxModelsPerDay) {
        provider = usageOverflowProvider;
        model = usageOverflowModel;
        index = rows.findIndex((row) => row.date === date && row.provider === provider && row.model === model);
      }
      const previous = rows[index];
      const updated = { date, provider, model };
      for (const name of counterNames) {
        updated[name] = Math.min(Number.MAX_SAFE_INTEGER, (previous?.[name] ?? 0) + entry[name]);
      }
      if (index === -1) rows.push(updated);
      else rows[index] = updated;
      storage.save('rows', rows);
    },
    recent(since) {
      return read().filter((row) => row.date >= since);
    },
  };
}
