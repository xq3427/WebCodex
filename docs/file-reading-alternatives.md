# 现有 MCP 文件读取方案与 WebCodex 改进建议

调研日期：2026-09-11。范围：公开源码、公开 issue 和官方文档；没有安装或运行第三方项目，没有在真实 ChatGPT 中做新的正文问答验收，没有改动 WebCodex 服务实现。

## 结论

**MCP 能传原文件字节，问题在于宿主怎样把这些字节交给模型。** 不能把“原文件传输成功”理解成“ChatGPT 已注册并解析原生附件”。

本次找到的最值得验证的新方向，是 MCP Apps 官方 PDF 示例中的 **组件解析 → 普通 MCP 工具返回正文/页图像**。它绕开了“给模型一个 fileId，让宿主自动把它当 PDF 附件”的未证实环节。

这仍不是 ChatGPT 原生附件。尚未找到一个有充分源码与正文验收证据、同时满足以下条件的现成项目：已知本地路径、纯 MCP、原文件自动导入、不转换为正文/图片、不装扩展、不增加公网服务、无需文件选择或上传按钮。这个有限调查不能证明协议永远不可能支持它。

## 现有项目实际怎样做

| 项目 | 实际机制 | 对当前目标的意义 |
| --- | --- | --- |
| [官方 filesystem server][filesystem-code] | 图片/音频用对应 MCP content；其他原文件使用 resource.blob | 证明可以传完整原字节，不证明 ChatGPT 自动解析 PDF |
| [Desktop Commander][dc-code] | PDF 本地转 Markdown并提取图片，返回 text/image；Office 使用不同适配器 | “模型能读文件”的主要来源是格式解析，不是原生附件 |
| [Microsoft MarkItDown MCP][markitdown-code] | convert_to_markdown 调用转换库，返回 Markdown 正文 | 可借鉴统一多格式适配，减少自行编写解析器 |
| [Citra / pdf-reader-mcp][citra-code] | Rust 提取正文、表格；渲染页面为 PNG；可选本地 OCR | 可借鉴扫描页、图表、公式的视觉证据及分页预算 |
| [MCP Apps 官方 PDF 示例][pdf-interact] | 原 PDF 字节范围进入组件；浏览器 PDF.js 解析，interact 工具回传 text/image | 最接近“原字节先传到网页，再让 GPT 获取内容”的参考实现 |
| [upload-mcp][upload-code] | 手工选图片，uploadFile 后设置 modelContent/privateContent/imageIds | 有图片成功社区报告，但不是自动本地 PDF 导入方案 |

### 1. 官方 filesystem：原字节传输已经存在

当前核查提交 `d73f99efbfd40c3aa1b61e88728b3d49fb52608f` 的 `read_media_file` 可以返回：

```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///example/document.pdf",
    "mimeType": "application/octet-stream",
    "blob": "BASE64_OF_ORIGINAL_BYTES"
  }
}
```

其 PDF/Office 落入通用 MIME 分支；没有 PDF 解析器或 ChatGPT 附件注册逻辑。这个实现会在内存收集全文件，还在 content/structuredContent 中重复资源，不能直接照搬为大文件方案。[源码][filesystem-code]

WebCodex 当前对 PDF 已返回 `application/pdf` 的 embedded resource，所以“换成标准 resource.blob”并不是尚未实现的新修复。大小限制、文件 MIME 和正文可见性是三个不同问题。

### 2. Desktop Commander：主要是本地内容提取

核查提交 `a781f5a4b8cfebac6638bc6fcbd38fca6326be53`：

- PDF 转 Markdown，提取嵌入图片并压缩为 WebP，再分别返回 MCP text/image。提取图片不等于把整页排版完整渲染出来。
- DOCX 解包读取正文结构/XML；表格文件通过 ExcelJS 提取单元格数据。
- 其 ChatGPT Remote MCP 方案还有自有云中继；不能把整个方案视作无第三方服务。我们可以借鉴解析方式，连接仍使用 WebCodex 现有官方隧道。[处理结果源码][dc-code]、[PDF转换源码][dc-pdf]

