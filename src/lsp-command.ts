// lsp-command — registers the `/lsp` slash command.
//
// Motivation: `mcp-instance` is the right tool for provisioning the fallback
// backend (mcpls, still routed under the `cclsp` instance name), but it
// is agent-facing only — there is no slash command, keybind, or CLI for it, and
// the discoverable affordance (`/mcps`) is exactly the one that cannot work,
// because mcp-route rewrites the `cclsp` entry on every reconciliation. `/lsp`
// closes that gap: a user-invoked, argument-free, deterministic command for the
// current location.
//
// A bare `/lsp` runs the coverage plan (codeintel/coverage), so it provisions
// whichever servers can serve this location in one go and reports the coverage
// table. That is a superset of the old fallback-only behaviour: the fallback is
// still always enabled, and a git root additionally gets serena. `/lsp` is not
// the place to refuse a non-git directory — the fallback serves it, and the
// table says so.
//
// Repeatable, but not a no-op: the same plan runs every time, and a server that
// already has an instance is RE-CHECKED rather than rewritten — its backend is
// probed, and a conf whose socket is disabled is re-enabled. So a second `/lsp`
// can fail where the first succeeded, which is the point: a conf is not an
// answer. A FAILED provision has no result envelope to carry the signal (a slash
// command emits text, not a tool result), so the report says so explicitly
// rather than printing failure prose as if it were the outcome the user asked
// for.
//
// Env: LSP_COMMAND_DISABLE=1 disables the command (mirrors MCP_ROUTE_DISABLE).

import { enableCoverage } from "./codeintel/coverage";
import { instanceDirectory, sessionDirectory } from "./codeintel/location";
import { codeIntelStatus } from "./codeintel/status";

export default {
  id: "local:lsp-command",
  setup: async (ctx: any) => {
    if (process.env.LSP_COMMAND_DISABLE === "1") return;

    if (!ctx?.command?.transform) {
      console.warn("[lsp-command] ctx.command.transform unavailable — command not registered");
      return;
    }

    // The plugin instance's location, captured once (like mcp-route). Used only
    // to detect divergence below: provisioning targets the INVOKING session's
    // location (resolved at execute time), while routing serves this instance
    // location. See codeintel/location for why the two are structurally allowed
    // to differ.
    const routed = instanceDirectory(ctx);

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "lsp",
        description:
          "Provision code intelligence for the current location: serena for the git " +
          "root and the fallback backend for any directory, in one pass. Runs the " +
          "same coverage plan as the codeintel tool; an instance that already " +
          "exists is re-checked rather than rewritten, so repeating it verifies " +
          "instead of assuming. " +
          "`/lsp status` prints the combined fallback+serena instance report.",
        execute: async ({
          sessionID,
          prompt,
        }: {
          sessionID: string;
          prompt?: { text?: string };
        }) => {
          // Optional verb from the command text. Anything other than a leading
          // `status` token keeps the default action (provision), so a bare
          // `/lsp` and `/lsp provision` behave identically. A trailing `all`
          // token reaches the repositories under a non-git directory, which is
          // the case a bare `/lsp` otherwise leaves to a second call per repo.
          const words = (prompt?.text ?? "").trim().toLowerCase().split(/\s+/);
          const verb = words[0] ?? "";
          const all = words.includes("all");

          if (verb === "status") {
            await ctx.session.synthetic({ sessionID, text: await codeIntelStatus() });
            return;
          }

          // Resolve from the INVOKING session, not the plugin instance.
          const directory = await sessionDirectory(ctx, sessionID);

          // run the shared coverage plan; report the result as a synthetic message
          // (a system line, no model turn) so the outcome is visible without
          // spending a completion.
          const result = await enableCoverage({ directory, all });

          // A slash command has no result envelope, so a failure has no other way
          // to announce itself: without this line the report reads as done and
          // the dead conf it describes is what the user finds out later. The
          // coverage table above the line names WHICH server failed.
          const failure = result.ok
            ? ""
            : "\n\n/lsp failed — not every eligible server was provisioned.";

          // Routing serves the plugin instance's location, so when a moved
          // session provisions elsewhere the route will not follow it. Make
          // that visible rather than letting it look like a silent no-op.
          const divergence =
            routed && routed !== directory
              ? `\nnote: code intelligence was provisioned for ${directory}, but MCP routing for this ` +
                `session serves ${routed}. Routing is per-location, not per-session; ` +
                `open OpenCode in ${directory} for the route to follow.`
              : "";

          await ctx.session.synthetic({ sessionID, text: result.message + failure + divergence });
        },
      });
    });
  },
};
