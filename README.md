# 宇伴

QQ AI 陪伴机器人，支持自动回复和定时问候，配有 macOS 控制台。

## 本地运行

需要 Node.js 22 或更高版本。在仓库根目录运行：

```sh
npm ci
npm start
```

打开 http://127.0.0.1:4173 查看控制台。没有模型或 QQ 账号也可以查看界面和调整演示设置。接入真实服务时，在自己的部署里配置模型和 QQ 机器人，并使用自己控制的 HTTPS 回调地址。

可以用 `npm test` 运行核心逻辑测试。在装有 Xcode 命令行工具的 macOS 上运行 `bash desktop/build.sh` 构建桌面控制台。Windows 源码位于 `windows/`，需要 .NET 10 SDK 和 Microsoft Edge WebView2。两个桌面控制台都连接自行配置的 HTTPS 地址。

公开版本包含可自托管的框架源码。服务密钥、管理口令和实际聊天数据应存放在部署机器上。托管版本配置、专用插件网关和内部运维工具由各自部署管理。

## 下载安装

[下载最新公开版本与 SHA-256 校验文件](https://github.com/xiaohantiko/yuban-showcase/releases/latest)

macOS 发布包使用临时签名，尚未通过 Apple 公证。
