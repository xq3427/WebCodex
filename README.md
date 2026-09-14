# WebCodex MCP

[English](README.en.md) · [快速开始](#快速开始) · [文档目录](docs/README.md) · [配置示例](examples/config.example.toml) · [贡献指南](CONTRIBUTING.md)

让 ChatGPT 网页通过 MCP 操作你授权的本地项目：读取和修改代码、查看 Git 变更、运行配置允许的程序，并读取本地 Codex 可见历史来接续工作。

WebCodex 提供本地工具，由 ChatGPT 理解任务并调用工具。它不调用 Codex 模型，不恢复或绕过产品额度；适合在 Codex 暂时不可用时继续处理项目。本项目由社区独立开发，与 OpenAI 无隶属关系。

**当前版本：0.16.0-preview.9，预览版。** 本机已有文件使用 `fs_copy` 直接复制；ChatGPT 生成的原文件优先使用 `fs_save_file` 自动回存。后者接收真实宿主文件 ID 或官方文件对象，在本机下载并核对原件大小和 SHA-256 后写入，文件字节不经过模型 Base64 中转。**自动回存的本机与合成组件测试已完成，真实 ChatGPT 文件授权、下载和保存全链路仍待验收。**

## 快速开始

**推荐：[下载一键安装包](https://github.com/xq3427/WebCodex/releases/download/v0.16.0-preview.9/WebCodex-0.16.0-preview.9-setup.zip)**，完整解压后，Windows 双击 `install.cmd`，Linux/macOS 运行 `sh install.sh`。它会准备 Node、本机工具和私有配置，并打开管理页面；无需编译、npm 登录或管理员权限。Linux/macOS 需先有 Git 和基础下载/解压工具。

在页面填入自己的 Tunnel ID、API key，添加工作区，保存并启动服务，再在 ChatGPT 中连接。**[完整快速开始教程](docs/quickstart.md)** 包含各平台安装、已有 Node 的 tgz/npm 用法、更新和故障处理。

已有 Node.js ≥22.16 和 npm，也可在源码仓库以外新建专用目录，直接运行 [npm 发布版](https://www.npmjs.com/package/webcodex-mcp/v/0.16.0-preview.9)，无需 npm 登录：

```text
npx --yes --package webcodex-mcp@0.16.0-preview.9 webcodex-mcp setup --workspace ./workspace --config ./config.toml
```

以后回到同一目录运行同一命令即可重新打开页面，已有 `config.toml` 原样保留。PowerShell 若拦截 `npx.ps1`，使用 `npx.cmd`。

开发者也可从源码安装，需要 Node.js ≥22.16：

```text
git clone https://github.com/xq3427/WebCodex.git
cd WebCodex
npm ci --ignore-scripts
npm run build
node dist/src/cli.js setup --workspace .
```

PowerShell 若拦截 `npm.ps1`，使用 `npm.cmd`。`setup` 会安装缺少的工具并打开页面；已有配置原样保留。加 `--no-panel` 仅部署并退出。

首次 `setup` 创建私有的 `.webcodex/config.toml`，生成本机设备和工作区身份，默认关闭命令执行与 Codex 历史读取。传统 `init` 仅创建配置，仍保留兼容。

## 统一配置与本地控制中心

下文 `node dist/src/cli.js …` 命令用于源码目录。安装包用户使用安装目录中的 `start-webcodex.cmd …`（Windows）或 `webcodex …`（Linux/macOS）；启动器已经绑定所选配置，无需重复填写 `--config`。

所有可修改设置都保存在选中的一份 TOML 或 JSON 文件中，包括设备、工作区、隧道 API key、Codex home、程序路径、权限和限额；不同配置文件不会合并。相对路径以**配置文件所在目录**为基准。

仅打开配置页面：

```text
node dist/src/cli.js panel
```

终端会输出带临时凭据的完整本机链接。页面支持工作区和权限表单、密钥只写更新、配置校验，以及面板管理服务的启动、停止和保存并重启。`panel` 本身不会立即启动 MCP 连接。链接需保密，终端需保持打开。

也可显式选择配置位置，后续命令使用同一个 `--config`：

```text
node dist/src/cli.js init --workspace . --config /absolute/private/config.toml
node dist/src/cli.js panel --config /absolute/private/config.toml
```

Windows 可使用 `D:/WebCodex/config.toml`。[TOML 模板](examples/config.example.toml)和 [JSON 模板](examples/config.example.json)中的身份与密钥故意留空；先用 `init` 生成本机配置，再参考模板修改，不直接运行空身份模板。

配置变更需要重启对应服务。页面可以管理由它启动的连接；旧版、`connect --no-panel` 或独立 `serve` 启动的服务，需要先在原终端正常停止，再从页面启动。页面不会强行接管外部进程。详见[配置指南](docs/local-configuration.md)和[控制中心指南](docs/local-panel.md)。

## 接入 ChatGPT 网页

### 固定只读 SSH 探测

当 ChatGPT 对通用 `exec_start` 的 SSH 调用进行安全拦截时，可在 v2 配置中声明远程主机并使用 `ssh_readonly_probe`。该工具只接受 `identity`、`roots`、`project_candidates`、`git_status`、`processes`、`gpu`、`directory_listing` 七种探测类型，服务端生成固定命令，禁止提交任意远程 shell。

```json
{
  "remotes": {
    "h20": {
      "name": "H20",
      "host": "172.22.207.231",
      "port": 30205,
      "user": "root",
      "identityFile": "D:/Documents/Star/ssh/ssh-key",
      "projectRoot": "/workspace/SourceDetection",
      "strictHostKeyChecking": true
    }
  }
}
```

密钥文件和远程地址仅保存在本机配置，不要提交到 Git。连接前先确认 `system_status` 和 `workspace_list`，再调用 `ssh_readonly_probe`。该工具不会复制代码、启动训练或修改远程文件。

推荐通过 **OpenAI 官方 Secure MCP Tunnel** 连接本机 stdio 服务。此模式无需自建公网服务器、域名、Cloudflare、浏览器扩展或 Actions 服务；账户仍须具备相应 Platform 隧道和 ChatGPT 连接权限。

1. 在 [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建或选择隧道，并准备具备运行权限的 API key。
2. 一键安装或首次 `setup` 已安装[官方 tunnel-client](https://github.com/openai/tunnel-client/releases)。已有手动配置可按[接入指南](docs/chatgpt-setup.md)单独安装；再次 setup 不自动替换已有工具路径。
3. 在所选配置的 `tunnel` 中填写 `enabled`、`id` 和 `apiKey`，保留 `server.transport = "stdio"`。
4. 检查并启动连接：

```text
node dist/src/cli.js connect --doctor-only
node dist/src/cli.js connect
```

5. 在 ChatGPT 的应用/开发者连接入口选择对应 Tunnel，在对话中启用 WebCodex。具体操作、账户条件和升级步骤见[接入指南](docs/chatgpt-setup.md)。

使用 v2 配置时，`connect` 同时启动连接与本地控制中心，并打印页面链接。`stdio` 使用官方隧道，`http` 启动回环 HTTP 服务；本机 HTTP 或页面可访问不代表 ChatGPT 已连接。面板端口冲突时会临时选择空闲回环端口，不修改配置。

对于 stdio 隧道，`connect --no-panel` 启动无页面连接，`connect --doctor-only` 只检查隧道配置；可另开终端运行 `node dist/src/cli.js tunnel status` 查看状态。对于 HTTP 配置，无页面服务使用 `node dist/src/cli.js serve`，本机依赖检查使用 `node dist/src/cli.js doctor`。自定义配置均需附加相同的 `--config`。服务应持续运行，不要启动另一份共用相同 state 的服务。

连接后可发送：

> 使用 WebCodex，先调用 system_status 和 workspace_list，确认设备与项目。读取 README.md，说明项目用途。然后在指定可写工作区新建一个尚不存在的 webcodex-smoke.txt，内容为“WebCodex 连接测试”，并实际读回验证。不要覆盖已有文件；出错时报告实际工具错误。

## 文件操作：选择正确入口

| 文件与任务 | 使用方式 | 完成依据 |
| --- | --- | --- |
| 本机已有文件 | `fs_stat` 取得源哈希，调用 `fs_copy`；支持跨工作区和只读源，无需上传或命令执行 | 复制回执与目标 `fs_stat` 大小、哈希一致 |
| Markdown、SVG、HTML、代码等文本 | `fs_write` 或 `fs_apply_patch` | 写入结果和读回核对 |
| ChatGPT 生成的 PNG、PPTX、PDF、ZIP 等原文件 | `fs_save_file` 提交当前产物真实文件引用及原件大小/哈希；用 `fs_save_file_status` 查询 | `saved`、`verified=true`，再与 `fs_stat` 核对 |
| 本地 PDF 正文 | `document_open` / `document_read` 原型 | 只有 `ready` 和实际返回的页正文可作为回答依据；真实宿主仍待复验 |

自动回存不要求用户填写 URL、逐个选择文件或安装扩展。只有文件 ID 时，组件调用 `getFileDownloadUrl` 并私下提交临时地址；已有可用官方文件对象时可直接下载。**真实 ID 必须属于当前生成产物且获宿主授权**，不能使用文件名、`sandbox:/mnt/data/...` 或之前上传的原附件 ID 替代。

在 Code Interpreter 中从同一份不再修改的原件计算 `size_bytes/content_sha256`。已有目标需先 `fs_stat`，把**目标当前哈希**放入 `expected_sha256`；`null` 只允许新建。组件应保持打开，按状态返回的 `retry_after_ms`、`polls_remaining` 和 `can_poll` 查询；pending 不代表保存完成，failed/unknown 不换键重放。

服务按 `limits.binaryWriteMaxBytes` 限制原文件，默认 32 MiB、最高可配置 128 MiB，不使用 Base64 分块缓存。旧 `fs_import_file` 和 Base64 工具保留兼容；Base64 仅用于完整字节可可靠交接的小载荷，发生截断就停止。不能缩图、重编码或重新生成来代替原文件。详见[本机复制与恢复](docs/file-workflow.md)和[自动原件回存](docs/file-writeback.md)。

## 其他能力与边界

当前注册 **65 个工具：55 个常规工具、10 个组件私有工具**。准确参数与当前版本入口见[工具 schema](docs/tools.json)和[生成的验收说明](docs/current-acceptance.md)；注册数量不保证当前 ChatGPT 对话能调用全部工具。

- 多工作区支持独立名称、只读权限及离线目录策略；文件修改保留设备校验、SHA-256 冲突检查、幂等键、备份和有条件恢复。
- 支持 Git 状态和差异、项目 AGENTS.md、显式登记的 linked worktree，以及独立任务、检查点和交接笔记。
- 命令执行默认关闭。通过页面开启后可运行本机程序，并查看输出、等待、取消或输入 stdin；旧配置可保留程序白名单策略。`trusted-host` 拥有本机用户权限，**不是操作系统沙箱**。
- Codex 历史访问默认关闭；开启后仅只读访问本地可见会话，不调用模型、不读取认证文件、不恢复隐藏推理，也不自动重放历史命令。
- 合成正文回传曾在真实 ChatGPT 连接中成功两次；这不证明 PDF 正文原型或原文件回存已通过真实验收。PDF 原型的字体/CMap 修复仍待真实 PDF 复验，不支持扫描件 OCR、图像理解或自动原生附件导入。
- 没有持续 shell/PTY、自动任务执行器或专用 Git 提交/推送工具。批量修改不是跨文件原子事务，文件恢复不能撤销程序、网络或数据库副作用。

本项目在 Windows 做本地验证，并配置 Windows、Linux、macOS CI。平台结果以[实际 CI 运行](https://github.com/xq3427/WebCodex/actions/workflows/ci.yml)为准，详见[测试边界](docs/testing.md)。WebCodex 使用 MIT 许可证；ChatGPT 订阅、平台权限与相关服务计费由服务提供方决定。

## 多目录、多设备与 Codex 接续

每个工作区对应一个本机 `root`；需要不同名称或权限时分别添加，不能在一个字段中串联多个路径。可通过页面或 CLI 管理：

```text
node dist/src/cli.js workspace add --id papers --name Papers --root /absolute/papers --read-only
node dist/src/cli.js workspace health
node dist/src/cli.js device rename --name "Office laptop"
node dist/src/cli.js codex enable --home /absolute/codex-home
node dist/src/cli.js codex status
```

已有工作区的 `id/uid` 应保留。每台设备分别初始化，维护独立配置、state 和隧道身份，不复制其他设备的真实配置或数据库。v2 修改、执行和取消调用要求 `expected_device_id`，文件不会自动跨设备同步。

Codex home 可位于任意本机盘符，例如 `D:/CodexData/.codex`。省略 `--home` 时优先保留已配置目录；首次发现才使用 `CODEX_HOME` 或用户目录下的 `.codex`，结果写入统一配置。重启连接后，可要求 ChatGPT 查找项目对应会话、读取必要历史，再检查当前文件和 Git 状态，继续未完成工作。详见[配置](docs/local-configuration.md)、[任务与执行](docs/task-workflow.md)及[应急接续](docs/codex-emergency.md)。

## 项目目录

| 路径 | 用途 |
| --- | --- |
| `src/` | TypeScript 实现：CLI、MCP 工具、工作区策略、文件服务、作业、历史与本地面板 |
| `src/browser/` | 浏览器 PDF 正文组件及资源加载代码 |
| `test/` | 合成文件、临时工作区及服务/组件回归测试 |
| `scripts/` | 构建、测试、工具导出、仓库审计与隧道辅助脚本 |
| `distribution/` | Windows/POSIX 一键安装器源码 |
| `examples/` | 不含真实身份和密钥的配置模板与示例 |
| `docs/` | 使用指南、架构、功能边界、生成的 schema 和验收入口 |
| `.github/` | CI 与 issue/PR 模板 |
| `dist/`、`node_modules/` | 本机构建和依赖输出，不提交 |
| `.webcodex/` | 默认本机配置、状态与运行产物，不提交 |
| `release/` | 本机生成的 tgz、安装 ZIP 与校验清单，不提交 |

## 文档与开发

- 入门：[快速安装](docs/quickstart.md) · [接入 ChatGPT](docs/chatgpt-setup.md) · [统一配置](docs/local-configuration.md) · [本地控制中心](docs/local-panel.md)
- 工作流：[文件操作](docs/file-workflow.md) · [自动原件回存](docs/file-writeback.md) · [任务与执行](docs/task-workflow.md) · [Codex 接续](docs/codex-emergency.md)
- 实现与证据：[架构](docs/architecture.md) · [功能状态](docs/implementation-status.md) · [测试](docs/testing.md) · [协议诊断](docs/protocol-diagnostics.md) · [路线](docs/roadmap.md)
- 维护：[贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [更新记录](CHANGELOG.md) · [第三方依赖](THIRD_PARTY_NOTICES.md)

完整导航见[文档目录](docs/README.md)。开发检查：

```text
npm run check
npm test
npm run check:tools
npm run test:repo
npm run audit:repo
```

工具或版本修改后，先构建并运行 `npm run export:tools` 更新生成文档，再执行一致性检查。真实配置、密钥、Codex 历史、状态库及未经脱敏的日志和私人验收产物不得提交。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| doctor 找不到 rg | 安装 ripgrep，或在所选配置中设置 `rgPath` |
| SQLite ExperimentalWarning | Node 内置 SQLite 提示，单独出现不表示服务失败 |
| `TUNNEL_ALREADY_RUNNING` | 程序会自动归档已确认失效的锁；若仍返回此错误，先检查 `tunnel status` 和原终端，不要手工删除锁或反复开新连接 |
| 应用有工具、对话却不能调用 | 确认正确连接已启用，按当前 ChatGPT 界面更新工具，再核对 `system_status` 与实际调用 |
| 回存停在 pending 或失败 | 查看 `fs_save_file_status` 的阶段、错误码和额度；ID 可见不代表授权或保存成功 |
| PDF 组件出现但不能总结 | 检查 `document_read`，只有返回 `ready` 和实际正文才可总结 |
| 改配置后行为没变 | 等作业结束后保存并正常重启对应服务；已有进程不自动重载 |

## 许可证

[MIT](LICENSE)。依赖软件和官方 tunnel-client 遵循各自许可证。
