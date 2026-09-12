# 独立任务、项目指导和交接（v0.8）

一个项目可以分别保存多个 WebCodex 任务，每个任务有稳定的 `task_id` 和追加保存的修订。任务记录存放在本机 state，不修改 Codex 会话，也不会启动模型或接管旧进程。`job_id` 标识一次实际程序执行，与保存开发进度的 `task_id` 不同。

先调用 `system_status` 确认设备、`workspace_list/open` 确认目录。v2 的 `task_create`、`task_checkpoint` 和 `task_export` 必须携带本次核实的 `expected_device_id`；所有工具只访问已绑定设备与工作区的任务，工作区别名重绑后不能把旧记录当作新目录的记录。

## 修改前读取适用指导

```json
{
  "workspace_id": "default",
  "path": "src/feature/new-file.ts",
  "max_bytes": 4096
}
```

将这组参数交给 `workspace_context`。目标可为目录或文件；允许最后一个文件名尚不存在，父目录必须存在。省略 path 时只看工作区根。服务从工作区根逐层走到目标父目录，目标为目录时包含该目录；每一层存在 `AGENTS.override.md` 就选择它，否则选择 `AGENTS.md`。override 为空也优先，override 过大或不可读会报告遗漏，不回退到同层普通文件。路径检查与普通文件工具相同，支持已明确登记的 Codex worktree。

`guidance` 返回来源 `source`、适用目录 `applies_to`、根到目标的 `precedence`、原文件 SHA-256 和正文 chunk。完整文件先脱敏再分页；沿 `next_cursor` 续读，以 source 和 `chunk.offset_bytes` 拼接，对重试去重。偏移单位为脱敏正文的 UTF-8 字节，不能当作 JavaScript 字符索引。每页 `max_bytes` 可调整。

`complete` 只表示可返回的正文已取完；还需检查 `scan_complete` 和 `omissions`。超出深度、单文件/总量限额，链接、无效编码等均有明确原因。变化、替换、插入 override 或扫描配置改变会使游标失效；重启服务后从头读取。默认仅扫描到根以下 32 层、单文件 64 KiB、全链 256 KiB，不做工作区外的全局 AGENTS、skills 或插件发现。

指导文件是项目上下文。其文字不能扩展文件授权、开启执行或改变设备身份；WebCodex 不执行文件里的命令。

## 创建和保存任务

将以下参数交给 `task_create`，其中设备 ID 必须替换为已核实的值：

```json
{
  "workspace_id": "default",
  "expected_device_id": "<system_status 返回的 device_id>",
  "title": "修复配置解析",
  "objective": "修复空配置文件的错误提示",
  "progress": "已阅读需求与目标目录指导，尚未修改代码",
  "next_steps": "补错误处理，运行现有解析测试",
  "tracked_paths": ["src/config.ts"],
  "job_ids": [],
  "status": "active",
  "idempotency_key": "config-fix-create-1"
}
```

响应的 `task_id` 和 `revision` 供后续使用。`session_id` 可选，用于记录真实 Codex 会话引用；服务不会仅凭该引用自动读取或验证原会话。`verification_notes` 可选，明确属于调用者备注。`status` 可选 `active/paused/completed`，是调用者设置的任务状态，不等于服务确认全部工作完成。

阶段结束用 `task_checkpoint`，提交 `task_id`、读到的 `expected_revision` 和新的 `idempotency_key`，并完整提供 `objective/progress/next_steps`。可附新的 title、验证备注、会话引用、状态、`tracked_paths` 和 `job_ids`；它保存一次新的观察，未传入的路径和作业列表按空列表处理，不自动继承上一修订。版本冲突返回 `TASK_REVISION_CONFLICT`，应先读取当前版本再决定如何更新。相同幂等键与相同参数的重试返回原结果，不重复创建修订；更改参数需新键。

每次保存默认最多选择 20 个常规文件、10 个真实 WebCodex 作业，文件原始字节哈希扫描总量默认 16 MiB，单文件还受 limits.fileReadMaxBytes 限制。新文件尚不存在时也可记录其缺失状态。服务只保存文件哈希/大小/是否存在，不复制文件正文；作业观察不包含原始参数、输出或 PID。文件路径必须在工作区内且通过保护检查。

标题最多 256 UTF-8 字节；目标、进度、下一步和验证备注各最多 8192 字节。完整修订序列化后最多 65536 字节，超过限制拒绝保存，不静默截断。常见凭据先脱敏再持久化，这不是识别任意秘密的保证。默认每工作区 100 个任务、每任务 100 个修订，达到上限拒绝新增；旧记录保留，目前没有自动清理。可调限额集中在同一配置的 `tasks` 字段。

