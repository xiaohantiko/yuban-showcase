import { createHash, randomBytes } from 'node:crypto';

const claimTTL = 10 * 60_000;
const claimCode = /^YB-[0-9A-F]{12}$/i;
const embeddedClaimCode = /YB-[0-9A-F]{12}/i;
const ownerCommand = /^(?:[/#]\s*)?(认领主人|叫我)(?=$|[\p{Cc}\s:：，,。！!])([\s\S]*)$/u;
const qqIdentifier = /^[a-z0-9_=-]{1,128}$/i;
const oneBotIdentifier = /^[1-9][0-9]{0,19}$/;

export function normalizeOwnerName(value = '') {
  const name = typeof value === 'string' ? value.trim() : null;
  if (name === null || name.length > 20 || /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(name)) {
    throw new Error('称呼需为单行文本，最多 20 个字符');
  }
  if (embeddedClaimCode.test(name)) throw new Error('请用昵称作为称呼，别填认领码');
  return name;
}

function digest(code) {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

export function createOwnerClaim(name, now = Date.now()) {
  const ownerName = normalizeOwnerName(name);
  const code = `YB-${randomBytes(6).toString('hex').toUpperCase()}`;
  return {
    command: `认领主人 ${code}`,
    record: { digest: digest(code), expiresAt: now + claimTTL, name: ownerName },
  };
}

export function parseOwnerCommand(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(ownerCommand);
  if (!match) return null;
  const [, command, rest] = match;
  const value = rest.replace(/^[\p{Zs}\t:：，,]+/u, '').trimEnd();
  if (command === '认领主人') return claimCode.test(value) ? { kind: 'claim', digest: digest(value) } : { kind: 'invalid' };
  if (/^[。！!]+$/u.test(value) || /^[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return { kind: 'invalid' };
  try {
    const name = normalizeOwnerName(value);
    return name ? { kind: 'name', name } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export function containsClaimCode(text) {
  // The prefix distinguishes even an inline pasted code from ordinary hex IDs.
  const input = text.trim();
  return embeddedClaimCode.test(input) || /^(?:[/#]\s*)?认领主人/u.test(input);
}

export function ownerIdentity(transport, target, scope = null) {
  if (target?.type !== 'c2c' || typeof target.id !== 'string') return null;
  const idPattern = transport === 'qq' ? qqIdentifier : transport === 'onebot' ? oneBotIdentifier : null;
  if (idPattern?.exec(target.id)?.[0] !== target.id) return null;
  if (scope !== null && (typeof scope !== 'string' || qqIdentifier.exec(scope)?.[0] !== scope)) return null;
  return { transport, id: target.id, scope };
}

export function matchesOwner(owner, identity) {
  return Boolean(owner && identity && owner.transport === identity.transport && owner.id === identity.id
    && (owner.scope ?? null) === identity.scope);
}

export function ownerStatus(owner, claim, now = Date.now()) {
  const identity = ownerIdentity(owner?.transport, { type: 'c2c', id: owner?.id }, owner?.scope);
  const expiresAt = Number.isFinite(claim?.expiresAt) && claim.expiresAt > now ? claim.expiresAt : null;
  if (!identity || !Number.isFinite(owner.boundAt)) {
    return { bound: false, owner: null, expiresAt };
  }
  const { id, transport } = identity;
  const tail = Math.min(4, Math.max(0, id.length - 2));
  return {
    bound: true,
    owner: { name: typeof owner.name === 'string' ? owner.name : '', transport, idHint: `••••${tail ? id.slice(-tail) : ''}`, boundAt: owner.boundAt },
    expiresAt,
  };
}
