// codeintel/snapshot — recovers the serena / fallback backend and language-server
// state for any panel that draws it.
//
// V2 removed the in-process LSP that V1's sidebar rendered from `sync.data.lsp`,
// so there is no API to list language servers. The truth is recovered from the
// two socket-activated MCP backends: the instance confs (read via the core
// reader) give the project<->port map, ONE `systemctl` list gives backend
// liveness and every MainPID, and ONE `ps -e` snapshot gives each backend's
// spawned language servers, walked in memory.
//
// Pure: node builtins + the core reader only, no Solid, so this is a legal
// import for a renderer and for a headless caller alike. It complements rather
// than duplicates `codeintel doctor`: doctor asks whether a language server is
// ATTACHED behind one instance (via `get_tool_support`, one subprocess and one
// MCP round trip per instance), while this reads the whole host in two
// subprocesses — every backend, every MainPID, every descendant — for a panel
// that must repaint on an interval. Neither answers the other's question.

import { CCLSP, SERENA } from "./descriptors";
import { containingRoot, leafOf, projectParent, readConfs, type ConfSource } from "./core";

// `seen` is bounded so a pathological tree cannot grow the panel forever; a
// language-server set this large would itself be the anomaly worth surfacing.
const MAX_SEEN = 32;

// The two servers the panel draws, as conf sources PLUS the two facts the panel
// adds: the tool slug it prints and the BACKEND unit template whose liveness it
// reads.
//
// Derived from the descriptors rather than restating them. A copy is how the
// instance directory or a `*_PROJECT` key comes to be spelled one way here and
// another in the module that writes the conf — and the two units differ from the
// descriptor's `unit` on purpose: a descriptor's unit is the SOCKET template
// (`serena-mcp@<port>.socket`, what an agent connects to), while liveness and
// MainPID belong to the BACKEND service behind it (`serena-backend@<port>.service`,
// the process that spawns language servers). `serena-mcp@.service` is only
// systemd-socket-proxyd, so a running proxy would report an LSP subtree that does
// not exist.
//
// The backend template is the descriptor's with its `-mcp` suffix replaced by
// `-backend`, so the two unit families are spelled once — in the descriptors,
// where the socket side already lives. Every reader below (`readBackendState`'s
// globs and `assembleServers`'s lookup key) goes through these two functions, so
// a renamed backend template cannot leave one of them asking about a unit that no
// longer exists.
const BACKEND_SUFFIX = "-backend";

function backendUnit(tool: "serena" | "cclsp"): string {
  return `${SERVED[tool].unit.replace(/-mcp$/, "")}${BACKEND_SUFFIX}`;
}

function instanceUnit(inst: Instance): string {
  return `${backendUnit(inst.tool)}@${inst.proxyPort}.service`;
}

const SERVED: Record<"serena" | "cclsp", { conf: ConfSource; unit: string }> = {
  serena: { conf: SERENA, unit: SERENA.unit },
  cclsp: { conf: CCLSP, unit: CCLSP.unit },
};

const SOURCES: Array<ConfSource & { tool: "serena" | "cclsp" }> = (
  ["serena", "cclsp"] as const
).map((tool) => ({ ...SERVED[tool].conf, tool }));

export type Instance = {
  tool: "serena" | "cclsp";
  project: string;
  proxyPort: number;
};

export type ServerInstance = Instance & {
  running: boolean;
  servers: string[];
  // Servers observed since the memory was created, in first-seen order. A server
  // that has spawned once stays listed (dimmed) after it exits, so the panel
  // does not reshuffle as LSPs come and go. The memory itself is a value the
  // caller owns and threads back in (`ServerMemory`), not module state: two
  // mounts of the panel must not share it, and a component that is torn down
  // must take its history with it.
  seen: string[];
};

// Sticky `seen` sets, keyed by tool+project. Owned by whoever polls (see
// `useServers`); this module only transforms it.
export type ServerMemory = Map<string, string[]>;

export function newServerMemory(): ServerMemory {
  return new Map();
}

