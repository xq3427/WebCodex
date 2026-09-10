# 贡献指南 / Contributing

欢迎提交缺陷修复、文档、跨平台兼容改进和测试。项目处于预览阶段，新增能力应先明确使用场景、权限边界和验收标准。

## 本地开发

安装 Node.js ≥22.16、Git、ripgrep，然后执行：

```text
npm ci --ignore-scripts
npm run check
npm test
npm run export:tools
npm run audit:repo
```

测试使用临时工作区和合成会话。不要让测试加载真实配置、读取个人 Codex 历史、调用付费模型或连接真实隧道。Windows 两项文件符号链接测试需要相应系统权限，详情见[测试说明](docs/testing.md)。

## 修改约定

- 将功能放入对应模块；CLI、MCP 注册层和底层实现保持一致。
- 文件修改必须保留设备校验、路径策略、哈希冲突检查、幂等语义和备份。新增执行功能说明其实际权限及副作用。
- 配置支持 JSON/TOML，不写死用户名、盘符、程序路径或凭据。增加字段时同步模板和兼容性说明。
- 对行为变更增加有意义的回归测试，特别是失败、重试和恢复路径。文档改动无需编写重复其内容的单元测试。
- 工具 schema 修改后构建并运行 `npm run export:tools`，提交新的 `docs/tools.json`。
- 版本变更同步 `package.json`、`package-lock.json` 和 `src/version.ts`；若变更组件资源地址，保留明确的历史兼容地址。
- 运行 `npm run audit:repo` 后人工检查 diff。检查脚本不能保证识别所有秘密。

## 提交问题和 PR

问题报告应包含版本、操作系统、复现步骤、预期/实际结果和经过脱敏的错误代码。使用临时项目和合成文件；不要上传真实配置、密钥、会话数据库或整段私有日志。

PR 说明应交代问题、修改后的行为、验证结果及尚未验证的平台。CI 配置了 Windows、Linux 和 macOS；本地通过不能替代远端结果。只修改与你的问题有关的内容。

目前自动原文件上传、浏览器自动化和 Actions/公网通道处于暂停状态。恢复此方向前请先提出独立设计，明确宿主支持与可复现的正文读取验收，不能用文件卡片代替功能成功。

## 安全与许可

漏洞按 [SECURITY.md](SECURITY.md) 私下报告。贡献应为你有权提供的内容；提交的项目代码使用 MIT，第三方代码保留原许可和来源。

English contributions are welcome. Include a reproducible case, relevant tests and the platforms you actually verified. Never attach credentials or private session data.
