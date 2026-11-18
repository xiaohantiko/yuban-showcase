export function createDshRelay() {
  return { configured: false, chainAboutConfigured: false, supportsChain: false, tools: [],
    async handle() { return { text: '此部署未提供原生 DSH 网关，请使用支持该能力的部署。' }; } };
}

export function isDshCommand(text) {
  return typeof text === 'string' && /^(?:插件身份$|插件(?:\s|$))/u.test(text.trim());
}
