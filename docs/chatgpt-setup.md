# 将 WebCodex 接入 ChatGPT 网页

本指南对应 0.16.0-preview.17、配置 schema v2。主线使用 OpenAI 官方 Secure MCP Tunnel 连接本地 MCP。`connect` 默认同时启动本机配置控制中心，并输出带临时凭据的完整本机链接，可直接在页面管理本次连接。本地 PDF 文字层使用 document_open/document_read，生成文件自动回存使用 fs_save_file/status，均需分别通过实际宿主验收；不等同于自动上传为原生附件。

连接路径是本机出站 HTTPS → OpenAI 隧道 → 本机官方客户端 → stdio MCP。不需要自建公网入口；本机、网络、客户端及你配置的代理需要保持运行。

官方参考：[Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。账户权限、组织条件、ChatGPT 开发者入口及计费以当前官方页面为准，不能保证所有账户都可用。

## 1. 初始化

新用户推荐按[快速开始](quickstart.md)下载一键安装 ZIP；安装器会准备本机依赖并打开管理页面。下面是已有 Node.js ≥22.16 的源码安装方式：

```text
npm ci --ignore-scripts
npm run build
node dist/src/cli.js setup --workspace .
```

PowerShell 可用 `npm.cmd`。首次 setup 安装工具并创建配置；已有配置原样保留。默认使用 `.webcodex/config.toml`；每条命令均可加同一个 `--config /absolute/private/config.toml`。Windows 示例为 `D:/WebCodex/config.toml`。传统 init 只生成配置，不安装工具。

`doctor` 检查本机 Git、rg、PDF 组件清单与字节完整性，并报告工作区状态，不证明云端已经连通。PATH 不同时可在配置填写本机 `nodePath/gitPath/rgPath`。详见[统一配置](local-configuration.md)。

## 2. 安装官方客户端

首次 setup 已从 [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases) 安装匹配操作系统和架构的客户端，可跳过本节。下面保留已有手动配置的安装方式。

Windows 提供安装脚本：

```powershell
.\scripts\install-tunnel.ps1
```

可通过 `-Version vX.Y.Z -Architecture amd64` 固定实际存在的发行版与架构。安装位置为所选配置的 `toolsDir/tunnel-client/`，不修改系统 PATH、不注册系统服务。脚本下载官方 release 资产、核对摘要并检查解压路径，保留许可报告和 SPDX 材料；未验证独立发布者签名。

两种本机配置方式：

- `clientPath = "auto"`：使用 `toolsDir/tunnel-client/install.json` 的安装记录，并复核版本、来源、架构和程序摘要。外置配置须在安装时传同一 `-Config`，例如 `./scripts/install-tunnel.ps1 -Config D:/WebCodex/config.toml`。可先加 `-ResolveOnly` 仅查看安装位置；不会下载或修改配置。
- 显式设置 `clientPath` 和 `clientSha256`：指定已下载的原生程序及完整 64 位 SHA-256，可用 `clientVersion` 固定版本。摘要须与可信官方发行材料核对；仅对未知文件自行算一次哈希不能证明其来源。

Linux/macOS 的首次 setup 同样生成已验证安装记录。手动安装可采用显式路径和摘要；不要复制其他操作系统的二进制或安装记录。

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

前者验证隧道配置、客户端并运行官方 doctor，不启动控制中心；后者按 `server.transport` 启动 MCP 服务和本地控制中心。本指南的 stdio 模式启动官方隧道；配置为 HTTP 时启动本机接口，其就绪不代表 ChatGPT 已接入。终端 stderr 会在独立一行输出完整链接，例如 `http://127.0.0.1:8767/#token=...`，打开终端实际生成的完整地址即可管理配置和重启本次服务，不需要另外运行 `panel`。面板端口占用或与 HTTP 服务端口相同时，会临时选择空闲回环端口，不修改配置或关闭旧页面。链接只在本机使用，包含临时面板凭据，不是 API key，勿分享。

不需要页面时使用 `node dist/src/cli.js connect --no-panel`。单独 `panel` 只打开控制中心，不自动连接；底层 `serve` 不启动页面。旧版、`--no-panel` 或独立 `serve` 启动的服务仍需在原终端正常停止后，才能从页面重新启动并管理。不要另外启动使用同一 state 的 `serve`。

终端保持运行是正常行为。连接检查或服务启动失败、发现外部实例时，控制中心保留供检查和修复，不接管外部服务；页面能打开不代表 ChatGPT 已连接。启动提示区分本地检查、等待连接和实际健康证据；一个 SQLite ExperimentalWarning 不表示失败。连接后在 ChatGPT 开发者应用入口添加对应 Tunnel，并在对话启用。

先发送：

> 使用 WebCodex，实际调用 system_status 和 workspace_list。确认版本为 0.16.0-preview.17，报告目标设备和工作区；读取我指定工作区的一个已知文本文件。不要仅凭应用详情判断工具可调用。

再在指定的可写临时目录测试创建和读回，检查实际内容与 SHA-256。新文件使用 `expected_sha256: null`；已有文件必须先读哈希，不能直接覆盖。写入还需要核实后的 `expected_device_id` 与稳定操作键。详见[文件工作流](file-workflow.md)。

注册集合为 60 项，其中 8 项仅组件使用；版本、工具数量和简短验收指令由[工具导出自动生成](current-acceptance.md)。ChatGPT 当前对话可见列表可能不同；工具发现、MCP 响应、磁盘结果和网页显示应分别判断。

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
| `TUNNEL_ALREADY_RUNNING` | 程序会自动归档能确认所属进程已退出的失效锁；若仍返回此错误，说明进程仍在运行、锁格式异常或本机无法安全验证。先检查原终端和同一配置的状态，不要手工删除锁 |
| `TUNNEL_CONTROL_UNAVAILABLE` | 检查控制目录及权限；不能据此认定存在另一连接 |

不要仅凭 `not_running` 删除锁。需要在本机核实原启动器、相关客户端/daemon 和端口后处理残留。程序不会抢占另一启动器。

健康结果是有界观测，不是 OS 级进程身份认证，也不是持续在线保证。成功工具响应计数可能包含业务失败，仍需核对 `ok/error` 和实际结果。诊断范围见[协议诊断](protocol-diagnostics.md)。

### 对话提示 `Session terminated`

这是连接／会话问题，不是分块大小或文件来源错误。先在本机运行 `node dist/src/cli.js tunnel status`，再检查 `node dist/src/cli.js diagnostics show` 的最近时间、工具和版本。如果连 `fs_stat` 都不可用，不要反复重传文件或改用导入接口。

确认本机没有原启动器、客户端或 daemon，且没有活动作业后，可用原配置重新 `connect`；不要删除未经核实的启动锁。隧道恢复为在线、MCP 就绪后，先在对话调用 `system_status` 和 `fs_stat`。健康探针不能证明旧对话的会话仍有效；若仍提示终止，在 ChatGPT 重新连接应用后再做只读检查，并确认原图仍可访问。

若断开前已经发送过写入或分块，先用原操作键查询 `operation_status` 或 `fs_write_binary_status`，不能仅凭会话报错认定“没有修改文件”。若只有只读调用且本机没有分块记录，则恢复连接后再开始传输；无法取得原文件字节时不能重生成或缩图替代。

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
