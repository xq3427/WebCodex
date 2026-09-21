# WebCodex MCP

WebCodex lets ChatGPT use MCP to work with local workspaces you authorize: read, edit and copy files, run local commands, and inspect Git status. The service runs locally and connects through the official OpenAI Secure MCP Tunnel.

## Start in three steps

### 1. Install

Node.js 22.16 or newer is required:

```powershell
npm install -g webcodex-mcp@0.16.0-preview.17
```

For a flat standalone directory without `node_modules/webcodex-mcp`, use the [GitHub setup package](https://github.com/xq3427/WebCodex/releases/tag/v0.16.0-preview.17). npm controls its installation layout and packages cannot safely change it to a flat tree.

### 2. Initialize

```powershell
webcodex init
```

The command prints the official Tunnel and API key pages and creates local configuration. Paste the credentials when prompted; they stay in the local configuration and are never printed or committed.

### 3. Connect

```powershell
webcodex connect
```

Keep the process running, then enable WebCodex from ChatGPT's app/developer connections.

## Documentation

- [Quickstart](docs/quickstart.md)
- [ChatGPT setup](docs/chatgpt-setup.md)
- [Configuration and dashboard](docs/local-configuration.md)
- [File workflows](docs/file-workflow.md)
- [Tool schema](docs/tools.json)
- [Changelog](CHANGELOG.md)

## Common checks

```powershell
webcodex doctor
webcodex config validate
webcodex access check
```

`webcodex-mcp` and `webcodex` invoke the same CLI. The process has only the permissions of the operating-system account that starts it; `trusted-host + all` does not bypass ACLs, Unix permissions, or administrator/UAC controls.

## Development and license

```powershell
git clone https://github.com/xq3427/WebCodex.git
cd WebCodex
npm ci --ignore-scripts
npm test
```

MIT licensed. See [CONTRIBUTING.md](CONTRIBUTING.md) for contributions and issue reports.
