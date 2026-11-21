import assert from 'node:assert/strict';
import test from 'node:test';
import { outreachStatus, validateOutreach } from './outreach.mjs';
import { mergeSettings, readSettings } from './logic.mjs';

test('outreach defaults to adaptive and preserves a previously chosen fixed delay', () => {
  const status = settings => outreachStatus(null, false, false, settings);
  assert.equal(readSettings().outreachMode, 'adaptive');
  assert.equal(readSettings({ afterMinutes: 360 }).outreachMode, 'adaptive');
  const old = readSettings({ afterMinutes: 75, quietEnd: '06:30' });
  assert.equal(old.outreachMode, 'manual');
  assert.equal(status(old).outreachMode, 'manual');
  assert.equal(mergeSettings(old, { voiceReplies: true }).outreachMode, 'manual');
  const adaptive = mergeSettings(old, { outreachMode: 'adaptive' });
  assert.equal(status(adaptive).outreachMode, 'adaptive');
  assert.equal(adaptive.afterMinutes, 75);
  assert.equal(adaptive.quietEnd, '06:30');
  assert.equal(readSettings(adaptive).outreachMode, 'adaptive');
  const fixedDefault = mergeSettings(adaptive, { outreachMode: 'manual', afterMinutes: 360 });
  assert.equal(readSettings(fixedDefault).outreachMode, 'manual');
  assert.equal(mergeSettings(adaptive, { afterMinutes: 12 }).outreachMode, 'manual');
  assert.throws(() => mergeSettings(old, { outreachMode: 'automatic' }), /请选择/u);
});

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
