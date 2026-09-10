# 第三方组件

WebCodex 自身使用 MIT。以下为当前锁定的直接依赖；安装包内的许可文本是第三方许可依据。

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | MCP 协议与传输 |
| diff | 8.0.4 | BSD-3-Clause | 文本差异与补丁 |
| smol-toml | 1.8.0 | BSD-3-Clause | TOML 解析 |
| zod | 3.25.76 | MIT | schema 校验 |
| @types/node | 22.20.1 | MIT | 开发期类型 |
| typescript | 5.9.3 | Apache-2.0 | 构建 |

间接依赖及精确版本见 [package-lock.json](package-lock.json)。发布二进制或捆绑依赖时，应另外收集全部实际分发组件的许可证，不能只附本表。

Node.js、Git 和 ripgrep 是用户安装的运行工具；源码仓库不捆绑其二进制。OpenAI [tunnel-client](https://github.com/openai/tunnel-client) 单独下载，适用该项目及其 release 中的许可、SPDX/第三方报告；Windows 安装脚本保留下载的相关材料。许可证不代表对 OpenAI 商标、服务或 API 的授权。

仓库中的 PDF 测试样本为项目合成验收文件，不是用户论文。研究下载、真实会话、网页截图和实验归档不属于公开源码。
