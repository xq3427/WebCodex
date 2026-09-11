# 将 ChatGPT 生成文件保存到本机

**0.16.0-preview.7 的默认原文件保存入口是 `fs_save_file` / `fs_save_file_status`。** 输入生成产物的真实宿主文件 ID 或官方文件对象；只有 ID 时由组件私下解析下载地址，已有可用官方对象时直接下载。本机取得完整原字节并核对原件大小/SHA-256 后保存。此流程不要求用户填写 URL、选择文件或安装扩展；原字节不经过模型文本中转。实际宿主必须授权这份文件，代码测试通过不能替代真实 ChatGPT 验收。

本机不会自行访问 ChatGPT 的 `/mnt/data`，也没有获得它的内存或文件权限。自动入口只需模型提交真实文件引用及校验信息。旧 Base64 兼容路线仍需模型完整提交原字节，分块不消除总体上下文成本；它不能替代宿主文件交接。

## 自动保存原文件

在生成文件的同一 ChatGPT 会话中，直接要求：

> 将刚才生成的原文件保存到指定工作区。不要重新生成、缩图或重编码。取得这份生成产物实际的宿主文件 ID，并在 Code Interpreter 计算同一原件的大小和 SHA-256。核实设备和工作区后调用 fs_save_file；已有目标先 fs_stat，使用当前目标 SHA-256 作为 expected_sha256。保持自动保存组件打开，按 fs_save_file_status 的查询间隔和剩余额度检查结果；只有 saved、verified=true 且 fs_stat 与原件大小/哈希一致才报告完成。不提供 URL，不用 Base64 搬运。

`fs_save_file` 输入包括工作区、相对目标路径、`expected_device_id`、`idempotency_key`、原件 `size_bytes/content_sha256` 和目标 `expected_sha256`。源引用二选一：

- `file_id`：附件或生成工具**实际提供的当前产物 ID**，形如 `file-…` 或 `file_…`。
- `file`：宿主依照 `openai/fileParams` 提供的完整官方文件对象；不是用户手工编写的下载地址。

不能从 `sandbox:/mnt/data/...`、文件名或其他附件 ID 猜出当前产物的 ID。`expected_sha256: null` 仍是只创建语义；新目录须先创建。原件哈希与已有目标哈希含义不同，不可交换。

宿主已经给出可用官方文件对象时直接下载。只有文件 ID 时，打开的紧凑组件自动调用 `window.openai.getFileDownloadUrl({fileId})`，再通过组件私有工具把地址交给服务。组件不 `fetch` 文件、不使用外部 CDN，也不将 URL、票据或文件字节写入模型上下文。本机继续使用既有 HTTPS 主机/地址策略及本地代理配置，不增加公网入口。一次下载已返回失败后，自动保存会话不会自行刷新地址重试；应查询并报告该操作的实际状态。

完整源文件下载到内存后先核对 `size_bytes/content_sha256`，不符返回 `FILE_IMPORT_ORIGINAL_MISMATCH`，不会覆盖目标；不能把收到的其他文件哈希改填成原件哈希。写入仍检查旧目标版本、备份、权限、幂等并验证结果。

`awaiting_host_file` 和 `pending` 不是保存完成。`fs_save_file_status` 每次立即返回，含 `retry_after_ms`、`polls_remaining` 和 `can_poll`，最多观察 30 次 pending，避免长期占用工具通道阻止组件调用。`saved` 含校验回执及独立的 `current_observation`；`failed` 显示固定错误码；`unknown` 必须查询原操作，不能更换键重放。底层持久记录仍使用 `operation_status` 的 `tool=fs_import_file` 和同一操作键。

票据只存在于组件私有元数据和有界本机内存，绑定工作区身份、目标、原件大小/哈希及旧版本。服务重启使未完成票据失效；已记录的保存结果仍可查询，不会把中断操作自动重做。会话数量/寿命复用 `binaryInputs.maxSessions/ttlMs`；文件限额使用 `limits.binaryWriteMaxBytes`。此通路不分块缓存文件，不受 `binaryInputs.chunkMaxBytes/maxCacheBytes` 限制。

