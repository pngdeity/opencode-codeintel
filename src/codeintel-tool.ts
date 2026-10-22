// codeintel — one verb over both code-intelligence servers, for one location.
//
// Why a third surface: `mcp-instance` and `serena-instance` share a verb and
// differ in eligibility (serena needs a git root, the fallback serves any
// directory), and nothing said so. The audited session
// (`ses_ea3f13d01ffeqeNXJ51e1Z5jJO`) tried one, was refused, and never learned
// the other existed. That choice is a function of the location, so it belongs
// here rather than in the caller's head: this tool runs the coverage plan
// (codeintel/coverage) and reports which server serves the location, which does
// not and why.
//
// It is additive over the two existing tools, not a replacement: they keep their
// explicit-scope verbs and their narrower reports. This one answers "make code
// intelligence work here", which is the question an agent actually has.
//
// `status` is the one verb borrowed rather than reimplemented: "what serves this
// location" and "what is provisioned on this host" are different questions, and
// the second already has one answer (`codeIntelStatus`). A tool that accepted
// `action=status` and printed its own version of it would be the same defect in
// prose that the coverage plan exists to remove from behaviour.
//
// The description is load-bearing: an agent reads it INSTEAD of the code, so
// every claim in it is a contract this file must keep. It says a covered server
// is re-checked, because that is what the runner does — a conf is not an answer.
//
// Env: CODEINTEL_DISABLE=1 disables the tool.

import { enableCoverage } from "./codeintel/coverage";
import { envelope } from "./codeintel/instance";
import { codeIntelStatus } from "./codeintel/status";

// The coverage runner, narrowed to the call this tool makes, so a test can supply
// one without implementing the injectable effects. The runner's own dependencies
// are its business; a surface that took them would be a second way to configure
// the plan. Derived from the runner's signature rather than restated, so a change
// to what this tool passes cannot land in one place and not the other.
export type CoverageRun = (
  input: Parameters<typeof enableCoverage>[0],
) => ReturnType<typeof enableCoverage>;

export function registerTool(ctx: any, run: CoverageRun = enableCoverage): void {
  ctx.tool.transform((editor: any) => {
    editor.add({
      name: "codeintel",
      description:
        "Provision code intelligence for a directory, on whichever server can serve " +
        "it: serena for the git root (its census is `git ls-files`), and the " +
        "socket-activated fallback (mcpls) for any directory, git or not. The two " +
        "are additive — the fallback is the extension-coverage floor and stays " +
        "enabled after serena is. action=enable runs both eligible steps in one " +
        "call and reports a coverage table: what serves this location, what does " +
        "not, and why. Safe to repeat: an instance that already exists is " +
        "re-checked rather than rewritten, and if its backend does not answer the " +
        "call fails and says so. action=status reports what is provisioned on this " +
        "host without changing anything. For a directory that is not itself a " +
        "repository but contains them, all=true also provisions serena for each " +
        "child repository in the same call; without it they are named and left " +
        "alone. Prefer this over choosing between mcp-instance and serena-instance. " +
        "Routing is picked up by mcp-route on its next 5 s poll, with no restart.",
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["enable", "status"],
            description:
              "enable provisions every eligible server for the location; status " +
              "reports the instances on this host. Defaults to enable."
          },
          directory: {
            type: "string",
            description:
              "Directory to provision. Defaults to the current location. A git " +
              "worktree resolves to its toplevel for both servers; a non-git " +
              "directory is served by the fallback, and by serena as well for " +
              "each repository directly under it when all=true.",
          },
          // `name` and `all` are enable-only; the descriptions say so rather than
          // leaving a caller to discover that status ignored them.
          name: {
            type: "string",
            description:
              "Instance name for a NEW conf, in the conf comment and the serena " +
              "project directory. Defaults to the directory's basename. Ignored " +
              "by status; never applied to a child repository, whose own basename " +
              "keys its serena project.",
          },
          all: {
            type: "boolean",
            description:
              "For a directory that is not itself a repository: also provision " +
              "serena for each repository directly under it, in this one call. " +
              "Without it those children are named but left alone. Ignored by " +
              "status.",
          },
        },
        additionalProperties: false,
      },
      execute: async (input: {
        action?: string;
        directory?: string;
        name?: string;
        all?: boolean;
      }) => {
        if (input.action === "status") return { content: await codeIntelStatus() };
        return envelope(
          await run({ directory: input.directory, name: input.name, all: input.all }),
        );
      },
    });
  });
}

export default {
  id: "local:codeintel-tool",
  setup: (ctx: any) => {
    if (process.env.CODEINTEL_DISABLE === "1") return;

    registerTool(ctx);
  },
};
