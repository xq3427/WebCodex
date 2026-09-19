# 快速开始：安装并连接 ChatGPT

推荐下载 [0.16.0-preview.16 安装包](https://github.com/xq3427/WebCodex/releases/download/v0.16.0-preview.16/WebCodex-0.16.0-preview.16-setup.zip)。它包含已构建的 WebCodex，无需克隆仓库或编译。首次安装需要联网访问 GitHub、npm registry；缺少 Node 时还会访问 nodejs.org。安装器不要求 npm 登录。

## 1. 安装

### Windows

1. 下载 ZIP，**完整解压**到一个普通目录。
2. 双击 `install.cmd`，等待完成。不要只在 ZIP 预览窗口中运行单个脚本。
3. 浏览器会打开本机管理页面。终端也会给出可点击的完整链接；保持终端运行。

默认安装到 `%LOCALAPPDATA%\WebCodex`。缺少 Node.js 时自动安装便携版 Node 22.23.2；优先复用现有 Node ≥22.16 与 npm。Git、ripgrep 和 OpenAI 官方 tunnel-client 由 `setup` 检测或安装。Windows 缺少 Git 时使用官方 MinGit。无需管理员权限，不改系统 PATH、不安装系统服务。

自定义位置或工作区，在解压目录运行：

```powershell
.\install.cmd -InstallDir "D:\Apps\WebCodex" -Workspace "D:\Projects\MyProject"
```

需要沿用其他位置的配置时，加 `-Config "D:\Private\config.json"`。安装目录中只有 `config.json` 时自动复用；同时存在 JSON/TOML 时须用 `-Config` 明确选择。POSIX 对应参数为 `--config`。

仅部署、不打开页面：

```powershell
.\install.cmd -NoPanel
```

安装完成后，双击安装目录内的 `start-webcodex.cmd` 可再次打开管理页面。它会复用已有配置。

### Linux / macOS

支持 x64 和 arm64。先准备 **Git、curl、tar、unzip 以及 sha256sum 或 shasum**。Linux 需要支持官方 Node 二进制的 glibc 环境；不承诺 Alpine/musl 的便携 Node 安装。macOS 可使用已有 Git 或先安装 Xcode Command Line Tools。安装器不运行 sudo。

```sh
curl -fL -o WebCodex-setup.zip https://github.com/xq3427/WebCodex/releases/download/v0.16.0-preview.16/WebCodex-0.16.0-preview.16-setup.zip
unzip WebCodex-setup.zip -d WebCodex-setup
cd WebCodex-setup
sh install.sh
```

默认安装目录为 `${XDG_DATA_HOME:-$HOME/.local/share}/webcodex`，配置为其下 `config.toml`，默认工作区为 `workspace`。也可指定：

```sh
sh install.sh --install-dir "$HOME/Applications/WebCodex" --workspace "$HOME/Projects/MyProject"
```

以后运行安装目录里的 `webcodex` 打开页面。无桌面的设备可用 `--no-panel` 仅完成部署；面板只绑定回环地址，不对公网开放。

## 2. 在页面配置

本地部署完成后，只需在页面完成账户与目录设置：

如果希望直接在命令行完成首次 Tunnel 配置，也可以运行：

```sh
webcodex init --workspace ./workspace
```

命令会显示官方 Tunnel 页面链接。请自行在浏览器打开链接，创建或选择 Tunnel 后回到终端粘贴 Tunnel ID；随后 CLI 会显示 API keys 页面链接，请自行打开、创建 API key，再回到终端粘贴 API key。CLI 不读取网页内容，也不会自动启动浏览器。输入时 key 不回显，保存后运行：

```sh
webcodex connect
```

无桌面或自动化环境可使用 `init --no-tunnel`，稍后在本机管理页面填写凭据。

1. 在 [OpenAI Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建自己的 Tunnel。准备有相应权限的 API key。
2. 在管理页面的隧道设置中填写 Tunnel ID、API key，启用隧道，保留 stdio 传输。保存后启动服务。
3. 在工作区设置中添加希望 ChatGPT 访问的目录，可分别设置名称和只读权限。新安装的初始工作区默认可读写。
4. 新安装默认启用全部本机命令。旧配置可在“功能与权限”点击“一键完全开放”，保存并重启后再点“立即检测实际权限”；需要接续 Codex 历史时另行开启历史读取并填写实际 Codex home。
5. 在 ChatGPT 的应用/开发者连接入口选择相应 Tunnel，并在对话中启用 WebCodex。入口取决于账户权限，详见[接入指南](chatgpt-setup.md)。

命令行也可完成同一操作：

```sh
webcodex access full
webcodex access check
webcodex connect
```

`access check` 会在每个已配置的可写工作区创建随机临时文件、读回核对并删除。`full_access_ready=true` 才表示已保存配置为 `trusted-host + all` 且所有可写工作区均通过实际落盘检测。若返回 `READ_ONLY`，请开放该工作区并重启；若返回 `EACCES`、`EPERM` 或 `EROFS`，是启动 WebCodex 的系统账户、磁盘或 NTFS 权限拒绝，需把目录授权给该账户或用具备所需权限的终端启动。WebCodex 不会自动触发 UAC。

如果 ChatGPT 只回复“安全检查拦截”或“权限不足”，先确认它是否真的调用了 WebCodex。让它报告**实际工具名和完整错误码**。没有工具调用记录时，拦截发生在 ChatGPT 工具调度层，修改 Windows ACL 或 WebCodex 配置不会解决；已经收到 `ACCESS_DENIED` 时才表示 Windows/Linux 文件系统拒绝了运行 WebCodex 的账户。`trusted-host + all` 会放开 WebCodex 的命令策略，但不会把普通账户提升为管理员，也不能绕过 NTFS ACL、网络共享权限、只读磁盘或受保护目录。

对于普通代码修改，优先要求 ChatGPT 使用 `fs_read`/`fs_write`/`fs_apply_patch`，不要先用通用 `exec_start` 生成脚本；同一台电脑内复制现有文件使用 `fs_stat` + `fs_copy`。这些专用文件工具不依赖本机命令开关，更容易得到明确的文件系统错误。若 `access check` 已通过，但 ChatGPT 没有实际调用写入工具，应刷新该应用的工具列表或新建对话后再次明确要求调用具体写入工具。

安装器自动完成的是**本机软件、依赖、私有配置和管理页面**。它不能替用户申请产品权限、创建账户密钥或授权 ChatGPT。此连接使用 OpenAI 官方隧道，无需自建公网服务器、Cloudflare 或浏览器扩展。WebCodex 本身开源；ChatGPT 订阅和平台计费不包含在安装包中。

终端中的面板链接含短期本机凭据，请勿分享。API key 只在自己的配置页面中输入；不要发到聊天、issue 或 GitHub。

## 3. 确认可用

在已启用 WebCodex 的 ChatGPT 对话发送：

> 使用 WebCodex，先调用 system_status 和 workspace_list，确认版本为 0.16.0-preview.16、设备与工作区正确。读取 README.md（如果存在）。在我指定的可写工作区新建一个不存在的 webcodex-smoke.txt，内容为“连接测试”，再实际读回。不要覆盖已有文件；失败时报告实际工具错误。

安装成功、面板打开、隧道 connected 和文件实际读写是不同检查。PDF 正文与 ChatGPT 原文件自动回存仍有[宿主验收边界](current-acceptance.md)，安装包不改变这些限制。

## 已有 Node：使用 tgz 或 npm

已有 Node.js ≥22.16 和 npm，可直接使用 [npm 上的 0.16.0-preview.16](https://www.npmjs.com/package/webcodex-mcp/v/0.16.0-preview.16)，无需 npm 账号或登录。先在源码仓库及其子目录之外新建专用目录，再运行；例如在用户主目录创建：

```sh
mkdir ~/WebCodex-local
cd ~/WebCodex-local
npx --yes --package webcodex-mcp@0.16.0-preview.16 webcodex setup --workspace ./workspace --config ./config.toml
```

命令会安装缺少的工具、在当前目录创建 `config.toml` 和 `workspace`，然后打开管理页面。按上文填写账户和工作区设置。以后回到同一目录运行同一条 `npx` 命令即可重新打开页面，已有配置原样保留；不要删除该目录里的配置、工具、状态和工作区。

也可以下载 Release 中的 `webcodex-mcp-0.16.0-preview.16.tgz`，在专用目录运行：

```sh
npm install ./webcodex-mcp-0.16.0-preview.16.tgz --omit=dev --ignore-scripts
npx --no-install webcodex setup --workspace ./workspace --config ./config.toml
```

Windows PowerShell 若拦截 `npm.ps1` 或 `npx.ps1`，使用 `npm.cmd` / `npx.cmd`。

若在源码仓库或其子目录运行，npm 可能优先识别同名开发项目，导致找不到 `webcodex-mcp` 命令。此时改到上述独立目录，或使用下方源码安装命令。

## 源码安装

```sh
git clone https://github.com/xq3427/WebCodex.git
cd WebCodex
npm ci --ignore-scripts
npm run build
node dist/src/cli.js setup --workspace .
```

`setup` 首次创建 `.webcodex/config.toml`，自动安装缺少的本机工具并打开页面。已有 JSON/TOML 配置会被发现并保留；也可以用 `--config` 选择其他位置。已有配置的再次 setup 只加载并打开页面，不自动替换程序路径、凭据或工作区，需修复时使用页面与 `doctor`。

## 更新、诊断与卸载

- **更新**：等作业结束，先正常停止旧终端/管理服务；下载新安装 ZIP，解压后以原 InstallDir 再运行安装器。程序保存在 `app/<版本>`，配置、tools、state 和 workspace 不变。同版本校验一致时复用；内容冲突会明确报错，不覆盖未知安装。
- **本机检查**：Windows 运行 `start-webcodex.cmd doctor`，Linux/macOS 运行安装目录中的 `webcodex doctor`。源码安装使用 `node dist/src/cli.js doctor --config <配置路径>`。输出中的 `local_access` 会逐个报告工作区真实创建、读回、删除测试；`EACCES`/`EPERM`/`EROFS` 表示当前启动账户或磁盘 ACL 拒绝，`READ_ONLY` 表示配置仍是只读，`WORKSPACE_UNAVAILABLE` 表示目录未挂载或已变更。
- **下载失败**：保留报错并重试安装器。不需要删除配置。可显式指定自己的代理，例如 Windows `install.cmd -Proxy http://127.0.0.1:7890`，POSIX `sh install.sh --proxy http://127.0.0.1:7890`。这是示例端口，需与实际代理一致。安装代理不会自动写入隧道运行配置。
- **浏览器没有打开**：点击终端给出的完整面板链接；页面端口冲突时会使用另一空闲回环端口。不要删除链接凭据部分。
- **卸载**：先停止进程，备份需要保留的工作区、配置和 state，再删除专用安装目录。安装目录的默认 workspace 可能包含自己的文件，卸载前需保留。外部工作区不在安装目录内；安装器没有添加系统服务或全局 PATH。

Release 同时提供 `SHA256SUMS`。安装器核对 tgz；Node 使用官方 SHASUMS，辅助工具使用官方 GitHub release 的 SHA-256，再检查归档路径与文件类型。GitHub 元数据暂时不可用时，使用随本版本保存的官方发布清单（tunnel-client v0.0.14、ripgrep 15.2.0、MinGit 2.55.0.windows.5），继续核对每份资产大小与摘要，不要求 GitHub token。网络必须仍能下载这些官方资产。安装包不包含本机密钥、实验文件或运行日志。完整发布过程见[发布说明](releasing.md)。