`HOST_FILE_API_UNAVAILABLE` 表示宿主没有提供所需 helper；`HOST_FILE_REFERENCE_UNAVAILABLE` 或 `HOST_FILE_RESOLUTION_FAILED` 表示引用解析未完成。函数存在或模型看到一个 ID，都不保证该 ID 已对当前插件授权。遇到错误应报告真实结果，不退回大量 Base64、替换原图或改动下载源规则。

`0.15.0-preview.5` 的 `fs_import_file` 仅保留为兼容入口：它需要宿主提供有效文件下载对象；此前真实调用提供的是 `sandbox:/...` 路径，服务因此拒绝，未完成保存。有条件的字节接收路线不依赖该入口。

**本机实现与真实宿主交接是两项验收。** 当前尚未确认 preview.7 在真实 ChatGPT 中完成生成 PNG、PPTX 等原文件的端到端保存。工具注册、附件下载按钮、真实文件 ID 或一个 `sandbox:/...` 链接，都不能证明本机已获得文件。只有收到完整原字节、写入成功并完成核对，才可报告已保存。

## 真实网页失败与当前边界

2026-09-11 的反馈中，2,341,397 字节原 PNG 在 Code Interpreter 输出下一段 Base64 时出现 `[...]` 截断。同期本地诊断显示隧道正常、只读调用已响应，未收到任何 `fs_write_binary_chunk` 请求。这次失败发生在本机接收之前，不能记为本地写入失败、哈希校验失败或隧道断开。用户读回结果表明旧目标保持原哈希；服务未取得新原图，不能报告原图已经回存。

后续用户确认这份 2,341,397 字节 PNG 有实际宿主文件 ID，因此下一步可沿 `fs_save_file` 主路线验证同一产物。当前仍没有 `getFileDownloadUrl` 成功解析或本机保存成功的证据；文件 ID 的存在不能替代插件文件授权、下载、原件校验和落盘验收。

64 KiB 原字节会生成 **87,384 个 Base64 字符**，这份文件共需 36 块。完整文件编码约 **312 万字符**；如果改用 4 KiB 块则需 572 块，整体文本成本仍然存在。增大块会增加单次中转压力，减小块也不能证明流程稳定。当前协议要求非末块等于返回的 `chunk_max_bytes`，客户端不能在同一配置下自行改为更小块。

遇到这种尚未提交工具的截断，应停止传输并报告“宿主字节中转未完成，无本地写入结果”，不提交省略号、不反复调整配置或重启健康服务，也不启动数百次文本中转作为常规解决办法。此前本地 MCP 合成文件测试只证明接收、恢复与哈希校验功能，不能替代网页端原文件交接验收。

## 兼容路线：有条件的字节回存验收

