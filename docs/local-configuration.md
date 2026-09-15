# 本机统一配置（0.16.0-preview.13）

每台设备维护一份配置，包含 API key、官方隧道、代理、设备身份、项目目录、Codex home、程序路径、本地面板端口和运行限额。新安装默认 `.webcodex/config.toml`；JSON 使用相同 schema v2。公开模板见 [config.example.toml](../examples/config.example.toml)。真实配置及备份包含凭据，应留在本机；CLI 生成和编辑的 v2 文件会限制文件权限。

## 初始化与选择文件

以下 Node 命令适用于 Windows、macOS 和 Linux；先安装 Node ≥22.16、Git、ripgrep，在仓库执行 `npm ci`、`npm run build`。

```text
node dist/src/cli.js init --workspace /absolute/project --config /absolute/private/config.toml
node dist/src/cli.js config validate --config /absolute/private/config.toml
node dist/src/cli.js config show --config /absolute/private/config.toml
node dist/src/cli.js doctor --config /absolute/private/config.toml
```

Windows 可将路径换成 `D:/Projects/demo`、`D:/WebCodex/config.toml`。配置文件也可放在其它本地磁盘。所有管理和启动命令均接受 `--config`；省略时按以下顺序选择，**不合并**：

1. `--config`。
2. `WEBCODEX_CONFIG` 指向的文件。
3. 当前目录 `.webcodex/config.toml` 或 `config.json`。
4. 用户目录：Windows `%LOCALAPPDATA%/WebCodex`；macOS `~/Library/Application Support/WebCodex`；Linux `${XDG_CONFIG_HOME:-~/.config}/webcodex`。

同级两个默认文件同时存在时报错。显式路径无效也报错，不回退。环境变量只用于文件选择和明确的自动路径发现；API key、HTTP token、代理不从旧环境变量补齐。

相对路径以配置文件目录为基准；路径支持 `~`、`${userHome}`、`${configDir}` 和 `${nodePath}`，不执行 shell，不展开任意环境变量。`nodePath/gitPath/rgPath = "auto"` 使用本机发现；跨设备可分别填写本机绝对路径。未知配置字段、重复键和错误格式报错，错误消息不引用原配置内容。

CLI 对常规 TOML 表、字段、`[[workspaces]]` 和顶层多行工作区数组保留注释。更新数组时可将数组改成单行、把内部注释移到数组上方；未改动的数组保持原布局。其他合法但复杂的多行或特殊引号布局仍能加载，自动编辑会返回 `CONFIG_EDIT_UNSUPPORTED` 并保留原文件，可手工修改该布局。JSON 编辑会重新格式化。

## 配置组

| 配置 | 用途 |
|---|---|
| `device.id` / `device.name` | init 生成的稳定 UUID / 用户可修改的设备显示名 |
| `workspaces` | 1–32 项路径字符串或对象；对象必填 root，可选 id、uid、name、readOnly、enabled、onUnavailable、executionProfile；linked worktree 需明确登记元数据 |
| `stateDir` / `toolsDir` | 自动运行数据及本机工具安装目录 |
| `nodePath` / `gitPath` / `rgPath` | 本机可执行程序入口 |
| `codexSessions` | 是否读取 Codex 历史、home、请求窗口数和单记录字节上限 |
| `tunnel` | enabled、id、apiKey、proxyUrl、clientPath、clientVersion、可选 clientSha256 |
| `server` / `http` | transport、回环 MCP HTTP 端口及 bearerToken |
| `localPanel` | 本地控制中心端口 port，默认 8767；固定监听 127.0.0.1 |
| `execution` | 全局执行模式、别名/固定参数、受限 env、可由工作区引用的 profiles，以及统一并发、超时、输出/输入限额 |
| `fileBatches` | 一批改动的文件数量与修改前后原始字节总量上限 |
| `fileWidget` | 显式组件诊断的兼容设置；不控制 ChatGPT 原生附件上传 |
| `diagnostics` | MCP 协议诊断开关，以及本机保存的请求元数据条数上限 |
| `projectContext` | 项目指导扫描深度、单文件及全链原始字节上限 |
| `tasks` | 每工作区任务数、每任务修订数、选定文件数、单次文件哈希扫描总量 |
| `limits` | 文本读取、源文件/哈希预算、有界 MCP 原字节和诊断组件、文本/二进制写入、搜索及目录列表限额；不限制 ChatGPT 原生附件大小 |

`diagnostics.maxEvents` 只限制 MCP 协议诊断表；原有操作审计、文件备份、任务历史和作业输出的保留方式不变，尚无通用日志轮转或自动清理策略，当前仍不接受 `logging`、`retention`、`logsDir`。`execution.env` 从 v0.6 起只接受下文列出的开发变量。隧道运行日志原文不转发，连接状态使用 `tunnel status` 的受限字段。SQLite/备份/作业输出属于运行数据，不是第二份用户配置。

### 本地面板

在同一份 v2 配置添加以下可选片段，省略时默认端口 8767：

```toml
[localPanel]
port = 8767
```

JSON 对应 `"localPanel": { "port": 8767 }`。端口必须是 1024–65535 的整数；不接受 host、API key 或公开地址字段。面板固定监听 `127.0.0.1`，与 `http.port` 的 MCP HTTP 端口独立。

```text
node dist/src/cli.js connect --config /absolute/private/config.toml
```

使用 v2 配置时，`connect` 默认同时启动本地控制中心和 MCP 服务，并在终端 stderr 独立一行打印含临时 `#token` 的完整可点击链接。服务按 `server.transport` 选择：stdio 使用官方隧道，HTTP 启动本机接口；HTTP 就绪不代表 ChatGPT 已接入。面板提供草稿、校验、工作区/权限/功能表单及密钥只写更新，保存到同一配置文件并使用配置哈希避免覆盖并发编辑；页面可以直接启停或重启本次连接。查看已有状态仍只读，不初始化第二个 App/StateStore。连接检查或服务启动失败、发现外部实例时，已启动的页面保留供检查和修复，不接管外部服务。

