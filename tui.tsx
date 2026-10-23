/**
 * codeintel/tui — the sidebar's Code intel block.
 *
 * Exported as `./tui` so a single install of this package delivers both the
 * server plugin and this panel. OpenTUI and Solid are peers, not dependencies:
 * the host OpenCode runtime supplies them, and a bundled copy would be a second
 * renderer instance.
 *
 * Why this file is alone in its concern
 *   The loader resolves each file's imports independently, and only the ENTRY
 *   file's bare imports are resolvable — a non-entry module that imports
 *   `solid-js` or `@opentui/solid` fails at runtime with
 *   `Cannot find package 'solid-js' imported from ...`. So this entrypoint holds
 *   the components and nothing else; the recovery logic it renders is in
 *   `./snapshot`, which imports only node builtins and the core reader. That
 *   split is what lets the block be refreshed on an interval while staying
 *   unit-testable without a TUI runtime.
 *
 * What is drawn
 *   One row per backend serving the session's project — the tool name, then one
 *   row per language server it has spawned. State is carried by the row's bullet
 *   (filled for live, hollow and dimmed for off) so it reads without color.
 *   Servers come from the sticky `seen` list, so an LSP that started once stays
 *   visible after it exits.
 *
 * Env: CODEINTEL_TUI_DISABLE=1 disables the block.
 */
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { currentDirectory } from "./src/codeintel/directory.ts";
import { palette, type Palette } from "./src/codeintel/tui-theme.ts";
import {
  currentProject,
  isBroken,
  leafOf,
  newServerMemory,
  readServers,
  tailOf,
  type ServerInstance,
} from "./src/codeintel/snapshot.ts";

const SERVERS_POLL_MS = 10_000;

// Polls the backend/LSP snapshot on an interval.
//
// The sticky `seen` memory is created HERE, per mount, and threaded through the
// poll: `readServers` returns the memory to use next time. Held in module scope
// it was shared by every mount, survived a failing poll, and could not be reset
// — state a component owns, living somewhere no component owns.
function useServers(intervalMs: number): { read: Accessor<ServerInstance[]> } {
  const [value, setValue] = createSignal<ServerInstance[]>([]);
  onMount(() => {
    let memory = newServerMemory();
    const refresh = () =>
      void readServers(memory)
        .then((next) => {
          memory = next.memory;
          setValue(next.rows);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, intervalMs);
    onCleanup(() => clearInterval(timer));
  });
  return { read: value };
}

// A tool row in two lines, matching the built-in sidebar idiom (bold label in
// body color, muted detail): line 1 is the backend, line 2 is each language
// server it has spawned, indented under the name. Line 1 carries a word only
// when the backend itself is down (`off`); a live backend with nothing spawned
// yet reads `idle`.
function ToolRow(props: { inst: ServerInstance; p: Palette }) {
  const inst = props.inst;
  const p = props.p;
  const anyActive = inst.running && inst.servers.length > 0;
  const bulletColor = anyActive ? p.ok : p.muted;
  const state = inst.running ? (inst.seen.length ? null : "idle") : "off";

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} minWidth={0}>
        <text fg={bulletColor} flexShrink={0}>
          •
        </text>
        <text
          fg={inst.running ? p.text : p.muted}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          <b>{inst.tool}</b>
        </text>
        {state ? (
          <text fg={p.muted} flexShrink={0} wrapMode="none">
            {state}
          </text>
        ) : null}
      </box>
      {inst.seen.map((server) => {
        const live = inst.running && inst.servers.includes(server);
        const broken = isBroken(server);
        const tail = tailOf(server);
        return (
          <box flexDirection="row" gap={1} minWidth={0}>
            <text fg={p.muted} flexShrink={0} wrapMode="none">
              {"  "}
            </text>
            <text fg={live ? p.ok : p.muted} flexShrink={0} wrapMode="none">
              {live ? "●" : "○"}
            </text>
            <text fg={live ? p.text : p.muted} flexShrink={0} wrapMode="none">
              <b>{server}</b>
            </text>
            <text fg={p.muted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="word">
              {tail}
            </text>
            {broken ? (
              <text fg={p.warn} flexShrink={0} wrapMode="none">
                {"⚠ broken server"}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

function ServersBlock(props: { ctx: any; instances: Accessor<ServerInstance[]> }) {
  const instances = () => props.instances();
  const p = palette(props.ctx.theme);

  return (
    <box flexDirection="column">
      {(() => {
        const all = instances();
        const dir = currentDirectory(props.ctx);
        const here = currentProject(dir, all);
        // `here` is a project in `all` by construction — `currentProject` matches
        // against `all`'s own roots — so this filter is never empty when `here`
        // is set, and there is no "project with no backend rows" arm to render.
        const mine = all.filter((i) => i.project === here);
        const sortedMine = [...mine].sort((a, b) => a.tool.localeCompare(b.tool));

        // Heading mirrors the built-in Context block: bold label in body color,
        // muted suffix on the same line. The project name is appended only when
        // the session sits below the project root, where it adds orientation;
        // at the root itself the sidebar is already scoped, so it is noise.
        const inSubdir = here !== null && dir !== undefined && dir !== here;
        return (
          <>
            <text fg={p.text} minWidth={0}>
              <span>
                <b>Code intel</b>
              </span>
              {inSubdir ? (
                <span fg={p.muted} flexGrow={1}>
                  {leafOf(here as string)}
                </span>
              ) : null}
            </text>
            {!here ? (
              <text fg={p.muted}>no server for this directory</text>
            ) : (
              sortedMine.map((inst) => <ToolRow inst={inst} p={p} />)
            )}
          </>
        );
      })()}
    </box>
  );
}

export const CodeIntelBlock = (props: { ctx: any }) => {
  const servers = useServers(SERVERS_POLL_MS);
  return <ServersBlock ctx={props.ctx} instances={servers.read} />;
};

export default Plugin.define({
  id: "codeintel-tui",
  setup(ctx) {
    if (process.env.CODEINTEL_TUI_DISABLE === "1") return;
    ctx.ui.slot({
      append: "sidebar.content",
      render: () => <CodeIntelBlock ctx={ctx} />,
    });
  },
});
