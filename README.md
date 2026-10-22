# @pngdeity/opencode-codeintel

OpenCode V2 plugin providing per-project socket-activated MCP code-intelligence routing and provisioning for **Serena** (`serena`) and the **mcpls** universal LSP fallback (`cclsp`).

## Surfaces Registered

1. **MCP Router (`mcp-route`)**: Routes `serena` and `cclsp` remote MCP entries per project directory using `~/.config/{serena,cclsp}/instances/*.conf`.
2. **`codeintel` Tool**: Single agent-callable entrypoint to enable or inspect code-intelligence coverage for a directory.
3. **`/lsp` Command**: TUI slash command to provision or inspect code-intelligence coverage.
4. **`mcp-instance` Tool**: Direct lifecycle control (`enable`, `disable`, `status`) for the `cclsp` (`mcpls`) fallback instance.
5. **`serena-instance` Tool**: Direct lifecycle control (`enable`, `refresh`, `disable`, `status`, `submodules`) for Serena instances.
6. **`serena-provision` Tool**: Multi-language `project.yml` census and provisioning for Serena 2.0.0.

## Companion Systemd Units & Scripts

Reference systemd user socket/service templates and maintenance scripts are bundled under [`contrib/`](./contrib).
