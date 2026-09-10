# WebCodex MCP

[English](README.en.md) · [GitHub](https://github.com/xq3427/WebCodex) · [文档目录](docs/README.md) · [配置示例](examples/config.example.toml) · [贡献指南](CONTRIBUTING.md)

让 ChatGPT 网页通过 MCP 操作你授权的本地项目：读取和修改代码、查看 Git 变更、运行配置允许的程序，并读取本地 Codex 会话来接续工作。

适合在 Codex 暂时不可用或额度用完时应急。WebCodex 提供本地工具，由 ChatGPT 理解任务和调用工具；它不调用 Codex 模型，也不恢复或绕过任何产品的额度。本项目由社区独立开发，与 OpenAI 无隶属关系。

**当前版本：0.14.0-preview.2，预览版。** 本地功能有自动化测试，ChatGPT 账户权限、工具发现和宿主行为需要在实际连接中验证。原文件自动上传功能已暂停，不能把 PDF 文件卡片或上传回执视为 GPT 已读到正文。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 多设备、多工作区 | 每台设备独立身份；目录可分别命名、设置只读、启用或停用，支持离线目录策略 |
| 文本文件操作 | 列目录、搜索、按行或分块读取、批量读取、创建目录、写入和应用补丁 |
| 变更保护 | 写前 SHA-256 冲突检查、操作幂等键、服务修改记录、备份和有条件恢复 |
| 批量变更 | 多文件预检、应用和状态查询；失败时保留状态并尝试有条件回滚 |
| Git 与项目指导 | 查看状态和差异、读取适用的 AGENTS.md；显式登记 Git linked worktree |
| 程序执行 | 默认关闭；开启后运行本机配置允许的程序，查询输出、等待、取消、通过管道提供输入 |
| Codex 接续 | 默认关闭；只读列出、搜索和续读本地可见会话，结合当前项目生成交接上下文 |
| 任务与检查点 | 保存独立任务、不可变进度修订、文件观察及作业记录，导出交接笔记 |
| 接入与诊断 | stdio、回环 Streamable HTTP、OpenAI 官方 Secure MCP Tunnel，以及可选本地面板 |

当前注册 **44 个工具，其中 42 个常规工具、2 个组件私有工具**。工具参数以[生成的 schema](docs/tools.json)为准；数量不代表 ChatGPT 一定将全部工具放入当前对话。

## 当前限制

- **没有实现纯 MCP 自动把 PDF/Office 原文件变成 ChatGPT 原生可读附件。** 原字节读取与组件诊断仍保留，但不属于已完成的文档分析能力。详见[原文件说明](docs/original-files.md)。
- 没有完整 Codex 客户端、模型调用、隐藏上下文恢复、自动任务执行器、PTY 或持续 shell。历史记录可能存在省略，必须检查分页和扫描完整性。
- 程序执行采用 `trusted-host`：拥有本机用户权限，**不是操作系统沙箱**。允许解释器或包管理器后，程序可能访问工作区之外的文件和网络。
- 批量变更不是跨文件原子事务；文件恢复不撤销外部程序、网络或数据库的副作用。
- 没有专用 Git 提交/推送工具，也没有把 ChatGPT 生成的二进制附件自动保存到本机的工具。
- 本版在 Windows 上做本地验证，并配置了 Linux/macOS CI。跨平台结果以[实际 CI 运行](https://github.com/xq3427/WebCodex/actions/workflows/ci.yml)为准，验证范围见[测试说明](docs/testing.md)。

## 快速开始

需要 **Node.js ≥ 22.16、Git、ripgrep（rg）**。克隆源码并安装：

```text
git clone https://github.com/xq3427/WebCodex.git
cd WebCodex
npm ci --ignore-scripts
npm run build
node dist/src/cli.js init --workspace .
node dist/src/cli.js config validate
node dist/src/cli.js doctor
```

PowerShell 若拦截 `npm.ps1`，使用 `npm.cmd` 代替 `npm`。本项目暂未发布 npm 包，请从源码构建。

`init` 创建私有的 `.webcodex/config.toml`，生成本机设备和工作区身份，默认关闭命令执行与 Codex 历史读取。已有配置时跳过 `init`，它不会覆盖现有配置。

所有可修改设置集中在选中的一份 TOML 或 JSON 文件中，包括 API key、隧道、设备名、工作区、Codex home、程序路径和限额。可显式选择其他位置：

```text
node dist/src/cli.js init --workspace . --config /absolute/private/config.toml
node dist/src/cli.js doctor --config /absolute/private/config.toml
```

Windows 可以使用 `D:/WebCodex/config.toml`。后续命令使用同一个 `--config`。相对路径以**配置文件所在目录**为基准；配置变更需要重启对应服务。

[JSON 模板](examples/config.example.json)和 [TOML 模板](examples/config.example.toml)中的身份与密钥故意留空。先用 `init` 生成本机配置，再参考模板修改；不要直接把空身份模板当作有效配置。

## 接入 ChatGPT 网页

推荐通过 **OpenAI 官方 Secure MCP Tunnel** 连接本机 stdio 服务。此模式不需要自建公网服务器、域名、Cloudflare、浏览器扩展或本项目的 Actions 服务，但需要你的 OpenAI 账户具备对应隧道和 ChatGPT 连接权限。

1. 在 [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建或选择隧道，并准备具备运行权限的 API key。
2. 安装[官方 tunnel-client](https://github.com/openai/tunnel-client/releases)。Windows 可运行 `./scripts/install-tunnel.ps1`；Linux/macOS 需下载匹配平台的程序并配置路径和 SHA-256。
3. 在本机配置的 `tunnel` 中填写 `enabled`、`id` 和 `apiKey`，保留 `server.transport = "stdio"`。
4. 运行本地检查及连接：

```text
node dist/src/cli.js connect --doctor-only
node dist/src/cli.js connect
```

5. 在 ChatGPT 的应用/开发者模式连接入口选择对应 Tunnel，在新对话启用 WebCodex。具体账户条件和操作见[接入指南](docs/chatgpt-setup.md)。

`connect` 会保持运行，这是正常行为。另开终端用 `node dist/src/cli.js tunnel status` 检查状态。不要同时启动两个共用同一 state 的服务。

连接后可以发送：

> 使用 WebCodex，先调用 system_status 和 workspace_list，确认设备与项目。读取 README.md，告诉我项目用途。然后在我指定的可写工作区新建一个尚不存在的 webcodex-smoke.txt，内容为“WebCodex 连接测试”，并实际读回验证。不要覆盖已有文件；出现错误时报告实际工具错误。

MCP 协议连通不等于业务操作成功：需要核对工具结果和磁盘读回。WebCodex 不收取软件许可费用；ChatGPT 订阅、平台权限和相关服务计费由服务提供方决定。

## 多目录与多设备

每个工作区对象配置一个 `root`。需要不同名称和权限时，分别添加对象；不能在一个 `root` 字段后直接串联多个路径。以下是需要合入现有 JSON 配置的片段：

```json
{
  "workspaces": [
    {
      "id": "code",
      "name": "代码项目",
      "root": "${userHome}/Projects/demo",
      "readOnly": false
    },
    {
      "id": "papers",
      "name": "论文资料",
      "root": "${userHome}/Documents/papers",
      "readOnly": true,
      "onUnavailable": "skip"
    }
  ]
}
```

新条目省略 `uid` 时会自动生成；已存在条目的 `id/uid` 应保留。也可追加路径字符串，例如 `"${userHome}/Projects/another"`，其权限默认为可写。Windows JSON 建议使用正斜杠 `D:/Projects/demo`；反斜杠需要写成 `D:\\Projects\\demo`。路径必须是本机实际目录。

CLI 可添加目录而无需手工编辑：

```text
node dist/src/cli.js workspace add --id papers --name Papers --root /absolute/papers --read-only
node dist/src/cli.js workspace health
node dist/src/cli.js device rename --name "Office laptop"
```

每台设备分别运行 `init`，维护独立配置、state 和隧道身份。不要复制另一台设备的完整配置或状态库。连接时核对 `device_id`；所有 v2 写入、执行和取消调用都要求 `expected_device_id`。WebCodex 不自动跨设备转发或同步文件。

## 接续本地 Codex 会话

在本机显式开启只读历史访问：

```text
node dist/src/cli.js codex enable --home /absolute/codex-home
node dist/src/cli.js codex status
```

Windows 可以将 home 设为 `D:/CodexData/.codex`，不要求位于 C 盘。不传 `--home` 时，命令优先保留已配置目录；首次发现才使用 `CODEX_HOME` 或用户目录下的 `.codex`，结果写入统一配置。

重启连接后，告诉 ChatGPT：

> 使用 WebCodex，查找本地 Codex 中与这个项目对应的会话，读取交接上下文和必要历史，再检查当前工作区文件与 Git 状态，列出未完成工作。不要自动重放历史命令。

详见[应急接续指南](docs/codex-emergency.md)。历史工具不读取账号认证文件，不恢复隐藏推理，不修改 Codex 会话。

## 可选程序执行

`execution.mode` 默认为 `disabled`，文本读写不依赖它。确需运行项目测试时，可先注册本机程序，再开启执行：

```text
node dist/src/cli.js execution preset --preset node
node dist/src/cli.js execution inspect
node dist/src/cli.js execution set-mode trusted-host
```

重启后，ChatGPT 可通过 `exec_start` 运行允许的别名，用 `exec_wait/exec_poll` 获取输出和退出码。支持 npm、Python、venv、Conda 配置预设，以及工作区独立执行 profile；完整用法见[配置指南](docs/local-configuration.md)和[任务工作流](docs/task-workflow.md)。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| doctor 报 rg 不可用 | 安装 ripgrep，或在所选配置中设置本机 `rgPath` |
| SQLite ExperimentalWarning | Node 内置 SQLite 的提示；单独出现不表示服务失败 |
| `TUNNEL_ALREADY_RUNNING` | 用同一配置查询 `tunnel status`，检查原连接；不要直接删除锁或反复开新连接 |
| 应用详情有工具，对话却无法调用 | 确认对话启用了正确连接，按 ChatGPT 当前界面更新工具，并用新对话核对版本和实际调用 |
| 文件写入失败 | 核对设备、工作区权限、相对路径、父目录、当前哈希和错误恢复提示 |
| PDF 组件出现但不能总结 | 自动原文件正文接入尚未实现；这不是已通过验收的能力 |
| 修改配置后行为没变 | 等作业结束，在原终端正常停止并重新启动；已有进程不会自动重载 |

## 开发与项目资料

```text
npm run check
npm test
npm run export:tools
npm run audit:repo
```

- [架构](docs/architecture.md) / [功能状态](docs/implementation-status.md) / [后续路线](docs/roadmap.md)
- [文件工作流](docs/file-workflow.md) / [协议诊断](docs/protocol-diagnostics.md) / [可选本地面板](docs/local-panel.md)
- [测试与验证边界](docs/testing.md) / [安全说明](SECURITY.md) / [贡献指南](CONTRIBUTING.md)
- [更新记录](CHANGELOG.md) / [第三方依赖](THIRD_PARTY_NOTICES.md)

真实配置、API key、Codex 历史、状态库、作业日志和本机验收记录不得提交。发布或提交 issue 前运行仓库检查，并检查脱敏后的 diff。

## 许可证

[MIT](LICENSE)。依赖软件和官方 tunnel-client 遵循各自许可证。