`connect` 遇到面板端口占用，或面板端口与本次 HTTP 服务端口相同时，会临时选择空闲回环端口，不修改配置或关闭旧页面。只打开配置页面可运行 `node dist/src/cli.js panel`，它不自动启动 daemon；`connect --no-panel` 保留无页面连接，`connect --doctor-only` 只检查、不启动页面，底层 `serve` 也不启动页面。旧版、`--no-panel` 或独立 `serve` 启动的外部服务，仍需在原终端正常停止一次，再从面板启动才能由它管理。

启动 URL 的 fragment 中包含本次面板凭据，需保密；页面清除地址片段后仅使用本机会话 `sessionStorage`，不加载外部资源。凭据随面板进程停止/重启失效，不从配置 API key 派生。保存后可在页面重启自有服务；面板端口变更下次启动面板生效。也可用 `panel --port 8777` 临时换端口，不修改配置。面板只接受 `127.0.0.1` 和 `localhost` 回环主机名，并要求 Host 与 Origin 使用同一端口，仍拒绝其他主机名。Linux 服务器可通过 `ssh -N -L 本机端口:127.0.0.1:面板端口 user@server` 建立本地转发（本机端口可以不同），再把启动链接的端口改成本机转发端口后打开；不要公开绑定面板。详见[面板指南](local-panel.md)。

历史 `actionsProbe` 和 `nativeAttachment` 字段允许保留，以便旧配置继续使用；默认程序将其视为未运行的归档实验，即使旧 enabled 仍是 true 也不会启动或安装任何第三方客户端。`config show` 只显示 inactive 提示，`init` 和 `config export` 不生成这一字段。历史资料见[后续路线](roadmap.md)。

### MCP 协议诊断

可选 `diagnostics` 位于所选的同一份 TOML/JSON 配置中。旧 v1/v2 配置省略整个组或部分字段时使用默认值；读取配置不补写原文件，更改后重启服务生效。

```toml
[diagnostics]
enabled = true
maxEvents = 1000
```

JSON 对应片段为 `"diagnostics": { "enabled": true, "maxEvents": 1000 }`。

| 字段 | 默认值 | 允许范围与含义 |
|---|---|---|
| `diagnostics.enabled` | `true` | 布尔值；是否记录新的 MCP 协议诊断 |
| `diagnostics.maxEvents` | `1000` | 20–10000 的整数；协议诊断最多保留的请求记录条数 |

诊断只保存固定协议元数据，例如方法、已注册工具名、阶段、受限错误码、时间和服务实例；不保存请求参数、文件路径或正文、工具返回内容、HTTP 请求头、API key 或远端请求 ID。记录位于 `stateDir` 中现有 SQLite 数据库的独立诊断表。启用时，服务启动及新增记录会按 `maxEvents` 清理较旧的协议诊断；这是条数上限，不是整个 SQLite 文件的字节上限。关闭诊断不会删除已有记录。

在仓库目录运行以下命令，可在隧道及 MCP 服务运行时读取最近 20 条诊断，无需停止服务。命令只读打开数据库，不取得 daemon 的 state 独占锁，不启动第二个服务：

```text
node dist/src/cli.js diagnostics show --config /absolute/private/config.toml
```

Windows 可将示例配置路径替换为 `D:/WebCodex/config.toml`。`system_status` 也返回当前实例最近 5 条诊断摘要。HTTP 鉴权、Host 校验或消息分帧/解析在 SDK 请求分发前失败时，不会进入这张表；没有记录不能证明网页没有选择某个应用。`response_sent` 只表示本地发送响应的操作完成，不证明网页展示结果、读取附件正文或完成后台作业。阶段说明与排查步骤见[协议诊断](protocol-diagnostics.md)。

### 文本读取、哈希与原文件预算

PDF、Office 原文件的自动附件接入已经暂停。[本地面板](local-panel.md)仅提供可选的手动定位，用户也可直接使用 ChatGPT 原生附件入口。手工上传不经过 MCP 响应，不受下列 MCP 原字节 4/7 MiB 限额约束；实际原生上传格式、大小与账户限额由 ChatGPT 决定。

`limits.fileReadMaxBytes` 控制 `fs_read_chunk` 可扫描的文本源文件大小，以及面板/任务中相关的单文件哈希扫描预算，默认 16777216（16 MiB），范围 1024–134217728（128 MiB）。面板遇到更大文件仅跳过哈希，仍返回元信息并允许复制路径、打开所在目录，不截断文件或禁止用户原生上传。每页文本正文仍受 `limits.readMaxBytes` 约束，默认 65536；任务快照另有 `tasks.maxSnapshotBytes` 总量限制。

`limits.fileTransferMaxBytes` 只控制 `fs_read_file` 以及显式诊断组件从工作区取得的完整原字节，默认 4194304（4 MiB），最大 7340032（7 MiB）。超限拒绝整次传输，不做转换或截断。调大文本预算、组件上传策略或缓存不会扩大这个传输上限，也不扩大写入权限。

新增 PDF 正文原型沿用 `limits.fileTransferMaxBytes`、`fileWidgetCacheMaxBytes`、`fileWidgetTicketTtlMs` 与 `fileWidgetChunkMaxBytes` 的已有原字节策略；具体的固定实验预算见 [PDF 正文原型](pdf-reading-prototype.md)。没有新增第二份配置文件或公网服务。

### 生成文件回存与二进制恢复

`0.15.0-preview.5` 新增可选 `limits.binaryWriteMaxBytes`，控制 `fs_import_file` 从 ChatGPT 官方文件参数下载完整文件的最大字节数。默认 33554432（32 MiB），范围 1024–134217728（128 MiB）的整数。旧配置省略该项时使用默认值，不必另建配置文件。

以下是需合入现有 `limits` 的片段；已有表不要重复创建，其他字段保留：

```toml
[limits]
binaryWriteMaxBytes = 33554432
```

