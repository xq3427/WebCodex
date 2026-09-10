# 首次发布清单

源码发布目标为公开仓库 [xq3427/WebCodex](https://github.com/xq3427/WebCodex)。以下清单适用于后续源码更新和 release；当前没有 npm 发布。

## 发布前

1. 运行类型检查、核心回归、仓库检查专项和 `npm run audit:repo`。
2. 构建后用 `npm run export:tools -- --check` 核对工具文档与源码一致。
3. 检查 README、版本、MIT 许可和第三方依赖许可；在 `docs/testing.md` 保留真实平台结果及跳过项。
4. 人工检查待提交内容，排除 `.webcodex`、配置/密钥、会话、备份、日志、截图、研究下载和实验归档。

仓库检查会包括已跟踪和未被忽略的候选文件，也会拒绝被强行跟踪的私有配置。它不能保证识别所有秘密；若曾泄露，应先撤销凭据，再处理历史。

## GitHub 授权与上传

使用正常浏览器登录，或在本机运行 `gh auth login --web` 完成 GitHub CLI 授权。**不要把 GitHub 密码、PAT 或设备授权码发送到对话、仓库或 issue。** GitHub 的 HTTPS Git 操作也不支持直接使用账号密码。

确认目标仓库后，再添加真实 remote、检查提交并推送；不要在 README 中预填不存在的仓库地址或通过徽章宣称 CI 已成功。创建仓库后可补充仓库 URL、项目描述和 topics。

GitHub 开源与 npm 发布是两件事。当前 `package.json` 的 `private: true` 是防止误发 npm，保留它不影响 GitHub 上公开 MIT 源码。

## 推送后

- 等待 Windows、Ubuntu、macOS workflow 的实际结果，修复失败或明确收窄支持范围。
- 依据账户可用功能开启私密漏洞报告、依赖告警和密钥推送保护，并核对 SECURITY.md 中的报告入口。
- 在真实 ChatGPT 连接中完成当前版本文本操作、Codex 接续和已启用执行能力的验收。
- CI 与验收尚未完成时保留预览版标识，不把暂停的原文件上传标成可用功能。

发布 release 或捆绑二进制前，额外核对实际分发组件的完整许可证与校验材料。本次整理的目标是源码，不捆绑 Node、官方隧道客户端或本机运行数据。
