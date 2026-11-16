import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const pageSize = 20;
const retained = 500;
const dailyLimit = 5;
const dayMs = 86_400_000;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function readFeedback(file) {
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { items: [], attempts: [] };
    throw error;
  }
  if (saved?.version !== 1 || !Array.isArray(saved.items) || saved.items.length > retained
    || !saved.items.every(item => Number.isSafeInteger(item?.createdAt)
      && [item.id, item.username, item.title, item.message].every(value => typeof value === 'string'))
    || !Array.isArray(saved.attempts) || !saved.attempts.every(item => typeof item?.accountId === 'string' && Number.isSafeInteger(item.at))) {
    throw new Error('无法读取反馈记录。');
  }
  return saved;
}

function writeFeedback(file, items, attempts) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, items, attempts }), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Keep the original write error. */ }
    throw error;
  }
}

function feedbackText(value, minimum, maximum, label) {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  const length = [...text].length;
  if (length < minimum || length > maximum) fail(400, `${label}需要 ${minimum} 至 ${maximum} 个字符。`);
  return text;
}

export function createFeedbackStore({ stateFile, clock = Date.now }) {
  const file = `${resolve(stateFile)}.feedback.json`;
  return {
    submit(account, input) {
      if (typeof account?.id !== 'string' || !account.id || typeof account.username !== 'string' || !account.username) {
        fail(400, '无法识别提交反馈的账号。');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'title' && key !== 'message')) {
        fail(400, '反馈只接受标题和问题描述。');
      }
      const title = feedbackText(input.title, 3, 80, '反馈标题');
      const message = feedbackText(input.message, 8, 2_000, '问题描述');
      const createdAt = clock();
      const { items, attempts } = readFeedback(file);
      const recent = attempts.filter(item => item.at > createdAt - dayMs);
      if (recent.filter(item => item.accountId === account.id).length >= dailyLimit) {
        fail(429, `每个账号在 24 小时内最多提交 ${dailyLimit} 条反馈。`);
      }
      const id = randomUUID();
      const item = { id, username: account.username, createdAt, title, message };
      writeFeedback(file, [item, ...items].slice(0, retained), [...recent, { accountId: account.id, at: createdAt }]);
      return { id, createdAt };
    },

    list(offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) fail(400, '反馈分页位置无效。');
      const { items } = readFeedback(file);
      return {
        items: items.slice(offset, offset + pageSize).map(({ id, username, createdAt, title, message }) => ({ id, username, createdAt, title, message })),
        total: items.length,
        offset,
        limit: pageSize,
      };
    },
  };
}
