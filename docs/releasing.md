# 源码更新与发布

源码发布目标为公开仓库 [xq3427/WebCodex](https://github.com/xq3427/WebCodex)。以下清单适用于后续源码更新和 release；当前没有 npm 发布。

## 发布前

1. 运行类型检查、核心回归、仓库检查专项和 `npm run audit:repo`。
2. 构建后用 `npm run check:tools` 核对工具文档与源码一致。
3. 检查 README、版本、MIT 许可和第三方依赖许可；在 `docs/testing.md` 保留真实平台结果及跳过项。
4. 人工检查待提交内容，排除 `.webcodex`、配置/密钥、会话、备份、日志、截图、研究下载和实验归档。

仓库检查会包括已跟踪和未被忽略的候选文件，也会拒绝被强行跟踪的私有配置。它不能保证识别所有秘密；若曾泄露，应先撤销凭据，再处理历史。

## GitHub 授权与上传

使用正常浏览器登录，或在本机运行 `gh auth login --web` 完成 GitHub CLI 授权。**不要把 GitHub 密码、PAT 或设备授权码发送到对话、仓库或 issue。** GitHub 的 HTTPS Git 操作也不支持直接使用账号密码。

本项目已有 `origin` 指向上述仓库。更新前先确认 remote 并拉取远端引用，检查本地与远端提交关系；不强推、不覆盖远端已有工作。Git Credential Manager、已有 SSH 身份或 GitHub CLI 可用于正常 Git 认证，不需要把凭据写进 remote URL。

提交前检查 `git diff --cached --stat` 和完整暂存差异，确认提交包含构建需要的全部源码、脚本、锁文件和合成测试。可以使用 `.git/info/exclude` 排除仅本机存在的私人验收文件；该文件不进入提交，原文件也不必删除。发布分支应是通过检查的同一份源码。

建议从待发布源码创建不含旧 `node_modules`、`dist`、配置和 state 的干净副本，按 README 重新安装、构建和初始化，确认公开源码本身可用。离线缓存安装只证明已有依赖可重建，不能替代其他设备首次联网下载和跨平台 CI。

GitHub 开源与 npm 发布是两件事。当前 `package.json` 的 `private: true` 是防止误发 npm，保留它不影响 GitHub 上公开 MIT 源码。

## 推送后

- 等待 Windows、Ubuntu、macOS workflow 的实际结果，修复失败或明确收窄支持范围。
- 依据账户可用功能开启私密漏洞报告、依赖告警和密钥推送保护，并核对 SECURITY.md 中的报告入口。
- 在真实 ChatGPT 连接中完成当前版本文本操作、Codex 接续和已启用执行能力的验收。
- CI 与验收尚未完成时保留预览版标识。PDF 正文原型与自动原件回存分别记录宿主验收，不能用本地合成测试、工具列表或文件卡片替代真实正文或原字节保存结果。

发布 release 或捆绑二进制前，额外核对实际分发组件的完整许可证与校验材料。本次整理的目标是源码，不捆绑 Node、官方隧道客户端或本机运行数据。
