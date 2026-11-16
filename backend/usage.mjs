const timeZone = 'Asia/Shanghai';
const dayMs = 86_400_000;
const localOffset = 8 * 60 * 60_000;
const retentionDays = 30;
const maxReportedTokens = 1_000_000_000;
export const usageMaxModelsPerDay = 16;
export const usageOverflowProvider = 'other';
export const usageOverflowModel = '(other-models)';

const providerOrigins = new Map([
  ['https://api.openai.com', 'openai'],
  ['https://api.deepseek.com', 'deepseek'],
  ['https://dashscope.aliyuncs.com', 'qwen'],
  ['https://ark.cn-beijing.volces.com', 'doubao'],
  ['https://api.moonshot.cn', 'kimi'],
]);
const providerNames = new Set([...providerOrigins.values(), 'compatible']);
const totalFields = ['requests', 'reported', 'unreported', 'failed', 'inputTokens', 'outputTokens', 'totalTokens'];
const usageFields = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const modelKey = (provider, model) => `${provider}\0${model}`;

export function usageProvider(baseUrl) {
  try { return providerOrigins.get(new URL(baseUrl).origin) ?? 'compatible'; }
  catch { return 'compatible'; }
}

function labels(provider, model) {
  if (typeof model !== 'string' || !modelId.test(model) || model.includes('://') || /^sk-[A-Za-z0-9_-]{12,}$/.test(model)) {
    return { provider: usageOverflowProvider, model: usageOverflowModel };
  }
  return { provider: providerNames.has(provider) ? provider : 'compatible', model };
}

function actualUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  if (!usageFields.every((field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0 && usage[field] <= maxReportedTokens)) return null;
  return Object.fromEntries(usageFields.map((field) => [field, usage[field]]));
}

const dateOf = (timestamp) => new Date(timestamp + localOffset).toISOString().slice(0, 10);
const zero = () => Object.fromEntries(totalFields.map((field) => [field, 0]));
const validCounter = (number) => Number.isSafeInteger(number) && number >= 0 ? number : 0;

function add(destination, source) {
  for (const field of totalFields) destination[field] = Math.min(Number.MAX_SAFE_INTEGER, destination[field] + validCounter(source[field]));
}

// The callback receives only safe labels and the supplier's numeric usage. The model's consumer
// decides whether its completion is usable while the reported tokens remain actual supplier counts.
export async function meterModelRequest({ onUsage, endpoint, model }, request) {
  let outcome = 'failed';
  let usage = null;
  try {
    const result = await request((value) => { if (onUsage) usage = actualUsage(value); });
    outcome = 'ok';
    return result;
  } finally {
    if (typeof onUsage === 'function') {
      try { await onUsage({ ...labels(usageProvider(endpoint), model), usage, outcome }); }
      catch { /* A metering failure must not change the model request outcome. */ }
    }
  }
}

export function createUsageTracker({ store, clock = Date.now }) {
  async function record({ provider, model, usage, outcome } = {}) {
    const observed = actualUsage(usage);
    const label = labels(provider, model);
    const failed = outcome === 'failed';
    const counters = {
      requests: 1,
      reported: Number(!failed && observed !== null),
      unreported: Number(!failed && observed === null),
      failed: Number(failed),
      inputTokens: observed?.prompt_tokens ?? 0,
      outputTokens: observed?.completion_tokens ?? 0,
      totalTokens: observed?.total_tokens ?? 0,
    };
    try { await store.record(dateOf(clock()), label.model, { ...label, ...counters }); }
    catch { /* A metering failure must not change the chat or setup result. */ }
  }

  async function snapshot() {
    const now = clock();
    const byDay = Array.from({ length: retentionDays }, (_, index) => ({
      date: dateOf(now - (retentionDays - 1 - index) * dayMs), ...zero(),
    }));
    const days = new Map(byDay.map((row) => [row.date, row]));
    const byKey = new Map();
    const last30Days = zero();
    for (const row of await store.recent(byDay[0].date)) {
      if (!days.has(row?.date) || !validCounter(row.requests)) continue;
      const { provider, model } = labels(row.provider, row.model);
      const key = modelKey(provider, model);
      if (!byKey.has(key)) byKey.set(key, { provider, model, ...zero() });
      add(byKey.get(key), row);
      add(days.get(row.date), row);
      add(last30Days, row);
    }
    const overflow = byKey.get(modelKey(usageOverflowProvider, usageOverflowModel))
      ?? { provider: usageOverflowProvider, model: usageOverflowModel, ...zero() };
    const models = [...byKey.values()].filter((row) => row !== overflow)
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests
        || modelKey(a.provider, a.model).localeCompare(modelKey(b.provider, b.model), 'en'));
    const byModel = models.slice(0, usageMaxModelsPerDay);
    for (const row of models.slice(usageMaxModelsPerDay)) add(overflow, row);
    if (overflow.requests) byModel.push(overflow);
    const today = zero();
    add(today, byDay.at(-1));
    return {
      timeZone, trackingSince: byDay.find(({ requests }) => requests > 0)?.date ?? null, today, last30Days, byDay, byModel,
    };
  }

  return { record, snapshot };
}
