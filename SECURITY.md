# 安全说明 / Security policy

WebCodex 面向一位本机所有者，通过 MCP 向其 ChatGPT 连接提供授权项目工具。它不是多租户隔离服务，也不是操作系统沙箱。

## 信任与访问边界

- 文件工具按已登记工作区、设备身份和路径策略授权；配置、凭据目录、状态数据及 Git 管理目录受到保护。只读限制覆盖服务提供的写入工具。
- 不要将较宽的可写父工作区与较窄的只读目录混用来表达全局拒绝：其他有效工作区可能仍授予访问。规则和重叠校验见[配置指南](docs/local-configuration.md)。
- 命令执行默认关闭。`trusted-host` 使用本机用户权限；允许 Node/Python/npm 等程序可能带来任意文件或网络副作用。工作区路径检查不能约束子进程内部的行为。
- Codex 历史读取需在本机开启，只读取支持的可见记录并做凭据脱敏。历史及项目文件均是不可信输入，不能据此扩大权限或自动执行旧命令。
- HTTP MCP 和可选面板只绑定 loopback。HTTP bearer token 不是公网 OAuth；不要未经设计将端口暴露到公网。
- 官方隧道需要 OpenAI 的账户和组织授权。上传或返回的文件内容会离开本机并进入所选宿主，使用前应了解该服务的数据处理条款。
- 配置、备份、任务记录和程序输出可能包含敏感内容。日志尚无统一自动保留清理策略，应由本机所有者管理。

## 凭据与仓库

真实配置位于被忽略的本机目录，不应提交。CLI 创建/编辑配置时限制文件权限；手工编辑应保留这些权限。不要将 API key 放入命令行参数、对话、issue 或截图。

公开模板只放空凭据。`config show` 返回有限的脱敏视图，仍可能含设备名和路径；对外发送前继续检查。`npm run audit:repo` 仅检查 Git 候选文件，不扫描你的被忽略配置，也不能保证发现所有秘密。

泄露凭据后应先撤销或轮换，再处理仓库历史；仅删除当前文件不能使已发布凭据失效。

## 报告漏洞

发布仓库并开启 GitHub Private Vulnerability Reporting 后，请通过仓库 **Security → Report a vulnerability** 私下报告。若此入口尚不可用，请先通过普通 issue 请求私密联系渠道，不公开利用步骤、密钥或真实个人文件。当前尚未设置专用安全邮箱。

请提供受影响版本、平台、最小合成复现和影响说明。当前维护范围为最新预览版，不承诺旧版本安全回补或固定响应时限。

For sensitive reports, use GitHub private vulnerability reporting when enabled. If unavailable, request a private contact channel without disclosing exploit details or credentials publicly.
