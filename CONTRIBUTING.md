# 贡献指南 / Contributing

欢迎提交缺陷修复、文档、跨平台兼容改进和测试。当前版本为 **0.16.0-preview.7**，仍处于预览阶段。新增能力应明确使用场景、权限边界和可重复的验收方式；当前状态见[功能说明](docs/implementation-status.md)，目录与模块入口见[项目目录](README.md#项目目录)和[架构](docs/architecture.md)。

## 本地开发

安装 Node.js ≥22.16、Git、ripgrep，然后执行：

```text
npm ci --ignore-scripts
npm run check
npm test
npm run check:tools
npm run test:repo
npm run audit:repo
git diff --check
```

PowerShell 若拦截 `npm.ps1`，使用 `npm.cmd`。`npm test` 会先构建，再按当前 `test/` 源文件清单运行测试；不要用残留的 `dist/test` 文件判断当前功能是否仍受支持。

自动测试使用临时工作区、合成文件和合成会话。不要加载真实配置、读取个人 Codex 历史、调用付费模型、连接真实隧道或重启正在运行的私人服务。下载、宿主 helper 和组件桥接应使用受控模拟；集成测试应验证真实服务逻辑与原字节校验，而不访问个人数据。

Windows 文件符号链接测试需要相应系统权限，可运行 `npm run test:symlinks`；没有权限时如实记录未验证范围。只改文档时检查命令、链接、版本与措辞即可，不需要编写复述文案的测试。完整要求见[测试说明](docs/testing.md)。

## 配置与私人数据

需要手动调试时，用 `init` 在隔离目录生成本机配置，并始终显式传相同 `--config`。JSON/TOML 共用统一配置模式；模板仅放占位符，不写入个人身份、路径或凭据。

以下内容不得进入提交、PR 附件或公开 issue：

- 真实 `config.toml/config.json`、`.webcodex/`、API key、临时面板链接、签名下载 URL 和组件票据。
- Codex 真实会话、账号认证数据、状态库、作业日志和未经脱敏的诊断输出。
- 私人文档、原图、验收文件及可关联私人文件的真实宿主 ID。

可提交可公开的合成夹具和经过人工核对的脱敏证据。`.gitignore` 与 `npm run audit:repo` 是辅助检查；提交前仍需审阅 `git status` 和拟提交 diff，不使用 `git add -f` 纳入真实配置或运行产物。

## 修改约定

- 将功能放入对应模块；CLI、MCP 注册层和底层实现保持一致。
- 文件修改必须保留设备校验、路径策略、哈希冲突检查、幂等语义和备份。新增执行功能说明其实际权限及副作用。
- 配置支持 JSON/TOML，不写死用户名、盘符、程序路径或凭据。增加字段时同步模板和兼容性说明。
- 对行为变更增加有意义的回归测试，特别是失败、重试和恢复路径。文档改动无需编写重复其内容的单元测试。
- 工具 schema 或版本修改后，运行 `npm run build` 和 `npm run export:tools`，同步提交 `docs/tools.json` 与 `docs/current-acceptance.md`；随后用 `npm run check:tools` 确认一致，不手工编辑生成文档。
- 版本变更同步 `package.json`、`package-lock.json` 和 `src/version.ts`；若变更组件资源地址，保留明确的历史兼容地址。
- 当前使用说明同步更新中文/英文 README 和相关指南。带日期、版本的历史审查与测试报告保留原始结论；新的验证另记环境、版本和证据，不追溯改写旧结果。

## 文件能力的验收约定

当前默认路线为：本机已有文件使用 `fs_copy`，ChatGPT 生成原件使用 `fs_save_file` / `fs_save_file_status`。旧 `fs_import_file` 与 Base64 工具保留兼容，不能把模型转抄完整原字节重新写成默认要求，也不能缩图、重编码或再生成来掩盖传输失败。

自动原件回存的回归测试至少覆盖来源大小/SHA-256、旧目标哈希、并发幂等、错误分类、失败时旧文件保护、过期、重启和未知结果不重放。组件测试应证明私有 URL/票据不进入模型可见状态。宿主文件 ID 必须对应当前产物，不能从 `sandbox:/...` 或旧附件推导。

本机测试、合成组件测试和真实 ChatGPT 验收分别报告。preview.7 的自动原件回存尚未完成真实宿主全链路验收；API 存在、文件 ID 可见或组件显示不是授权或保存证据。实际完成必须有 `saved`、`verified=true` 和与原件匹配的磁盘大小/哈希。PDF 正文读取也必须依据实际页正文，不能用卡片、上传回执或合成文字回传代替解析结果。

## 提交问题和 PR

问题报告应包含版本、操作系统、复现步骤、预期/实际结果和经过脱敏的错误代码。使用临时项目和合成文件；不要上传真实配置、密钥、会话数据库或整段私有日志。

PR 说明应交代问题、修改后的行为、验证结果及尚未验证的平台。CI 配置了 Windows、Linux 和 macOS；本地通过不能替代远端结果。只修改与你的问题有关的内容。

浏览器自动化、Actions/额外公网通道，以及将本地原文件自动送入 ChatGPT 原生附件的旧实验不属于当前已验收能力。涉及这些方向的改动应提出独立设计，说明实际宿主依据与可复现验收；不能与已实现但仍待宿主验收的 `fs_save_file` 原件回存混为一谈。

## 安全与许可

漏洞按 [SECURITY.md](SECURITY.md) 私下报告。贡献应为你有权提供的内容；提交的项目代码使用 MIT，第三方代码保留原许可和来源。

English contributions are welcome. Include a reproducible case, relevant tests and the platforms you actually verified. Never attach credentials or private session data.
