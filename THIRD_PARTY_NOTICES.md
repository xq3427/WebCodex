# 第三方组件

WebCodex 自身使用 MIT。以下为 `0.16.0-preview.7` 锁定的直接依赖；安装包内的完整许可文本是第三方许可依据。依赖的许可证不会因被本项目调用或打包而改为 MIT。

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | MCP 协议与传输 |
| diff | 8.0.4 | BSD-3-Clause | 文本差异与补丁 |
| pdfjs-dist | 6.3.289 | Apache-2.0；字体等另有许可 | 浏览器 PDF 文字层解析 |
| smol-toml | 1.8.0 | BSD-3-Clause | TOML 解析 |
| zod | 3.25.76 | MIT | schema 校验 |
| @types/node | 22.20.1 | MIT | 开发期类型 |
| typescript | 5.9.3 | Apache-2.0 | 构建 |
| esbuild | 0.28.2 | MIT | 捆绑浏览器组件与 PDF.js |

间接依赖及精确版本见 [package-lock.json](package-lock.json)。源码安装使用 `npm ci` 获取锁定包；发布二进制或捆绑依赖时，应保留全部实际分发组件的版权、许可证和适用声明，不能只附本表。PDF.js 构建声明也不能代替 Node.js 运行依赖各自的许可证。

## 已核对的运行依赖许可

以下路径在执行 `npm ci` 后可用，均相对于项目目录：

| 组件或资产 | 完整许可文本 | 说明 |
| --- | --- | --- |
| diff | `node_modules/diff/LICENSE` | BSD-3-Clause，版权方 Kevin Decker；源码或二进制再分发均须保留相应版权、条件和免责声明 |
| smol-toml | `node_modules/smol-toml/LICENSE` | BSD-3-Clause，版权方 Squirrel Chat et al.；同样保留完整许可及声明 |
| PDF.js 主程序 | `node_modules/pdfjs-dist/LICENSE` | Apache-2.0；适用声明随构建产物保留 |
| PDF.js CMap 数据 | `node_modules/pdfjs-dist/cmaps/LICENSE` | Adobe 的三条款 BSD 形式许可，独立于主程序许可 |
| FOXIT 标准字体 | `node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT` | PDFium Authors 的三条款 BSD 形式许可 |
| Liberation 字体 | `node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION` | 包含 GPL-2.0、字体嵌入例外及附加条款；应保留全文，不能只标注 Apache-2.0 |

当前浏览器 PDF 组件内置 PDF.js、168 项 CMap 和 14 项标准字体，不在运行时从 CDN 获取。构建脚本将安装包主目录及 `cmaps`、`standard_fonts`、`wasm` 目录中的许可/声明文本汇总到 `dist/src/assets/PDFJS-NOTICES.txt`，并保留捆绑 JavaScript 中的法律注释。分发构建产物时应一并保留该文件；它没有汇总 `diff`、`smol-toml` 等其他运行依赖。

当前构建不内置 WASM 或 ICC 资产；许可证汇总保留 WASM 目录声明，不代表相关功能已启用。若后续修改构建范围或分发整个 `pdfjs-dist` 安装包，应重新核对实际资产，包括 `iccs/LICENSE` 等未被当前汇总脚本收集的文本，以及适用的源代码提供义务。

Node.js、Git 和 ripgrep 是用户安装的运行工具；源码仓库不捆绑其二进制。OpenAI [tunnel-client](https://github.com/openai/tunnel-client) 单独下载，适用该项目及其 release 中的许可、SPDX/第三方报告；Windows 安装脚本保留下载的相关材料。许可证不代表对 OpenAI 商标、服务或 API 的授权。

仓库中的 PDF 测试样本为项目合成验收文件，不是用户论文。研究下载、真实会话、网页截图和实验归档不属于公开源码。
