# 架构

WebCodex 是 TypeScript/Node.js MCP 服务，当前版本为 `0.16.0-preview.8`。ChatGPT 负责理解任务、规划和工具选择，本地服务负责配置授权、执行工具与返回证据。

```text
ChatGPT → OpenAI Secure MCP Tunnel → 官方本机 tunnel-client
                                      ↓ stdio
本地 MCP 客户端 ──────── stdio / loopback HTTP → server.ts → App
                                                    ├─ 文件/路径/变更
                                                    ├─ Git 与项目指导
                                                    ├─ 作业和 stdin
                                                    ├─ Codex 可见会话（只读）
                                                    └─ 任务、检查点、SQLite 状态
```

官方隧道是可选传输；直接本地 stdio 不需要 OpenAI API key。回环 HTTP 是供本机 MCP 客户端使用的入口，不等同于 ChatGPT 公网连接。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/cli.ts` | 初始化、配置管理、doctor、服务/隧道/可选面板入口 |
| `src/config*.ts`、workspace 配置模块 | 单文件选择、schema、路径展开、身份与私有配置编辑 |
| `src/server.ts`、`server-instructions.ts` | 工具注册、输入/输出约定、设备校验、模型指导 |
| `src/app.ts` | 组装服务组件与生命周期 |
| 文件系统、路径、批量变更模块 | 授权目录、文本与原字节、哈希、幂等、备份/恢复 |
| jobs / execution 模块 | 总开关与旧 allowlist 兼容、本机程序解析、环境预设、持久作业记录、日志和管道输入 |
| codex 模块 | 只读索引和会话扫描、完整记录脱敏、分页与上下文 |
| tasks / checkpoints / state | 任务修订、交接文件、SQLite 存储与操作审计 |
| tunnel / diagnostics 模块 | 官方客户端验证、启动锁、健康状态和协议元数据 |
| local-panel / file-widget 模块 | 本机文件、会话与作业浏览，以及显式原文件组件诊断；组件显示不保证宿主获得文档正文 |
| panel-config / local-admin-ui | 本机表单、密钥只写更新、配置版本检查、原子保存；管理 API 不作为 MCP 工具暴露 |
| panel-runtime | 管理自有隧道/HTTP 子进程、配置版本锁定、忙作业和外部启动器保护、合作式关闭 |
| panel-launcher | connect 的管理页面与服务统一启动、一次性输出本机临时凭据链接、端口冲突避让和独立传输状态提示 |
| document-service / document-tools / document-assets | App 持有的原件快照与分页任务、普通正文读取、私有原件传输；资源白名单用于构建内置字体/CMap及旧资源工具兼容 |
| browser/pdf-runtime / document-widget | 捆绑 PDF.js，浏览器校验完整原字节、提取分页文字层并通过 MCP 提交 |
| local-copy / filesystem | 同一设备上按源/目标工作区直接复制完整原字节；源可只读、目标须可写，使用源哈希、备份、持久操作与读回校验 |
| file-save / file-save-tools / file-save-widget | 默认生成文件保存入口：实际宿主文件 ID → 组件私下解析临时地址，或直接接收官方文件对象；固定原件大小/哈希、目标和操作键，非阻塞查询状态 |
| file-import / file-download / filesystem | 已授权宿主文件 → 官方 HTTPS 原件下载 → 写前原件核对 → 工作区原字节提交及读回校验；保留旧导入入口，文件名元数据不决定本机路径 |
| binary-input / binary-chunks | 有条件的兼容回存：有界 Base64 原字节 → 持久分块暂存 → 完整 SHA-256 → 工作区写入及恢复；模型中转曾在真实网页被截断，不作为默认原文件保存方式 |

## 三条文件路径

- **本机文件到本机目录**：`fs_copy` 直接在已授权工作区之间复制，不经过 ChatGPT 上传、下载器或程序执行。
- **ChatGPT 生成文件到本机目录**：`fs_save_file` / `fs_save_file_status` 使用实际宿主文件引用。组件调用 `getFileDownloadUrl` 后只将地址交给私有工具，由本机出站下载；用户无需填写 URL，也不增加公网服务、扩展或第三方通道。原件大小和 SHA-256 在写入前核对。
- **本机 PDF 到模型正文**：`document_open` 创建受限原件快照，宿主组件在浏览器校验并解析 PDF 文字层，`document_read` 返回 pending 或已提交的分页正文。它不等于 ChatGPT 原生附件上传，也不支持 OCR。

下载器目前只接受 `https://files.oaiusercontent.com`，限制公开网络目标并校验 TLS、重定向、大小和完成情况；可复用本机配置的 `tunnel.proxyUrl`。`sandbox:/...` 和本机路径不能代替宿主文件引用。文件 ID 的存在也不保证当前插件已获宿主授权。

## 数据与生命周期

用户配置集中于一份 JSON/TOML。运行数据写入配置指定的 state 目录，包括身份绑定、操作记录、文件备份、任务和作业输出；它们不是第二套用户配置。

服务对 state 建立单实例所有权；隧道启动器另有锁。状态查询不应再构造一个 App 并争用运行实例。退出服务会取消其活动作业，持久 ID 只能恢复记录，不能恢复原进程或 stdin。

写入先校验设备与工作区，再核对原始哈希和操作键，保存恢复资料并执行。多文件批次有预检和条件回滚，但不是操作系统原子事务。必须检查部分完成与 unknown 状态。

自动保存票据只保留在有界本机内存和组件私有元数据，服务重启后不再有效；持久保存结果仍可查询。组件不把 URL、票据、文件 ID 或原字节加入模型上下文，也不直接下载文件。只有绑定原操作的 `saved` 和 `verified=true` 回执表示提交时完成校验；当前文件是否仍相同需看独立磁盘观察。超时或未知结果不能通过换键或换工具自动重放。

`connect` 默认联合启动本地控制中心及所选服务，终端输出带临时面板凭据的回环链接。控制中心操作同一配置文件，使用版本检查与原子保存；启停/重启仅作用于它管理的服务。管理 API 不进入 MCP 工具列表，面板端口与 MCP HTTP 端口独立。

Codex 会话读取与普通项目文件读取使用不同的受限入口。启用历史读取不会把整个 Codex home 开放成可写工作区。历史结果需要检查省略和扫描完整性，也不能替代当前文件事实。

## 边界

工具层的路径授权不限制允许程序的内部行为。`trusted-host` 必须按本机用户权限理解。HTTP token 只保护回环入口，不构成多用户服务或公网 OAuth。

将本机原文件自动加入 ChatGPT 原生附件、浏览器自动化、Actions 与第三方公网通道仍暂停，不参与默认启动。生成文件自动保存到本机是独立方向，preview.7 已实现，但真实 ChatGPT 端到端验收尚未完成。模拟宿主测试验证原字节保存链路，不能证明当前宿主已授权某个文件；组件显示也不证明模型已获得正文。

PDF 文字层采用新路径：`document_open` 提前创建任务，组件自动传输/解析/提交，`document_read` 非阻塞返回 pending 或真正分页正文。状态归 App 所有，不能放在按 HTTP 请求重建的 MCP server 注册闭包内。解析器随构建打包，不在 Node 服务端执行。详细预算与验收范围见 [PDF 正文原型](pdf-reading-prototype.md)。