// The language-server registry, in one table: the command-line marker that
// identifies a running server, its display name, and the languages it covers.
// Order matters — the more specific marker wins in `resolveServer`. A server
// covering a single language renders without a tail; the polyglot servers (deno,
// vtsls, typescript-language-server, the JSON/YAML servers whose file match is
// broader than their name) are why the coverage list exists — a bare `json` or
// `vtsls` understates what the user can edit.
//
// `broken` marks a server that is catalogued but known not to work under this
// host, so the panel flags it "present but non-functional" rather than implying
// a healthy LSP. The flag is advisory: the panel renders a glyph, nothing is
// disabled here. The rows stay because removing one would hide the gap; the
// reproduction for each, and the history of the removed `csharp` route, are in
// `docs/cclsp-retirement.md`.
//
// The two C# rows are both real here and must stay ordered: `omnisharp` is the
// fallback backend's server, `roslyn` is serena's own and the one that actually
// serves C#. A broader C# marker added later must not swallow either.
export const SERVERS: Array<{
  marker: RegExp;
  name: string;
  languages: string[];
  broken?: boolean;
}> = [
  {
    marker: /typescript-language-server/,
    name: "ts",
    languages: ["typescript", "tsx", "javascript", "jsx"],
  },
  { marker: /vtsls/, name: "vtsls", languages: ["typescript", "tsx", "javascript", "jsx"] },
  {
    marker: /deno/,
    name: "deno",
    languages: ["typescript", "tsx", "javascript", "jsx", "json", "markdown"],
  },
  { marker: /pyright/, name: "pyright", languages: ["python"] },
  { marker: /gopls/, name: "gopls", languages: ["go"] },
  { marker: /rust-analyzer/, name: "rust", languages: ["rust"] },
  { marker: /clangd/, name: "clangd", languages: ["c", "cpp"] },
  { marker: /vscode-json-languageserver/, name: "json", languages: ["json", "jsonc"] },
  { marker: /yaml-language-server/, name: "yaml", languages: ["yaml"] },
  { marker: /marksman/, name: "markdown", languages: ["markdown"] },
  { marker: /taplo/, name: "toml", languages: ["toml"] },
  { marker: /bash-language-server/, name: "bash", languages: ["bash"] },
  { marker: /terraform-ls/, name: "terraform", languages: ["terraform"] },
  { marker: /pkl-lsp/, name: "pkl", languages: ["pkl"], broken: true },
  { marker: /omnisharp/, name: "omnisharp", languages: ["csharp"], broken: true },
  { marker: /roslyn/, name: "roslyn", languages: ["csharp"] },
  { marker: /dart/, name: "dart", languages: ["dart"] },
];

// A server's language tokens. The curated table wins; otherwise the name is
// itself the language (the overwhelmingly common 1:1 case).
export function languagesOf(server: string): string[] {
  return SERVERS.find((s) => s.name === server)?.languages ?? [server];
}

// Whether a server is catalogued-but-known-broken (see the SERVERS comment).
// The panel renders a warning glyph for these; it does not affect anything else.
export function isBroken(server: string): boolean {
  return SERVERS.find((s) => s.name === server)?.broken === true;
}

// The tail a language-server row prints: its coverage list, unless that list is
// just the name again (`gopls` → `go`, but `toml` → nothing).
export function tailOf(server: string): string {
  const languages = languagesOf(server);
  return languages.length === 1 && languages[0] === server ? "" : languages.join(" ");
}

// A process's argv as `ps` printed it, minus its arguments. Exported because it
// is what `resolveServer` classifies, and a test that restates this split is a
// test of its own copy.
//
// An interpreter is peeled to the script it runs: `/usr/bin/python3 …/pylsp` is
// pylsp, not python, and `/usr/bin/dotnet …/LanguageServer.dll` is the C# server
// rather than dotnet. Only the common launchers are peeled — a general "argv[0]
// is not the server" heuristic would need a table of its own — and flags are
// skipped, because `dotnet --roll-forward Major x.dll` and `node --inspect
// server.js` both put the script behind an option.
const LAUNCHERS = /^(python[\d.]*|node|dotnet|java|sh|bash)$/;

export function commandOf(args: string): string {
  const argv = args.trim().split(/\s+/).filter(Boolean);
  const exec = argv[0] ?? "";
  if (!LAUNCHERS.test(exec.split("/").pop() ?? "")) return exec;
  return argv.slice(1).find((a) => !a.startsWith("-")) ?? exec;
}

