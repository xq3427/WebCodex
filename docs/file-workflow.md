# 文件读取、批量变更与恢复预览

工具的外层结果为 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": ... }`。以下 JSON 是工具输入示例；工作区 ID、文件哈希和变更 ID 应从真实工具返回取得。

## 完整原文件

自动 PDF/Office 正文接入已经暂停；`fs_open_file` 仅用于明确要求的组件诊断。明确索取完整原始字节或读取原生 PNG/JPEG/GIF/WebP 图片时使用 `fs_read_file`。两者均不先提取文本、OCR 或转换文件。按行和分块接口用于文本检查和代码编辑。

`fs_read_file` 的 inline 上限默认 4 MiB、最大 7 MiB；`fs_open_file` 的 `effective_local_file_max_bytes` 还受组件上传策略和快照总预算限制。组件上传策略默认 100 MiB，不能扩大本地文件的实际读取上限；已有快照占用缓存时还可能暂时拒绝新文件。超限不返回截断的文件。协议传输、上传或文件卡片均不证明 ChatGPT 已获得正文，完整说明和验收边界见[原文件传输](original-files.md)。

## 保存 SVG 等文本产物

ChatGPT 生成的 SVG、XML、HTML、Markdown 或源代码可直接用 `fs_write` 写到已授权工作区，无需原文件组件或命令执行权限。这是将文本保存到本机的流程。

先核实 `system_status` 和 `workspace_list`。例如列表中的目标工作区 root 为 `D:/Projects/papers`，要保存 `D:/Projects/papers\示意图.svg`，使用返回的工作区 ID 和相对路径 `示意图.svg`。文件已存在时先 `fs_read` 并传其原始 SHA-256；确认文件不存在且父目录存在时，使用 `expected_sha256: null` 新建。以下占位值必须替换为真实返回值：

```json
{
  "workspace_id": "<目标工作区 ID>",
  "expected_device_id": "<核实后的设备 UUID>",
  "path": "示意图.svg",
  "content": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"80\"><rect width=\"120\" height=\"80\" fill=\"#eef\"/></svg>\n",
  "expected_sha256": null,
  "idempotency_key": "<本次保存的唯一操作 ID>"
}
```

幂等键只接受字母、数字、下划线、点、冒号和连字符，1–128 个字符；占位文字不能原样提交。网络不确定时复用完全相同的键和参数；更改内容则使用新的键和当前哈希。缺少子目录时先用 `fs_mkdir` 逐层创建。成功后 `fs_read` 读回，核对内容和哈希，再报告实际保存位置。

PNG、PDF、ZIP 等生成的二进制产物尚无专用下载/回存工具。`fs_read_file`、`fs_open_file` 将本机文件传出，不会把 ChatGPT 生成附件保存到本机；`sandbox:/...` 路径也不是本机可直接获取的下载 URL。

## 批量读取

调用 `fs_read_many`：

```json
{
  "workspace_id": "default",
  "files": [
    { "path": "package.json" },
    { "path": "src/server.ts", "start_line": 1, "end_line": 50 }
  ],
  "max_total_bytes": 32768
}
```

每批 1–16 项，按输入顺序返回 `results`，`index` 从 0 开始。成功项的 `data` 与 `fs_read` 一致，包含正文、原始文件 SHA-256、行号、编码、换行格式和分页字段。缺失或禁止读取的文件只让对应项失败，不影响其他项；因此外层成功不能代表每一项成功。

`max_total_bytes` 只限制所有正文合计的 UTF-8 字节数，不包括 JSON、元数据和错误说明。默认值及上限为配置的 `limits.readMaxBytes`（默认 65536）。不会返回不完整的 UTF-8 字符；完整原始文件的哈希不会因为正文截断而变化。

预算用尽时对应项返回 `READ_BUDGET_EXHAUSTED`、`omitted: true`，整批 `truncated` 为真。若剩余预算放不下某个多字节字符，后续更小的内容仍可能成功。调用者应逐项检查，按需分批重试；成功项的 `data` 中还有 `next_start_line` 和 `line_cut`。

行被截断时，相同输入和预算会返回相同前缀，不能把重复片段盲目拼接。单行本身超过 `readMaxBytes`，或源文件超过普通按行接口的大小限制时，改用下面的 `fs_read_chunk` 获取连续正文。

## 大文件与长行续读

v0.6 新增只读工具 `fs_read_chunk`，不受行长影响：

```json
{
  "workspace_id": "default",
  "path": "data/large-report.json",
  "max_bytes": 32768
}
```

首次不传 cursor，之后保持相同 `workspace_id` 和 `path`，将返回的签名 `next_cursor` 原样放入下一次请求。允许调整 `max_bytes`，范围 256 到 `limits.readMaxBytes`；默认使用该上限，初始为 65536。游标绑定工作区身份、路径、原文件版本和解码后偏移，不能自行构造或跨文件复用。

返回关键字段：

