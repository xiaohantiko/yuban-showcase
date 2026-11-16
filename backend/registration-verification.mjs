import { createHmac, randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createChallenge, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

const challengeLifetime = 3 * 60_000;
const issuanceWindow = 60_000;
const perClientLimit = 12;
const globalLimit = 120;
const pendingLimit = 256;
const counterMin = 2_000;
const counterLimit = 4_000;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const hexKey = /^[0-9a-f]{64}$/;

function readProof(payload) {
  if (typeof payload !== 'string' || !payload || payload.length > 4096 || !base64.test(payload)) return null;
  try {
    const { challenge, solution } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (typeof challenge?.signature !== 'string' || !hexKey.test(challenge.signature)
      || !Number.isInteger(solution?.counter) || solution.counter < counterMin || solution.counter >= counterLimit
      || typeof solution.derivedKey !== 'string' || !hexKey.test(solution.derivedKey)) return null;
    return { challenge, solution: { counter: solution.counter, derivedKey: solution.derivedKey } };
  } catch {
    return null;
  }
}

export function createRegistrationVerification({ secret, clock = Date.now }) {
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(secret)) {
    throw new Error('开启注册验证需要有效的 YUBAN_ADMIN_TOKEN。');
  }

  const deriveSecret = (purpose) => createHmac('sha256', secret).update(`yuban/registration/v1/${purpose}`).digest('hex');
  const hmacSignatureSecret = deriveSecret('challenge');
  const clientSecret = deriveSecret('client');
  const clientHash = (key) => createHmac('sha256', clientSecret)
    .update(typeof key === 'string' ? key.slice(0, 200) : '').digest('hex');
  const pending = new Map();
  const clientIssuances = new Map();
  let windowEndsAt = 0;
  let issuances = 0;
  let creating = 0;

  async function issue(clientKey) {
    const now = clock();
    if (now >= windowEndsAt) {
      windowEndsAt = now + issuanceWindow;
      issuances = 0;
      clientIssuances.clear();
    }
    if (issuances >= globalLimit) return null;
    const client = clientHash(clientKey);
    const clientCount = clientIssuances.get(client) ?? 0;
    if (clientCount >= perClientLimit) return null;
    for (const [signature, entry] of pending) {
      if (entry.expiresAt <= now) pending.delete(signature);
    }
    if (pending.size + creating >= pendingLimit) return null;

    issuances += 1;
    clientIssuances.set(client, clientCount + 1);
    creating += 1;
    const expiresAt = Math.floor((now + challengeLifetime) / 1000);
    try {
      const challenge = await createChallenge({
        algorithm: 'PBKDF2/SHA-256',
        cost: 2_000,
        counter: randomInt(counterMin, counterLimit),
        deriveKey,
        expiresAt,
        hmacSignatureSecret,
      });
      const expiresAtMs = expiresAt * 1000;
      if (expiresAtMs <= clock()) return null;
      pending.set(challenge.signature, { challenge, client, expiresAt: expiresAtMs });
      return structuredClone(challenge);
    } finally {
      creating -= 1;
    }
  }

  async function consume(payload, clientKey) {
    const proof = readProof(payload);
    if (!proof) return false;
    const { signature } = proof.challenge;
    const entry = pending.get(signature);
    if (!entry) return false;
    if (entry.expiresAt <= clock()) {
      pending.delete(signature);
      return false;
    }
    if (entry.client !== clientHash(clientKey) || !isDeepStrictEqual(proof.challenge, entry.challenge)) return false;

    // Reserve consumption synchronously before cryptographic work, so concurrent replays cannot verify again.
    pending.delete(signature);
    try {
      const result = await verifySolution({
        challenge: entry.challenge,
        solution: proof.solution,
        deriveKey,
        hmacSignatureSecret,
      });
      return result.verified && entry.expiresAt > clock();
    } catch {
      return false;
    }
  }

  return { issue, consume };
}
