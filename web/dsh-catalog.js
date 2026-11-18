const DSH_PLUGIN_CATALOG = Object.freeze([
  {
    id: 'agent-md', name: 'dsh-agent-md', source: 'wwsmiler1-bit/dsh-agent-md', mode: '人设导入',
    detail: '在 DSH 会话中读取 AGENT.md；用 GPT 时，可以把同一份人设导入宇伴。',
    docs: 'https://github.com/wwsmiler1-bit/dsh-agent-md#安装',
    steps: 'git clone https://github.com/wwsmiler1-bit/dsh-agent-md.git\n# 按上游安装说明，把本地源码挂进 DSH desktop profile，然后重启 DSH。',
  },
  {
    id: 'remember', name: 'dsh-remember', source: 'Arborsm/dsh-remember', mode: '记忆导入',
    detail: '在 DSH 内整理记忆。用 GPT 时，可以从摘要里挑几条，转成自己的相处记忆。',
    docs: 'https://github.com/Arborsm/dsh-remember#install',
    steps: 'dsh plugin --profile web add dsh-remember@0.3.1\n# 重启 DSH Web；用独立的记忆目录和数据库。',
  },
  {
    id: 'memory', name: 'dsh-plugin-memory', source: 'LittleBlackTong/dsh-plugin-memory', mode: '人设与记忆导入',
    detail: '在 DSH 保留 SOUL.md 和 Markdown 记忆。换用 GPT 时，可导入其中想保留的内容。',
    docs: 'https://github.com/LittleBlackTong/dsh-plugin-memory#quickstart',
    steps: 'dsh plugin --profile web add dsh-plugin-memory@0.17.9\n# 重启 DSH，再在插件设置里初始化 SOUL 和记忆库。',
  },
]);
