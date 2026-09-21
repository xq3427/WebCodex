# WebCodex MCP

让 ChatGPT 通过 MCP 操作你授权的本地工作区：读取、修改、复制文件，运行本机命令，并查看 Git 状态。服务在本机运行，使用 OpenAI Secure MCP Tunnel 连接 ChatGPT。

## 三步开始

### 1. 安装

需要 Node.js 22.16 或更高版本：

```powershell
npm install -g webcodex-mcp@0.16.0-preview.17
```

如果你希望得到平铺的独立目录（不出现 `node_modules/webcodex-mcp`），请使用 [GitHub 一键安装包](https://github.com/xq3427/WebCodex/releases/tag/v0.16.0-preview.17)。npm 的目录层级由 npm 固定管理，不能由包安全地改成平铺结构。

### 2. 初始化

```powershell
webcodex init
```

命令会显示 Tunnel 和 API key 官方页面地址，并在本机生成配置。按提示粘贴凭据；密钥只写入本机配置，不会打印或提交。

### 3. 启动

```powershell
webcodex connect
```

保持该进程运行，然后在 ChatGPT 的应用/开发者连接入口启用 WebCodex。

## 详细文档

- [完整快速开始](docs/quickstart.md)
- [ChatGPT 接入](docs/chatgpt-setup.md)
- [配置与控制面板](docs/local-configuration.md)
- [文件操作与回存](docs/file-workflow.md)
- [工具清单](docs/tools.json)
- [更新记录](CHANGELOG.md)

## 常用命令

```powershell
webcodex doctor
webcodex config validate
webcodex access check
```

`webcodex-mcp` 与 `webcodex` 指向同一个 CLI。程序权限受启动它的操作系统账户限制；`trusted-host + all` 不会绕过 Windows ACL、Linux 权限或管理员/UAC。

## 开发与许可证

```powershell
git clone https://github.com/xq3427/WebCodex.git
cd WebCodex
npm ci --ignore-scripts
npm test
```

本项目采用 MIT 许可证。问题反馈和贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
