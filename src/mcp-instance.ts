// mcp-instance — tool wrapper over the code-intelligence fallback's instance
// lifecycle (codeintel/instance), for ONE directory.
//
// Why the tool exists rather than a documented `/mcp` flow: OpenCode's `mcp`
// block is declarative and global, while the fallback endpoint is a
// socket-activated systemd instance bound to a project. codeintel/instance
// writes the conf and enables the socket; mcp-route then routes the `cclsp`
// entry to it. This tool is the human/agent entry point for the half that is
// per-directory.
//
// Scope note: the fallback is THE code-intelligence floor on this host — it
// serves extensions serena does not cover and directories serena refuses
// (non-git). serena's richer provisioning (project.yml, a serena_config.yml
// registration) is the separate `serena-instance` tool.
//
// Env: MCP_INSTANCE_DISABLE=1 disables the tool (mirrors MCP_ROUTE_DISABLE).

import { readConfs } from "./codeintel/core";
import { CCLSP } from "./codeintel/descriptors";
import { bind, envelope, locationStatus, resolveLocation, type Bound } from "./codeintel/instance";

// The fallback serves any directory, so its non-git mode is read from the
// descriptor rather than spread into an operation's input where a type error
// cannot see it.
const NON_GIT = CCLSP.nonGit;

async function status(input: { directory?: string }): Promise<string> {
  const directory = input.directory ?? process.cwd();
  const target = resolveLocation(directory, NON_GIT ? "directory" : "git");
  // A refusal still names where the caller asked about; the report then says no
  // instance can live there, which is the truth rather than a failed resolve.
  const root = target.refusal ? directory : target.root;

  const confs = await readConfs(CCLSP);
  return [
    `location : ${directory}`,
    `root     : ${root}`,
    ...locationStatus(CCLSP, confs, {
      root,
      noun: "fallback",
      none: "code intelligence is disabled here",
    }),
  ].join("\n");
}

export default {
  id: "local:mcp-instance",
  setup: (ctx: any) => {
    if (process.env.MCP_INSTANCE_DISABLE === "1") return;

    registerTool(ctx);
  },
};

// Extracted for tests: the bound lifecycle is injectable, and a test's bound
// object carries its own effects (`bind(descriptor, { effects })`), so the real
// `bind(CCLSP)` arm can be driven over a fake descriptor without systemd. The
// default is built here, once, from the descriptor — `bind(CCLSP)` carries the
// fallback's non-git eligibility, so a surface cannot forget it.
export function registerTool(ctx: any, bound: Bound = bind(CCLSP)): void {
  ctx.tool.transform((editor: any) => {
    editor.add({
      name: "mcp-instance",
      description:
        "Create or remove a code-intelligence fallback MCP instance for a " +
        "directory, then leave it reachable by mcp-route. Use when the fallback " +
        "server is disabled for the current location, i.e. the directory is not " +
        "under any known project root; " +
        "`/mcp` and `opencode mcp add` cannot fix this because mcp-route rewrites " +
        "the `cclsp` entry on every reconciliation, and the missing piece is the " +
        "socket-activated instance, not the MCP entry. Works for ANY directory, " +
        "git repository or not: a git repo resolves to its toplevel, a non-git " +
        "directory (e.g. a dotfiles or config directory) resolves to itself. " +
        "action=enable writes " +
        "~/.config/cclsp/instances/<port>.conf and enables cclsp-mcp@<port>.socket; " +
        "action=disable stops the socket and deletes the conf; action=status " +
        "reports the instance for a directory. The backend needs no per-project " +
        "config file, so a conf plus a socket is the whole job. Routing is picked " +
        "up on mcp-route's next 5 s poll, with no restart.",
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["enable", "disable", "status"],
            description:
              "enable creates the instance, disable removes it, status reports it. " +
              "Defaults to status.",
          },
          directory: {
            type: "string",
            description:
              "Directory to provision: its git root (if a repository) or the " +
              "directory itself (if not). Defaults to the current location.",
          },
          name: {
            type: "string",
            description:
              "Instance name, used only in the conf comment and in reports. " +
              "Defaults to the repository directory name.",
          },
        },
        additionalProperties: false,
      },
      execute: async (input: { action?: string; directory?: string; name?: string }) => {
        const action = input.action ?? "status";
        if (action === "enable") {
          return envelope(await bound.enable(input));
        }
        if (action === "disable") {
          return envelope(await bound.disable(input));
        }
        return { content: await status(input) };
      },
    });
  });
}