下面只验证保留的 Base64 兼容接收工具。默认自动保存的验收见[真实 ChatGPT 验收](#真实-chatgpt-验收)。仅当当前宿主已能完整转交原字节、文件较小且传输次数可控时，在隔离目录验证：

> 检查这份合成小文件的原字节能否完整传给 WebCodex；如果 Base64 输出被截断或不能完整作为参数提交，立即报告交接失败，不扩大块、不缩图、不继续大量分块尝试。可以完整提交时，核实设备和工作区，在 Code Interpreter 读取同一原文件的大小和 SHA-256，按 fs_write_binary_chunk 返回的 next_offset/chunk_max_bytes 传送，每块提供原始 chunk_sha256；只新建到测试路径、不覆盖。只有 status=saved 且 verified=true 后才报告成功，再用 fs_stat 核对。丢失响应先查 fs_write_binary_status，不盲目换键重传。

工作区名称和目标文件名按实际任务替换。模型应先用 `system_status`、`workspace_list` 确认目标设备、工作区 ID 和可写权限，再提交相对路径，例如 `论文重点预览.pptx`。工作区配置负责决定其本机根目录，工具中不写死盘符或用户目录。需要子目录时，先用 `fs_mkdir` 创建缺少的父目录。

新文件传 `expected_sha256: null`，它是只创建语义；现有文件会拒绝覆盖。用户已要求替换现有文件时，先调用 `fs_stat` 取得当前原字节哈希，再作为 `expected_sha256` 提交。每次保存需要核实的 `expected_device_id` 和新的 `idempotency_key`。

这些工具不额外要求用户逐个选择文件或点击组件，但这不代表宿主自动转交已经可用。ChatGPT 自身的工具授权与文件可用性由宿主决定；如果文件未传入，应明确说明当前卡在宿主交接，不能捏造参数或静默改写为文本内容。

## 兼容路线：直接原字节回存

遇到 `FILE_IMPORT_SOURCE_DENIED` 时，先检查实际调用工具。它表示 WebCodex 本机下载器的来源校验拒绝；`fs_save_file` 使用相同下载器，也可能返回该错误。不能据此说成宿主拦截、分块超限或本机没有写入权限。`details.stage/reason` 只返回固定分类；例如 `source_url / host_not_allowed` 表示提供的下载地址主机不在允许范围。不要修改域名规则或反复调用同一下载路线。

结构化状态将默认入口设为 `fs_save_file`，`chunk_write` 字段保留 `fs_write_binary_chunk` 作为有条件的兼容入口：原字节必须能在宿主限额内完整交接，`model_relay_verified` 与 `large_file_model_relay_recommended` 均为 `false`。若前次导入结果不明，先查 `operation_status`；确认失败后，只有仍能从 Code Interpreter 取得并完整提交同一份原文件的准确字节时，才考虑小载荷分块回写。覆盖已有图片前，用 `fs_stat` 取得**当前目标文件**的 SHA-256 作为 `expected_sha256`，不是原图摘要或 `null`。完整原图大小和摘要分别放在 `size_bytes/content_sha256`；未收齐、未校验前旧图保持不变。若当前对话缺少分块工具或无法输出完整原字节，应报告这一实际限制，不能退回缩图或把导入失败当作分块失败。

- 一次小载荷使用 `fs_write_binary`，传 content_base64、content_sha256、size_bytes、workspace_id、path、expected_device_id、expected_sha256 和 idempotency_key。
- 较长载荷使用 `fs_write_binary_chunk`，另传 offset_bytes、chunk_sha256。全程使用同一操作键、目标路径、原文件大小/摘要和旧目标哈希。
- 在 Code Interpreter 从同一个不再修改的原文件计算摘要；每次只读取工具指定偏移的下一块。不要把变量名、文件路径、省略号或被截断的输出当作 Base64。不要由模型猜字节或根据坏数据重新计算“预期摘要”。
- `receiving` 仅表示私有暂存；目标文件尚未提交。按 next_offset 继续，收齐并校验整文件后才原子写入并返回 saved。重复同一偏移、相同字节的分块不会重复追加。
- 丢失响应先查 `fs_write_binary_status`。最终写入的持久记录使用 `operation_status` 的 tool=fs_write_binary；unknown 禁止重放。历史回执与当前磁盘观察分开报告。此前下载导入若状态不明，也不能直接改用这个工具重试。
- 若状态返回 `resume_action: repeat_last_chunk`，按 `retry_chunk_offset` 和 `retry_chunk_bytes` 重送原文件的最后一块，沿用原操作键。此状态表示暂存已收齐但提交尚未确认，不能把 `next_offset=total_bytes` 当作保存成功。
- 若运行期间修改配置，后续继续请求仍服从当前限额。状态为 `blocked`、`resume_action: inspect_local_limits` 时，先报告返回的所需/当前限额，不能自动放宽配置或换键绕过；最终结果为 `unknown` 时继续禁止重放。

`0.16.0-preview.5` 默认每块 **64 KiB（65536 字节）**，`binaryInputs.chunkMaxBytes` 可配置为 1 KiB–256 KiB（1024–262144 字节）。分块整文件上限为 `min(limits.binaryWriteMaxBytes, binaryInputs.maxCacheBytes)`，默认分别为 32 MiB 和 64 MiB，所以默认单文件最多 **32 MiB**。二进制单文件配置最大仍为 128 MiB；暂存总预算 `maxCacheBytes` 可配置为 1 KiB–512 MiB，按声明的完整文件大小预留。会话数默认最多 4 份，连续 15 分钟未收到新分块后过期；多个会话仍共享暂存总预算。

单消息 `fs_write_binary` 的 `limits.inlineBinaryWriteMaxBytes` 仍默认 **256 KiB**，与 `binaryWriteMaxBytes` 取较小值；它不再限制分块整文件。升级保留显式较小旧配置，例如已有 12 KiB 分块或 1 MiB 暂存设置仍生效；省略的字段才使用新默认值。修改限额后需校验配置并正常重启，不能靠换操作键绕过当前限额。

默认 64 KiB 分块下，170,732 字节文件需要 3 块。Base64 会增加约三分之一的传输字符，分块减少调用次数或单条消息大小，不消除总体上下文成本。服务限额不保证宿主能可靠承载大段 Base64、足够的工具调用次数或输出预算。**不得为了满足限额缩小图片、重新编码或替换原文件**；超限或传输失败应报告实际状态，不能宣称原文件已回存。详情见[配置](local-configuration.md#原字节直接回存)。

## 官方文件对象与旧导入入口

`fs_save_file` 和兼容入口 `fs_import_file` 的工具描述都包含 `_meta["openai/fileParams"]: ["file"]`。官方文件对象也是当前自动保存主路线支持的输入。`file` 是顶层文件对象，其 schema 必须声明下列四个属性：

| 属性 | 是否必填 | 来源与用途 |
| --- | --- | --- |
| `download_url` | 是 | ChatGPT 提供的有效临时 HTTPS 下载地址 |
| `file_id` | 是 | ChatGPT 文件标识，不是本机文件路径 |
| `mime_type` | 否 | 宿主提供的可选类型信息 |
| `file_name` | 否 | 宿主提供的可选文件名；不决定保存路径 |

两个入口都另外提交 `workspace_id`、`path`、`expected_device_id`、`expected_sha256` 和 `idempotency_key`；当前默认入口 `fs_save_file` 还必须提交同一生成原件的 `size_bytes/content_sha256`。文件对象应由宿主根据该产物提供，不能从显示名称或 `sandbox:/mnt/data/...` 猜出下载地址。两个入口都不读取 ChatGPT 的沙箱文件系统，也不接受本机路径或任意网站 URL 作为替代。

官方依据：[OpenAI Docs — Define file inputs](https://developers.openai.com/plugins/reference#define-file-inputs) 和 [File APIs](https://developers.openai.com/plugins/reference#file-apis)。前者规定文件参数结构；后者规定 `getFileDownloadUrl({fileId})` 返回临时 `downloadUrl`，并支持组件上传、文件库选择、file params 传入或工具文件引用返回的文件。文档不保证当前会话的某个生成文件已对本插件授权，因此实际交接能力需要用真实 ChatGPT 验证，不能用 GPT Actions 的文件接口行为代替 MCP 验收。

preview.7 已将**宿主文件 ID → 组件取得临时地址 → 本机下载并校验**和**宿主官方文件对象 → 本机下载并校验**接入同一 `fs_save_file` 主入口。下一步应在真实网页验证这两种来源实际到达的阶段，优先使用当前产物已提供的真实引用。临时下载地址由宿主内部提供，不要求用户复制 URL，也不要求用户自建公网服务器。只有真实生成产物完成大小/哈希核对及落盘后，才能将相应宿主交接分支记为验收通过。不能把 `sandbox:/...` 字符串改名为“文件对象”，也不能把本机合成测试算作真实宿主验收。

OpenAI Docs 还提供 [Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)：Responses API 可允许程序协调 MCP 和 Code Interpreter 工具，让中间结果保留在运行时。这是一项 API 应用配置，文档并未证明 ChatGPT 网页插件可由 MCP 服务开启同样能力，也不保证 Code Interpreter 的大段输出不会先被截断。不能把增加 `allowed_callers` 当成本项目网页连接的现成修复，更不能未经验证改走 API 来替代用户要求的网页应急方案。

## 自动保存与兼容导入共用的下载连接和限额

继续使用现有 MCP 连接和 OpenAI 官方 Secure MCP Tunnel。回存只增加本机到 `https://files.oaiusercontent.com` 的出站下载，不增加公网入口、域名、证书、Cloudflare、Actions 服务、浏览器扩展或额外 API key。下载凭据来自本次宿主官方文件对象，或组件针对已授权文件 ID 取得的临时地址；不使用 `tunnel.apiKey` 下载文件。

已有配置的 `tunnel.proxyUrl` 非空时，下载复用该代理；为空时直接连接。服务不会自动安装代理或修改真实配置，官方下载主机和网络目标校验继续生效。

服务只接受该官方下载主机的 HTTPS 地址，并检查网络目标、传输大小和完成情况。下载未完成或传输校验失败时不提交目标文件。临时地址可能过期，也可能因本机网络无法访问而失败；不能通过关闭校验或换成任意下载服务解决。

`limits.binaryWriteMaxBytes` 默认 **33554432 字节（32 MiB）**，可在统一 TOML/JSON 配置中调整，最大 **134217728 字节（128 MiB）**。旧配置省略此项即可使用默认值。它与 `fs_read_file` 的 4/7 MiB 内联响应上限独立，也不扩大文本 `fs_write` 的限额；preview.6 的批量 copy/move/delete 使用此二进制单文件限额，并受独立批次总预算限制。配置方式见[本机配置](local-configuration.md#生成文件回存与二进制恢复)。

## 成功、重试与恢复

成功回执包含目标工作区、相对路径、`size_bytes`、`sha256`、`change_id` 和 `verified`。校验的是提交时的完整原字节；随后用 `fs_stat` 再确认当前磁盘状态。文件哈希一致说明保存的字节一致，不证明 PPTX 内容正确、论文总结准确或宿主读取过原文。

响应丢失或失败后，按实际使用的入口查询，始终保留原 `workspace_id`、`expected_device_id` 和 `idempotency_key`：

- `fs_save_file` 主路线先查 `fs_save_file_status`；底层持久记录用 `operation_status` 的 `tool=fs_import_file`。pending 时遵守查询间隔和剩余额度，失败、未知、阻断或额度耗尽时停止自动轮询，不换键重放。
- `fs_write_binary_chunk` 兼容路线先查 `fs_write_binary_status`；最终写入记录用 `operation_status` 的 `tool=fs_write_binary`。
- 直接调用旧 `fs_import_file` 时，用 `operation_status` 的 `tool=fs_import_file` 查询。

自动保存的 `saved` 状态包含历史校验回执和独立的 `current_observation`；`operation_status` 可查看原操作阶段、回执、关联 change_id 及当前磁盘观察。历史成功不能代表文件现在仍相同。

旧 `fs_import_file` 自 preview.6 起用稳定 file_id、目标路径、预期旧哈希识别导入；同一操作允许宿主刷新 download_url，不重复已完成写入。该兼容入口只有在状态明确 `retryable=true` 的写入前下载失败时，才可沿用原键重试，默认最多 3 次（含首次）。busy 不占用导入操作键。有效额度取已保存上限与当前配置的较小值；下调后的重试检查会持久收紧上限，再调高不会恢复耗尽额度。

preview.7 的 `fs_save_file` 会话还固定原件大小和 SHA-256，并在一次失败或未知结果后停止自动完成；不能根据底层导入的 retryable 标记触发组件重试，也不能改走旧入口自动绕过会话终态。文件摘要一旦记录便不能更换内容；unknown、提交后中断、旧版本不确定回执均不自动重放，不能更换操作键绕过。旧记录按原参数核对，不能追溯声称其支持新 URL 身份规则或原件大小/哈希约束。

`FILE_WRITE_VERIFICATION_FAILED` 表示写入后的校验未能确认目标字节，文件可能已经改变，变更记录可能为 `unknown`。此时先用 `operation_status` 查询原操作，再用 `fs_stat` 和 `changes_list` 检查当前状态与记录，保留实际错误，不宣称“没有写入”或“保存成功”，也不更换操作键自动重写。其他提交后错误或连接中断同样不能仅凭失败响应断言目标未改变；`unknown` 记录需要本机核对，不能通过恢复工具强制重放。

覆盖前会保存原字节备份，并保留原哈希冲突检查。通过 `changes_list` 找到记录后，可用 `changes_preview` 查看恢复目标；二进制版本返回 `diff_kind: "binary"`、大小和哈希，不生成虚假的文本差异。确认后用 `changes_restore` 有条件恢复。变更记录区分文本写入和原字节写入，恢复分别遵守文本与二进制目标限额。详见[恢复工作流](file-workflow.md#查看恢复会发生什么)。

工作区只读、受保护路径、符号链接/硬链接、设备身份和目录绑定检查继续生效。普通结果与诊断不包含签名下载 URL 或文件标识；请勿将实际文件参数、运行数据库或凭据粘贴到公开 issue。

## 真实 ChatGPT 验收

preview.7 的主路线验收应记录实际 `system_status` 版本，并确认当前对话实际可调用 `fs_save_file`、`fs_save_file_status` 和 `fs_stat`。使用同一份实际生成产物及其真实宿主文件 ID 或官方对象，先保存到测试工作区中尚不存在的路径，保留生成端原件。当前已有真实文件 ID 的 2,341,397 字节 PNG 可用于验证该路线，不需要再次输出它的 Base64。

验收需要同时确认：

1. ChatGPT 在 Code Interpreter 读取同一原文件的大小和完整 SHA-256，源引用确实属于这份产物；不重新生成、缩图或重编码。
2. 调用 `fs_save_file`，按实际分支确认宿主已提供可用官方对象，或组件已通过 `getFileDownloadUrl` 取得该文件的临时地址。记录真实结果，不能把函数存在、工具注册或 ID 可见当作解析成功。
3. 组件保持打开；`awaiting_host_file/pending` 阶段按 `retry_after_ms` 和 `polls_remaining/can_poll` 查询 `fs_save_file_status`。不使用长时间阻塞工具等待，也不自动重复打开保存入口。
4. `fs_save_file` 或其状态查询最终返回 `status=saved`、`verified=true`，随后 `fs_stat` 的大小与 SHA-256 与原件及回执一致。
5. 本机文件可由兼容程序打开；可取得生成端原件时，逐字节或用 SHA-256 比较同一产物。重复同一个操作不产生重复写入，只创建请求不会覆盖已有文件。

若工具不可调用、宿主 helper 缺失、当前文件未授权、下载或原件校验失败、状态未知或查询额度耗尽，记录实际错误与到达阶段，不能报告“文件已回存”，也不自动改为大段 Base64 中转。旧分块工具的验收仍按前述[兼容路线](#兼容路线有条件的字节回存验收)单独记录；其载荷截断不能证明自动文件引用路线失败，其本机接收测试通过也不能证明宿主文件引用路线成功。本说明不代表该 PNG 或任何已有私人 PPT 已保存到本机。