## 读取与核对观察

`task_list` 返回指定工作区任务，按更新时间倒序，使用 `limit` 和 `next_offset` 续页；并发更新可能改变分页位置，应按 task_id 去重。列表不包含完整历史正文。每页最多 100 个摘要，摘要预算为 `min(65536, max(2048, readMaxBytes))`，避免较小正文页长导致无法列出一条完整任务。

`task_read` 默认读取最新修订，也可指定 `revision`。响应 `content_format: task_revision_json`，大正文沿 `next_cursor` 拼接 content，按 chunk 字节偏移去重，拼完整后再解析 JSON。游标固定到最初选定的修订，新检查点不会把后半页偷偷切换为另一个版本；服务重启后游标失效，持久 task ID 和修订仍可重新读取。

首次读取返回 `freshness`：比较保存时与当前的选定文件、作业和 Git 观察，状态可能为 changed、unchanged、unknown。后续正文分页不重复采样，`freshness: null`、`freshness_sampled: false`；需要最新观察时从无 cursor 的新一次读取开始。

变化汇总涵盖选定文件和作业；观察到 Git 变化也标为 changed，Git 是否可完整比较另见 `freshness.git.state`。未选择文件时不会报告 unchanged。文件检查明细最多 20 条，优先列出 changed 和 unknown，其余通过状态计数及 `tracked_files_truncated` 标明；遇到无法读取或超出快照预算的文件标为 unknown。

`verification_validity` 始终为 unknown。文件哈希没变只说明这些选定文件当前未变，无法证明某个测试套件对这些哈希运行过，或环境、依赖和其他文件未变。退出码为 0 也不能单独识别执行了哪个测试。调用者填写的“测试通过”仍为备注，不会被转换成服务验证事实。

## 等待测试和读取日志尾部

在本机控制中心开启命令执行并保存、重启后，用 `exec_start` 启动本机程序名、绝对程序路径或保留的预设，保留 job ID。未切换的旧 `allowlist` 配置仍只接受其程序别名。对作业调用：

```json
{
  "workspace_id": "default",
  "job_id": "<exec_start 返回的 job_id>",
  "cursor": 0,
  "max_bytes": 4096,
  "wait_ms": 1000
}
```

`exec_wait` 返回增量输出、`next_cursor`、作业状态/退出码，以及 `terminal`、`wait_reason`、`waited_ms`。新输出、终态或等待到期都会返回；有输出但仍在运行时继续用 next_cursor 等待。默认 1 秒，单次最多 20 秒；程序总超时仍由 exec_start 的 timeout_ms 与 execution 超时配置控制。服务关闭会唤醒等待并返回 `SERVICE_CLOSING`。

查看失败附近的日志可用 `exec_tail`，输入相同 workspace_id/job_id，加 `stream: "stderr"` 或 `"all"`、max_bytes。返回最近已保存输出，最多取 256 个 chunk，保持其时间顺序和全局字节偏移。默认正文预算为 `min(16384, readMaxBytes)`；输入至少 4 字节，最多 readMaxBytes。

程序非零退出且完全没有捕获输出时，回执带 `failure_diagnostics.code = PROCESS_EXIT_WITHOUT_OUTPUT`。这只确认未捕获到输出，不能据此断言网络、防火墙、密钥或服务权限有问题。若 `output_bytes > 0` 而当前增量页为空，先读 `exec_tail` 的 stderr；不要把已读完的游标当成日志丢失。远程命令排查见 [SSH 故障定位](ssh-troubleshooting.md)。

v0.10 按工作区选择 `executionProfile`，省略时使用全局默认。新作业回执绑定 profile、所选程序、固定参数和实际精简环境的摘要；改变这些设置后，相同 `exec_start` 幂等键返回冲突，不会把旧运行当作新环境下的验证。旧版本无摘要回执继续按旧规则返回，不重新启动。活动作业的 stdin 也校验原执行配置；变化会拒绝发送。查看 `workspace_list/open` 确认有效环境，再决定是否确需新执行。

工作区离线、被禁用或身份变化时，该工作区的既有作业查询、输入和取消会受身份校验限制；`workspace_health` 可用于诊断。正常服务关闭仍会结束本服务拥有的活动进程。跨离线状态独立控制作业及跨重启续跑尚未实现。

