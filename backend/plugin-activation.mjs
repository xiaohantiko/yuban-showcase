import { dshPluginIDs, pluginCapabilities, selectedPlugins } from './plugin-capabilities.mjs';

export const pluginActivationRoute = '/api/plugins/activation';
export class PluginActivationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new PluginActivationError(status, message); };
const same = (a, b) => a.length === b.length && a.every(id => b.includes(id));

export function availablePlugins(dsh) {
  return dshPluginIDs.filter(id => id !== 'chain' || dsh?.supportsChain !== false);
}

function record(settings) {
  const value = settings?.pluginActivation;
  return value?.version === 1 && Number.isSafeInteger(value.revision) && value.revision > 0
    && value.configured === true && value.botEnabled === true
    && Array.isArray(value.everEnabled) ? value : null;
}

// Only an existing QQ/OneBot configuration is legacy evidence. Merely starting
// the process, opening a console, or selecting defaults never activates a bot.
export function migratePluginActivation(settings, { legacy = false } = {}) {
  if (record(settings) || !legacy) return settings;
  const selected = selectedPlugins(settings);
  return { ...settings, pluginActivation: { version: 1, revision: 1, configured: true,
    botEnabled: true, everEnabled: selected, legacy: true } };
}

export function botIsEnabled(settings) { return Boolean(record(settings)); }
export function activationRevision(settings) { return record(settings)?.revision ?? 0; }

export function activationSnapshot(settings, { dsh, memoryReady = false } = {}) {
  const current = record(settings);
  const available = availablePlugins(dsh);
  const all = pluginCapabilities({ ...settings, dshPlugins: dshPluginIDs }, { dsh, memoryReady });
  return {
    version: 1, revision: current?.revision ?? 0, configured: Boolean(current), botEnabled: Boolean(current),
    selected: current ? selectedPlugins(settings) : available,
    everEnabled: current ? dshPluginIDs.filter(id => current.everEnabled.includes(id)) : [],
    available,
    capabilities: all.map(item => available.includes(item.id) ? item : {
      ...item, status: 'unavailable', reason: '需要支持 DSH 网关的部署。',
    }),
  };
}

export function applyPluginActivation(settings, input, { dsh } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['action', 'selected', 'confirmed', 'revision'].includes(key))) {
    fail(400, '启用设置只接受操作、所选能力、确认和版本。');
  }
  if (input.confirmed !== true) fail(400, '请先确认这次能力变更。');
  const current = record(settings);
  if (!Number.isSafeInteger(input.revision) || input.revision !== activationRevision(settings)) {
    fail(409, '能力设置刚刚发生变化，请刷新后重新确认。');
  }
  const available = availablePlugins(dsh);
  if (!Array.isArray(input.selected) || input.selected.length > available.length
    || input.selected.some(id => !available.includes(id)) || new Set(input.selected).size !== input.selected.length) {
    fail(400, '请选择当前部署支持且不重复的能力。');
  }
  if (!['activate', 'update', 'reset'].includes(input.action)) fail(400, '请选择有效的启用操作。');
  if (!current && input.action !== 'activate') fail(409, '请先确认首次启用。');
  if (current && input.action === 'activate') fail(409, '机器人已启用，请确认变更或软重置。');
  const selected = dshPluginIDs.filter(id => input.selected.includes(id));
  const previous = selectedPlugins(settings);
  if (current && input.action === 'update' && selected.some(id => !previous.includes(id))) {
    fail(409, '新增或重新开启能力需要确认软重置。');
  }
  return { ...settings, dshPlugins: selected,
    dshChainManaged: true,
    pluginActivation: { version: 1, revision: (current?.revision ?? 0) + 1, configured: true,
      botEnabled: true, everEnabled: dshPluginIDs.filter(id => selected.includes(id) || current?.everEnabled.includes(id)) },
  };
}

export function assertPluginSettingsPatch(settings, input) {
  if (Object.hasOwn(input, 'pluginActivation') || Object.hasOwn(input, 'dshChainManaged')) {
    fail(400, '能力启用状态只能通过确认入口修改。');
  }
  if (Object.hasOwn(input, 'dshPlugins') && (!Array.isArray(input.dshPlugins)
    || !same(input.dshPlugins, selectedPlugins(settings)))) {
    fail(409, '请通过能力启用入口确认变更；重新开启需要软重置。');
  }
}

export function assertBotEnabled(settings) {
  if (!botIsEnabled(settings)) fail(409, '请先确认机器人要启用的能力，再继续连接 QQ。');
}

export function assertPluginEnabled(settings, plugin, supported = ['agent-md', 'remember', 'memory', 'chain']) {
  assertBotEnabled(settings);
  if (!supported.includes(plugin) || !selectedPlugins(settings).includes(plugin)) {
    fail(409, '这个能力尚未开启。请在能力设置中确认软重置后启用。');
  }
}
