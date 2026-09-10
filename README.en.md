# WebCodex MCP

[中文](README.md) · [GitHub](https://github.com/xq3427/WebCodex) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

Workspace-scoped local development tools for ChatGPT over MCP. Read and edit code, inspect Git changes, run locally configured programs, and read visible local Codex history to continue a project when Codex is temporarily unavailable.

WebCodex supplies tools, not a model. It does not call Codex models, restore quotas, or bypass product limits. This is an independent community project, not an official OpenAI product.

**Version: 0.14.0-preview.2 — preview.** Automatic original PDF/Office attachment has been deferred. A file card or upload receipt does not prove that ChatGPT can read the document body.

## Features and limits

- Independent device identity and multiple named workspaces with read-only and availability policies.
- Bounded text reads, search, chunking, writes, patches, batch changes, SHA-256 conflict checks, backups and conditional restoration.
- Git status/diff, project instructions, and explicitly registered linked worktrees.
- Optional allowlisted native program execution, durable job records, output cursors, cancellation and pipe input.
- Optional read-only access to visible Codex sessions, search and handoff context.
- Independent task records, immutable progress revisions and exported handoff notes.
- stdio, loopback Streamable HTTP, official OpenAI Secure MCP Tunnel, and an optional local panel.

There are 44 registered tools: 42 ordinary tools and 2 component-only tools. See the generated [tool schemas](docs/tools.json).

Execution is disabled by default. Enabling `trusted-host` runs programs with the local owner's permissions; it is **not an OS sandbox**. Interpreter and package-manager aliases may allow filesystem and network effects outside a workspace. Batch changes are not atomic transactions, and file restoration cannot undo arbitrary program side effects.

There is no persistent shell/PTY, autonomous task runner, hidden Codex context recovery, dedicated Git commit/push tool, or automatic import of ChatGPT-generated binary attachments. Original-byte transport and experimental widgets do not provide verified automatic document analysis.

## Install from source

Requires **Node.js ≥22.16, Git and ripgrep**. Clone and install:

```text
git clone https://github.com/xq3427/WebCodex.git
cd WebCodex
npm ci --ignore-scripts
npm run build
node dist/src/cli.js init --workspace .
node dist/src/cli.js config validate
node dist/src/cli.js doctor
```

On PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`. No npm release is available yet.

Initialization creates a private `.webcodex/config.toml` with fresh device/workspace identities. Existing files are never overwritten. JSON uses the same schema. Every command accepts `--config /absolute/private/config.toml`; Windows paths such as `D:/WebCodex/config.toml` are supported.

All user settings, including the tunnel API key, live in the selected file. Relative paths resolve against its directory. Settings do not merge across configuration files, and changes require a service restart.

The [TOML](examples/config.example.toml) and [JSON](examples/config.example.json) examples intentionally have blank identities and credentials. Run `init` first and copy desired settings into that generated configuration.

## Connect to ChatGPT

Use the [official OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). This path does not require your own public server, domain, Cloudflare, browser extension or Actions endpoint. Your account still needs the appropriate Platform and ChatGPT access.

1. Create/select a tunnel in [Platform](https://platform.openai.com/settings/organization/tunnels).
2. Install the official [tunnel-client](https://github.com/openai/tunnel-client/releases). Windows users can run `./scripts/install-tunnel.ps1`. Linux/macOS users must configure a platform-specific binary path and SHA-256.
3. Set `tunnel.enabled`, `tunnel.id` and `tunnel.apiKey` in the private configuration. Keep `server.transport = "stdio"`.
4. Run:

```text
node dist/src/cli.js connect --doctor-only
node dist/src/cli.js connect
```

5. Add the corresponding Tunnel through ChatGPT's developer connection UI and enable WebCodex in a conversation.

Keep the connection terminal running. Inspect it from another terminal with `node dist/src/cli.js tunnel status`. Do not start another server using the same state directory. See the [setup guide](docs/chatgpt-setup.md) for authentication, upgrades and troubleshooting.

Ask ChatGPT to call `system_status` and `workspace_list`, verify the device, read a known text file, then create a new test text file without overwriting anything and read it back. Verify actual tool results, not just the assistant's success claim.

## Workspaces and Codex history

Each workspace has one root. Add another locally:

```text
node dist/src/cli.js workspace add --id papers --name Papers --root /absolute/papers --read-only
node dist/src/cli.js workspace health
node dist/src/cli.js device rename --name "Office laptop"
node dist/src/cli.js codex enable --home /absolute/codex-home
```

On Windows, Codex history may live on any local drive, for example `D:/CodexData/.codex`. If `--home` is omitted, the command preserves an existing configured directory, or discovers `CODEX_HOME` / `~/.codex` once and saves the result.

Restart the connection after configuration changes. Initialize each device separately; do not clone live credentials, identities or state. v2 mutations require `expected_device_id`. Files and operations are not automatically routed between devices.

Read-only Codex access does not modify sessions or read authentication files. Follow cursors and omission indicators, and verify current files before continuing historical work.

## Development

```text
npm run check
npm test
npm run export:tools
npm run audit:repo
```

Windows local validation and its limitations are documented in [testing](docs/testing.md). Check the [actual CI runs](https://github.com/xq3427/WebCodex/actions/workflows/ci.yml) for Windows, Linux and macOS results.

The detailed guides are currently in Chinese: [configuration](docs/local-configuration.md), [files](docs/file-workflow.md), [tasks](docs/task-workflow.md), [Codex continuation](docs/codex-emergency.md), [architecture](docs/architecture.md), [roadmap](docs/roadmap.md).

Keep live configurations, keys, Codex history, state databases and logs out of commits and issues. See [security](SECURITY.md).

## License

[MIT](LICENSE). Third-party components retain their own licenses; see [notices](THIRD_PARTY_NOTICES.md).
