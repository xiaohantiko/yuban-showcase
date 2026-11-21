import { createHash } from 'node:crypto';
import { botIsEnabled } from './plugin-activation.mjs';

export const outreachRoute = '/api/plugins/outreach';

export function outreachStatus(owner, supported, optedIn, settings) {
  // Bind a console confirmation to this pairing without exposing its QQ identifier.
  const binding = owner?.transport === 'qq' && supported
    ? createHash('sha256').update(JSON.stringify(['outreach', owner.scope, owner.id, owner.boundAt])).digest('hex') : null;
  const { afterMinutes, quietEnabled, quietStart, quietEnd, timeZone } = settings;
  return { enabled: Boolean(binding && optedIn), available: Boolean(binding), paused: !settings.enabled || !botIsEnabled(settings),
    binding, afterMinutes, quietEnabled, quietStart, quietEnd, timeZone };
}

export function validateOutreach(data, status) {
  const reject = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (typeof data.enabled !== 'boolean' || Object.keys(data).some(key => !['enabled', 'consent', 'binding'].includes(key))) {
    reject(400, '请指定是否启用「主动找我」。');
  }
  if (data.enabled && data.consent !== true) reject(400, '请先确认允许伙伴主动向绑定的 QQ 发消息。');
  if (!status.available || data.binding !== status.binding) reject(409, '请先绑定本账号的 QQ，或刷新后重新确认当前绑定。');
}
