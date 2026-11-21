import assert from 'node:assert/strict';
import test from 'node:test';
import { outreachStatus, validateOutreach } from './outreach.mjs';

test('outreach consent targets the stable pairing and cannot be transferred to another bot or owner', () => {
  const owner = { transport: 'qq', scope: 'test-bot', id: 'test-contact', name: '阿禾', boundAt: 10 };
  const settings = { enabled: true, afterMinutes: 360, quietEnabled: true, quietStart: '23:00', quietEnd: '06:30', timeZone: 'Asia/Shanghai' };
  const status = outreachStatus(owner, true, true, settings);
  const grant = { enabled: true, consent: true, binding: status.binding };
  assert.equal(status.enabled, true);
  assert.equal(status.quietEnd, '06:30');
  assert.doesNotThrow(() => validateOutreach(grant, outreachStatus({ ...owner, name: '新昵称' }, true, true, settings)));
  for (const change of [{ scope: 'another-bot' }, { id: 'another-contact' }, { boundAt: 11 }, { transport: 'onebot' }]) {
    assert.throws(() => validateOutreach(grant, outreachStatus({ ...owner, ...change }, true, false, settings)), { status: 409 });
  }
  assert.throws(() => validateOutreach(grant, outreachStatus(owner, false, true, settings)), { status: 409 });
  assert.throws(() => validateOutreach({ ...grant, consent: false }, status), { status: 400 });
  assert.throws(() => validateOutreach({ ...grant, recipient: 'another-contact' }, status), { status: 400 });
  assert.doesNotThrow(() => validateOutreach({ enabled: false, binding: status.binding }, status));
});
