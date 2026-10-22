// mcp-route — per-location routing to the socket-activated serena/fallback MCP endpoints.
//
// OpenCode's `mcp.servers` is a single global map, but the socket-activated
// instances are project-bound: serena via `--project`, the fallback via the unit's
// `WorkingDirectory=`. Neither can be expressed declaratively, so this plugin
// rewrites the `serena`/`cclsp` entries per location using `ctx.mcp.transform`,
// which OpenCode reconciles into server lifecycle.
//
// The MCP entry is still NAMED `cclsp` even though the backend behind it is now
// mcpls (the cclsp package is retired — the binary stays installed only for
// rollback, and nothing runs it — see docs/cclsp-retirement.md). The name is the
// routing slot; renaming it would touch the systemd templates, all instance
// confs, and the test fixtures.
//
// The route table is DERIVED from the instance conf files, which already hold
// the project root and the ports. Those confs stay the single source of truth.
// When they change on disk, the change is detected and `reload()` reapplies the
// transform.
//
// Policy:
//   - Location inside a known project root -> both servers enabled as `remote`
//     at that project's endpoints. Per project policy, the fallback backend
//     stays enabled alongside serena to cover extensions serena cannot serve
//     (.pkl, ...).
//   - Location outside every known root -> both servers disabled. Code
//     intelligence is an explicit act: an unrouted directory gets nothing
//     rather than a stdio fallback, which would reintroduce per-location
//     process duplication.
//
// The transform is total and non-throwing: any unexpected input disables both
// servers. It runs inside a reconciliation loop the user cannot see, so a
// thrown exception must never be the failure mode.
//
// Scope: the location directory is captured once, when the plugin instance
// loads. OpenCode loads one instance per location, which is what makes
// per-location routing possible, but a session that changes its working
// directory after load keeps the servers it was loaded with. MCP routing is
// therefore per-location, not per-session. This is a platform constraint, not a
// choice: MCP server config is resolved per location and the session id is only
// call metadata, delivered after routing has already selected servers. A
// session that moves and provisions elsewhere (/lsp) can therefore diverge from
// the route; /lsp reports that divergence. See codeintel/location.
//
// A location has two forms — `project.canonical` and `directory` — and they can
// disagree (a symlinked or cross-mounted root). `codeintel/location` prefers
// canonical, so the router matches both and takes the longest matching root
// across them; see `lookup`.
//
// Env: MCP_ROUTE_DISABLE=1 disables routing for the session.

import { readdir, readFile, stat } from "node:fs/promises";
import { containingRoot } from "./codeintel/core";
import { instanceDirectory } from "./codeintel/location";

const HOME = process.env.HOME ?? "";
const SERENA_DIR = `${HOME}/.config/serena/instances`;
const CCLSP_DIR = `${HOME}/.config/cclsp/instances`;
const SERVER_NAMES = ["serena", "cclsp"] as const;
const WATCH_INTERVAL_MS = 5000;

type Route = { serena?: number; cclsp?: number };
type Table = Map<string, Route>;

// Number.isInteger only proves the type. A conf carrying 0, a negative, or an
// out-of-range port must not become an enabled server pointed at a URL that
// cannot connect.
export function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

export function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

async function readRoutes(
  dir: string,
  projectKey: string,
  portKey: string,
): Promise<Array<[string, number]>> {
  const entries: Array<[string, number]> = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return entries;
  }
  for (const file of files) {
    if (!file.endsWith(".conf")) continue;
    try {
      const conf = parseConf(await readFile(`${dir}/${file}`, "utf8"));
      const project = conf[projectKey];
      const port = Number.parseInt(conf[portKey] ?? "", 10);
      if (!project || !isPort(port)) continue;
      entries.push([project, port]);
    } catch {
      // unreadable or malformed conf — skip; a missing route disables the server
    }
  }
  return entries;
}

async function buildTable(): Promise<Table> {
  const table: Table = new Map();
  for (const [project, port] of await readRoutes(
    SERENA_DIR,
    "SERENA_PROJECT",
    "SERENA_PROXY_PORT",
  )) {
    table.set(project, { ...(table.get(project) ?? {}), serena: port });
  }
  for (const [project, port] of await readRoutes(CCLSP_DIR, "CCLSP_PROJECT", "CCLSP_PROXY_PORT")) {
    table.set(project, { ...(table.get(project) ?? {}), cclsp: port });
  }
  return table;
}

// Cheap fingerprint of the conf directories, used to detect change without
// parsing the files on every poll.
async function fingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const dir of [SERENA_DIR, CCLSP_DIR]) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      parts.push(`${dir}:missing`);
      continue;
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".conf")) continue;
      try {
        const info = await stat(`${dir}/${file}`);
        parts.push(`${dir}/${file}:${info.size}:${info.mtimeMs}`);
      } catch {
        parts.push(`${dir}/${file}:gone`);
      }
    }
  }
  return parts.join("|");
}

