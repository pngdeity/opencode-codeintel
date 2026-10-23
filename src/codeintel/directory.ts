// directory — the session's current directory, as the panel needs it.
//
// Kept apart from tui.tsx because it reads the runtime context and returns a
// string; nothing here imports Solid, so it can be exercised without a TUI.

export type SessionContext = {
  readonly location: unknown;
  readonly data: { location: { default: () => unknown } };
};

// The runtime supplies either a bare path or an object carrying `directory`
// (V2 uses the latter). Both shapes appear across versions, so this accepts
// either rather than assuming one.
export function currentDirectory(ctx: SessionContext): string | undefined {
  const location = (ctx.location ?? ctx.data.location.default()) as
    | string
    | { directory?: string }
    | undefined;
  if (typeof location === "string") return location;
  return location?.directory;
}