JSON 对应片段为 `"limits": { "binaryWriteMaxBytes": 33554432 }`。配置调整后运行 `config validate`，再正常重启服务。

`fs_stat` 的完整字节哈希扫描使用 `binaryWriteMaxBytes` 与 `writeMaxBytes` 中较大的值；`fs_import_file` 的下载与写入目标严格使用 `binaryWriteMaxBytes`。变更记录保存写入类型：文本与旧记录的恢复继续受 `writeMaxBytes` 限制，原字节回存记录的恢复目标受 `binaryWriteMaxBytes` 限制。二进制操作检查当前文件时可使用两者中较大的预算，但不会据此扩大恢复目标大小。文本 `fs_write`、补丁和批量 write/patch 仍受原 `writeMaxBytes` 限制；批量 copy/move/delete 使用二进制限额。降低限额后，较大的当前文件或历史备份可能无法再核验或恢复；服务不会自动提高配置。

下载仅访问官方 `files.oaiusercontent.com` 的 HTTPS 地址，不使用 `tunnel.apiKey`，不新增公网端口、证书、Actions 服务或浏览器扩展。若已有配置设置 `tunnel.proxyUrl`，下载复用该本机代理配置；为空时直接连接，不自动安装或启用代理。目标仍须符合官方下载主机与网络校验。文件地址来自 ChatGPT 文件参数；配置无法把 `sandbox:/...` 路径变成可下载地址。本地大小上限与 ChatGPT 宿主是否传入生成附件是不同条件，后者仍待真实验收，见[回存说明](file-writeback.md)。

### 回存重试与二进制批次预算

统一配置可加入：

```toml
[fileImports]
maxAttempts = 3
downloadTimeoutMs = 60000

[fileBatches]
maxFiles = 20
maxTotalBytes = 4194304
binaryMaxTotalBytes = 134217728
```

省略新字段时使用上述默认值。maxAttempts 范围 1–10（包含首次尝试），downloadTimeoutMs 范围 1000–300000；仅明确发生在写入前的下载失败可同键重试。busy 不消耗尝试，提交结果不明必须查询 operation_status，不能自动重写。有效尝试上限取已保存额度与当前配置的较小值；在下调后的重试检查中持久保留收紧额度，之后调高不会复活已耗尽操作，剩余额度以状态查询为准。

maxTotalBytes 继续约束文本 write/patch 的批次子预算；含 copy/move/delete 的批次以 binaryMaxTotalBytes 约束全批前后字节总预算（纯文本批次只使用 maxTotalBytes），范围 1024–536870912。copy/move/delete 使用 limits.binaryWriteMaxBytes 的单文件限额。预算计算包含前后快照，例如 32 MiB 复制/移动至少计 64 MiB；不等于仅计算新增文件大小。修改预算后须重新预览计划。

### 原字节直接回存

```toml
[limits]
inlineBinaryWriteMaxBytes = 262144
binaryWriteMaxBytes = 33554432

[binaryInputs]
chunkMaxBytes = 65536
maxSessions = 4
maxCacheBytes = 67108864
ttlMs = 900000
```

将字段合并到现有表，勿重复定义 `limits` 或覆盖其他配置。`0.16.0-preview.5` 将单消息与分块整文件限额分开：

| 字段 | 默认值 | 范围与用途 |
| --- | --- | --- |
| `limits.inlineBinaryWriteMaxBytes` | 262144（256 KiB） | 1024–1048576；仅限制单消息 `fs_write_binary`，与 `binaryWriteMaxBytes` 取较小值，不限制分块整文件 |
| `limits.binaryWriteMaxBytes` | 33554432（32 MiB） | 1024–134217728（128 MiB）；二进制单文件限额，原最大值不变 |
| `binaryInputs.chunkMaxBytes` | 65536（64 KiB） | 1024–262144（1 KiB–256 KiB）；每块原始字节上限，实际块大小不超过整文件限额 |
| `binaryInputs.maxCacheBytes` | 67108864（64 MiB） | 1024–536870912（1 KiB–512 MiB）；全部分块会话共享的暂存总预算，按声明的完整文件大小预留 |
| `binaryInputs.maxSessions` | 4 | 1–16；最多同时暂存的会话数，仍需符合总字节预算 |
| `binaryInputs.ttlMs` | 900000（15 分钟） | 1000–3600000 毫秒；按连续未收到新分块的时间计算 |

分块整文件上限为 `min(binaryWriteMaxBytes, maxCacheBytes)`，默认 32 MiB。只调大 `inlineBinaryWriteMaxBytes` 不会提高分块预算；暂存总预算较小或已被其他会话占用时，服务也不能保证接收一个达到单文件上限的新文件。

省略字段使用上例默认值；**已有显式较小配置原样保留**，例如旧 `chunkMaxBytes = 12288` 或 `maxCacheBytes = 1048576` 不因升级自动提高。需要提高时在同一配置文件中修改对应字段，运行 `config validate` 后正常重启。`inlineBinaryWriteMaxBytes` 原值也保留，但它只约束单消息路线。

分块写入使用本机 SQLite 中有界、按工作区绑定的私有暂存，不创建公网入口。未收齐前不会写目标文件，收齐后验证整文件 SHA-256 并使用原有备份/CAS/设备权限和幂等写入。过期清理只回收暂存，不删除工作区文件或历史写入回执。服务端上限不保证 ChatGPT 能可靠传送大段 Base64，分块仍消耗对话预算；不得为满足限额缩图、重新编码或替换原文件，失败应报告原字节传输的实际状态。

### 原文件组件自动与手动模式

以下设置仅为保留的 `fs_open_file / file_widget_probe` 显式诊断流程提供兼容，不是正常阅读文档的必配项，也不控制本地面板、ChatGPT 原生附件或 `fs_save_file / fs_import_file` 回存流程。当前共 65 个注册工具，包含 55 个常规工具和 10 个组件私有工具；PDF 正文原型不使用这里的手动/自动上传设置。

