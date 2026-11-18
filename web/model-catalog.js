const MODEL_CATALOG = Object.freeze([
  {
    id: 'deepseek',
    name: 'DeepSeek',
    base: 'https://api.deepseek.com',
    docs: 'https://api-docs.deepseek.com/zh-cn/',
    voiceNote: 'DeepSeek 已提供海星、暗潮音色。部署者配置独立的 DeepSeek 语音密钥后，可接入 QQ 语音回复。发送能力取决于机器人权限和平台支持。',
    voiceDocs: 'https://api-docs.deepseek.com/zh-cn/guides/tts/',
    models: [
      { name: 'DeepSeek Flash（推荐）', model: 'deepseek-flash', note: '默认用于日常 QQ 聊天。使用 DeepSeek 开放平台的 API Key。' },
      { name: 'DeepSeek V4 Pro', model: 'deepseek-v4-pro', note: '使用 DeepSeek 开放平台的 API Key。' },
    ],
  },
  {
    id: 'qwen',
    name: '千问',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docs: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    voiceNote: '百炼提供千问语音合成。接入百炼原生语音接口需要专用适配，也可以另接兼容的语音服务。',
    voiceDocs: 'https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api',
    models: [
      { name: '千问 Plus', model: 'qwen-plus', note: '使用阿里云百炼华北 2（北京）的 API Key。' },
      { name: '千问 Qwen4-Max', model: 'qwen4-max', note: '11 月 16 日上线的正式版。使用百炼北京地域的 API Key 并开通调用权限，复杂推理可能需要更多时间。', docs: 'https://help.aliyun.com/zh/model-studio/qwen4-max' },
    ],
  },
  {
    id: 'doubao',
    name: '豆包',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    docs: 'https://docs.volcengine.com/docs/ark/model-list?lang=zh',
    voiceNote: '豆包提供独立的语音合成接口。接入豆包原生语音需要专用适配，也可以另接兼容的语音服务。',
    voiceDocs: 'https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh',
    models: [{ name: '豆包 · 火山方舟', model: 'doubao-seed-2-1-lite-260915', note: '在火山方舟北京地域开通模型后，使用该地域的 API Key。' }],
  },
  {
    id: 'openai',
    name: 'GPT / OpenAI',
    base: 'https://api.openai.com/v1',
    docs: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
    voiceNote: 'OpenAI 的 gpt-4o-mini-tts 可单独接入语音。官方将于 2027 年 1 月 6 日停用该接口下的语音模型，后继 Realtime 接口需要专用适配。',
    voiceDocs: 'https://developers.openai.com/api/docs/guides/text-to-speech',
    models: [
      { name: 'GPT-5.4 mini', model: 'gpt-5.4-mini', note: '需要有对应模型权限的 OpenAI API 账号。' },
      { name: 'GPT-6.2 Sol', model: 'gpt-6.2-sol', note: '11 月 17 日上线的新款模型。需要 OpenAI API 调用权限；会先推理再回复，复杂对话可能等待更久。', docs: 'https://developers.openai.com/api/docs/models/gpt-6.2-sol' },
    ],
  },
]);