| 字段 | 含义 |
|---|---|
| `content` | 本页完整 UTF-8 字符组成的正文，不含文件开头的编码 BOM |
| `sha256` / `size_bytes` | 完整原文件字节的 SHA-256 和大小，含原始 BOM；所有页保持一致 |
| `format` | 原文件 encoding、bom、newline |
| `chunk.offset_bytes` / `end_bytes` / `total_bytes` | 本页起止位置及完整解码正文长度 |
| `chunk.unit` | `decoded_utf8_bytes`，不是原文件字节偏移或字符数 |
| `returned_bytes` | 本页 content 的 UTF-8 字节数 |
| `complete` / `next_cursor` | 是否到达全文末尾、下一页签名游标；结束时为 true/null |

按 offset 递增拼接正文，并检查前一页 end_bytes 等于后一页 offset_bytes。网络重试可能返回同一片段，应按文件 SHA-256 与偏移去重。中文、emoji 不会拆成无效字符；UTF-16 文件的原始偏移与返回偏移不同，不能将返回偏移直接用于磁盘写入。拼接的展示文本也不能替代原文件哈希。

源文件大小默认最多 16 MiB，由同一配置的 `limits.fileReadMaxBytes` 控制，最大可设为 128 MiB。支持有效 UTF-8（可带 BOM）和带 BOM 的 UTF-16 LE/BE；二进制控制字符、无效编码或超限文件明确报错。每页以有界缓冲重扫完整源文件，验证完整 SHA-256、文件身份和修改状态后才返回当前片段；因此读取大文件的很多小页会增加本机 I/O。

文件改动、替换或身份变化返回 `FILE_CURSOR_STALE`；服务重启或游标无效返回 `INVALID_CURSOR`。此时从无 cursor 的第一页重读，不将不同版本拼接。读取时仍执行工作区和敏感路径检查；同样不允许 symlink/junction、硬链接及受保护文件。

`fileReadMaxBytes` 只扩大这一只读接口可接受的源文件范围，不扩大 `writeMaxBytes`。对于超出写入限额的大文件，读取成功不代表 `fs_write`、补丁或恢复能够操作；不要通过自动调大写入配置来绕过本机设定。

## 查看恢复会发生什么

从写入结果的 `change_id` 或 `changes_list` 的记录 `id` 取得变更标识，再调用 `changes_preview`：

```json
{
  "workspace_id": "default",
  "change_id": "替换为实际变更ID",
  "context_lines": 3,
  "max_bytes": 32768
}
```

预览方向始终是**当前文件 → 该记录保存的上一版本**，返回 `direction: "restore"`。`operation` 说明恢复将执行 `create`、`modify` 或 `delete`；例如撤销新建文件会显示 `delete`。`current_sha256` 是当前版本，`restore_sha256` 是恢复目标；不存在的版本用 `null`。

只有状态为 `applied` 且当前文件仍匹配记录 `after_sha256` 的变更才能预览。不能用历史旧记录预览一个已经有后续修改的文件。预览不修改文件，可用于只读工作区；实际恢复仍要求可写授权。

`context_lines` 范围 0–20；`max_bytes` 上限为 `readMaxBytes`。`diff_bytes` 是完整 diff 的 UTF-8 字节数，`returned_bytes` 是实际返回字节数；`truncated: true` 表示差异未完整展示。计算另有时间和编辑量上限，超过时返回 `DIFF_TOO_COMPLEX`。预览中的文本不替代原始字节备份，编码和 BOM 通过格式字段说明。

确认差异后调用 `changes_restore`，使用预览返回的当前哈希：

```json
{
  "workspace_id": "default",
  "expected_device_id": "替换为 system_status 返回的实际设备 UUID",
  "change_id": "替换为同一变更ID",
  "expected_sha256": "替换为预览返回的current_sha256",
  "idempotency_key": "restore-example-001"
}
```

若当前文件不存在，`expected_sha256` 使用 JSON `null`。操作键应为本次操作新生成的 1–128 个 ASCII 字母、数字或 `_.:-` 字符，示例键不要用于多次不同操作。预览不锁定后续状态，期间发生编辑会导致恢复的版本检查失败，应重新读取。恢复会验证备份哈希和大小，生成新的变更记录，并将原记录标为 `restored`；相同请求重试必须复用原操作键。

已有逐文件恢复继续适用。可先预览每个目标，再逐个恢复并检查结果；外部程序造成的全部副作用不属于文件变更恢复的范围。v0.8 的批次还可记录多文件执行与回滚进度，具体见下节。

## 多文件预览与应用

`fs_batch_preview` 接受同一工作区内的 `changes` 数组，支持创建/覆盖、严格补丁、删除和移动。修改前先读取适用的项目指导和完整原文件哈希。下面展示形状，所有 `<...>` 均须替换为实际值；不要把示例文件名当作已获授权的修改目标：

```json
{
  "workspace_id": "default",
  "changes": [
    { "op": "write", "path": "src/new.ts", "content": "export const ready = true;\n", "expected_sha256": null },
    { "op": "patch", "path": "src/config.ts", "patch": "<严格单文件 unified diff>", "expected_sha256": "<当前原始字节 SHA-256>" },
    { "op": "delete", "path": "src/obsolete.ts", "expected_sha256": "<当前原始字节 SHA-256>" },
    { "op": "move", "path": "docs/old-name.md", "to": "docs/new-name.md", "expected_sha256": "<源文件当前原始字节 SHA-256>" }
  ],
  "max_bytes": 32768
}
```

