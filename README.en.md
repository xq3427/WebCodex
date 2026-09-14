# WebCodex MCP

[中文](README.md) · [Quick start](#quick-start) · [Documentation](docs/README.md) · [Configuration example](examples/config.example.toml) · [Contributing](CONTRIBUTING.md)

Let ChatGPT use MCP to work on authorized local projects: read and edit code, inspect Git changes, run locally configured programs, and read visible local Codex history to continue a project.

WebCodex supplies local tools; ChatGPT interprets the task and calls them. It does not call Codex models, restore quotas, or bypass product limits. It can help continue project work when Codex is temporarily unavailable. This is an independent community project, not an official OpenAI product.

**Version: 0.16.0-preview.11 — preview.** Copy existing local files with `fs_copy`; use `fs_save_file` for original files generated in ChatGPT. The save route accepts an actual host file ID or official file object, downloads the original locally, and checks its expected size and SHA-256 before writing. File bytes do not pass through model-transcribed Base64. **Local and synthetic component tests have passed; real ChatGPT authorization, download and save acceptance remains pending.**

## Quick start

**Recommended: [download the setup ZIP](https://github.com/xq3427/WebCodex/releases/download/v0.16.0-preview.11/WebCodex-0.16.0-preview.11-setup.zip)**. Extract it fully, then double-click `install.cmd` on Windows or run `sh install.sh` on Linux/macOS. It prepares Node, local tools and private configuration, then opens the dashboard. No compilation, npm login or administrator access is required. Linux/macOS require Git and standard download/archive utilities.

Enter your own Tunnel ID and API key in the dashboard, add workspaces, save and start the connection, then enable it in ChatGPT. See the [complete quick-start guide](docs/quickstart.md) for paths, updates, proxies and installation from a tgz or npm.

With Node.js ≥22.16 and npm already installed, run the [npm release](https://www.npmjs.com/package/webcodex-mcp/v/0.16.0-preview.11) from a new dedicated directory outside the source checkout; no npm login is needed:

```text
npx --yes --package webcodex-mcp@0.16.0-preview.11 webcodex-mcp setup --workspace ./workspace --config ./config.toml
```

Return to the same directory and run the same command to reopen the dashboard. Existing `config.toml` stays unchanged. Use `npx.cmd` if PowerShell blocks `npx.ps1`.

Developers can build from source with Node.js ≥22.16:

```text
git clone https://github.com/xq3427/WebCodex.git
cd WebCodex
npm ci --ignore-scripts
npm run build
node dist/src/cli.js setup --workspace .
```

On PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`. `setup` installs missing tools for a new configuration and opens the dashboard. Existing configuration stays unchanged. Add `--no-panel` to prepare and exit.

New setup creates a private `.webcodex/config.toml` with fresh device/workspace identities. Command execution and Codex history access are disabled by default. `init` can perform the first-run credential wizard: it prints and opens the official Tunnel page, asks for the Tunnel ID, then prints and opens the API keys page and asks for the API key. The key is hidden while typing and is written only to the local configuration. Run `connect` afterwards to start MCP. Use `init --no-tunnel` on headless or non-interactive systems and configure credentials later in the local panel.

```text
webcodex-mcp init --workspace ./workspace
webcodex-mcp connect
```

## Unified configuration and local control center

The `node dist/src/cli.js …` examples below assume a source checkout. Setup ZIP users can run `start-webcodex.cmd …` on Windows or `webcodex …` on Linux/macOS from the installation directory. These launchers already select the configured file; do not append another `--config`.

All settings live in one selected TOML or JSON file: device, workspaces, tunnel API key, Codex home, program paths, permissions and limits. Configuration files are not merged. Relative paths resolve against the **configuration file's directory**.

Open only the configuration page:

```text
node dist/src/cli.js panel
```

The terminal prints a complete local URL containing a temporary credential. The page provides workspace and permission forms, write-only secret updates, validation, and start/stop/save-and-restart controls for services it manages. `panel` does not immediately start an MCP connection. Keep the URL private and the terminal running.

You can select another configuration location; keep using the same `--config` with subsequent commands:

```text
node dist/src/cli.js init --workspace . --config /absolute/private/config.toml
node dist/src/cli.js panel --config /absolute/private/config.toml
```

Windows paths such as `D:/WebCodex/config.toml` are supported. The [TOML](examples/config.example.toml) and [JSON](examples/config.example.json) templates intentionally contain blank identities and credentials. Initialize a local configuration first, then copy the settings you need; do not run an empty-identity template directly.

Configuration changes require restarting the corresponding service. The page manages connections it starts. Services launched by an older version, `connect --no-panel`, or standalone `serve` must be stopped normally in their original terminal before starting them from the page. External processes are never forcibly adopted. See [configuration](docs/local-configuration.md) and the [control center guide](docs/local-panel.md).

## Connect to ChatGPT

Use the **official OpenAI Secure MCP Tunnel** for a local stdio service. This path needs no self-hosted public server, domain, Cloudflare, browser extension or Actions endpoint. Your account still needs the appropriate Platform tunnel and ChatGPT connection access.

1. Create or select a tunnel in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), and prepare an API key with permission to run it.
2. The installer or a new `setup` already installs the official [tunnel-client](https://github.com/openai/tunnel-client/releases). Existing manual configurations can follow the [connection guide](docs/chatgpt-setup.md) to install it separately.
3. Set `tunnel.enabled`, `tunnel.id` and `tunnel.apiKey` in the selected configuration. Keep `server.transport = "stdio"`.
4. Check and start the connection:

```text
node dist/src/cli.js connect --doctor-only
node dist/src/cli.js connect
```

5. Select the corresponding Tunnel in ChatGPT's app/developer connection UI and enable WebCodex in the conversation. See the [setup guide](docs/chatgpt-setup.md) for account requirements, detailed steps and upgrades.

With a v2 configuration, `connect` starts the connection and local control center, then prints the page URL. `stdio` uses the official tunnel; `http` starts a loopback HTTP service. A reachable local HTTP endpoint or page does not establish a ChatGPT connection. If the panel port conflicts, a free loopback port is selected without changing configuration.

For stdio tunnels, `connect --no-panel` starts a connection without the page and `connect --doctor-only` only checks tunnel setup; inspect status from another terminal with `node dist/src/cli.js tunnel status`. For HTTP configurations, use `node dist/src/cli.js serve` without a panel and `node dist/src/cli.js doctor` for local dependency checks. Append the same `--config` when using a custom location. Keep the service running and do not start another service sharing its state directory.

After connecting, ask:

> Use WebCodex. Call system_status and workspace_list to confirm the device and project. Read README.md and explain the project. In the specified writable workspace, create webcodex-smoke.txt only if it does not exist, containing “WebCodex connection test”, then read it back and verify. Do not overwrite an existing file; report the actual tool error if anything fails.

## Files: choose the appropriate route

| File or task | Route | Completion evidence |
| --- | --- | --- |
| Existing local file | Read its hash with `fs_stat`, then use `fs_copy`; supports different workspaces and read-only sources, without upload or command execution | Copy receipt matches destination `fs_stat` size/hash |
| Markdown, SVG, HTML or source code | `fs_write` or `fs_apply_patch` | Write result and a verified readback |
| Original PNG, PPTX, PDF, ZIP or other ChatGPT-generated file | `fs_save_file` with this artifact's real file reference and original size/hash; inspect `fs_save_file_status` | `saved`, `verified=true`, then matching `fs_stat` |
| Text in a local PDF | Experimental `document_open` / `document_read` | Answer only from actual pages returned as `ready`; real host retest remains pending |

Automatic saving needs no user-entered URL, per-file picker or extension. For a file ID, the component calls `getFileDownloadUrl` and privately forwards the temporary address. A usable official file object can download directly. **The real ID must identify the current generated artifact and be authorized by the host**; a filename, `sandbox:/mnt/data/...`, or an earlier source attachment's ID is not a substitute.

Compute `size_bytes/content_sha256` from the same unchanged original in Code Interpreter. For an existing destination, call `fs_stat` first and put the **current destination hash** in `expected_sha256`; `null` is create-only. Keep the component mounted and respect `retry_after_ms`, `polls_remaining` and `can_poll` when checking status. Pending is not saved; do not replay failed or unknown operations with a new key.

The route uses `limits.binaryWriteMaxBytes`, defaulting to 32 MiB and configurable up to 128 MiB, independently of Base64 chunk staging. Legacy `fs_import_file` and Base64 tools remain compatible. Use Base64 only for complete small payloads that the host can reliably relay; stop on truncation. Never resize, reencode or regenerate an artifact to replace the original. See [local copying and recovery](docs/file-workflow.md) and [automatic original-file saving](docs/file-writeback.md).

## Other capabilities and boundaries

There are **65 registered tools: 55 ordinary tools and 10 component-only tools**. See the generated [tool schemas](docs/tools.json) and [current acceptance entry](docs/current-acceptance.md). Registration does not guarantee that every tool is callable in the current ChatGPT conversation.

- Workspaces have independent names, read-only permissions and availability policies. File changes retain device checks, SHA-256 preconditions, idempotency keys, backups and conditional restoration.
- Git status/diff, project AGENTS.md instructions, explicitly registered linked worktrees, independent tasks, checkpoints and handoff notes are supported.
- Command execution is disabled by default. The page can enable local programs with output, waits, cancellation and stdin; legacy configurations may retain an allowlist. `trusted-host` runs with the local owner's permissions and is **not an OS sandbox**.
- Codex history access is disabled by default. When enabled, it reads visible local sessions without model calls, authentication files, hidden reasoning recovery or automatic replay of historical commands.
- A synthetic text relay succeeded twice in a real ChatGPT connection. This does not establish real PDF ingestion or original-file writeback. The PDF prototype's bundled-font/CMap fix still needs a real PDF retest; there is no scanned-document OCR, image understanding or automatic native attachment ingestion.
- There is no persistent shell/PTY, autonomous task runner or dedicated Git commit/push tool. Batch changes are not cross-file atomic transactions, and file restoration cannot undo program, network or database side effects.

Local validation has been performed on Windows, with CI configured for Windows, Linux and macOS. Consult the [actual CI runs](https://github.com/xq3427/WebCodex/actions/workflows/ci.yml) and [testing boundaries](docs/testing.md). WebCodex is MIT-licensed; ChatGPT subscriptions, platform permissions and service billing are determined by their providers.

## Workspaces, devices and Codex continuation

Each workspace has one local `root`. Add separate entries for different names or permissions; do not concatenate paths in a single root field. Use the page or CLI:

```text
node dist/src/cli.js workspace add --id papers --name Papers --root /absolute/papers --read-only
node dist/src/cli.js workspace health
node dist/src/cli.js device rename --name "Office laptop"
node dist/src/cli.js codex enable --home /absolute/codex-home
node dist/src/cli.js codex status
```

Preserve existing workspace `id/uid` values. Initialize each device separately with its own configuration, state and tunnel identity; do not copy another device's live configuration or database. v2 mutations, execution and cancellation require `expected_device_id`. Files are not automatically synchronized between devices.

Codex home can reside on any local drive, such as `D:/CodexData/.codex`. If `--home` is omitted, the existing configured directory is retained; first discovery uses `CODEX_HOME` or `.codex` under the user directory and stores the result in unified configuration. After restarting the connection, ask ChatGPT to locate the project's conversation, read necessary history, then inspect current files and Git state before continuing. See [configuration](docs/local-configuration.md), [tasks and execution](docs/task-workflow.md), and [Codex continuation](docs/codex-emergency.md).

## Project layout

| Path | Purpose |
| --- | --- |
| `src/` | TypeScript CLI, MCP tools, workspace policy, file services, jobs, history and local panel |
| `src/browser/` | Browser PDF text component and asset-loading code |
| `test/` | Synthetic-file, temporary-workspace, service and component regression tests |
| `scripts/` | Build, tests, tool export, repository audit and tunnel helpers |
| `examples/` | Configuration templates and examples without live identities or secrets |
| `docs/` | Guides, architecture, boundaries, generated schemas and acceptance entry |
| `.github/` | CI and issue/PR templates |
| `dist/`, `node_modules/` | Local build and dependency outputs; not committed |
| `.webcodex/` | Default local configuration, state and runtime artifacts; not committed |

## Documentation and development

- Setup: [ChatGPT connection](docs/chatgpt-setup.md) · [unified configuration](docs/local-configuration.md) · [local control center](docs/local-panel.md)
- Workflows: [files](docs/file-workflow.md) · [original-file saving](docs/file-writeback.md) · [tasks and execution](docs/task-workflow.md) · [Codex continuation](docs/codex-emergency.md)
- Implementation and evidence: [architecture](docs/architecture.md) · [feature status](docs/implementation-status.md) · [testing](docs/testing.md) · [protocol diagnostics](docs/protocol-diagnostics.md) · [roadmap](docs/roadmap.md)
- Maintenance: [contributing](CONTRIBUTING.md) · [security](SECURITY.md) · [changelog](CHANGELOG.md) · [third-party notices](THIRD_PARTY_NOTICES.md)

The detailed guides are currently in Chinese; see the [full index](docs/README.md). Development checks:

```text
npm run check
npm test
npm run check:tools
npm run test:repo
npm run audit:repo
```

After tool or version changes, build and run `npm run export:tools` to update generated documentation before checking consistency. Never commit live configurations, credentials, Codex history, state databases, unredacted logs or private acceptance artifacts.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| doctor cannot find rg | Install ripgrep or configure `rgPath` in the selected file |
| SQLite ExperimentalWarning | A Node SQLite notice; it does not alone indicate failure |
| `TUNNEL_ALREADY_RUNNING` | Inspect `tunnel status` with the same configuration; do not delete locks or repeatedly start another connection |
| Tools appear in app details but are unavailable in chat | Enable the correct connection, update tools through the current ChatGPT UI, then verify `system_status` and actual calls |
| File save remains pending or fails | Inspect `fs_save_file_status`, its error and polling budget; a visible ID does not establish authorization or a saved file |
| PDF component appears without readable text | Check `document_read`; answer only from actual pages returned as `ready` |
| Configuration edits have no effect | Wait for jobs to finish, then save and restart the relevant service; running processes do not automatically reload |

## License

[MIT](LICENSE). Dependencies and the official tunnel-client retain their own licenses.


