# 测试与验证边界

## 当前本地结果

2026-09-10，0.14.0-preview.2，Windows / Node.js 22.16.0：

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查与构建 | 通过 |
| 核心完整回归 `npm test` | 558 项：556 通过、0 失败、2 跳过 |
| 仓库检查脚本专项 `npm run test:repo` | 4 通过、0 失败 |
| MCP 工具 schema | 已从隔离的本地 stdio 服务生成 44 项 |
| 全新源码安装检查 | 10 个步骤通过，包含锁定依赖安装、构建、init、validate、doctor、schema 与仓库检查 |
| 公开候选文件检查 | 未发现命中规则的凭据、私有文件或失效本地文件链接 |
| npm 生产依赖安全公告检查 | 0 项已知漏洞；仅代表本次查询结果 |

两项跳过为 Windows 文件符号链接场景，当前进程没有创建该类链接的权限。没有为本次整理提升为管理员、开启开发者模式或复用此前的一次性 UAC 授权。

全新安装检查使用临时的中文与空格路径，仅复制公开候选文件，不带旧 node_modules、dist、真实配置或状态。依赖按锁文件从本机缓存重新安装，随后按 README 初始化；测试结束清理该临时副本。它验证本机安装流程，不代替其他平台或无缓存网络下载验收。

本地测试覆盖实际临时文件、SQLite、程序/子进程、HTTP/stdio、配置及合成会话。它们**不等于当前版本已完成真实 ChatGPT 网页验收**，也不证明原文件正文附件能力已经实现。

## 日常运行

```text
npm ci --ignore-scripts
npm run check
npm test
npm run export:tools -- --check
npm run test:repo
npm run audit:repo
```

`npm test` 先构建，按当前 `test/*.test.ts` 源文件清单运行，避免已删除实验遗留的 dist 测试被重新执行。测试串行调度以减少本机进程/端口冲突。

测试使用临时目录、合成内容和测试自己的进程，不加载真实 `.webcodex/config.toml`，不需要真实 API key 或隧道。某些受限运行环境会阻止 Windows ACL 检查、回环端口或子进程清理；应在具备这些本机能力的开发环境运行，不能把权限失败直接视为断言通过。

旧 PowerShell 兼容入口另有 `scripts/test-start-tunnel.ps1`、`test-check-tunnel.ps1` 和 `test-tunnel-auth.ps1`。修改这些旧脚本时单独运行相应测试；不能宣称核心 Node 回归已运行所有额外脚本。

## 覆盖范围

- 文本/Unicode、分页/长行、大文件边界、补丁、哈希冲突、幂等、备份与条件恢复。
- 工作区身份、设备匹配、同权限重叠、只读/离线、链接路径与显式 Git worktree。
- JSON/TOML、路径展开、私有配置权限、迁移、执行别名/profile 和环境限制。
- 程序输出与 stdin、超时/取消、作业观察、任务修订、交接和重启后的不确定状态。
- Codex 可见会话分页、搜索、脱敏、项目匹配及支持的历史格式。
- MCP stdio/HTTP 调用、空参数、输出 schema、有限历史组件 URI 及诊断。
- 官方隧道启动器的验证/锁/健康判断，使用合成客户端；可选本地面板及旧实验配置不激活。

自动化测试通过不排除未覆盖缺陷。真实文件格式、Codex 内部日志结构和 ChatGPT 宿主接口变化仍可能需要兼容修复。

## Windows 符号链接专项

在已经拥有文件符号链接权限的终端运行：

```text
npm run test:symlinks
```

它严格要求两项均通过，不能用跳过满足要求。脚本不会修改系统设置，结果留在被忽略的本机运行目录。通常需要已启用开发者模式的环境或用户自行授权的管理员终端；普通 directory junction 测试不能替代文件符号链接场景。

## 跨平台 CI

GitHub workflow 配置 Windows、Ubuntu、macOS，固定 Node.js 22.16.0，并设置 `WEBCODEX_REQUIRE_FILE_SYMLINK_TESTS=1`。还检查工具文档是否过期、仓库检查专项和公开候选文件。

远端结果见 [GitHub Actions](https://github.com/xq3427/WebCodex/actions/workflows/ci.yml)。上方统计为本地 Windows 结果，不能代替某次提交的三平台运行结果；应核对对应提交的完整矩阵。失败必须修复或明确收窄支持范围，不能为绿灯取消必要检查。

## 发布前人工验收

创建 GitHub 仓库后核对 CI，并在具备权限的真实 ChatGPT 连接中验证设备/工作区、文本创建及读回、修改冲突和恢复、Codex 接续，以及用户已启用时的程序执行。

原文件自动上传暂停，不纳入已完成能力。不要用本地组件、传输字节、上传回执、文件卡片或旧版本网页截图代替新版本正文读取证据。
