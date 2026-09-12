# 源码更新与发布

源码发布目标为公开仓库 [xq3427/WebCodex](https://github.com/xq3427/WebCodex)，npm 包名为 `webcodex-mcp`。源码、GitHub Release 和 npm 是独立发布步骤，完成各自上传后再报告已发布。

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

根 `package.json` 保留 `private: true` 防止把开发目录误发到 npm。打包脚本在临时目录生成可发布清单，不复制开发依赖、构建脚本或本机配置。

## 构建安装包

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run export:tools
npm run check:tools
npm run test:repo
npm run audit:repo
npm run test:package
npm run test:installers
npm run package:release
```

产物写入 `release/`（已忽略），同名文件已存在时拒绝覆盖；可用 `npm run package:release -- --output release/<新目录>` 选择新输出目录。

- `webcodex-mcp-<版本>.tgz`：预构建 CLI、当前版本组件、文档和配置模板；生产依赖使用 `npm-shrinkwrap.json` 锁定。
- `WebCodex-<版本>-setup.zip`：tgz、Windows/POSIX 安装器和内部校验清单。
- `SHA256SUMS`：对外提供 tgz 与 ZIP 校验；另有 tgz 逐文件清单供审阅。

打包从当前 `src/**/*.ts` 映射对应编译 JS，仅收录当前 manifest 指向的组件，拒绝过期构建；归档生成后再次逐字节核对清单。不会打入整个 dist、node_modules、研究下载、测试夹具、源映射或运行状态。Node、Git、ripgrep 和官方 tunnel-client 在安装时从官方源获取，并保留其许可/校验记录；不是仓库里的本机二进制副本。

在独立目录解压 ZIP，运行安装器并检查 `doctor`。CI 在 Windows/Linux/macOS 执行核心、包内容、真实 tgz 离线安装及合成安装器测试；官方依赖首次联网下载和真实 ChatGPT 连接需要另行记录，不能用合成包替代。

## 发布 GitHub Release / npm

推送源码后等待该提交三平台 CI 通过，再创建版本 tag 与预览 Release，将同一次构建的 ZIP、tgz、SHA256SUMS 作为附件上传。修改 README 和快速开始中的版本下载链接时同时更新包版本与 `src/version.ts`，保留上一版组件 URI 兼容。

npm 登录只在本机完成：

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish ./release/webcodex-mcp-<版本>.tgz --access public --tag next --registry=https://registry.npmjs.org
```

预览版使用 `next` 标签。不要对根开发目录直接 `npm publish`，不要传账号密码或 token 到聊天，也不要关闭 npm 的账户验证。发布后使用 `npm view webcodex-mcp@<版本> version dist.integrity` 核对，再从注册表在独立目录安装验证。未登录或账户未完成发布授权时，GitHub 安装 ZIP/tgz 仍然可以独立交付。

## 推送后

- 等待 Windows、Ubuntu、macOS workflow 的实际结果，修复失败或明确收窄支持范围。
- 依据账户可用功能开启私密漏洞报告、依赖告警和密钥推送保护，并核对 SECURITY.md 中的报告入口。
- 在真实 ChatGPT 连接中完成当前版本文本操作、Codex 接续和已启用执行能力的验收。
- CI 与验收尚未完成时保留预览版标识。PDF 正文原型与自动原件回存分别记录宿主验收，不能用本地合成测试、工具列表或文件卡片替代真实正文或原字节保存结果。

发布 release 前核对实际分发组件的许可证与校验材料；本机密钥和运行数据不进入任何发布产物。
