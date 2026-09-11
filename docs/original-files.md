# 原文件能力与当前限制

**当前没有完成“通过纯 MCP 自动上传本地 PDF/Office 原文件，让 ChatGPT 像原生附件一样直接分析正文”的功能。** 此方向已暂停。

`0.15.0-preview.1` 新增不同的数据路径：`document_open/read` 自动将完整 PDF 传入组件，在浏览器运行 PDF.js，再以普通 MCP 工具回传分页文字层。它不等同于原生附件，也不支持图像、OCR 或 Office。使用与验收边界见 [PDF 正文原型](pdf-reading-prototype.md)。以下保留工具的限制不应套用于新正文工具。

## 保留的工具

| 工具 | 实际作用 | 不代表什么 |
| --- | --- | --- |
| `fs_read` / `fs_read_chunk` / `fs_read_many` | 返回授权范围内的文本内容 | 不能直接解析所有二进制格式 |
| `fs_read_file` | 传递完整原始字节；常见图片使用 MCP image 内容，其余依宿主处理 resource | 不保证 PDF/Office 自动进入模型附件上下文 |
| `fs_open_file` | 返回原文件元数据和组件票据，供显式组件诊断 | 初始响应没有文件正文 |
| `file_widget_probe` | 打开合成文件/组件能力探测 | 不证明真实文档分析成功 |
| `file_widget_read/release` | 组件私有的分块读取和释放 | 不应让模型循环调用来尝试拼接附件 |

这些路径不先做文本提取、OCR 或格式转换。`content_processing: none` 只说明服务端没有处理正文，不说明宿主已经支持文件格式。

## 大小与传输

`fs_read_file` 原字节 inline 上限默认 4 MiB、配置最大 7 MiB。此实现上限考虑 Base64 和协议消息体，与 ChatGPT 网页手工上传的上限是两回事。

组件路径的上传策略默认 100 MiB，但本机有效上限还受快照缓存预算等限制；默认总原字节缓存为 32 MiB，已有快照也占用预算。调大一个数值不能建立尚未验证的宿主附件支持。超限会失败，不截断伪装成完整原文件。

## 如何判定真正可读

哈希一致只能证明字节一致；组件出现、fileId、上传成功和文件引用 ACK 都不能证明模型获得正文。必须让 ChatGPT 根据实际文档回答提示中未提供的信息，核对内容才能验收。

ChatGPT 原生手工附件是另外一条宿主能力，可自行使用；它不算 WebCodex 自动上传目标已经完成。本项目当前不安装浏览器扩展、不控制浏览器，也不启动 Actions 或公网代理。

SVG、HTML、Markdown、XML 和代码本身是文本，可以直接用 `fs_write` 保存并读回，见[文件工作流](file-workflow.md)。从 `0.15.0-preview.5` 起，`fs_import_file` 可接收 ChatGPT 官方文件参数，保存 PPTX/PDF/PNG/ZIP 等完整原字节，再用 `fs_stat` 核对。它的方向是 **ChatGPT 文件 → 本机**，不改变本文的本机文档上传与模型正文读取边界。真实生成附件交接仍待宿主验收，详见[生成文件回存](file-writeback.md)。