// The server name for one process's argv: the first marker whose row matches the
// COMMAND (argv[0], or the script an interpreter was given), else null. Matching
// the command rather than the whole line is what keeps `/dart/` from claiming a
// `dart` argument on an unrelated process, and `/deno/` from claiming a path
// through a directory named deno. The line as a whole is tried only when
// `commandOf` could not get past a launcher — `sh -c gopls` names the server
// nowhere in argv[0] — and `sh`/`bash` are excluded from that second pass
// because their `-c` string says everything about the server and nothing about
// the process that would still be running if it were the server.
const SHELLS = /^(sh|bash)$/;

export function resolveServer(args: string): string | null {
  const command = commandOf(args);
  for (const { marker, name } of SERVERS) if (marker.test(command)) return name;
  if (SHELLS.test((args.trim().split(/\s+/)[0] ?? "").split("/").pop() ?? "")) {
    for (const { marker, name } of SERVERS) if (marker.test(args)) return name;
  }
  return null;
}

async function readInstances(): Promise<Instance[]> {
  const out: Instance[] = [];
  for (const source of SOURCES) {
    for (const conf of await readConfs(source)) {
      out.push({
        tool: source.tool,
        project: conf.project,
        proxyPort: conf.proxyPort,
      });
    }
  }
  return out;
}

// What one `list-units` read gives the poll: which backend units are running,
// and the MainPID of each. `active` is null when systemctl could not be read —
// "unknown", which the panel renders as off but must not confuse with "verified
// stopped" when deciding whether to trust an empty LSP list.
export type BackendState = {
  active: Set<string> | null;
  mainPid: Map<string, number>;
};

// One `systemctl --user show` for both backend templates, asking only the two
// properties the poll needs. This replaces two subprocesses per instance (and,
// before that, a `show` inside the row loop) with ONE call for every instance:
// `show` accepts several units and, with `--value`, prints one line per unit per
// property in unit-then-property order, so RUNNING/PID triples are read off in
// a single pass. Columns: Id ActiveState MainPID.
export async function readBackendState(): Promise<BackendState> {
  const state: BackendState = { active: null, mainPid: new Map() };
  try {
    const proc = Bun.spawn(
      [
        "systemctl",
        "--user",
        "show",
        "-p",
        "Id",
        "-p",
        "ActiveState",
        "-p",
        "MainPID",
        `${backendUnit("serena")}@*.service`,
        `${backendUnit("cclsp")}@*.service`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const active = new Set<string>();
    for (const block of text.split(/\n\s*\n/)) {
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1));
      }
      const unit = fields.get("Id");
      if (!unit) continue;
      if (fields.get("ActiveState") === "active") active.add(unit);
      const pid = Number.parseInt(fields.get("MainPID") ?? "", 10);
      if (Number.isInteger(pid) && pid > 0) state.mainPid.set(unit, pid);
    }
    state.active = active;
  } catch {
    // systemctl unavailable — liveness is unknown, not "everything is down".
  }
  return state;
}

type Proc = { ppid: number; args: string };

// One `ps -e` snapshot for the whole process table, keyed by pid. Walking the
// tree in memory replaces a `pgrep`+`ps` spawn per descendant and removes the
// pgrep->ps race entirely.
async function readProcessTable(): Promise<Map<number, Proc>> {
  const table = new Map<number, Proc>();
  try {
    const proc = Bun.spawn(["ps", "-e", "-o", "pid=,ppid=,args="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
    }
  } catch {
    // ps unavailable — no LSP names this poll
  }
  return table;
}

// Ancestor->descendant map built once per poll, so a backend MainPID can be
// resolved to its whole subtree without further subprocesses.
export function buildChildren(table: Map<number, Proc>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const [pid, proc] of table) {
    const list = children.get(proc.ppid);
    if (list) list.push(pid);
    else children.set(proc.ppid, [pid]);
  }
  return children;
}

