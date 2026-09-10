# MCP 协议诊断（0.12.0-preview.8）

协议诊断用于区分请求是否到达本地 MCP 服务、是否被 SDK 或工具拒绝，以及本地响应发送是否完成。它不证明 ChatGPT 已显示工具结果或能够读取附件正文。

## 配置与读取

把设置合并到当前使用的配置文件，与设备身份、目录和 API key 共用一份配置：

```toml
[diagnostics]
enabled = true
maxEvents = 1000
```

`enabled` 默认 `true`，只接受布尔值；`maxEvents` 默认 `1000`，允许 20–10000 的整数。JSON 对应 `"diagnostics": { "enabled": true, "maxEvents": 1000 }`。旧 v1/v2 配置可以省略这些字段，加载时使用默认值，不写回文件。配置修改后重启生效。

先完成构建，再在仓库目录读取：

```text
node dist/src/cli.js diagnostics show
node dist/src/cli.js diagnostics show --config /absolute/private/config.toml
```

Windows 路径例如 `D:/WebCodex/config.toml`；macOS/Linux 使用对应本机路径。文件选择顺序与其他 CLI 命令一致，见[本机统一配置](local-configuration.md#初始化与选择文件)。两条命令是默认配置和显式配置的替代写法，无需重复运行。

此命令只读打开所选配置的 `stateDir/webcodex.sqlite`，不取得正在运行的 daemon 的 state 独占锁，也不启动第二个服务或调用模型。可以在隧道保持连接时执行；数据库或诊断表尚不可用时返回 `available: false` 和受限 `reason`，不会为查看记录创建新的运行 state。

| 读取入口 | 返回范围 | 配置来源 |
|---|---|---|
| 本机 `diagnostics show` | 最近 20 条，包含该 state 中保留的旧服务实例，最新记录在前 | 当前读取的配置文件 |
| MCP `system_status` 的 `data.diagnostics` | 当前服务实例最近 5 条；`current_instance_only: true` | 当前服务启动时加载的配置 |

CLI 显示的 `enabled` 和 `max_events` 来自磁盘配置；修改配置后、重启之前，可能与仍在运行的服务不同。关闭诊断后 CLI 仍可读取保留的旧记录；`available: true` 表示诊断表可读取，不表示当前仍在记录，也不表示隧道已经连接。

## 保存哪些信息

服务在 MCP transport 边界观察带请求 ID 的 `initialize`、`tools/list`、`tools/call`、`resources/list` 和 `resources/read`。每个被跟踪请求先插入一条记录，再更新完成阶段，不为收到和发送分别保存两条。通知及其他方法不在当前跟踪范围。

记录只含以下固定字段：

| 字段 | 含义 |
|---|---|
| `trace_id` | 本地新生成的 UUID，不复制客户端请求 ID |
| `instance_id` / `version` | 处理请求的本地服务实例及版本 |
| `method` / `tool` | 上述固定方法；工具名仅接受本服务已注册名称，未知名称记作 `<unknown>`，非工具请求为 `null` |
| `outcome` / `stage` | 下表中的处理结果与阶段 |
| `error_code` | 固定允许的工具错误码、数字协议错误码，或通用分类；不保存错误原文 |
| `started_at` / `duration_ms` | 收到请求的 UTC 时间和观察到完成阶段的耗时；尚未完成时耗时为 `null` |

请求参数、文件名和路径、文件正文、搜索词、工具输出、HTTP 请求头、API key、token、客户端请求 ID 均不写入此诊断表。未列入允许集合的工具错误码统一为 `OTHER_TOOL_ERROR`。原有操作审计仍按原规则记录，不受本节的协议诊断字段约束。

启用时，服务启动及每次新增记录都会清理超过 `maxEvents` 的较旧诊断记录，范围涵盖该表中的旧实例。该上限只控制诊断记录条数，不限制完整数据库的物理文件大小；没有新增请求时，不按时间自动清理。设置 `enabled = false` 后重启会停止新增诊断，已有记录保留，不执行该表的清理。原有操作审计、文件备份、任务修订和作业输出不因这个设置被删除。

诊断写入失败不会把原本成功的工具请求变成错误；当前实例的诊断摘要会报告不可用。因此诊断也不是保证完整的请求账本。

## 如何解释阶段

| `outcome` / `stage` | 已观察到的事实 | 后续核对 |
|---|---|---|
| `received` / `received` | 请求已进入被观察的 MCP 分发边界，尚无完成记录 | 请求可能仍在处理，也可能服务退出或记录更新失败；不能据此判定操作未执行 |
| `responded` / `response_sent` | transport 的发送操作完成，未识别到顶层协议或工具错误 | 查看实际结果、批次状态或作业终态；这不证明网页已显示响应、读到附件正文或测试通过 |
| `rejected` / `protocol` | SDK 返回 JSON-RPC 错误 | 核对方法及协议错误码；错误正文不保存在诊断表中 |
| `rejected` / `input_validation` | SDK 参数校验返回 `-32602` | 核对当前 `tools/list` 中的字段和类型，例如写操作需要的 `expected_device_id` |
| `rejected` / `tool` | 工具返回业务或权限错误 | 按实际工具响应的 `error.code` 与 `recovery` 处理；诊断中的错误码可能已归为通用分类 |
| `rejected` / `dispatch_or_validation` | SDK 返回工具错误，但没有匹配到更具体的类别 | 结合实际工具响应核对工具名称与输入 |
| `unconfirmed` / `send_failed` | 本地发送响应失败 | 操作可能已执行；先核对文件、作业或操作记录，再决定是否重试 |
| `unconfirmed` / `transport_closed` | 有待确认请求时连接关闭 | 先核对操作状态，不能把断连当作回滚 |
| `unconfirmed` / `tracking_capacity` | 待确认请求数量达到诊断跟踪上限，旧请求不再继续跟踪 | 当前诊断不完整；核对实际操作状态 |
| `unconfirmed` / `duplicate_request_id` | 同一连接在旧请求未完成时再次使用相同请求 ID | 旧请求结果未确认；该字段不是用于工具幂等重试的操作 ID |

`duration_ms` 是服务观察到的协议处理耗时，不包含用户看到结果的时间；异步 `exec_start` 返回也不等于程序运行结束。

## 排查一次网页请求

1. 保持当前隧道运行，用显式 `--config` 读取诊断，确认查看的是目标设备及同一服务 state。结合 `system_status` 的 `instance_id`、版本和配置中的设备身份，区分旧实例记录。
2. 在网页发起已授权的操作后再读一次，按时间、实例、方法和工具名定位。这里没有参数、路径或网页请求 ID，多个同时发生的同名调用可能无法精确对应。
3. `tools/list` 表示本地收到过工具发现请求，不能证明某个对话已选择或允许全部工具。`tools/call` 的拒绝阶段可帮助区分输入格式问题与本机权限或目录问题。
4. 若出现 `response_sent`，继续查看实际文件、作业结果或网页可访问的正文。文件名、上传回执、文件引用 ACK 和诊断记录都不能替代正文可读性的验收。

没有新记录时，先检查读取的配置、实例、开关和保留范围，再结合 `tunnel status` 检查连接。HTTP 的鉴权、Host/Origin 校验、请求大小/格式处理，或 stdio 消息分帧/解析可能在 MCP SDK 分发之前拒绝输入，这些失败不进入当前诊断表。未跟踪的方法、日志写入故障及被清理的旧记录也会造成缺口。不能仅根据缺少记录断言网页没有选择应用，或断言某个写操作没有执行。

网页附件上传与正文可读性仍须独立验收，当前状态见[原文件说明](original-files.md)及[文件组件原型](original-files.md)。本功能只增加本地协议证据，不改变该验收结论。