write 的 `expected_sha256: null` 只允许新建，覆盖时须提供现有哈希；其余操作要求源文件存在且哈希一致。移动目标必须不存在，父目录必须存在。每条路径在一批中只能出现一次，移动的源和目标各计一条；不支持在同一批先创建后修改、连续移动或覆盖已存在目标。全部路径继续受工作区、链接、硬链接、敏感目录和设备绑定检查。

预览返回 `plan_sha256`、完整 `changes` 元数据、`path_count`、`total_bytes` 和有界 diff。检查各项修改前后哈希与字节数，以及 `diff_truncated/diff_omission` 和整批 `truncated`；diff 截断时需另行检查完整目标内容，不能把有限片段视为完整审阅。diff 对常见凭据先脱敏，`diff_redacted/redactions` 表示是否有替换，展示文本不能代替原文件哈希。移动在执行层展开为目标创建与源删除两个步骤。预览 `persisted: false`、`atomic: false`，不持久保存正文、不预留文件或阻止外部编辑。

确认计划后调用 `fs_batch_apply`，提交同一个 workspace_id 与完全相同的 changes，增加 `expected_plan_sha256`（预览返回值）、`expected_device_id` 和新的稳定 `idempotency_key`。不传预览专用 max_bytes。服务重新读取并校验全部文件，计划不同返回 `BATCH_PLAN_CONFLICT`，文件版本不同也会拒绝，不自动调整补丁或覆盖新编辑。

整批默认最多 20 条不同路径，修改前后原始字节合计最多 4 MiB，每个文件仍受 `limits.writeMaxBytes` 限制；移动因源/目标两个步骤计入实际字节和路径预算。可调项在同一配置的 `fileBatches` 中，详见[本机配置](local-configuration.md#v08-的批量变更与作业输入限额)。应用前完成预检和备份，之后按步骤写入，保留逐步变更 ID。它不保证外部程序无法看见中间状态。

移动、条件回滚和逐文件恢复会保留记录中的普通权限位，包括 POSIX 可执行位；权限变化也会使旧预览或提交检查失败。不复制 ACL、所有权、时间戳或 set-ID 等特殊权限。旧备份没有权限记录时，恢复到现有文件沿用其普通权限；重建不存在的文件使用安全默认权限，不能推断原来的可执行位。

## 批次失败、查询与恢复

`fs_batch_apply` 返回批次 `batch_id`、`status`、`changes`、逐路径 `steps` 和错误。不能仅凭 MCP 外层 `ok: true` 判断整批成功，应检查状态和每一步：

| 状态 | 含义与下一步 |
|---|---|
| `applied` | 记录中的步骤已应用；需要时再检查当前文件与测试结果 |
| `rolled_back` | 执行失败后已完成有条件回滚；原应用目标没有完成，先核对错误与当前状态 |
| `partial` | 部分步骤未能安全回滚；查看 step 的 rollback_conflict/unknown 和当前观察，保留本地后续编辑 |
| `unknown` | 服务重启时发现批次未完成，保存记录不能确定最终结果；不自动继续或回滚 |

失败后按相反顺序尝试回滚已写步骤。只有文件仍匹配本次写入结果时才恢复备份；发现其他修改或提交状态未知时，不覆盖新内容。步骤可能带 `change_id`、`rollback_change_id` 和 `error_code`，可结合现有 `changes_preview/restore` 按版本检查处理；每次恢复都应核对当前真实文件，不能直接假定恢复完毕。

现有恢复工具仅接受状态为 applied 的单文件变更，并要求当前版本匹配记录。单文件记录为 unknown 时，即使观察到某个哈希相同，也不会自动转为 applied；这种情况需要本机检查保存的备份与实际文件，目前没有通过 MCP 强制恢复 unknown 记录的入口。

连接中断或需要查询时调用 `fs_batch_status`：

```json
{
  "workspace_id": "default",
  "idempotency_key": "<原 fs_batch_apply 使用的键>"
}
```

查询返回保存的执行进度、`recorded_result`，并单独提供当前 `observations`。每条观察包括当前哈希和 `matches: before/after/both/neither/unknown`；读取失败、超出观察预算等为 unknown。`observations_atomic: false` 表示这些文件按顺序观察，不能认作同一瞬间的一致快照。哈希匹配也不能证明是哪个进程进行了修改。未找到该工作区对应记录时 `exists: false`。

相同 apply 请求重试须保留原键和参数，返回原记录，不重复执行；幂等重试的旧结果不等于当前文件状态，当前状态须查询。状态不确定时先查询和核对实际文件，不换键重发整批。批次记录和备份保留在本机 state，服务重启不会恢复旧进程，也不会自动重放未完成批次。批次只管理文件工具的修改，不回滚命令、数据库或网络副作用。

正常停止服务时会等待已开始的工具调用完成后再关闭状态数据库；强制结束进程或系统崩溃仍可能留下 unknown 批次。大量文件操作应在退出前核对返回结果，不能把正常关闭的等待机制当作故障恢复保证。