检查 `earlier_output_omitted`（更早内容未显示）、`other_streams_omitted`（只选一种流）和 `output_truncated`（进程输出超过保存上限）。日志尾部不能恢复未保存的输出；tail 的 next_cursor 指向当前全部已保存输出末尾，可用于以后不筛选流的 exec_poll/exec_wait。需要查看更早已保存日志时从 exec_poll cursor 0 开始。

作业持久记录、等待接口与尾部读取不提供 PTY、持久 shell 或进程恢复。v0.8 可明确打开 stdin 管道，具体用法见下节。停止隧道仍会取消该服务拥有的活动作业，unknown 仍需本机核实。

## 向运行中的程序提供输入

本机执行已启用且项目可写时，在 `exec_start` 增加 `stdin: "pipe"`。默认 `"closed"` 保持旧行为，不能给已经按 closed 启动的作业事后开启管道。程序应支持普通标准输入；全屏界面、依赖终端尺寸或控制键的工具需要 PTY，本版不支持。

取得 job ID 后，用 `exec_wait/poll` 检查程序是否正在等待所需输入，再调用 `exec_write_stdin`：

```json
{
  "workspace_id": "default",
  "expected_device_id": "<system_status 返回的实际 device_id>",
  "job_id": "<exec_start 返回的实际 job_id>",
  "content": "demo-name\n",
  "end": false,
  "idempotency_key": "job-input-name-1"
}
```

接口不会自动添加换行。输入必须是有效 Unicode 文本，按 UTF-8 字节计数；本例 `\n` 为 JSON 换行转义。只发送 EOF 时省略 content 并传 `end: true`；也可将最后一段文本与 end 一起发送。空文本且 end 为 false 会被拒绝。EOF 不代表终止进程，之后继续读取输出和真实退出码。

成功结果包括 `bytes_written`、`end`、`delivery: "written_to_pipe"`。它只说明写入管道完成，不能证明程序已理解或处理文本。作业查询中的 `stdin.mode/state/bytes_attempted` 分别说明启动方式、当前已知输入状态与累计尝试字节；已结束、取消、非本服务活动进程或已关闭/未知的输入不能继续写入。

需要特定输入顺序时，应等待上一条发送结果后再发送下一条；不要并行发送有先后依赖的内容。相同键重试不会重发，但新键代表一条新的输入请求。

一次逻辑输入使用一个稳定幂等键，网络重试须带原参数和原键；同键不同内容拒绝。`STDIN_DELIVERY_UNKNOWN` 表示管道回调失败、超时或交付无法确认，子程序可能已经消费部分或全部字节。服务关闭输入管道，不自动重新发送；先检查输出、程序状态和实际副作用，再决定恢复步骤，不能换键盲重发。服务重启后的未确认操作也不自动重放。

单次默认最多 64 KiB，单 job 累计尝试默认 1 MiB，单次写入默认等待最多 5 秒；详见[输入限额](local-configuration.md#v08-的批量变更与作业输入限额)。服务只持久记录输入请求摘要和字节等元数据，不保留正文；子程序自身可能回显或保存输入，输出仍按原作业日志规则处理。

## 显式交回 Codex

先用 `task_read` 核对要导出的 task_id 和 revision，并检查当前观察。再 `checkpoint_read` 取得项目根 `WEBCODEX_HANDOFF.md` 的原始 SHA-256；不存在时使用 null。用 `task_export` 提交 workspace_id、task_id、选定 revision、expected_device_id、expected_sha256 和 idempotency_key。只有显式 export 才写文件，遵循原有备份与哈希冲突规则。

每个任务的内部修订独立保存，导出入口仍只有一份 `WEBCODEX_HANDOFF.md`。导出另一个任务会替换该文件，必须携带刚读到的哈希；不会删除任何任务修订。导出过大时完整拒绝，不截断内容。导出只是保存时的观察，不重新执行测试。

额度恢复后，原 Codex 任务可读取导出文件、当前指导与 Git diff，核对事实后继续。旧 `checkpoint_save/read` 继续工作，也仍会更新同一文件；它们不会自动导入、追加或同步独立 task 修订。

v0.8 的批量文件操作提供预检、备份和有条件回滚，仍不承诺 OS 原子事务；没有自动任务执行器、OS 沙箱、PTY 或与 MCP 连接分离的常驻作业管理。新版真实 ChatGPT 云端闭环和 macOS/Linux 实机验证仍应按[连接指南](chatgpt-setup.md)单独验收。