应核实每种格式的真实读取函数。例如后缀选择器提到旧 .xls，并不证明底层 XLSX reader 能正确处理旧二进制工作簿。

### 3. MarkItDown：多格式统一适配

核查提交 `9480644d9c3b7397b9bf0156f858fa3a5aad7d2c`。官方 MCP 工具的核心是：

```python
return converter.convert_uri(uri).markdown
```

本地 file URI 转为本地读取；默认 PDF/Office 转换不要求云模型 API。PDF、DOCX、XLSX、旧 XLS 和 PPTX 各有解析依赖；Python ≥3.10。官方 MCP 包安装 all extras，依赖较多，可选 Azure/LLM 功能与默认本地转换应分开理解。[MCP入口][markitdown-code]、[本地URI处理][markitdown-local]

若以后采用它，宜以固定本地 worker 调用必要格式 extras，复用 WebCodex 的工作区授权与限制，而不是直接开放任意 URI。它依然是“提取正文”路线。

### 4. Citra：文字不足时提供页图像

核查提交 `ad84b95fa860f7be77cec3d9d0a8fdef07eddfa0`。该仓库原名 PDF Reader MCP，目前品牌为 Citra，生产入口启动 Rust 程序。它能够返回提取文字和标准 MCP PNG 图像；视觉路径有源文件、页数、像素等工作预算，OCR还需要另配本地工具。[结果构造][citra-code]

这种设计比仅提取纯文本更适合扫描页和复杂图表，但不是把未处理原文件注册成 ChatGPT 附件。

### 5. upload-mcp：图片正例不能扩大成 PDF 正例

核查提交 `ff012afb68b47e7c2c6704ef856605ae253f2e09`：

```text
用户在组件中选图片
→ uploadFile
→ setWidgetState({modelContent, privateContent, imageIds})
→ 用户继续提问
```

当前工具不接收本地文件路径，没有自动带入本地文件，也没有自动发 follow-up 的实现。作者与另一用户在公开 issue 中报告图片成功，另一个 PDF 尝试则失败。[图片成功报告][image-success]、[PDF失败报告][pdf-failure]

OpenAI 官方文档的 `imageIds` 说明也明确针对图片，不能把 PDF ID 填进去后宣称具有同样语义。[官方图片状态][openai-images]

该项目的另一个适配器还存在“图像上下文被拒绝，回退成文字后仍显示图像已加入”的状态问题，因此其 UI 成功提示不能作为我们的验收标准。

## 新候选：借鉴官方 PDF viewer 的内容回传

核查提交 `6d9bdc7babf275b759225aa722cbf5510c4c6021`。区别不在于多显示一个 PDF 组件，而在于它有**模型可调用的读取工具**：

```text
display_pdf → 组件自动加载
interact(get_text 或 get_screenshot)
    → 服务向该组件排入读取请求
    → 组件通过 MCP poll_pdf_commands 接收
    → PDF.js 提取文字或渲染页截图
    → MCP submit_page_data 回传
    → 原来的 interact 调用返回实际 text/image
```

证据：[模型工具等待并返回内容][pdf-interact]、[组件解析和提交][pdf-submit]、[自动加载及开始轮询][pdf-auto]。

这条路径无需让 `resource_link` 或 `fileId` 自动成为 ChatGPT 附件，也不要求用户点击“发送给 GPT”。不过模型仍需调用读取工具，且组件必须正常运行。

### 不能忽略的前提

1. **原示例按范围读取原字节，不是先完整上传。** 使用 PDFDataRangeTransport，并关闭自动全量抓取。WebCodex 若坚持先传完整原文件，应沿用现有全文件重建和 SHA-256 校验，再交给浏览器 PDF.js。[范围读取源码][pdf-range]
2. **它仍有解析。** 主要正文/截图处理发生在浏览器组件，而不是原生 ChatGPT 附件解析系统。浏览器本身也运行在用户设备上；不能用“云端解析”描述它。
3. **组件和工具需交错工作。** 模型的 interact 等待时，宿主必须允许组件继续 poll/submit；全连接串行执行会阻塞自己。示例已专门处理“提交结果先于下一次长轮询”的问题。[并发处理][pdf-poll]
4. **生命周期有条件。** 组件未挂载、暂停或销毁后无法回传；示例还依赖单进程内存队列及超时。不能直接承诺所有 ChatGPT 会话都兼容。
5. **原示例有额外依赖。** 浏览器标准字体从 unpkg 获取，服务端也会探查 PDF 元数据/表单。若要保持原文件先传、无额外运行时第三方请求，需把字体/worker/必要资源打包，并去掉最小只读原型不需要的服务端解析。[字体设置][pdf-fonts]
6. **仅核实了源码机制，未在你的 ChatGPT 中运行。** MCP 原生图像是否进入该连接的模型上下文，也要通过正文/图像问答单独验证。