// Every catalogued server in `rootPid`'s subtree, sorted and deduplicated. A
// process whose argv names no catalogued server is walked THROUGH, not skipped:
// a launcher or wrapper sits between a backend and the LSP it started.
//
// Exported with `buildChildren` because both were pure and unexported, so the
// only way to exercise them was through `assembleServers` — which never passed a
// shared parent, a cycle or a deep chain. `visited` is what makes the walk safe
// against the one shape `ps` cannot honestly exclude: a pid whose parent link
// points back down the tree, which would otherwise spin forever and take the TUI
// with it.
export function lspNamesUnder(
  rootPid: number,
  children: Map<number, number[]>,
  table: Map<number, Proc>,
): string[] {
  const names = new Set<string>();
  const visited = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      const args = table.get(child)?.args ?? "";
      const name = resolveServer(args);
      if (name) names.add(name);
      queue.push(child);
    }
  }
  return [...names].sort();
}

// The poll assembly, pure: it takes the three observations (instance confs, the
// backend state, the keyed process table) plus the memory it must extend, and
// returns the sorted rows and the memory to pass back next poll. No spawn, no
// fs, and no module state — the caller owns both the reads and the memory.
//
// `memory` is REQUIRED, with no default. A default here was a silent reset: the
// first poll would work and every later one would forget the servers it had
// already seen, because each call would start from an empty map. The type cannot
// tell "a new poller" from "a poller that forgot", so the caller must say which.
export function assembleServers(
  instances: Instance[],
  backends: BackendState,
  table: Map<number, Proc>,
  memory: ServerMemory,
): { rows: ServerInstance[]; memory: ServerMemory } {
  const children = buildChildren(table);
  const next: ServerMemory = new Map();
  const rows: ServerInstance[] = [];

  for (const inst of instances) {
    const unit = instanceUnit(inst);
    const running = backends.active?.has(unit) === true;
    const pid = running ? (backends.mainPid.get(unit) ?? null) : null;
    const live = pid === null ? [] : lspNamesUnder(pid, children, table);

    // Only a row with something live is worth remembering, and only keys for
    // instances that still exist are carried forward: the map stays O(running)
    // and a deleted conf takes its history with it.
    const key = `${inst.tool}\u0000${inst.project}`;
    const known = [...(memory.get(key) ?? [])];
    for (const server of live) {
      if (!known.includes(server) && known.length < MAX_SEEN) known.push(server);
    }
    next.set(key, known);

    rows.push({ ...inst, running, servers: live, seen: [...known].sort() });
  }

  // Running instances first, then by tool then project.
  rows.sort((a, b) =>
    a.running === b.running
      ? a.tool === b.tool
        ? a.project.localeCompare(b.project)
        : a.tool.localeCompare(b.tool)
      : a.running
        ? -1
        : 1,
  );
  return { rows, memory: next };
}

// Three subprocesses total per poll (`ps`, one `show` for every backend, and the
// conf reads), launched together. MainPID comes from the same `show` as
// liveness, so the cost no longer grows with the number of running backends.
//
// `memory` is required for the same reason it is on `assembleServers`: with a
// default, a caller that forgot to thread it back got a panel that silently
// forgot every server between polls, and nothing failed.
export async function readServers(memory: ServerMemory): Promise<{
  rows: ServerInstance[];
  memory: ServerMemory;
}> {
  const [instances, backends, table] = await Promise.all([
    readInstances(),
    readBackendState(),
    readProcessTable(),
  ]);
  return assembleServers(instances, backends, table, memory);
}

// Does the session's directory fall under this instance's project root? The
// rule is `core.containingRoot`'s — segment-wise, longest match — because the
// router answers the same question over the same keys, and two statements of it
// is how the panel comes to attribute a session to one project while mcp-route
// routes it to another.
export function currentProject(
  directory: string | undefined,
  instances: ServerInstance[],
): string | null {
  if (!directory) return null;
  return containingRoot(
    instances.map((i) => i.project),
    directory,
  );
}

// Basename of a project path; the sidebar shows one project at a time, so the
// leaf is the only segment worth spending columns on.
export { leafOf };

// The parent directory, abbreviated, or null when there is nothing to
// disambiguate with (a top-level project).
export function parentOf(project: string): string | null {
  return projectParent(project);
}
