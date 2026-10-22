// codeintel/location — one resolver contract for "which directory does this
// operation target?".
//
// Two consumers need a directory but see different truths, and V2 makes that
// structural, not incidental:
//
//   - Routing (mcp-route) is PER-LOCATION. OpenCode loads one plugin instance
//     per location, and MCP server config is resolved per location, so routing
//     can only ever see `ctx.location` — the plugin instance's location. The
//     invoke-time session id is call metadata, delivered after routing has
//     already selected servers, so it cannot influence it.
//   - Provisioning (/lsp, the mcp-instance tool) runs at INVOKE time and can
//     read the invoking session's own location, which a session may change
//     (Session.Info.location is mutable, e.g. /move).
//
// The two can therefore diverge: a session that moved into a directory will
// provision there while routing still serves the plugin instance's location.
// That divergence is a platform constraint, not something this module can
// remove. What it can do is name both meanings explicitly, so callers pick the
// right one deliberately and a divergence is at least expressible (the /lsp
// command reports it).
//
// WHO OWNS WHICH, because this module cannot enforce it: the two functions are
// distinguished by which side of a call they may be used on, and a caller that
// picks the wrong one gets a plausible directory rather than an error.
//   - `instanceDirectory` — ROUTING scope. Only `mcp-route.ts` may use it, and
//     only to decide which servers a plugin instance's config exposes.
//   - `sessionDirectory` — INVOKE scope. Used by `lsp-command.ts` (and anything
//     else that acts on behalf of one call) so a moved session provisions and
//     reports in the directory it is actually in.
// A third consumer would need a reason to prefer one; naming the two here means
// the next reader does not have to infer it from which files happen to import
// what.

// The slice of the plugin context this module reads. Typed structurally rather
// than `any` so the two meanings are explicit and a test can pass a fake:
// `location` (the plugin instance's location) and `session.get` (the invoking
// session lookup). Everything else on the real ctx is irrelevant here.
export type LocationContext = {
  location?: {
    directory?: string;
    project?: { canonical?: string };
  };
  session: {
    get(input: { sessionID: string }): Promise<{ location?: { directory?: string } } | undefined>;
  };
};

// The plugin instance's location, normalized to the form the router matches
// against (project.canonical), falling back to the raw directory. This is the
// only directory routing may use.
export function instanceDirectory(ctx: LocationContext): string {
  return ctx?.location?.project?.canonical ?? ctx?.location?.directory ?? "";
}

// The invoking session's location, resolved at call time. Never throws: a
// session that moved, is missing, or whose lookup fails falls back to the
// plugin instance's location and finally to the process cwd, so a resolution
// failure can never provision an empty path.
export async function sessionDirectory(ctx: LocationContext, sessionID: string): Promise<string> {
  let directory = instanceDirectory(ctx);
  try {
    const session = await ctx.session.get({ sessionID });
    directory = session?.location?.directory ?? directory;
  } catch (error: any) {
    console.warn(
      `[codeintel/location] could not resolve session location for ${sessionID}: ${error?.message}`,
    );
  }
  return directory || process.cwd();
}