技术判断：其命令、文件数据和结果都可以用 MCP 工具传递，因此值得验证复用现有 Secure MCP Tunnel；不需要为这条机制另加 Actions、Cloudflare、浏览器扩展或付费模型 API。这个判断不是实际兼容性已经通过的结论。

## WebCodex 当前缺了哪一环

以公开提交 `22083f0e0652fc98dc26ca2fe424996b1adb4cd0` 为基线：

- [file-transfer.ts][webcodex-transfer] 对 PDF/Office 返回原字节 resource，对常见图片返回 image。
- [file-widget-probe.ts][webcodex-widget] 的初始模型结果是元数据；分块原字节仅供组件。
- [file-widget.ts][webcodex-send] 的 uploadFile + resource_link 尝试主要是在交接一个文件标识，没有像官方 PDF 示例那样将实际页正文作为普通工具结果返回。

因此本地传输测试通过、哈希正确、组件显示都不等于文档分析功能完成。继续重复上传或只修改成功提示没有解决模型正文输入缺失。

## 推荐的最小验证顺序

实施补记：后续 preview.3 已在真实 ChatGPT 中发现公开 read 阻塞期间组件 poll 不到达，详见[真实时序与修正](reading-relay-prototype.md#preview3-的真实失败与-preview4-修正)。preview.4 因而改为提前准备任务、非阻塞状态读取，仍在同一纯 MCP 路径验证；不能把下文最初的并发设想当作已获宿主支持。

**先验证 PDF 的新回传机制；通过前不扩成新版本的大功能，也不更换整套 MCP 服务。**

### 第一关：先测工具回传，不带 PDF

用只含合成数据的最小组件，验证模型工具发请求、组件收到并回传、模型工具返回实际正文。必须在真实 ChatGPT + 现有官方隧道下确认：

- 无文件选择器、无上传/发送按钮，组件能自动启动；
- 模型工具等待期间组件可调用私有工具，不发生串行阻塞；
- 模型能回答只存在于回传内容中的测试信息；
- 关闭组件、超时、重复请求均明确失败或安全恢复，不能伪报成功。

### 第二关：复用完整原文件传输，再加浏览器 PDF.js

保持源文件字节不变，分块传输只是运输方式；全量重建/hash通过后，组件解析原 PDF。模型侧只增加清晰的文档读取能力，例如 `document_open`、`document_read`，不让用户选择“原文件/文本/图片”模式。

文字页返回正文、页码和覆盖范围；扫描页、公式和图表按需返回标准 image。所有库、worker、字体随服务构建分发，不依赖运行时 CDN。源文件预算、单次文本预算、图片像素/字节预算分开设置；大文件不能一次无限塞入上下文。

先验证文字 PDF、扫描 PDF、含表格/公式/图表 PDF，问题答案不预先放在提示中。再验证超过7 MiB、中文路径、多工作区和源文件变化；测试成功以答案及页码正确为准。

### 第三关：根据结果决定是否继续

- 若正文及图像回传均通过：再扩展分页、缓存、取消、组件恢复和支持范围。可以减少手动操作，但组件仍需存在，完全隐藏/关闭由宿主控制。
- 若 ChatGPT 阻止该交错调用或组件不能稳定运行：停止这条路线，记录实际失败点，不靠无限重试或文字“成功”掩盖。
- 若用户接受改变“不做本地内容处理”的约束：可另选 MarkItDown/Desktop Commander/Citra 的服务端格式适配方式，用普通 MCP text/image 直接返回内容。该方式可避免组件生命周期依赖，但不能冒充原文件附件。
- Office格式需独立选型和验收。官方 PDF 示例不能作为 DOCX/XLSX/PPTX 全部支持的证明。

## 官方接口的其他边界

- [OpenAI MCP fetch 文档][openai-fetch] 的资料检索方案返回全文 text，不是原生附件。
- [Apps File APIs][openai-file-api] 中 `openai/fileParams` 是 ChatGPT 将文件传给工具的输入定义，不能反向理解成任意本地文件自动成为附件。
- [GPT Actions][openai-actions] 的 `openaiFileResponse` 明确有对话文件语义，但属于另一条接口与部署路线；把同名字段写进 MCP 不会自动得到相同支持。
- [Responses input_file][openai-input-file] 支持 API 文件输入，但需要独立模型 API 调用，不能当成把文件加入当前 ChatGPT 网页对话。

本次没有恢复任何已暂停的运行服务，也没有提交或推送本报告。下一步建议是一个真实宿主中的小型只读验证，而不是再次宣称原文件上传功能已经实现。

[filesystem-code]: https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/index.ts#L249-L315
[dc-code]: https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/a781f5a4b8cfebac6638bc6fcbd38fca6326be53/src/handlers/filesystem-handlers.ts#L116-L150
[dc-pdf]: https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/a781f5a4b8cfebac6638bc6fcbd38fca6326be53/src/tools/pdf/lib/pdf2md.ts#L70-L102
[markitdown-code]: https://github.com/microsoft/markitdown/blob/9480644d9c3b7397b9bf0156f858fa3a5aad7d2c/packages/markitdown-mcp/src/markitdown_mcp/__main__.py#L19-L24
[markitdown-local]: https://github.com/microsoft/markitdown/blob/9480644d9c3b7397b9bf0156f858fa3a5aad7d2c/packages/markitdown/src/markitdown/_markitdown.py#L458-L470
[citra-code]: https://github.com/SylphxAI/pdf-reader-mcp/blob/ad84b95fa860f7be77cec3d9d0a8fdef07eddfa0/crates/pdf-reader-mcp-server/src/read_pdf.rs#L325-L366
[pdf-interact]: https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server/server.ts#L2159-L2248
[pdf-submit]: https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server/src/mcp-app.ts#L2583-L2673
[pdf-auto]: https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server/src/mcp-app.ts#L4674-L4782
[pdf-range]: https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server/src/mcp-app.ts#L4525-L4577
[pdf-poll]: https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server/src/mcp-app.ts#L4936-L4953
[pdf-fonts]: https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server/src/mcp-app.ts#L83-L91
[upload-code]: https://github.com/mikechao/upload-mcp/blob/ff012afb68b47e7c2c6704ef856605ae253f2e09/src/web/file-upload-chatgpt.tsx#L24-L63
[image-success]: https://github.com/openai/openai-apps-sdk-examples/issues/148#issuecomment-4023196764
[pdf-failure]: https://github.com/openai/openai-apps-sdk-examples/issues/148#issuecomment-4033065912
[openai-images]: https://developers.openai.com/plugins/build/chatgpt-ui#make-images-visible-to-the-model
[openai-file-api]: https://developers.openai.com/plugins/reference#file-apis
[openai-fetch]: https://developers.openai.com/api/docs/mcp#fetch-tool
[openai-actions]: https://developers.openai.com/api/docs/actions/sending-files#returning-files
[openai-input-file]: https://developers.openai.com/api/docs/guides/file-inputs
[webcodex-transfer]: https://github.com/xq3427/WebCodex/blob/22083f0e0652fc98dc26ca2fe424996b1adb4cd0/src/file-transfer.ts#L128-L142
[webcodex-widget]: https://github.com/xq3427/WebCodex/blob/22083f0e0652fc98dc26ca2fe424996b1adb4cd0/src/file-widget-probe.ts#L118-L179
[webcodex-send]: https://github.com/xq3427/WebCodex/blob/22083f0e0652fc98dc26ca2fe424996b1adb4cd0/src/file-widget.ts#L886-L958