```toml
[fileWidget]
mode = "automatic"
compact = true
closeAfterSend = true
```

JSON 对应 `"fileWidget": { "mode": "automatic", "compact": true, "closeAfterSend": true }`。省略时采用上面的默认值，不补写原配置。mode 只允许 automatic/manual，两个开关仅允许布尔值。

| 字段 | 兼容行为 |
|---|---|
| `fileWidget.mode` | automatic 在明确打开组件、文件重建校验后尝试上传及宿主支持的引用；manual 保留点击 |
| `fileWidget.compact` | 紧凑展示组件，不保证完全隐藏宿主界面 |
| `fileWidget.closeAfterSend` | 在相应状态同步成功且宿主支持时请求关闭，不保证关闭或模型可读 |

无文件探针始终手动。原文件传入、哈希、组件上传回执与模型实际读到正文是不同结果；此前组件上传后正文仍不可访问，不能根据这些设置或 fileId 宣称功能已完成。PDF 文字层也可试用 [document_open/read 原型](pdf-reading-prototype.md)，其真实宿主验收仍待完成；诊断历史见[原文件说明](original-files.md#保留的工具)。

下列可选字段继续属于原配置的 `limits`，只影响兼容组件：

| 字段 | 默认值 | 允许范围与含义 |
|---|---|---|
| `fileWidgetUploadMaxBytes` | 104857600 | 1–536870912 字节；组件本机上传策略，不是宿主能力 |
| `fileWidgetTicketTtlMs` | 300000 | 1000–1800000 毫秒；分块票据有效期 |
| `fileWidgetCacheMaxBytes` | 33554432 | 1–268435456 原始字节；内存快照总量 |
| `fileWidgetChunkMaxBytes` | 65536 | 4096–262144 原始字节；每块上限 |

票据到期、释放或服务重启后失效，不能跨重启续传。缓存和上传策略可以进一步降低组件实际单文件预算，不会提高后端 4/7 MiB 上限。不要将历史草案中的 `fileTransfer` 等未实现字段写入当前配置。正常原生上传无需调整这些字段。

### 指导、任务和等待限额

新增设置继续写在所选的同一份 TOML/JSON 配置中。旧 v2 文件省略这些字段时使用下列默认值，无需为升级重新生成设备身份或配置文件：

| 字段 | 默认值 | 允许范围与含义 |
|---|---|---|
| `projectContext.maxDepth` | 32 | 1–128；工作区根为深度 0，只扫描到设定深度 |
| `projectContext.maxFileBytes` | 65536 | 1024–1048576；单份指导原文件上限 |
| `projectContext.maxTotalBytes` | 262144 | 不小于 maxFileBytes，最多 4194304；整个指导链读取总量 |
| `tasks.maxTasksPerWorkspace` | 100 | 1–10000；达到后拒绝新建，保留旧任务 |
| `tasks.maxRevisionsPerTask` | 100 | 1–10000；达到后拒绝追加，保留旧修订 |
| `tasks.maxTrackedFiles` | 20 | 1–100；每次保存显式选择的文件数量 |
| `tasks.maxSnapshotBytes` | 16777216 | 1024–134217728；一次保存或当前状态检查的原文件哈希扫描总量 |
| `execution.defaultWaitMs` | 1000 | 0–maxWaitMs；exec_wait 默认等待时长，不改变程序超时 |
| `execution.maxWaitMs` | 20000 | 1–20000；单次 exec_wait 最大等待毫秒数 |

`workspace_context` 的 `max_bytes` 只控制返回正文预算，范围 256–readMaxBytes。指导完整读取和脱敏后才分块；过大、无法读取或超过深度的来源通过 `omissions` 报告，不能把 `complete: true` 当作无遗漏。各层存在 override 但无法读取时不回退到 AGENTS.md。改动来源、选择关系或扫描配置会使旧 context 游标失效；每页预算可调整，重启后从头读取。

任务修订保存于本机 state，属于运行数据。上面的任务数和修订数是拒绝新增的上限，不会自动删除历史；当前没有任务删除或自动保留清理。检查点正文有独立的完整大小限制，详见[任务工作流](task-workflow.md)。配置修改后重启生效，不自动开启命令执行。

### v0.8 的批量变更与作业输入限额

| 字段 | 默认值 | 允许范围与含义 |
|---|---|---|
| `fileBatches.maxFiles` | 20 | 1–100；每批涉及的不同路径数，移动/复制计源/目标两条路径 |
| `fileBatches.maxTotalBytes` | 4194304 | 1024–33554432；一批 write/patch 修改前后原字节的小计 |
| `fileBatches.binaryMaxTotalBytes` | 134217728 | 1024–536870912；含 copy/move/delete 的批次全部前后原字节合计 |
| `execution.stdinMaxBytes` | 65536 | 1–1048576；每次写入输入管道的 UTF-8 字节上限 |
| `execution.stdinMaxTotalBytes` | 1048576 | 1–16777216；单个 job 累计尝试写入的 UTF-8 字节上限，不小于 stdinMaxBytes |
| `execution.stdinWriteTimeoutMs` | 5000 | 100–20000；单次管道写入的最大等待毫秒数，不改变程序总超时 |

write/patch 单文件受 `limits.writeMaxBytes` 约束，copy/move/delete 单文件受 `limits.binaryWriteMaxBytes` 约束，不能通过拆成批量操作绕过；预览 diff 的正文预算受 `limits.readMaxBytes` 约束。文件数量、备份及修改后字节全部预检，预览本身不保存计划或锁定外部编辑器。详见[批量变更](file-workflow.md#多文件预览与应用)。

`exec_start` 默认关闭 stdin，只有明确传入 `stdin: "pipe"` 才保留输入管道。输入限额并不会开启执行；作业仍须本机启用 trusted-host 并授权可写工作区。累计输入按尝试发送计数，交付未知也不返还预算，以免重复发送。成功幂等重试返回原记录，不重复计数或发送。旧 v2 文件省略新字段自动取以上默认；v1 继续原 schema，迁移到 v2 后可自定义这些设置。

## 设备与工作区

### 直接添加多个目录

从 v0.9 起，schema v2 支持以下配置片段，将它放进**原先选定的同一份配置文件**即可。字段是复数 `workspaces`；每个路径对应一个独立工作区，`root` 本身仍是单个字符串。JSON 中 Windows 路径建议用 `/`；使用反斜杠时须写成 `D:/Projects/papers`。

```json
{
  "workspaces": [
    "D:/Projects/demo",
    "D:/Projects/papers"
  ]
}
```

这是字段片段，不是完整配置。**已有 `default` 等条目请保留原来的 id、uid，只在数组后追加新路径**，否则原本随机分配的 UID 会被自动生成的 UID 替代，旧任务、变更及幂等回执不会自动归到新身份。例如原数组只有一个对象时，在该对象后添加 `, "D:/Projects/papers"` 即可。

需要便于辨认的别名、名称或只读权限时使用对象；这三种写法可以混用：

```json
{
  "workspaces": [
    "./projects/app",
    { "root": "./projects/api", "id": "api", "name": "后端项目" },
    { "root": "D:/Projects/papers", "id": "papers", "name": "论文资料", "readOnly": true }
  ]
}
```

TOML 使用顶层数组，写在 `[device]` 等表头之前；也可继续使用 `[[workspaces]]` 并仅填写 `root`。同一文件两种定义不能同时出现：

```toml
workspaces = [
  "D:/Projects/demo", # 开发项目
  "D:/Projects/papers",               # 另一个独立工作区
]
```

省略字段时，名称取目录名（最多 120 个 UTF-16 单位），`readOnly` 为 false、`enabled` 为 true、`onUnavailable` 为 `"error"`；ID 和 UID 根据 `device.id` 与规范化目录稳定生成。禁用或暂时无法解析的目录使用展开后的路径；CLI 禁用、改绑时会固定选中条目的身份。读取配置不写回文件，不创建 state；重排、等价相对路径、Windows 大小写变化或仅改显示名称均不会换身份。移动目录或更换设备产生不同身份；新设备仍需单独 init，不能复制运行 state。CLI `workspace list` 或 MCP `workspace_list` 显示最终 ID，后续工具必须使用它选择工作区，不能假定第一项叫 `default`。

运行中的服务保持启动时的授权，保存配置后须重启隧道生效。更换已登记目录推荐下面的 `workspace rebind`：保持 ID、为新根生成新 UID；旧根已消失时也能按先前列出的 ID 修复。此命令可能把目标简写展开为对象，其他条目保持原形状。旧 v1 配置仍使用完整条目，迁移到 v2 后才支持简写。

默认要求目录已经存在。重复目录、受保护目录仍被拒绝；启用的目录不能经过链接/junction。两个启用的父子工作区必须使用相同的 readOnly 设置，避免父目录写授权覆盖子目录只读限制。同权限嵌套允许，但同一物理文件的操作记录仍按所选工作区独立保存；建议优先登记互不重叠的项目根。Git linked worktree 继续用 `--worktree` 显式授权，单加路径不会放行其元数据。

### 暂时离线、禁用与目录身份

v0.10 可在同一配置中分别处理暂时不在线的项目。以下是字段片段；已有条目的 id、uid 应保留：

```json
{
  "workspaces": [
    { "root": "D:/Projects/demo", "id": "code" },
    { "root": "D:/Projects/papers", "id": "papers", "onUnavailable": "skip" },
    { "root": "D:/ArchivedProject", "id": "archive", "enabled": false }
  ]
}
```

`enabled: false` 暂停该工作区注册，保留配置和旧记录，加载及运行时不探测其根目录；静态保护边界和配置格式仍须有效。可以禁用全部条目后启动服务。禁用只作用于这条注册：如果另一个启用的父工作区仍授权访问该目录，父工作区的权限仍然生效，它不是目录黑名单。

`onUnavailable: "error"` 是默认值，启动时目录缺失或不可访问会报错。`"skip"` 允许服务跳过缺失、设备离线及访问权限错误，让其他工作区继续运行；不会自动创建目录，也不会放行链接、受保护目录或无效仓库布局。运行中某个目录失效时，`workspace_list` 仍逐项返回状态，其他可用目录的文件操作继续工作。

MCP `workspace_health` 可检查全部工作区或指定 `workspace_id`，同时核验当前服务的设备、工作区和根目录绑定。CLI `workspace health` 只检查配置与目录元数据，不打开服务 state；即使默认 `error` 的根目录缺失，也可用它定位问题。CLI 结果标明 `identity_scope`，其中 `available` 不证明目录与旧备份的运行时绑定一致；同样不能把 `doctor` 或 `execution inspect` 的静态结果当作该证明。

| 状态 | 含义与处理 |
|---|---|
| `available` | 当前目录检查通过；MCP 结果还包含运行时绑定核验 |
| `disabled` | 已禁用，工具返回 `WORKSPACE_DISABLED`；本机 enable 后重启 |
| `missing` / `inaccessible` | 缺失或不可访问，工具返回 `WORKSPACE_UNAVAILABLE`；恢复目录或权限 |
| `blocked` | 链接、保护边界或仓库元数据等检查未通过；按 error_code 在本机修复 |
| `restart_required` | 该目录启动时没有可用绑定，现已出现；核对后重启，工具返回 `WORKSPACE_RESTART_REQUIRED` |
| `identity_mismatch` | 同一路径对应的物理目录或保存的身份不符；恢复原目录，或明确登记新身份 |

服务将规范路径与根目录的设备号、文件系统实体编号、创建时间共同记录为指纹。如果**启动时被跳过**的目录后来出现，需要重启后验证并建立绑定；如果已绑定的原目录仅在运行期间暂时移走、随后恢复为同一实体，可直接恢复访问。禁用条目也须先本机 enable，再重启。

在同一路径新建另一目录，不等于恢复原项目：旧 UID 会得到 `WORKSPACE_IDENTITY_MISMATCH`，旧备份与幂等结果不会应用到新目录。默认配置在重启时也会拒绝；设置了 skip 的条目可保留为不可用，让其他工作区启动，但重启不会自动接纳替换目录。确认新目录就是目标后，使用 `workspace rebind --id ID --root PATH --new-identity` 明确生成新 UID；它保持 ID 和禁用状态，如需恢复禁用条目还要执行 enable。更换到不同 root 的普通 rebind 本身就会生成新 UID。

根目录不可用、被禁用或身份不符时，该工作区的既有 `exec_poll/list/wait/tail/cancel` 和 `exec_write_stdin` 也会受限，不能据此认为进程已经停止。若无法恢复原根且需要停止作业，可在本机正常停止该 WebCodex 服务；关闭过程会尝试清理该实例拥有的全部活动作业，也会影响其他工作区的作业。当前版本没有脱离目录授权的单独进程管理通道。

### 本机管理命令

```text
node dist/src/cli.js device show
node dist/src/cli.js device rename --name "家用笔记本"
node dist/src/cli.js workspace list
node dist/src/cli.js workspace health
node dist/src/cli.js workspace add --id demo --root /absolute/project --name "项目 A"
node dist/src/cli.js workspace disable --id demo
node dist/src/cli.js workspace enable --id demo
node dist/src/cli.js workspace rebind --id demo --root /absolute/new-project
node dist/src/cli.js workspace rebind --id demo --root /absolute/recreated-project --new-identity
node dist/src/cli.js workspace remove --id demo
```

enable/disable、rebind 和其他配置管理命令只修改所选文件，运行中的服务需重启才能采用新设置。enable 会重新校验目录；`onUnavailable: "skip"` 的条目可以保持暂时离线。disable/rebind 可按先前列出的 ID 修复已缺失目录，选中的简写可能展开成对象，其他条目的身份不变。remove 只移除注册，不删除项目文件、历史或备份；至少保留一条配置，可改为禁用。

设备改名保持 ID。换设备应重新 init，填写本机设置。`config export --output config.example.toml` 生成身份和凭据均留空的公开模板，不复制当前配置的路径、密钥、注释或执行授权；默认关闭执行及连接。每台设备仍需 init 生成本机身份，再转入所需设置；export 不是完整配置备份。

每台设备分别运行一个本地服务，并在 ChatGPT 中区分对应连接。工具结果携带 `source.device_id/device_name/instance_id`，工作区带 UID。schema v2 的写入、执行、取消工具必须提交 `expected_device_id`；先读取 `system_status` 确认目标设备。工具不会跨机器自动转发。

更换 root 使用 rebind，变更实际目录会生成新 UID；不能把同一个 UID 手工绑定到另一目录后继续使用旧备份。state 也绑定设备 ID；不匹配时启动失败。将配置和 state 原样整套克隆无法可靠识别为另一台机器，因此新设备初始化步骤仍然必要。

### 登记 Codex 或其他 Git worktree

先确认会话的 cwd 是要接续的真实工作树，在本机显式登记：

```text
node dist/src/cli.js workspace add --id codex-task --root /absolute/selected-worktree --worktree
# 已存在的别名要改绑到选定 worktree 时
node dist/src/cli.js workspace rebind --id codex-task --root /absolute/another-worktree --worktree
```

`--worktree` 只登记已存在的标准 linked worktree，不创建、移动或复制代码。CLI 读取 `.git` 指针、反向 `gitdir` 和 `commondir` 并验证相互关系，将实际 `worktree.gitDir`、`worktree.commonDir` 写入所选 v2 配置；这些路径支持普通配置路径语法，但应优先让 CLI 生成，换设备后重新登记。普通目录不加此标记，未登记的 `.git` 指针文件不会被当成普通项目放行。

当前只支持普通非 bare 主仓库的标准 linked worktree。禁止链接/junction、异常指针、被替换的元数据、子模块及其他未支持的布局；文件工具仍拒绝访问 `.git`、gitDir、commonDir。运行中检测到元数据变化会返回 `WORKTREE_METADATA_CHANGED`，应在本机核对目录后重新登记并重启，不继续使用旧授权。

Codex home 内的例外仅覆盖已登记、且位于 `codexSessions.home/worktrees` **严格后代**的选定工作区；home 本身、worktrees 容器本身、认证文件及其他内部目录仍不可作为普通工作区。Codex 使用自定义 worktree 位置时，登记实际位置即可，不能把整个 Codex home 开放。会话的 cwd 只有落在当前授权工作区内才会匹配可操作项目。

## 本地 Codex 会话

```text
node dist/src/cli.js codex enable --home D:/CodexData
node dist/src/cli.js codex status
node dist/src/cli.js codex disable
```

不提供 `--home` 时保留已有目录；尚未配置时才采用 `CODEX_HOME` 或用户的 `.codex`。目录无需位于 C 盘。显式无效目录不回退。历史读取不修改 Codex 数据、不调用模型，也不自动扩大项目文件授权。`maxWindowsPerRequest` 为 1–8，默认 4；`maxRecordBytes` 为 65536–1048576，默认 1048576，超大记录报告遗漏。

## 命令执行与连接

日常使用只需在控制中心开启或关闭“本机命令执行”，不再配置逐项放行名单。开启并保存后对应 `execution.mode="trusted-host"` 和 `execution.commandPolicy="all"`；关闭为 `mode="disabled"`。`all` 接受本机程序名或绝对原生程序路径，仍使用分离的参数数组，保留关闭模式、只读工作区、超时和并发限制。旧配置未声明 `commandPolicy` 时保持 `allowlist`；页面可以显式切换，不会在打开页面时改动旧权限。

以下 CLI 预设和 profile 用于已有高级配置兼容，普通页面用户无需逐项选择：

```text
node dist/src/cli.js execution inspect
node dist/src/cli.js execution preset --preset npm
node dist/src/cli.js execution preset --preset python --command /absolute/python
node dist/src/cli.js execution preset --preset venv --alias project-python --prefix /absolute/project/.venv
node dist/src/cli.js execution preset --preset conda --alias analysis-python --prefix /absolute/conda-environment
node dist/src/cli.js execution set-mode trusted-host
node dist/src/cli.js execution add --alias python --executable /absolute/python
node dist/src/cli.js execution remove --alias python
node dist/src/cli.js execution set-mode disabled
node dist/src/cli.js connect --doctor-only
node dist/src/cli.js connect
node dist/src/cli.js tunnel status
```

执行默认关闭。`trusted-host` 使用服务用户权限，并不是 OS 沙箱。`allowlist` 兼容模式只接受已配置程序别名；`all` 还接受本机可找到的原生程序名及绝对路径。`.cmd/.bat` 不直接执行，脚本应通过对应解释器传入分离参数；npm 可保留 Node＋`npm-cli.js` 预设。固定参数支持重复，参数以 `--` 开头时使用 `--prefix-arg=--flag`。命令与解释器按当前设备解析，不写死某台机器的路径。

`execution inspect` 只检查配置和保留的预设，不运行解释器、版本命令或项目脚本，也不打开 WebCodex state。返回 `static_check_only: true`；顶层 `ready` 的范围是 `global_defaults`，应同时检查 `workspaces` 的可用性和 ready。`all` 模式不要求存在程序白名单，`program_resolution_at_launch: true` 表示具体程序要在执行时解析；ready 不能证明任意程序已安装或项目依赖可用。输出不显示固定参数和环境变量值。

| preset | 选择方式 | 生成的程序定义 |
|---|---|---|
| `node` | `--command` 或当前配置的 nodePath | 选定的原生 Node 入口，无固定参数 |
| `npm` | `--command` 指定 Node；邻近安装中找不到入口时必须提供 `--entry /absolute/npm-cli.js` | 原生 Node＋npm-cli.js 固定入口，不执行 npm.cmd/npm.ps1 |
| `python` | `--command` 指定解释器；省略时仅接受 PATH 中唯一确定的原生解释器 | 选定的 Python 入口，不执行 shell shim |
| `venv` | 必须 `--prefix`，目录含 pyvenv.cfg | Windows 的 Scripts/python.exe 或 POSIX 的 bin/python，保留虚拟环境入口路径 |
| `conda` | 必须 `--prefix`，目录含 conda-meta | Windows 的 python.exe 或 POSIX 的 bin/python，不调用 conda activate |

`--alias` 可自定别名，默认使用 preset 名称。已存在且不同的别名需先显式 remove；preset 不替换它，也不改变执行模式。`execution add/remove/preset` 管理全局别名；工作区 profile 在同一配置文件中编辑。每个 preset 都只做静态检查，配置保存后重启生效。conda 的 activation hooks 不会执行；依赖 hook 或额外 DLL 搜索路径的环境可能仍无法直接运行，应先用该别名执行最小导入测试。此版本没有交互终端或持久 shell。

### 每工作区执行环境

v0.10 允许最多 32 个具名 `execution.profiles`；名称使用 1–64 个英文字母、数字、下划线或连字符。每个 profile 必须提供 `allowedExecutables`，可选 `env`；工作区用 `executionProfile` 引用它。以下 TOML 是完整配置中的相关片段，已有工作区仍保留原 id/uid：

```toml
[[workspaces]]
id = "app"
root = "${configDir}/projects/app"
executionProfile = "app-tests"

[[workspaces]]
id = "papers"
root = "${userHome}/Documents/papers"
executionProfile = "paper-python"
onUnavailable = "skip"

[execution.profiles.app-tests.allowedExecutables.node]
command = "${nodePath}"
args = []

[execution.profiles.app-tests.env]
NODE_ENV = "test"
CI = "true"

[execution.profiles.paper-python.allowedExecutables.python]
command = "D:/Environments/papers/python.exe"
args = []

[execution.profiles.paper-python.env]
PYTHONUTF8 = "1"
```

Python 路径按本机环境填写，例如 Windows venv 的 `Scripts/python.exe` 或 Linux/macOS 的 `/absolute/venv/bin/python`。JSON 可使用下面两个可解析的字段片段，**合并进原配置，不替换整个配置、execution 对象或 workspaces 数组**。先将 profiles 合并进已有 execution，保留原 mode、全局别名、env、限额及其他 profile：

```json
{
  "execution": {
    "profiles": {
      "app-tests": {
        "allowedExecutables": {
          "node": { "command": "${nodePath}", "args": [] }
        },
        "env": { "NODE_ENV": "test", "CI": "true" }
      },
      "paper-python": {
        "allowedExecutables": {
          "python": { "command": "D:/Environments/papers/python.exe", "args": [] }
        },
        "env": { "PYTHONUTF8": "1" }
      }
    }
  }
}
```

然后把下面字段加到 workspaces 中目标工作区的已有对象内，**保留原 id、uid、root 和其他设置**；论文工作区的字段值改为 `"paper-python"`。此片段属于工作区对象，不放在配置顶层：

```json
{
  "executionProfile": "app-tests"
}
```

没有引用时继续使用全局 `execution.allowedExecutables` 与 `execution.env`。有引用时，profile 的别名表和 env **完整替换全局设置**：不会补入全局别名；省略 profile.env 表示没有配置的环境覆盖，也不会补入全局 env。仍会继承下文限定的少量宿主运行变量。缺失的 profile 引用会使配置校验失败；空别名表表示该工作区没有可用程序入口。

profile 只选择环境，不启用执行或提供沙箱。全局 `execution.mode`、工作区 enabled/readOnly、设备与目录身份检查，以及全局并发、超时、输出和输入限额继续生效；并发上限由所有工作区共享。`workspace_list/open` 返回选定 profile、别名/程序路径/固定参数数量和环境变量名；先查看这些信息再调用 `exec_start`。

从 v0.10 创建的新作业将 profile 名称、选定程序、固定参数和实际受限环境绑定到启动幂等负载。修改它们后重用原 start 操作键通常返回 `IDEMPOTENCY_CONFLICT`；删除别名或撤销授权也可能先返回对应的授权错误。排队期间发生变化会返回 `EXECUTION_PROFILE_CHANGED`。应先核对旧 job 的结果，再决定是否使用新操作键启动新的作业，不能把改配置后的重试当作续接原进程。既有 job 的 stdin 也核验启动环境，环境或 profile 改变后会拒绝继续输入。

v0.10 以前没有 profile 上下文的旧全局回执，在当前授权仍有效且原请求匹配时继续返回原结果，不会重新启动或重复输入；旧记录的 `execution_context_sha256` 为 null，不能从旧回执推断当前环境。旧 pending/unknown 操作仍需人工核对，不自动重放，也不能转换成 profile 作业。修改配置仍须重启服务生效，而重启不会恢复旧进程。

### 配置开发环境变量

在同一配置添加可选字段，以下 TOML 仅为片段：

```toml
[execution.env]
NODE_ENV = "test"
CI = "true"
PYTHONUTF8 = "1"
OMP_NUM_THREADS = "2"
```

JSON 对应 `"execution": { ..., "env": { "NODE_ENV": "test", "CI": "true" } }`。全局 env 与 profile.env 使用相同规则，只接受下列大小写完全一致的名称，值必须是字符串：

| 名称 | 接受的值 |
|---|---|
| `NODE_ENV` | development、test、production |
| `CI` | true、false、0、1 |
| `PYTHONUNBUFFERED`、`PYTHONDONTWRITEBYTECODE`、`PYTHONUTF8` | 0 或 1 |
| `NO_COLOR` | 空字符串、0、1、true、false |
| `FORCE_COLOR` | 0、1、2、3、true、false |
| `TZ`、`LANG`、`LC_ALL` | 有界时区/locale 文本，无控制字符；TZ 不接受 `..` |
| `OMP_NUM_THREADS`、`MKL_NUM_THREADS`、`OPENBLAS_NUM_THREADS`、`NUMEXPR_NUM_THREADS` | 1–4096 的整数字符串 |
| `CUDA_VISIBLE_DEVICES` | 空字符串、-1 或逗号分隔的数字设备序号 |

不接受自定义变量、PATH、NODE_OPTIONS、PYTHONPATH、PYTHONHOME、HOME、代理、API key/token/secret/password 等字段，也不从 MCP 调用参数临时传入任意 env。配置加载和作业启动前都会校验；配置展示只列出变量名。服务仅继承少量系统运行变量，子进程 PATH 由选定解释器所在目录加宿主 PATH 构成，凭据和代码注入变量不继承。Windows 的 `ProgramData` 是 OpenSSH 启动所需的系统目录变量，隧道启动器、面板托管服务及命令子进程均保留宿主值，不写死盘符、不允许配置覆盖。Windows `ComSpec` 由宿主 `SystemRoot` 派生。该过滤不是 OS 沙箱，已授权程序仍具有服务用户的宿主权限。

### 实际构建与测试

在本机确认已授权执行、程序和项目后重启，先通过 `system_status` 核实设备，并用 `workspace_open` 确认目标工作区及其有效 profile。该环境有 npm 别名时，用 `exec_start` 指定此别名和 `args: ["run", "build"]`，通过 `exec_wait` 或 `exec_poll` 持续取得新输出并检查终态；构建成功后再启动 `args: ["test"]`，保留各自 job ID、退出码及关键输出。等待调用可能因新输出或超时提前返回，不代表作业结束。用 `exec_tail` 检查末尾或 stderr 时同时检查遗漏标志。非零退出、`unknown` 或输出截断都须单独核对，不把静态 inspect 当作测试结果。最后用 `task_checkpoint` 记录真实作业 ID 和选定文件，按需 `task_export` 交回 Codex；旧 `checkpoint_save` 仍可使用。

### 隧道与本机 HTTP

隧道采用 `stdio`；API key 写入 `tunnel.apiKey`。代理写入 `tunnel.proxyUrl`，空字符串表示不用代理。`clientPath="auto"` 读取 `toolsDir/tunnel-client/install.json` 并验证官方安装记录和摘要；显式客户端必须提供 `clientSha256`。`connect --doctor-only` 检查连接配置，不启动第二个 MCP daemon。

本机 HTTP 使用 `server.transport="http"`，同一文件中的 `http.bearerToken` 至少 32 字符（init 自动生成，公开模板留空）；它不是用于公开 ChatGPT 连接的 OAuth。配置修改后需重启服务生效，可在控制中心重启由它管理的服务，或在原启动终端正常重启。

## 从 v1 迁移

```text
node dist/src/cli.js config migrate --config .webcodex/config.json --output .webcodex/config.json
node dist/src/cli.js config migrate --config .webcodex/config.json --output .webcodex/config.json --apply
```

首条预览，`--apply` 才写入。默认在源配置旁寻找旧 `private/tunnel-auth.json` 和 `connect.ps1`；也可指定 `--legacy-auth`、`--legacy-connect`。只读取支持的静态连接参数，不执行导入脚本。原位 JSON 迁移避免默认 TOML/JSON 并存；转换到 TOML 后须显式选中它，并在本机归档旧默认文件。

迁移保留实际目录、只读权限、执行策略与已存在的设备/工作区身份，原文件备份到 state 下受限的 `private-config-backups`。旧输入文件保留作为回退材料，但 v2 不再读取这些配置来源；确认后可在本机归档。迁移工具不重启服务。

没有工作区归属信息的旧作业、备份和幂等结果会保留，但不能自动认定属于当前目录；相关读取/恢复返回明确错误。新操作从新绑定记录开始。普通文件内容不受影响。
