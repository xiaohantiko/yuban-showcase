# 宇伴

宇伴把自选 AI 模型接到 QQ 机器人，支持私聊回复和定时问候。网页和桌面管理台用于连接机器人、配置人设和记忆、查看运行记录和模型用量。日常聊天在 QQ 里进行。

[下载最新公开版](https://github.com/xiaohantiko/yuban-showcase/releases/latest) · [查看更新日志](CHANGELOG.md)

## 下载安装

- **macOS 13 或更新版本，Apple 芯片和 Intel**。打开 `Yuban-macOS-universal.dmg`，将「宇伴」拖进「应用程序」，再从「应用程序」打开。下载包的签名和公证状态见 Releases 中对应版本的说明。
- **Windows 11 x64**。完整解压 `Yuban-Windows-x64.zip`，再在解压后的目录运行 `Yuban.exe`。桌面界面需要 Microsoft Edge WebView2 Runtime。

桌面端首次打开时，在「云端连接」填入自托管宇伴服务的 **HTTPS 根地址**，保存后注册或登录。地址应直接打开管理台，保留域名和必要的端口即可。若只有本机 HTTP 服务，请用浏览器访问。每个公开发行版附有 `SHA256SUMS.txt`。

## 本地运行

需要 Node.js 22 或更新版本。在仓库根目录运行以下命令。

```sh
npm ci
npm start
```

用浏览器打开 <http://127.0.0.1:4173>。默认监听本机地址。可以先查看管理台和调整演示设置，再配置实际模型和机器人。运行 `npm test` 可检查核心逻辑。

## 自托管并连接桌面端

这一节适合需要让桌面端登录或接收 QQ 回调的部署。将宇伴运行在你自己的服务器上，用自己的域名和有效的 HTTPS 证书提供访问。

1. 在服务进程的环境中设置 `YUBAN_CONSOLE_ACCOUNTS=multi`，并为 `YUBAN_ADMIN_TOKEN` 生成独立的随机值，例如用 `openssl rand -hex 32`。也可把设置保存到服务器上仅自己可读的 `.env`。保管好这个值，避免写进版本库或分享给用户。
2. 用 `npm ci` 安装依赖，再由服务管理器保持 `npm start` 运行。把 HTTPS 反向代理指向服务的本机端口 `4173`，保留原始 Host，由代理将 `X-Forwarded-Proto` 设置为 `https`。服务仍监听本机地址，外部请求经代理进入。
3. 用浏览器打开管理台并注册，妥善保存界面给出的恢复码。若需要初次认领管理员，在注册页的初始化入口使用该部署生成的管理口令。普通成员使用自己的账号。桌面端使用同一 HTTPS 地址及管理台账号。
4. 保留服务的持久化数据目录。默认本地数据在 `.data/`，其中包括运行状态与账号数据。备份和迁移时同时保护数据和部署配置。

## 接入模型和 QQ

1. 在管理台「开始使用 → 选一个 AI」选择服务商和模型，填写自己的 API 密钥，验证后保存。GPT 可选 GPT-5.4 mini 或 GPT-6.2 Sol，百炼北京可选千问 Plus 或 Qwen4-Max。
2. 在 QQ 开放平台创建自己的机器人。将平台颁发的 AppID 和 ClientSecret 填入管理台「连接 QQ」，由管理台验证并保存。 [QQ 开放平台](https://q.qq.com/)
3. 从「连接 QQ」复制管理台显示的回调地址，填入 QQ 开放平台，并订阅单聊消息 `C2C_MESSAGE_CREATE`。部署环境提供的回调路径可能因账号而异，以管理台显示的值为准。
4. 在「认领主人」里生成一次性认领消息，用自己的 QQ 在机器人私聊发送整条消息。认领成功后即可继续在 QQ 聊天。
5. 在「人设与记忆」编辑设置，在「主动问候」设置间隔和免打扰时间。也可在 QQ 私聊发送「开启问候」或「关闭问候」。若收不到回复，先检查 QQ 回调验证和事件订阅，再看管理台的运行记录。

## 从源码构建桌面端

- macOS 安装 Xcode 命令行工具后，在仓库根目录运行 `bash desktop/build.sh --dmg`。应用和磁盘映像输出到 `dist/`。
- Windows 安装 .NET 10 SDK 后，运行 `dotnet publish windows/Yuban.Windows.csproj -c Release -r win-x64 --self-contained true`。将发布目录完整打包，运行时保留其中所有文件。
