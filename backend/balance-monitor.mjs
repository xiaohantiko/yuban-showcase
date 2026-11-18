import { balanceCredentialId, confirmBalanceNotice, prepareBalanceNotice, readModelBalance } from './balance.mjs';

const CHECK_INTERVAL = 15 * 60_000;
const REFRESH_INTERVAL = 60_000;
const CHECK_LEASE = 10_000;
const NOTICE_MAX_AGE = 30 * 60_000;

export function createBalanceMonitor({ store, getEnv, fetchImpl = fetch, clock = Date.now, signal }) {
  async function context() {
    const env = await getEnv();
    return { env, credentialId: await balanceCredentialId(env) };
  }

  async function snapshot(scope = null) {
    const { env, credentialId } = await context();
    let value;
    try { ({ value } = await store.read()); }
    catch {
      return { status: 'unavailable', provider: credentialId ? 'deepseek' : null, currency: null,
        totalBalance: null, low: null, checkedAt: null, refreshing: false,
        notification: { pending: false, notified: false } };
    }
    const balance = credentialId && value.balance?.credentialId === credentialId ? value.balance : null;
    const inactive = credentialId ? null : await readModelBalance(env, { fetchImpl, clock, signal });
    const current = balance ?? inactive;
    const pending = balance && clock() - balance.checkedAt <= NOTICE_MAX_AGE
      ? prepareBalanceNotice(value.notice, { balance, scope }) : null;
    const notified = Boolean(scope && value.notice?.scope === scope && value.notice.credentialId === credentialId && value.notice.notified);
    return {
      status: current?.status ?? 'not-checked',
      provider: credentialId ? 'deepseek' : null,
      currency: current?.status === 'ok' ? current.currency : null,
      totalBalance: current?.status === 'ok' ? current.totalBalance : null,
      low: current?.status === 'ok' ? current.low : null,
      checkedAt: balance?.checkedAt ?? null,
      refreshing: Boolean(credentialId && value.checkingCredentialId === credentialId && value.checkingUntil > clock()),
      notification: { pending: Boolean(pending?.notice), notified },
    };
  }

  async function refresh(scope = null, { force = false } = {}) {
    const { env, credentialId } = await context();
    if (!credentialId || signal?.aborted) return false;
    const now = clock();
    const checkId = crypto.randomUUID();
    let claimed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await store.read();
      const current = previous.value;
      const sameCredential = current.checkingCredentialId === credentialId;
      if (sameCredential && (current.checkingUntil > now
        || (force ? current.lastAttemptAt + REFRESH_INTERVAL > now : current.nextCheckAt > now))) return false;
      const next = { ...current, checkId, checkingCredentialId: credentialId, checkingUntil: now + CHECK_LEASE,
        lastAttemptAt: now, nextCheckAt: now + CHECK_INTERVAL };
      if (await store.compareAndSet(previous, next)) { claimed = true; break; }
    }
    if (!claimed) return false;
    const balance = await readModelBalance(env, { fetchImpl, clock, signal });
    if (signal?.aborted || (await context()).credentialId !== credentialId) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await store.read();
      if (previous.value.checkId !== checkId || signal?.aborted) return false;
      const { state } = prepareBalanceNotice(previous.value.notice, { balance, scope });
      const next = { ...previous.value, balance, notice: state, checkingUntil: 0,
        nextCheckAt: clock() + (balance.status === 'ok' ? CHECK_INTERVAL : REFRESH_INTERVAL) };
      if (await store.compareAndSet(previous, next)) return true;
    }
    return false;
  }

  async function pending(scope, { proactive = false, companionName, companionPersona } = {}) {
    if (!scope || signal?.aborted) return null;
    const { credentialId } = await context();
    if (!credentialId) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await store.read();
      const balance = previous.value.balance;
      if (balance?.credentialId !== credentialId || clock() - balance.checkedAt > NOTICE_MAX_AGE) return null;
      const prepared = prepareBalanceNotice(previous.value.notice, { balance, scope, companionName, companionPersona });
      if (!prepared.notice || (proactive && previous.value.proactiveReceipt === prepared.receipt)) return null;
      const next = { ...previous.value, notice: prepared.state,
        ...(proactive ? { proactiveReceipt: prepared.receipt } : {}) };
      if (await store.compareAndSet(previous, next)) {
        return { text: prepared.notice, receipt: prepared.receipt, scope, credentialId };
      }
    }
    return null;
  }

  async function isCurrent(ticket) {
    if (!ticket || signal?.aborted || ticket.credentialId !== (await context()).credentialId) return false;
    const { value } = await store.read();
    const balance = value.balance;
    const notice = value.notice;
    return balance?.status === 'ok' && balance.low === true && balance.credentialId === ticket.credentialId
      && clock() - balance.checkedAt <= NOTICE_MAX_AGE && notice?.scope === ticket.scope
      && notice.credentialId === ticket.credentialId && notice.low === true
      && notice.notified === false && notice.receipt === ticket.receipt;
  }

  async function confirm(ticket) {
    if (!ticket || !await isCurrent(ticket)) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await store.read();
      const current = previous.value.notice;
      if (current?.scope !== ticket.scope || current.credentialId !== ticket.credentialId) return false;
      const notice = confirmBalanceNotice(current, ticket.receipt);
      if (notice === current) return false;
      if (await store.compareAndSet(previous, { ...previous.value, notice })) return true;
    }
    return false;
  }

  return { snapshot, refresh, pending, isCurrent, confirm };
}
