# 文档目录

[中文 README](../README.md) · [English README](../README.en.md) · [项目目录](../README.md#项目目录) · [贡献指南](../CONTRIBUTING.md)

当前版本为 **0.16.0-preview.8**。首次使用推荐安装 ZIP 或 `setup`，通过页面配置并连接后，在测试工作区验收。精确工具定义与版本信息以[工具 schema](tools.json)和[当前验收入口](current-acceptance.md)为准。

## 安装、配置与接入

| 文档 | 何时阅读 |
| --- | --- |
| [快速开始](quickstart.md) | Windows 双击安装、Linux/macOS 安装、tgz/npm、账户配置和更新 |
| [统一配置](local-configuration.md) | 选择 JSON/TOML；配置设备、目录、Codex home、执行权限和限额 |
| [本地控制中心](local-panel.md) | 在本机页面管理配置、工作区、权限及面板管理服务的启停 |
| [接入 ChatGPT](chatgpt-setup.md) | 配置官方隧道、启动连接、核实身份，处理升级和接入故障 |

## 日常工作流

| 文档 | 内容 |
| --- | --- |
| [文件工作流](file-workflow.md) | 文本读写、`fs_copy` 本机跨工作区复制、批量操作、哈希冲突和恢复 |
| [自动原件回存](file-writeback.md) | `fs_save_file` / `fs_save_file_status` 使用真实文件 ID 或官方对象，验证原件大小/哈希后保存；旧导入和小载荷 Base64 仅保留兼容 |
| [Codex 应急接续](codex-emergency.md) | 查找、搜索和分页续读本地可见会话，结合当前项目生成交接上下文 |
| [任务与执行](task-workflow.md) | 任务修订、检查点、作业输出、等待、stdin 和导出 |

自动原件回存的本机与合成组件测试通过，不等于真实 ChatGPT 已授权并交付生成文件。当前文件 ID 可见、helper 存在、组件出现或 pending 状态都不是保存成功；真实全链路仍待验收。只依据 `saved`、`verified=true` 和匹配原件大小/哈希的 `fs_stat` 报告完成。

## 文档读取原型与能力边界

| 文档 | 内容 |
| --- | --- |
| [原文件能力边界](original-files.md) | 区分原字节传输、组件行为、原生附件和正文访问 |
| [PDF 正文原型](pdf-reading-prototype.md) | 原文件校验、浏览器 PDF.js 文字层和 MCP 分页正文；字体/CMap 修复仍待真实 PDF 复验 |
| [内容回传原型](reading-relay-prototype.md) | 组件向普通工具回传合成正文的验收；该结果不证明 PDF 解析成功 |
| [现有读取方案调研](file-reading-alternatives.md) | 公开 MCP 项目的实现与可借鉴机制 |

当前没有已验收的自动原生附件导入，也不支持扫描件 OCR 或图像理解。读取原型与原件回存是不同方向，不能互相替代成功证据。

## 实现、诊断与维护

| 文档 | 内容 |
| --- | --- |
| [架构](architecture.md) | 模块、数据流和权限边界 |
| [功能状态](implementation-status.md) | 当前可用、受限、实验及暂停能力 |
| [协议诊断](protocol-diagnostics.md) | 有界诊断记录、工具是否到达服务端以及结果判读 |
| [SSH 故障定位](ssh-troubleshooting.md) | 手工正常但 MCP 失败、Windows 启动环境、stderr 和超时的正确判读 |
| [测试](testing.md) | 必要命令、合成数据、实际证据和平台差异 |
| [路线](roadmap.md) | 后续优先级与未完成验收 |
| [发布指南](releasing.md) | GitHub 授权、公开内容检查和发布后验收 |
| [2026-09-11 项目审查](project-review-20260911.md) | 按日期保留的审查快照；不代替当前功能状态与生成的版本信息 |

## 生成文档与历史记录

- [tools.json](tools.json)：精确 MCP 输入、输出和工具元数据。
- [current-acceptance.md](current-acceptance.md)：当前版本、工具数量和最小验收指令。

这两份文件由构建后的 `npm run export:tools` 同步生成，不手工修改；用 `npm run check:tools` 检查一致性。带版本或日期的测试、调研和审查记录保留当时证据，新增验证应记录新的版本、环境与结果，不把历史未验收状态改写为当前成功。

[更新记录](../CHANGELOG.md) · [贡献指南](../CONTRIBUTING.md) · [安全说明](../SECURITY.md) · [第三方依赖](../THIRD_PARTY_NOTICES.md) · [许可证](../LICENSE)
