// opencode-codeintel — unified OpenCode V2 plugin consolidating the six
// code-intelligence surfaces:
//   - mcp-route: per-project MCP endpoint routing for `serena` and `cclsp`
//   - codeintel-tool: unified `codeintel` provisioning & status tool
//   - lsp-command: `/lsp` TUI slash command
//   - mcp-instance: `mcp-instance` fallback lifecycle tool
//   - serena-instance: `serena-instance` Serena lifecycle tool
//   - serena-provision: `serena-provision` multi-language project.yml generator
//
// Each surface retains its own environment gate (`MCP_ROUTE_DISABLE`,
// `CODEINTEL_TOOL_DISABLE`, `LSP_COMMAND_DISABLE`, `MCP_INSTANCE_DISABLE`,
// `SERENA_INSTANCE_DISABLE`, `SERENA_PROVISION_DISABLE`) in addition to the
// umbrella `CODEINTEL_DISABLE=1` and `ctx.options` toggles.

import codeintelTool from "./codeintel-tool";
import lspCommand from "./lsp-command";
import mcpInstance from "./mcp-instance";
import mcpRoute from "./mcp-route";
import serenaInstance from "./serena-instance";
import serenaProvision from "./serena-provision";

export {
  codeintelTool,
  lspCommand,
  mcpInstance,
  mcpRoute,
  serenaInstance,
  serenaProvision,
};
export * from "./codeintel/core";
export * from "./codeintel/descriptors";
export * from "./codeintel/instance";
export * from "./codeintel/coverage";
export * from "./codeintel/status";

export default {
  id: "codeintel",
  setup: async (ctx: any) => {
    if (process.env.CODEINTEL_DISABLE === "1" || ctx?.options?.disabled === true) return;

    const opts = (ctx?.options && typeof ctx.options === "object" ? ctx.options : {}) as Record<
      string,
      unknown
    >;

    const disposers: Array<() => unknown> = [];

    if (opts.mcpRoute !== false) {
      const disposeRoute = await mcpRoute.setup(ctx);
      if (typeof disposeRoute === "function") disposers.push(disposeRoute);
    }
    if (opts.codeintelTool !== false) {
      await codeintelTool.setup(ctx);
    }
    if (opts.lspCommand !== false) {
      await lspCommand.setup(ctx);
    }
    if (opts.mcpInstance !== false) {
      await mcpInstance.setup(ctx);
    }
    if (opts.serenaInstance !== false) {
      await serenaInstance.setup(ctx);
    }
    if (opts.serenaProvision !== false) {
      await serenaProvision.setup(ctx);
    }

    return async () => {
      for (const dispose of disposers) {
        await dispose();
      }
    };
  },
};
