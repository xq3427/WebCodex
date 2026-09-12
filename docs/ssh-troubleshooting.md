# SSH：手工正常，通过 WebCodex 失败

Windows OpenSSH 在初始化日志前使用系统环境变量 `ProgramData`。旧版 WebCodex 的精简环境遗漏它，可能导致 `ssh -V`、实际连接都立即退出 255，stdout/stderr 均为空。这发生在连接前，与提高命令权限无关。

修复会在隧道启动器、面板托管 HTTP 服务和命令子进程三处保留 Windows 提供的 `ProgramData`；不从配置猜测目录，不写死 C 盘，也不继承 API key、代理或代码注入变量。用户无需新增配置项。若使用其他 MCP 客户端启动 WebCodex，该客户端也需把宿主的 `ProgramData` 传入服务。

更新源码并运行 `npm run build` 后，在现有作业结束时正常关闭原 `connect` 终端，再运行：

```text
node dist/src/cli.js connect
```

自定义配置需继续添加相同的 `--config`。本次应重启整个启动器，以便加载启动环境的修复；只刷新 ChatGPT 工具列表或由旧面板重启子服务不足以更新旧启动器代码。正常关闭服务会取消它仍管理的本机作业，因此先检查作业状态。

## 分步定位

1. 先用 `exec_start` 运行实际选定的 `ssh.exe` 和 `args: ["-V"]`。这不连接服务器；若已失败，先核对程序路径、版本及本机执行环境。
2. 用 `exec_wait` 等待作业终态并检查退出码。`wait_reason=timeout` 只是一次等待到期；`status=timed_out` 表示 WebCodex 到达程序运行时限。两者都不能单独证明 TCP 连接超时。
3. 使用 `exec_tail`，选择 `stream: "stderr"`，读取 SSH 实际错误。退出 255 是通用 SSH 错误，不能唯一定位网络或认证。`PROCESS_EXIT_WITHOUT_OUTPUT` 表示未捕获到程序输出，并非已经证实日志保存失败。
4. 本机版本探针成功后，使用实际主机、端口和密钥做只读连接：`-v -T -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1`，远端命令仅输出标记。保留已配置的主机密钥校验；不要通过关闭防火墙、禁用主机校验或放开更多权限处理未知原因。
5. 从 SSH 日志分别确认连接建立、认证和远端标记。验证成功只说明当前连接可用；训练是否仍在运行，需要另外读取实时进程和实验状态。不要自动重放训练启动、删除或其他有副作用的远程命令。

诊断日志可能包含主机、账户及本机路径。公开 issue 只附程序版本、退出码、必要错误行和阶段；不上传密钥、完整环境、访问凭据或实验正文。
