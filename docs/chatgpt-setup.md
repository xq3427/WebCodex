# 将 WebCodex 接入 ChatGPT 网页

本指南对应 0.14.0-preview.2、配置 schema v2。主线使用 OpenAI 官方 Secure MCP Tunnel 连接本地 MCP。可选本机面板不参与连接，原文件自动上传功能暂停。

连接路径是本机出站 HTTPS → OpenAI 隧道 → 本机官方客户端 → stdio MCP。不需要自建公网入口；本机、网络、客户端及你配置的代理需要保持运行。

官方参考：[Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。账户权限、组织条件、ChatGPT 开发者入口及计费以当前官方页面为准，不能保证所有账户都可用。

## 1. 初始化

安装 Node.js ≥22.16、Git 和 ripgrep。在下载的仓库目录执行：

```text
npm ci --ignore-scripts
npm run build
node dist/src/cli.js init --workspace .
node dist/src/cli.js config validate
node dist/src/cli.js doctor
```

PowerShell 可用 `npm.cmd`。已有配置时跳过 `init`。默认使用 `.webcodex/config.toml`；每条命令均可加同一个 `--config /absolute/private/config.toml`。Windows 示例为 `D:/WebCodex/config.toml`。

`doctor` 检查本机 Git、rg 等依赖并报告工作区状态，不证明云端已经连通。PATH 不同时可在配置填写本机 `nodePath/gitPath/rgPath`。详见[统一配置](local-configuration.md)。

## 2. 安装官方客户端

从 [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases) 下载匹配操作系统和架构的客户端。

Windows 提供安装脚本：

```powershell
.\scripts\install-tunnel.ps1
```

可通过 `-Version vX.Y.Z -Architecture amd64` 固定实际存在的发行版与架构。安装位置为仓库 `.webcodex/tools/tunnel-client/`，不修改系统 PATH、不注册系统服务。脚本下载官方 release 资产、核对摘要并检查解压路径，保留许可报告和 SPDX 材料；未验证独立发布者签名。

两种本机配置方式：

- `clientPath = "auto"`：使用 `toolsDir/tunnel-client/install.json` 的安装记录，并复核版本、来源、架构和程序摘要。配置文件放在其他目录时，需要把 `toolsDir` 指向实际安装目录的 tools 根。
- 显式设置 `clientPath` 和 `clientSha256`：指定已下载的原生程序及完整 64 位 SHA-256，可用 `clientVersion` 固定版本。摘要须与可信官方发行材料核对；仅对未知文件自行算一次哈希不能证明其来源。

Linux/macOS 当前需采用显式路径和摘要；没有这些平台的一键安装脚本。不要复制其他操作系统的二进制或安装记录。

## 3. 配置隧道和鉴权

1. 打开 [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels)，创建或选择隧道。
2. 按官方页面关联管理它的 Platform organization 与使用它的 ChatGPT workspace。
3. 在 [Platform API keys](https://platform.openai.com/settings/organization/api-keys) 准备具有隧道运行权限的 key。管理隧道与运行隧道是不同权限，具体以组织设置为准。
4. 编辑唯一的本机配置。以下是片段，不要重复已有同名 TOML 表：

```toml
[server]
transport = "stdio"

[tunnel]
enabled = false
id = ""
apiKey = ""
proxyUrl = ""
clientPath = "auto"
clientVersion = "auto"
```

填入真实 id/key 并完成客户端配置后，才将 `enabled` 设为 `true`。代理可填本机实际 HTTP 代理，例如 `http://127.0.0.1:7890`；不用代理就留空。代理 URL 不接受账号密码、查询串或额外路径。

v2 API key 和连接设置只从选中的文件读取，不从旧密钥文件、命令行或环境变量补齐。CLI 不显示密钥；客户端通过专用子进程环境接收运行凭据。

在 ChatGPT 连接配置中选择 Tunnel。此 stdio MCP 服务没有自己的 OAuth 登录；若界面要求填写应用鉴权类型，应按官方 Tunnel 接入流程选择相应方式，不要把 Platform runtime key 填入 OAuth 字段。隧道组织授权仍然适用，不能把“服务无独立 OAuth”理解为公开访问。

## 4. 启动与验收

```text
node dist/src/cli.js connect --doctor-only
node dist/src/cli.js connect
```

前者验证配置、客户端并运行官方 doctor；后者再启动持久连接和 MCP 服务。不要另外启动使用同一 state 的 `serve`。

终端保持运行是正常行为。启动提示区分本地检查、等待连接和实际健康证据；一个 SQLite ExperimentalWarning 不表示失败。连接后在 ChatGPT 开发者应用入口添加对应 Tunnel，并在对话启用。

先发送：

> 使用 WebCodex，实际调用 system_status 和 workspace_list。确认版本为 0.14.0-preview.2，报告目标设备和工作区；读取我指定工作区的一个已知文本文件。不要仅凭应用详情判断工具可调用。

再在指定的可写临时目录测试创建和读回，检查实际内容与 SHA-256。新文件使用 `expected_sha256: null`；已有文件必须先读哈希，不能直接覆盖。写入还需要核实后的 `expected_device_id` 与稳定操作键。详见[文件工作流](file-workflow.md)。

注册集合为 44 项，其中 2 项仅组件使用。ChatGPT 当前对话可见列表可能不同；工具发现、MCP 响应、磁盘结果和网页显示应分别判断。

## 5. 排错

在另一个终端使用同一配置查询：

```text
node dist/src/cli.js tunnel status
node dist/src/cli.js diagnostics show
```

| 情况 | 处理 |
| --- | --- |
| disabled / client_unverified | 检查所选配置及客户端安装、路径和摘要 |
| authentication_or_permission | 检查运行 key、组织与 ChatGPT workspace 授权 |
| network_timeout / poll_not_fresh | 检查本机出站网络与所配置的代理 |
| mcp_not_ready / local_unhealthy | 检查构建、工作区、运行数据与服务占用 |
| connected_no_tool_calls | 已有近期连接证据，尚未观察到工具响应；回到对话做实际调用 |
| `TUNNEL_ALREADY_RUNNING` | 检查原终端和同一配置的状态；可能已有连接，也可能异常退出留锁 |
| `TUNNEL_CONTROL_UNAVAILABLE` | 检查控制目录及权限；不能据此认定存在另一连接 |

不要仅凭 `not_running` 删除锁。需要在本机核实原启动器、相关客户端/daemon 和端口后处理残留。程序不会抢占另一启动器。

健康结果是有界观测，不是 OS 级进程身份认证，也不是持续在线保证。成功工具响应计数可能包含业务失败，仍需核对 `ok/error` 和实际结果。诊断范围见[协议诊断](protocol-diagnostics.md)。

## 升级已有 v2 配置

先等待已知 WebCodex 作业进入终态，保存交接，再在原连接终端 Ctrl+C。构建新代码后重新 `connect`，按 ChatGPT 当前界面更新工具，在新对话核对版本和设备。

服务重启会取消其活动作业；持久 job ID 不能恢复原进程。文件/历史 cursor 不能跨服务重启复用。配置不会自动热更新。

历史 `actionsProbe/nativeAttachment` 字段可保留用于兼容，但本版不会启动相应实验。新 `init/export` 不生成这些字段；没有 `chat` 上传命令、浏览器依赖或 Actions/公网服务。

## 从 v0.4 / v1 配置升级

先停止原连接，保存备份。迁移命令第一条预览，第二条应用，源文件不会作为脚本执行：

```text
node dist/src/cli.js config migrate --config .webcodex/config.json --output .webcodex/config.json
node dist/src/cli.js config migrate --config .webcodex/config.json --output .webcodex/config.json --apply
node dist/src/cli.js config validate --config .webcodex/config.json
node dist/src/cli.js doctor --config .webcodex/config.json
node dist/src/cli.js connect --doctor-only --config .webcodex/config.json
```

原位 JSON 迁移避免默认 TOML/JSON 同时存在。旧配置及支持的静态连接设置会被迁移，私有备份留在 state 内。无法证实归属的旧记录不会自动继承为当前设备/项目记录。详见[迁移规则](local-configuration.md#从-v1-迁移)。

## 其他本地客户端

支持 stdio 的 MCP 客户端可直接启动服务，无需 OpenAI 隧道：

```json
{
  "mcpServers": {
    "webcodex": {
      "command": "node",
      "args": [
        "/absolute/WebCodex/dist/src/cli.js",
        "serve",
        "--config",
        "/absolute/private/config.toml"
      ]
    }
  }
}
```

具体配置外层结构取决于客户端。这是本机客户端示例，不能当作 ChatGPT 云端访问本机路径的方法。

选择 `server.transport = "http"` 并配置不少于 32 字符的 `http.bearerToken` 时，`serve` 仅监听 `127.0.0.1`。这不是公网 OAuth 服务，不能直接拿 localhost URL 接入 ChatGPT 云端。
