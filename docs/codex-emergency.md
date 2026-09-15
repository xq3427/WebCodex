# Codex 额度用完时，用 WebCodex 接续项目

服务提供文件读写与多文件变更、独立任务记录、目录指导、作业输入与日志、Codex 历史续读、Git worktree 和执行环境配置。ChatGPT 先确认设备、读全需要的历史并核对真实工作树，再通过 WebCodex 的文件、Git 和执行工具继续项目。读取历史不启动 Codex、不调用 Codex 模型，也不修改 Codex 会话；ChatGPT 网页自身的可用额度和工具权限仍适用。

## 配置与升级

在唯一的本机配置中设置 `codexSessions.home` 并启用专用只读会话工具。该目录可以位于任意本机磁盘；会话工具仅访问日志和索引，不开放整个 Codex 目录。普通文件/Git 工具仍拒绝配置、认证文件和 Codex home，只有本机明确登记、位于 home/worktrees 严格后代的选定 linked worktree 可按工作区授权访问。新安装默认开放初始工作区写入及全部本机命令，历史读取仍默认关闭；已有配置不会因升级自动扩权。

升级服务前，先等本服务启动的后台作业结束。一次 `exec_start` 工具调用返回仅表示已取得 job ID，要用 `exec_poll` 核对作业终态；`unknown` 仍需核实，不代表已停止。保留自己启动的 job ID，不能只看 `exec_list` 最近一页就断言没有其他作业。确认后在原隧道终端按 Ctrl+C，重新构建；旧 v1 配置按[连接指南](chatgpt-setup.md#从-v04--v1-配置升级)迁移，已有 v2 配置无需重建，再启动：

```text
node dist/src/cli.js connect
```

所有命令可加 `--config` 显式选择 TOML/JSON。启动器从 v2 配置读取 `tunnel.apiKey` 等连接设置，不再读取旧 `tunnel-auth.json`。在另一个终端运行 `node dist/src/cli.js tunnel status`，确认连接和 MCP 就绪。在 ChatGPT 刷新工具后，核对 `system_status.version` 与本机安装版本一致，设备符合预期，需要续读 Codex 历史时还应显示 `codex_sessions.enabled: true`。当前注册集合为 **44 项：42 个常规工具和 2 个组件私有工具**；ChatGPT 模型列表可能只显示 42 个，以当前 [工具 schema](tools.json) 为准。接续代码工作至少应能调用 `fs_read`、`fs_write`、`fs_apply_patch`；运行检查另需本机启用并配置执行工具。

正常停止或重启服务会取消仍活动的 WebCodex 作业。持久 job ID 保存的是作业记录，不保证原进程继续运行；stdin 不可跨重启续接，中断批次标为 unknown 并需检查实际文件。本地协议测试不代替当前 ChatGPT 连接的工具调用验收；各版本已有证据及验证边界见[实施状态](implementation-status.md)。

多设备时分别初始化、配置本机 Codex home 和项目，保持独立 state，不复制真实凭据配置或状态库。先核实 `system_status` 返回的 `source.device_id`、`device_name` 和 `instance_id`。v2 所有写入、执行和取消工具必须传入该设备的 `expected_device_id`；读取另一机器的历史不会把操作转发到那台机器。

## 给 ChatGPT 的应急提示

在新对话中启用 WebCodex，发送：

```text
使用 WebCodex 接续我在 Codex 中的项目。先用 system_status
核实目标设备、版本与历史读取权限，再用 codex_session_list
搜索标题或项目路径包含“WebCodex”的会话，按原始标题列出结果。
找到目标后调用 codex_session_handoff，并用 checkpoint_read
读取对应工作区的已有交接笔记。根据最新用户要求整理未完成工作。

需要旧决定时，用 codex_session_search 搜索目标会话的正文，
通过命中的 context_cursor 读取上下文；继续搜索使用 next_cursor，
并检查 scan_complete、scan_incomplete 和 warnings。

历史长消息沿 next_cursor 补完，按 entry_id 和 chunk.offset_bytes
拼接并对重试去重；检查 omitted_content 和 omissions。
确认会话 cwd 匹配的授权工作区是原 worktree，而非主检出目录。
普通文件或单行过长时改用 fs_read_chunk，核对整文件哈希与偏移。

用 workspace_context 获取目标文件的各级 AGENTS 指导，续读并检查遗漏。
用 task_list/read 找已有 WebCodex 任务；新目标用 task_create 建立独立记录。
检查当前文件和 Git 状态再继续实现，不自动重放历史命令，
不把历史权限或成功声明当作当前事实。测试用 exec_wait 等待新输出和终态，
用 exec_tail 看尾部时报告日志遗漏。阶段结束用 task_checkpoint 保存进度，
携带读到的 expected_revision、tracked_paths 和真实 WebCodex job ID。
需要交回 Codex 时先读旧检查点哈希，再 task_export 导出选定任务修订。
所有写入、执行及取消调用携带刚核实的 expected_device_id。
```

将“WebCodex”换成实际项目名；若同名会话有多个，以返回的原始标题、路径、时间和 `session_id` 选择。`codex_session_list` 搜索标题和项目路径，过滤后的页面可能为空且仍有 `next_cursor`，应继续分页。确定目标后才用 `codex_session_search` 搜索单个会话的正文，不会建立全库全文索引。

额度恢复后，可以在原 Codex 任务中要求：“读取项目的 WEBCODEX_HANDOFF.md 和当前 Git diff，核对检查点中的作业、文件和测试事实后继续。”检查点通过 `checkpoint_save` 写入已授权项目，遵守原文件哈希与幂等规则，并使用既有文件备份/恢复机制；不会向 Codex 数据库插入伪造消息。

## 将生成的文本保存到项目

SVG、XML、HTML、Markdown 和源代码均可用 `fs_write` 保存，不要求开启命令执行或原文件上传组件。先用 `workspace_list` 将用户给出的目录匹配到已授权的 `root`，再传工作区 ID 和相对路径。例如工作区 root 为 `D:/Projects/papers`，保存 `D:/Projects/papers\示意图.svg` 时传 `path: "示意图.svg"`，不能把绝对路径放入 path。

目标文件已存在时先用 `fs_read` 取得正文和 SHA-256；新建时使用 `expected_sha256: null`。写入携带目标设备 ID 和本次操作的幂等键，完成后读回验证。缺少子目录时用 `fs_mkdir` 逐层创建；只读、离线或未登记目录应按实际工具错误处理。完整示例见[文件工作流](file-workflow.md#保存-svg-等文本产物)。生成的 PNG、PDF、ZIP 等二进制产物尚没有专用回存入口，不能将原文件上传成功当作二进制回存能力。

## 历史与交接工具

| 工具 | 作用 | 常用输入 |
| --- | --- | --- |
| `codex_session_list` | 列表及标题/项目路径搜索，支持归档 | `query`、`workspace_id`、`include_archived`、`limit`、`cursor` |
| `codex_session_read` | 最近可见消息、消息内续读及更早历史分页 | `session_id`、`limit`、`max_bytes`、`cursor`、`include_tools` |
| `codex_session_search` | 对一个已确定的会话搜索已脱敏正文 | `session_id`、`query`、`limit`、`max_bytes`、`cursor`、`include_tools` |
| `codex_session_handoff` | 最近对话加当前已授权项目指导、Git 状态和接续步骤 | `session_id`、`limit`、`max_bytes` |
| `checkpoint_read` | 读取项目根目录的交接笔记及原文件哈希 | `workspace_id`、`start_line`、`end_line` |
| `checkpoint_save` | 保存调用者备注和服务采集的项目事实 | `workspace_id`、`expected_device_id`、`objective`、`progress`、`next_steps`、`expected_sha256`、`idempotency_key` |

四个 `codex_session_*` 工具和 `checkpoint_read` 均为只读；`checkpoint_save` 会写入项目文件。本机不额外调用模型生成摘要，ChatGPT 根据历史和当前项目信息分析任务。

例如调用 `codex_session_list`：

```json
{
  "query": "WebCodex",
  "include_archived": true,
  "limit": 10
}
```

然后使用真实返回的 `session_id` 调用 `codex_session_handoff`。需要详细工具记录时，另起一条 `codex_session_read`，显式设 `include_tools: true`；默认仅有用户和助手可见消息。恢复模式不同，应重新从最新页读取，不能将 `include_tools: false` 的游标用于 `true`。

会话内每页消息按时间正序排列，第一页取最近内容。`next_cursor` **优先补完同一条未读完的消息，再进入更早内容**；不要将各页正文直接相连当作正序。`max_bytes` 限制返回正文的 UTF-8 总字节数，不包括有界的元数据；默认和上限为 `limits.readMaxBytes`，最低 256。

每条 entry 带稳定 `entry_id` 与 `chunk: { offset_bytes, end_bytes, total_bytes, has_more }`。按 entry_id 聚合，按 offset_bytes 递增拼接其 text，对同偏移重试去重；`has_more: false` 才表示这一条消息已补完。chunk 偏移对应**完整脱敏正文的 UTF-8 字节**，不是磁盘 JSONL 字节、字符数或 token 数。`text_truncated: true` 表示本片段后仍有内容，继续使用 next_cursor 即可，不必调大配置才能读到消息尾部。每次都会完整投影并脱敏原记录，然后分块，避免凭据跨页边界逃过脱敏。

`omitted_content` 跨读取链保留已发生的遗漏；`omissions` 给出本页扫描范围内的文件标识、字节范围和原因，例如记录超限、坏 JSON、不完整尾部。范围可能在多页重复，应结合 `omission_scope` 理解，不能把列表长度简单相加当作漏失消息数。读取完游标但 omitted_content 为真时，`scan_complete` 仍为 false；窗口耗尽而尚有游标也不能说历史已读完。超出 maxRecordBytes 的单记录仍会遗漏，不是无限长度消息读取器。

列表游标绑定本次索引快照，活跃会话改变排序时会返回 `HISTORY_INDEX_CHANGED`，应重新列第一页。所有游标均签名，不能改写为任意本地路径；服务重启后旧游标失效。消息续读锚定原记录字节区间及 SHA-256：消息原地修改、替换、截断或分段不再属于该会话时返回 `HISTORY_CURSOR_STALE`，从最新页重新读取。正常追加可继续读取原锚定消息；它不代表对整套历史建立了不可变化的快照。

## 搜索会话正文

`codex_session_search` 必须指定从列表得到的 `session_id`。`query` 为 1–200 个字符，区分大小写、按字面量匹配，不接受正则表达式。搜索对象是完整脱敏后的可见正文；默认 `include_tools: false`，需要查工具参数或结果时才显式开启。`limit` 为 1–50，`max_bytes` 为 256 到本机 `limits.readMaxBytes`，约束返回片段的总 UTF-8 字节数。

```json
{
  "session_id": "从列表返回的真实会话ID",
  "query": "待实现",
  "include_tools": false,
  "limit": 10,
  "max_bytes": 8192
}
```

结果按最近命中的消息优先，每条消息给出首个命中的 `snippet`。需要上下文时，把该项的 `context_cursor` 传给 `codex_session_read`，保持相同 `session_id` 和 `include_tools`。搜索结果顶层的 `next_cursor` 则用于下一次 `codex_session_search`，保持原查询参数；两种游标用途不同。

每次请求只扫描有限历史窗口。必须同时检查 `scan_complete`、`scan_incomplete`、`warnings` 和 `next_cursor`：页面无命中而仍有游标时继续搜索；即使没有下一页，若有坏记录、超大行或缺失前序分段等遗漏，也不能宣称整个历史中不存在该内容。`snippet_truncated` 表示片段不是整条消息，需要上下文时继续读取。

## 保存交接检查点

v0.7 推荐每个独立目标使用 `task_create` 创建任务记录，以 `task_checkpoint` 追加修订。保存时指定 `tracked_paths` 和真实 `job_ids`，下次 `task_read` 对比当前观察；`verification_validity` 仍为 unknown，文件没变不能单独证明测试有效。需要交回 Codex 时，用 `task_export` 明确选择 task ID 与修订，并携带 `checkpoint_read` 取得的现有文件哈希。不同任务的内部记录不覆盖彼此，导出文件仍只有一份。完整示例见[任务工作流](task-workflow.md)。下面的旧 `checkpoint_save/read` 用法继续兼容，历史文件不会自动导入新任务。

检查点路径固定为授权工作区根目录的 `WEBCODEX_HANDOFF.md`，不能用参数改写到其他位置。`workspace_open` 会显示已有检查点预览；正式更新前仍应调用 `checkpoint_read` 获取当前 `exists`、`sha256` 和正文。

`checkpoint_read` 的 `start_line`、`end_line` 可选，按完整内容脱敏后的行号分页，返回的 `line_numbers` 为 `redacted_text`；`sha256` 始终来自完整原文件字节，不能对展示文本重新计算来代替。默认请求完整笔记正文，输出受本机 `readMaxBytes` 限制；服务生成的笔记上限为 64 KiB，并受本地写入限额限制。检查 `truncated` 和 `next_start_line`；文件不存在时返回 `exists: false`、`sha256: null`。如果单行超过预算而出现 `line_cut`，原样重读仍可能得到同一前缀，应调整本机读取限额或缩短过长备注，不能盲目拼接重复片段。

首次确认文件不存在后，可调用：

```json
{
  "workspace_id": "default",
  "expected_device_id": "替换为 system_status 返回的实际设备 UUID",
  "objective": "完成项目当前待办",
  "progress": "已完成的修改，以及仍需核实的事项",
  "next_steps": "下一步先检查相关文件，再完成剩余实现",
  "verification_notes": "记录实际检查方法与结果；尚未运行的检查明确标注",
  "expected_sha256": null,
  "idempotency_key": "handoff-20260908-01"
}
```

必填字段为 `workspace_id`、`objective`、`progress`、`next_steps`、`expected_sha256` 和 `idempotency_key`，schema v2 还要求 `expected_device_id`。示例中的设备占位文字必须替换为实际返回的 UUID。可选 `verification_notes`、真实 Codex `session_id`，以及最多 10 个属于该工作区的不同 WebCodex `job_ids`；作业 ID 必须来自实际工具结果。备注字段均为非空文本，每个最多 8192 UTF-8 字节。

服务在保存时补充经过路径过滤的 Git 状态、所选作业的真实状态/退出码/时间，以及该工作区中持久化的 `queued`、`running`、`unknown` 作业数量。它不会复制原始参数、命令输出或任意错误原文，也不会因某进程退出码为 0 就断言某个测试套件通过。Git 列表可能被截断，指定作业也不是所有任务；应检查笔记中的覆盖范围和截断标志。调用者填写的进度、验证备注和会话引用会与服务观测分开标注，均为保存时的上下文。

更新已有文件时，先读后传入返回的 `sha256`，不能继续使用 `null`。人工修改或另一个写入先发生时会返回冲突，保留磁盘现有内容；重新读取并结合修改后再保存。保存仍记录文件变更，可通过 `changes_preview` / `changes_restore` 检查和恢复。

网络重试必须复用同一 `idempotency_key` 和完全相同的参数，返回原保存结果。要更新备注或仅刷新 Git/作业事实，应读取当前文件版本并使用新的幂等键；旧键不会重新采集事实。同一笔记在恢复到 Codex 时仍需核对当前项目，不能当作当前权限或未经复核的成功证明。

## 授权与命令执行

新安装默认关闭历史访问，旧配置也不会自动开启。本机 CLI 可以管理：

```powershell
node dist/src/cli.js codex status
node dist/src/cli.js codex enable
# 自定义目录可加 --home 'D:/CodexData'
# 需要关闭时使用：node dist/src/cli.js codex disable
```

省略 `--home` 时保留已配置目录；尚未配置时使用当前进程的 `CODEX_HOME`，否则使用用户目录下的 `.codex`。全部支持 `--config`，修改后重启服务生效。关闭不会删除会话；历史目录被移走时，也可以用 `codex disable` 恢复服务配置。

会话访问允许读取这个 Codex home 的本地会话，不意味着其中每个项目都获得了文件操作授权。`workspace_id: null` 或 `workspace_authorized: false` 表示该会话项目尚不可通过 WebCodex 文件/执行工具操作。需要在本机明确添加真实项目目录，再重启：

```powershell
node dist/src/cli.js workspace add --id myproject --root 'D:/Projects/example'
# 会话 cwd 是已存在的 linked worktree 时，加 --worktree 登记实际工作树
node dist/src/cli.js workspace add --id codex-task --root 'D:/CodexData/worktrees/task/project' --worktree
```

`--worktree` 验证并保存 gitDir/commonDir，只支持普通非 bare 主仓库的标准 linked worktree；不迁移代码、不暴露 Git 元数据。Codex home 内只能登记 home/worktrees 的严格后代，不得登记 home 或 worktrees 容器本身。运行中指针变化会拒绝访问，必须在本机核对后重新登记并重启。

运行测试和构建还要求在本机选择 `trusted-host` 并配置程序别名。可先用 `execution inspect` 静态检查、`execution preset --preset npm` 注册 npm；Python、venv、conda 与受限 `execution.env` 用法见[本地配置指南](local-configuration.md)。preset 和读取历史不会替你打开执行权限。静态检查不证明依赖或测试可用，仍需启动真实 build/test 并核实退出码与输出。Codex 原本启动的进程不属于 WebCodex 作业，不能用 `exec_poll` 或 `exec_cancel` 接管。

v2 的 `exec_start` 默认超时来自 `execution.defaultTimeoutMs`，初始为 60 秒。较长构建或测试应显式提供 `timeout_ms`，且不超过本机上限；可用 `config show` 检查执行配置。保留 job ID 并持续轮询，空输出不代表完成。启动和取消都携带目标设备 ID。重启或关闭隧道会结束本服务管理的活动作业；崩溃后未确认的作业标为 `unknown`，不能据此自动重跑旧命令。

## 格式、限制与隐私

- 优先用 `state_*.sqlite` 的 `threads.rollout_path` 定位当前历史文件，以只读连接查询固定元数据字段。索引不可用时，回退到会话目录中的 JSONL 头部；此时标题可能缺失，搜索能力会减弱。
- 支持 `sessions`、`archived_sessions` 和经过唯一匹配验证的 `history_base` 历史前缀。本机同一任务可能有原文件和续写文件，不能只凭文件名相似度挑选。无法唯一定位前序文件时，返回 `unread_older_history` 和警告，不拼接猜测内容。
- 每个底层读取最多扫描 8 MiB，默认正文窗口 1 MiB，头部最多 512 KiB；v2 每请求的窗口上限由 `codexSessions.maxWindowsPerRequest` 配置，默认 4、最大 8。单记录上限由 `maxRecordBytes` 配置，默认 1 MiB。分段链最多 8 层，每个父段最多检查 32 个候选。巨行、坏 JSON、不完整尾部、缺失前序段会有统计或警告；有界读取不承诺取回所有异常/超大记录。
- 只投影 `response_item` 的用户/助手可见文本，避免与 `event_msg` 镜像重复。不返回内部 reasoning、analysis、system/developer 消息或附件二进制；纯事件日志或未来未知格式可能没有可读取文本，需要更新适配器。
- 已知 API token、Bearer、凭据赋值、私钥及 URL 凭据会先脱敏再截断；脱敏不能识别任意形式的秘密。可选工具输出可能含项目内容，只有需要时再请求。
- 仅支持这台电脑实际保存的历史。尚未下载到本机的云任务、其他主机任务不在范围内。linked worktree 需要本机显式登记；读取会话不会自动授予其文件权限。
- 本地存储是版本相关的内部格式。已对本机新旧 JSONL 与 SQLite 索引做实际验证；未知 schema、路径异常或歧义会明确报错/提示，不声称完全恢复完整 Codex 运行状态。

## 实现依据与验证

[OpenAI 官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)提供 `thread/list`、`thread/read`、分页读取及归档说明，并说明列表可能扫描日志修复索引。本实现使用独立的本地只读适配器，不启动第二个 app-server，也不通过 `turn/start` 或模型 API 恢复任务。

回归测试涵盖分段历史、SQLite 精确定位、归档、路径边界、活跃文件分页、脱敏、权限和实际 MCP 调用。当前真实会话的列表、读取、接续上下文已在独立临时 WebCodex state 中验证，脱敏验收信息保存在 `.webcodex/codex-session-evidence.json`，没有保存会话正文。

v0.4 另已在独立临时 state 中使用本机真实会话验证正文搜索及命中上下文读取；扫描达到窗口上限时明确返回 `next_cursor` 和 `scan_complete: false`。仅含计数与状态的证据保存在 `.webcodex/v04-local-evidence.json`，本地结果不代替新版本的 ChatGPT 云端验收。
