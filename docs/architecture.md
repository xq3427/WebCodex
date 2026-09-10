# 架构

WebCodex 是 TypeScript/Node.js MCP 服务。ChatGPT 负责理解任务、规划和工具选择，本地服务负责配置授权、执行工具与返回证据。

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
| jobs / execution 模块 | 原生程序别名、环境 profile、持久作业记录、日志和管道输入 |
| codex 模块 | 只读索引和会话扫描、完整记录脱敏、分页与上下文 |
| tasks / checkpoints / state | 任务修订、交接文件、SQLite 存储与操作审计 |
| tunnel / diagnostics 模块 | 官方客户端验证、启动锁、健康状态和协议元数据 |
| local-panel / file-widget 模块 | 可选本机页面和显式组件诊断，不保证宿主获得文档正文 |

## 数据与生命周期

用户配置集中于一份 JSON/TOML。运行数据写入配置指定的 state 目录，包括身份绑定、操作记录、文件备份、任务和作业输出；它们不是第二套用户配置。

服务对 state 建立单实例所有权；隧道启动器另有锁。状态查询不应再构造一个 App 并争用运行实例。退出服务会取消其活动作业，持久 ID 只能恢复记录，不能恢复原进程或 stdin。

写入先校验设备与工作区，再核对原始哈希和操作键，保存恢复资料并执行。多文件批次有预检和条件回滚，但不是操作系统原子事务。必须检查部分完成与 unknown 状态。

Codex 会话读取与普通项目文件读取使用不同的受限入口。启用历史读取不会把整个 Codex home 开放成可写工作区。历史结果需要检查省略和扫描完整性，也不能替代当前文件事实。

## 边界

工具层的路径授权不限制允许程序的内部行为。`trusted-host` 必须按本机用户权限理解。HTTP token 只保护回环入口，不构成多用户服务或公网 OAuth。

原文件自动附件、浏览器自动化、Actions 与第三方公网通道已暂停，不参与默认启动。保留组件实验用于显式诊断；其成功事件不提升为模型正文可读结论。