// Longest-prefix match: the location may be a subdirectory of a project root,
// so choose the most specific root that contains it. Every candidate form is
// considered and the longest matching root wins ACROSS forms, not per form:
// `instanceDirectory` prefers `project.canonical`, but a session opened on a
// subdirectory has canonical at the repository root while its directory may sit
// under a more specific conf, so consulting only the preferred form can both
// miss a route and pick the wrong one.
export function lookup(table: Table, directory: string, alternate?: string): Route | undefined {
  const candidates = [directory, alternate].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  // The most specific root wins ACROSS candidate forms, not per form — one
  // `containingRoot` call over all of them does that by construction, and it is
  // the same rule the sidebar uses to attribute a session to a project.
  let best: string | null = null;
  for (const candidate of candidates) {
    const match = containingRoot(table.keys(), candidate.replace(/\/+$/, "") || "/");
    if (match !== null && (best === null || match.length > best.length)) best = match;
  }
  if (best === null) return undefined;
  // `containingRoot` returns a NORMALISED root, which is not necessarily the
  // table's own spelling of that root (a conf key may carry a trailing slash).
  // The route belongs to the key, so map back to it.
  const key = table.has(best)
    ? best
    : [...table.keys()].find((k) => (k.replace(/\/+$/, "") || "/") === best);
  return key === undefined ? undefined : table.get(key);
}

// One notice per (server, directory): applyRoute runs on every transform and on
// each reconcile, so the warning must not repeat. Keyed by server+directory so a
// location change re-arms it.
const notified = new Set<string>();

// `seen` is injectable so a test can assert on the notice set without mutating
// the module singleton (which would make tests order-dependent).
export function applyRoute(
  editor: any,
  route: Route | undefined,
  directory: string,
  seen: Set<string> = notified,
): void {
  for (const name of SERVER_NAMES) {
    const port = route?.[name];
    if (!isPort(port)) {
      // Unrouted: disable rather than fall back to a per-location stdio server.
      // The URL is irrelevant while disabled, but V2 requires one on a `remote`
      // entry (a url-less entry is silently dropped), so a non-routable
      // placeholder is used. OpenCode does not dial a disabled entry, so this
      // alone produces no failure; the notice below explains the state without
      // dressing it up as a connection error.
      editor.set(name, { type: "remote", url: "http://127.0.0.1:0/mcp", disabled: true });
      if (route !== undefined) {
        // The location is inside a known project root but this server has no
        // instance there: serena is provisioned on demand, so a cclsp-only root
        // lands here by design. Say so once, naming the project.
        const key = `${name}\u0000${directory}`;
        if (!seen.has(key)) {
          seen.add(key);
          console.warn(
            `[mcp-route] ${name} is not provisioned for ${directory} ` +
              `(the location is routed, but has no ${name} instance). ` +
              `This is not a connection failure — ${name} is disabled here; ` +
              `provision it to enable it` +
              (name === "cclsp"
                ? " (run /lsp, or use the mcp-instance tool)."
                : " (use the serena-instance tool)."),
          );
        }
      }
      continue;
    }
    editor.set(name, { type: "remote", url: `http://127.0.0.1:${port}/mcp`, disabled: false });
  }
}

export default {
  id: "mcp-route",
  setup: async (ctx: any) => {
    if (process.env.MCP_ROUTE_DISABLE === "1") return;

    const mcp = ctx?.mcp;
    if (!mcp?.transform || !mcp?.reload) {
      console.warn("[mcp-route] ctx.mcp.transform/reload unavailable — plugin disabled");
      return;
    }

    // Baseline the fingerprint BEFORE reading the confs: a conf written while
    // this setup runs must show up as a change on the first tick rather than
    // being absorbed into the baseline and never reloaded.
    let last = await fingerprint();
    let table: Table;
    try {
      table = await buildTable();
    } catch (error) {
      console.warn("[mcp-route] failed to read instance confs — routing disabled:", error);
      return;
    }

    const directory: string = instanceDirectory(ctx);
    // The unresolved form, consulted alongside the preferred one: the two can
    // name different paths (a symlinked or cross-mounted root), and neither is
    // reliably the more specific of the two.
    const alternate: string | undefined = ctx?.location?.directory;

    const registration = await mcp.transform((editor: any) => {
      // Total and non-throwing: the transform runs inside OpenCode's
      // reconciliation loop, so it must never raise.
      try {
        applyRoute(editor, lookup(table, directory, alternate), directory);
      } catch (error) {
        console.warn("[mcp-route] transform failed — disabling code-intelligence servers:", error);
        try {
          applyRoute(editor, undefined, directory);
        } catch {
          // nothing further can be done from inside the transform
        }
      }
    });

    // Apply the table just built. The transform only takes effect on a
    // reconcile, and the tick below returns early while the fingerprint is
    // unchanged — so without this call a conf that already existed at setup is
    // absorbed into the baseline and never applied, and the entry keeps its
    // shipped `disabled: true`. That state is indistinguishable from an
    // unprovisioned project, which is the failure this prevents.
    await mcp.reload();

    const interval = setInterval(async () => {
      try {
        const next = await fingerprint();
        if (next === last) return;
        last = next;
        table = await buildTable();
        await mcp.reload();
      } catch (error) {
        console.warn("[mcp-route] conf change handling failed:", error);
      }
    }, WATCH_INTERVAL_MS);
    if (typeof interval?.unref === "function") interval.unref();

    return () => {
      clearInterval(interval);
      return registration?.dispose?.();
    };
  },
};
