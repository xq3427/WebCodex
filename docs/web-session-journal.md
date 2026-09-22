# WebCodex 会话工作记录

WebCodex 会在当前工作区下保存 MCP 工具调用记录和显式检查点，默认位置是：

```text
<workspace-root>/.webcodex/sessions/sessions.sqlite
```

每个工作区使用独立的会话库。`workspace_uid`、设备身份和根目录指纹都会参与校验，因此在 A 工作区创建的会话不能从 B 工作区读取。会话库使用 SQLite，服务重启后仍然存在；只读工作区可以读取已有记录，但不能创建新记录。

## GPT 如何恢复工作

新网页会话开始后，要求 GPT 依次调用：

```text
system_status
workspace_list
web_session_resume_context
```

需要查看某个历史会话时，再调用 `web_session_list` 和 `web_session_read`；两者都支持 `next_cursor` 分页，继续请求时固定同一个 `workspace_id`。完成一个阶段后调用 `web_session_checkpoint`，保存标题、已完成内容、下一步和重要文件。

如果宿主提供 OpenAI Apps SDK 的 `openai/session` 元数据，WebCodex 会自动把同一网页会话的工具调用关联到同一个 `session_key`。原始匿名 ID 不会写入文件。宿主没有提供该元数据时，可以使用 `web_session_bind` 给当前记录绑定标题；这时需要继续使用它返回的 `session_key`。

## 记录范围

会话记录包括工具名称、成功或失败、错误码、工作区相对路径、时间、耗时和检查点。新增的 `web_session_turn` 工具可以在 GPT 发送最终回复前，一次性保存当前用户消息和 GPT 回复；`web_session_read` 会返回这些经脱敏的、由调用方明确提交的对话轮次。它不会自动拦截网页消息。默认不保存 API key、Tunnel 凭据、Base64、二进制内容、完整命令输出或完整工具参数。

每个工作区会话还维护一个活动批次状态。普通工作区工具返回的 `journal` 字段会显示 `pending: true`，并要求在最终回复前调用 `web_session_turn`；提交成功后返回 `state: committed`。新工具调用会开启新的待提交批次。`stale_pending` 只表示超过观察窗口仍没有提交，不代表 GPT 一定已经结束。

`web_session_list` 返回 `journal.committed_epochs`、`journal.pending_epochs`、`journal.stale_pending_epochs` 和 `journal.submission_coverage`。这是“发生过 WebCodex 工具活动的批次提交覆盖率”，不是全部 ChatGPT 网页轮次的真实完成率，因为纯 MCP 收不到网页最终回复事件。

这仍不是自动完整的 ChatGPT 网页聊天记录。普通用户消息和 GPT 回复只有在 GPT 调用 `web_session_turn` 明确写入后才会保存；未通过 MCP 发送的内容不会传到 MCP 服务。需要宿主自动捕获 transcript，仍必须由宿主或浏览器扩展提供额外能力。

## 配置

```json
{
  "sessions": {
    "enabled": true,
    "directory": ".webcodex/sessions",
    "retentionDays": 90,
    "maxEvents": 2000,
    "maxBytes": 33554432,
    "recordToolArguments": "redacted",
    "recordToolResults": "summary",
    "remindBeforeFinalReply": true,
    "journalStatusInToolResults": true,
    "stalePendingMinutes": 30
  }
}
```

`directory` 必须是当前工作区内的相对路径，不能使用绝对路径、`..`、符号链接或 junction 穿出工作区。会话记录按保留天数和事件数量清理，关闭 `sessions.enabled` 后不会再创建新记录。

`recordToolArguments` 设为 `none` 时不保存路径摘要；设为 `redacted` 时只保存脱敏后的工作区相对路径。无论设置如何，原始参数、密钥、完整输出、二进制和 Base64 都不会写入会话库。`include_archived` 仅影响已经标记为归档的记录；当前版本只自动创建活动记录，归档管理接口将在后续版本提供。

`journalStatusInToolResults` 控制普通 MCP 结果中是否附加 `journal` 状态；建议保持开启。`remindBeforeFinalReply` 控制是否在 `pending` 批次中要求 GPT 提交；`stalePendingMinutes` 只用于标记长期未提交批次，不会自动补写回复。
