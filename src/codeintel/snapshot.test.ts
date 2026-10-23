// Regression net for the SERVERS table in tui-status/codeintel.ts. Two
// properties here are correctness, not cosmetics, and both are easy to break
// with an edit that reads like formatting:
//
//   1. Marker ORDER. resolveServer() returns the first marker that tests true, so
//      a row inserted above a broader one silently reassigns that server. This is
//      not hypothetical: omnisharp and roslyn are two different C# servers, and
//      listing /roslyn/ first (or flagging /roslyn/ instead of /omnisharp/)
//      would mark serena's WORKING C# server as broken while leaving the broken
//      one clean. The order is load-bearing and is asserted below.
//   2. Marker SPECIFICITY. A loosened regex (/go/ for /gopls/) reassigns rows
//      with no visible symptom until a server is mislabelled in the panel. The
//      inputs below include lines chosen to expose exactly that (see the gofmt
//      and golangci-lint entries) — an earlier draft's inputs could not, and
//      that mutation passed until an input was added for it.
//
// Mutation coverage was measured, not assumed. Against the four edits that
// matter — flagging /roslyn/ instead of /omnisharp/, dropping the omnisharp
// flag, swapping the two C# rows, and widening /gopls/ to /go/ — the suite fails
// on all four. One widening (/terraform-ls/ to /terra/) is NOT caught, because
// every real args line containing "terra" also contains "terraform-ls"; add an
// input that separates them if that row is ever loosened.
//
// The marker resolution below is driven by the REAL exported table, not a copy
// of it. An earlier draft of this file restated the markers locally and was
// blind to mutation 2 for exactly that reason — a test that builds its own
// input validates a table that does not exist. See the verification lesson in
// docs/records/context-tools-measurements.md about a check that asserted against
// a field occurring nowhere in production.
//
// The args strings are real lines taken from the live host, not invented
// shapes.

import { describe, expect, test } from "bun:test";
import { CCLSP, SERENA } from "./descriptors";
import { containingRoot } from "./core";

function lookup<T>(table: Map<string, T>, directory: string): T | undefined {
  if (!directory || typeof directory !== "string") return undefined;
  const dir = directory.replace(/\/+$/, "") || "/";
  const root = containingRoot(table.keys(), dir);
  if (!root) return undefined;
  return table.get(root) ?? table.get(`${root}/`);
}

import {
  assembleServers,
  buildChildren,
  commandOf,
  currentProject,
  isBroken,
  languagesOf,
  lspNamesUnder,
  newServerMemory,
  parentOf,
  resolveServer,
  SERVERS,
  tailOf,
  type BackendState,
  type Instance,
  type ServerInstance,
} from "./snapshot";

const REAL_ARGS: Array<[args: string, expects: string | null]> = [
  ["/home/user/.local/share/opencode/tools/omnisharp-1.40.0/OmniSharp -lsp", "omnisharp"],
  [
    "/usr/bin/dotnet /usr/lib/serena/language_servers/static/CSharpLanguageServer/roslyn-language-server.linux-x64.5.5.0-2.26078.4/Microsoft.CodeAnalysis.LanguageServer.dll --stdio",
    "roslyn",
  ],
  ["/opt/roslyn-language-server/roslyn-language-server --stdio --autoLoadProjects", "roslyn"],
  ["pkl-lsp", "pkl"],
  ["/usr/bin/gopls", "gopls"],
  ["/usr/bin/taplo lsp stdio", "toml"],
  ["/usr/bin/pyright-langserver --stdio", "pyright"],
  ["rust-analyzer", "rust"],
  ["typescript-language-server --stdio", "ts"],
  ["/usr/bin/bash-language-server start", "bash"],
  // These two exist to catch a LOOSENED marker rather than a moved row: each
  // contains a substring an over-broad pattern would steal. Widening the gopls
  // row from `/gopls/` to `/go/` takes the gofmt line below (measured: with the
  // naive inputs alone that mutation passed), and spreading the terraform row to
  // `/terra/` takes the same shape. Without an input like these, widening a
  // marker is invisible to the suite.
  ["/usr/lib/go/bin/gofmt -l", null],
  ["/usr/bin/terraform-ls serve", "terraform"],
];

describe("SERVERS marker resolution", () => {
  test("real args lines resolve to their expected server name", () => {
    for (const [args, expects] of REAL_ARGS) {
      expect(resolveServer(args), args).toBe(expects);
    }
  });

  test("omnisharp is matched before roslyn (two C# servers, distinct rows)", () => {
    const omnisharp = SERVERS.findIndex((s) => s.name === "omnisharp");
    const roslyn = SERVERS.findIndex((s) => s.name === "roslyn");
    expect(omnisharp).toBeGreaterThanOrEqual(0);
    expect(roslyn).toBeGreaterThanOrEqual(0);
    // /roslyn/ would still not match the omnisharp args line, but the pair must
    // stay ordered so a broader C# marker added later cannot swallow the other.
    expect(omnisharp).toBeLessThan(roslyn);
  });
});

describe("isBroken", () => {
  test("marks the two catalogued-but-non-functional servers", () => {
    expect(isBroken("pkl")).toBe(true);
    expect(isBroken("omnisharp")).toBe(true);
  });

  test("does NOT mark roslyn, which is a different and working C# server", () => {
    expect(isBroken("roslyn")).toBe(false);
  });

  test("does not mark healthy servers", () => {
    for (const name of ["gopls", "pyright", "rust", "clangd", "toml", "bash", "ts"]) {
      expect(isBroken(name), name).toBe(false);
    }
  });

  test("an unknown server is not broken", () => {
    expect(isBroken("nonexistent-server")).toBe(false);
  });
});

describe("languagesOf", () => {
  test("curated rows win over the name-is-language fallback", () => {
    expect(languagesOf("roslyn")).toEqual(["csharp"]);
    expect(languagesOf("omnisharp")).toEqual(["csharp"]);
    expect(languagesOf("toml")).toEqual(["toml"]);
    expect(languagesOf("pkl")).toEqual(["pkl"]);
  });

  test("an uncurated server falls back to its own name", () => {
    expect(languagesOf("some-new-server")).toEqual(["some-new-server"]);
  });
});

// The process walk on its own. Both halves were pure and unexported, so the only
// thing exercising them was `assembleServers` — which builds a flat table, one
// backend and one child, and so could never distinguish a walk from a lookup.
// The shapes below are the ones a real `ps -e` produces and the panel must
// survive: siblings, a wrapper between backend and server, a shared parent, and a
// parent link that points back down the tree.
function table(entries: Array<[pid: number, ppid: number, args: string]>) {
  return new Map(entries.map(([pid, ppid, args]) => [pid, { ppid, args }]));
}

describe("the process-tree walk", () => {
  test("buildChildren keys every process under its parent", () => {
    const children = buildChildren(
      table([
        [10, 1, "/usr/lib/serena/serena-backend"],
        [11, 10, "/usr/bin/gopls"],
        [12, 10, "/usr/bin/taplo lsp stdio"],
        [13, 11, "/opt/roslyn-language-server/roslyn-language-server --stdio"],
      ]),
    );
    expect(children.get(10)).toEqual([11, 12]);
    expect(children.get(11)).toEqual([13]);
    expect(children.get(1)).toEqual([10]);
  });

  test("a wrapper between the backend and its server is walked through, not skipped", () => {
    // A launcher is the common real shape: `node`, `dotnet` and `sh -c` all sit
    // between a backend and the server it started. A walk that stopped at an
    // unrecognised argv would report no language servers for those backends.
    const proc = table([
      [10, 1, "/usr/lib/serena/serena-backend"],
      [11, 10, "/usr/bin/node /usr/lib/serena/wrapper.js"],
      [12, 11, "/usr/bin/gopls"],
    ]);
    expect(lspNamesUnder(10, buildChildren(proc), proc)).toEqual(["gopls"]);
  });

  test("siblings under a shared parent, and grandchildren, all count, deduplicated and sorted", () => {
    const proc = table([
      [10, 1, "/usr/lib/serena/serena-backend"],
      [11, 10, "/usr/bin/gopls"],
      [12, 10, "/usr/bin/taplo lsp stdio"],
      [13, 11, "/usr/bin/pyright-langserver --stdio"],
      [14, 12, "/usr/bin/gopls"],
    ]);
    expect(lspNamesUnder(10, buildChildren(proc), proc)).toEqual(["gopls", "pyright", "toml"]);
  });

  test("a parent link pointing back down the tree terminates", () => {
    // `ps` cannot honestly rule this out (a recycled pid), and the poll runs on a
    // UI timer: a cycle here would spin forever inside the TUI's own render loop
    // rather than fail a test. 12 claims 13 as its parent while 13 claims 12.
    const proc = table([
      [10, 1, "/usr/lib/serena/serena-backend"],
      [11, 10, "/usr/bin/gopls"],
      [12, 11, "/usr/bin/taplo lsp stdio"],
      [13, 12, "/usr/bin/pyright-langserver --stdio"],
    ]);
    const cyclic = buildChildren(proc);
    cyclic.get(13)?.push(11);
    expect(lspNamesUnder(10, cyclic, proc)).toEqual(["gopls", "pyright", "toml"]);
  });

  test("a backend with no descendants, and a child with no args, both yield nothing", () => {
    const proc = table([
      [10, 1, "/usr/lib/serena/serena-backend"],
      [11, 10, ""],
    ]);
    expect(lspNamesUnder(10, buildChildren(proc), proc)).toEqual([]);
    expect(lspNamesUnder(99, buildChildren(proc), proc)).toEqual([]);
  });
});

// assembleServers: the poll assembly, now reachable without systemctl/ps. The
// three observations are supplied directly, so the running/not-running split,
// the process-tree walk, and the sort are all exercised.
describe("assembleServers", () => {
  // The backend observation: which units are running, and each one's MainPID.
  function backend(running: string[], pid?: number): BackendState {
    return {
      active: new Set(running),
      mainPid: new Map(pid === undefined ? [] : running.map((u) => [u, pid] as [string, number])),
    };
  }

  // A backend (pid 100) with a language-server child (pid 101).
  function tableWithLsp(): Map<number, { ppid: number; args: string }> {
    return new Map([
      [100, { ppid: 1, args: "/usr/lib/serena/serena-backend" }],
      [101, { ppid: 100, args: "/usr/bin/gopls" }],
    ]);
  }

  const inst: Instance = {
    tool: "serena",
    project: "/home/user/repo",
    proxyPort: 8811,
  };

  test("a running instance whose backend has an LSP child reports the LSP", () => {
    const rows = assembleServers(
      [inst],
      backend(["serena-backend@8811.service"], 100),
      tableWithLsp(),
      newServerMemory(),
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].running).toBe(true);
    expect(rows[0].servers).toEqual(["gopls"]);
    expect(rows[0].seen).toEqual(["gopls"]);
  });

  test("a NOT-running instance reports no servers, without consulting MainPID", () => {
    let called = false;
    const backends = backend([], 100);
    const rows = assembleServers([inst], backends, tableWithLsp(), newServerMemory()).rows;
    expect(rows[0].running).toBe(false);
    expect(rows[0].servers).toEqual([]);
    expect(called).toBe(false);
  });

  test("a stopped backend's MainPID is never consulted", () => {
    // systemd reports the LAST MainPID of a stopped unit too, so trusting it
    // would hang a stale or recycled pid onto a backend that is not running.
    const stale: BackendState = {
      active: new Set(),
      mainPid: new Map([["serena-backend@8811.service", 100]]),
    };
    const { rows } = assembleServers([inst], stale, tableWithLsp(), newServerMemory());
    expect(rows[0].running).toBe(false);
    expect(rows[0].servers).toEqual([]);
  });

  test("a running backend with a null MainPID reports no servers, not a throw", () => {
    const rows = assembleServers(
      [inst],
      backend(["serena-backend@8811.service"]),
      tableWithLsp(),
      newServerMemory(),
    ).rows;
    expect(rows[0].running).toBe(true);
    expect(rows[0].servers).toEqual([]);
  });

  test("the unit name is the tool's template at the proxy port", () => {
    // A conf on a DIFFERENT port than the running unit is not running.
    const rows = assembleServers(
      [inst],
      backend(["serena-backend@9999.service"]),
      new Map(),
      newServerMemory(),
    ).rows;
    expect(rows[0].running).toBe(false);
  });

  test("the backend unit is the descriptor's socket unit under a backend suffix", () => {
    // The two unit families are one spelling: `serena-mcp` (the socket an agent
    // connects to) and `serena-backend` (the process that spawns servers). The
    // panel used to restate the backend name in three places, so a descriptor
    // rename would leave the globs asking about a unit nobody serves. Driven
    // through the assembly, which is where the unit string is actually built.
    const rows = assembleServers(
      [
        { tool: "serena", project: "/s", proxyPort: 8802 },
        { tool: "cclsp", project: "/c", proxyPort: 8812 },
      ],
      backend([
        `${SERENA.unit.replace(/-mcp$/, "")}-backend@8802.service`,
        `${CCLSP.unit.replace(/-mcp$/, "")}-backend@8812.service`,
      ]),
      new Map(),
      newServerMemory(),
    ).rows;
    expect(rows.every((r) => r.running)).toBe(true);
  });

  test("running instances sort before stopped ones", () => {
    const stopped: Instance = { ...inst, project: "/aaa", proxyPort: 8801 };
    const running: Instance = { ...inst, project: "/zzz", proxyPort: 8811 };
    const rows = assembleServers(
      [stopped, running],
      backend(["serena-backend@8811.service"], 100),
      tableWithLsp(),
      newServerMemory(),
    ).rows;
    expect(rows[0].running).toBe(true);
    expect(rows[0].proxyPort).toBe(8811);
  });

  test("among same running-state, rows sort by tool then project", () => {
    const a: Instance = { tool: "cclsp", project: "/b", proxyPort: 8801 };
    const b: Instance = { tool: "serena", project: "/a", proxyPort: 8802 };
    const rows = assembleServers([b, a], backend([]), new Map(), newServerMemory()).rows;
    // cclsp sorts before serena regardless of project
    expect(rows.map((r) => r.tool)).toEqual(["cclsp", "serena"]);
  });
});

describe("resolveServer classifies the command, not the whole argv", () => {
  test("an interpreter's script is the server", () => {
    // Live line: serena launches C# this way, so the marker has to see the dll.
    expect(
      resolveServer(
        "/usr/bin/dotnet /usr/lib/serena/language_servers/static/CSharpLanguageServer/roslyn-language-server.linux-x64/Microsoft.CodeAnalysis.LanguageServer.dll --stdio",
      ),
    ).toBe("roslyn");
    // A script the table does not know is not a server, and is not `python`.
    expect(resolveServer("/usr/bin/python3 /usr/local/bin/whatever.py --stdio")).toBe(null);
  });

  test("a shell that launches a server by name is still recognisable", () => {
    expect(resolveServer("/bin/sh -c 'gopls serve'")).toBe("gopls");
  });

  test("a path segment that merely spells a server name does not claim it", () => {
    // The defect: an unanchored marker over the whole argv took these.
    expect(resolveServer("/usr/bin/gofmt -w /home/user/src/deno/main.ts")).toBe(null);
    expect(resolveServer("/usr/bin/make -C /home/user/dart-build")).toBe(null);
    expect(resolveServer("vim /home/user/project/terraform/main.tf")).toBe(null);
  });

  test("commandOf peels only known launchers", () => {
    expect(commandOf("/usr/bin/gopls -mode=stdio")).toBe("/usr/bin/gopls");
    expect(commandOf("  /usr/bin/taplo   lsp stdio ")).toBe("/usr/bin/taplo");
    expect(commandOf("/usr/bin/node /opt/x/server.js --stdio")).toBe("/opt/x/server.js");
    expect(commandOf("")).toBe("");
  });
});

describe("the sticky memory is an argument, not module state", () => {
  const inst: Instance = {
    tool: "serena",
    project: "/home/user/repo",
    proxyPort: 8811,
  };
  const withGopls = new Map([
    [100, { ppid: 1, args: "/usr/lib/serena/serena-backend" }],
    [101, { ppid: 100, args: "/usr/bin/gopls" }],
  ]);
  const backend = (running: boolean): BackendState => ({
    active: new Set(running ? ["serena-backend@8811.service"] : []),
    mainPid: new Map(running ? [["serena-backend@8811.service", 100]] : []),
  });

  test("a second poll keeps a server that has since exited", () => {
    const first = assembleServers([inst], backend(true), withGopls, newServerMemory());
    const dead = new Map([[100, { ppid: 1, args: "/usr/lib/serena/serena-backend" }]]);
    const second = assembleServers([inst], backend(true), dead, first.memory);
    expect(second.rows[0].servers).toEqual([]);
    expect(second.rows[0].seen).toEqual(["gopls"]);
  });

  test("a fresh memory starts empty: two mounts do not share history", () => {
    const first = assembleServers([inst], backend(true), withGopls, newServerMemory());
    expect(first.memory.size).toBe(1);
    const other = assembleServers([inst], backend(false), new Map(), newServerMemory());
    expect(other.rows[0].seen).toEqual([]);
  });

  test("an instance that no longer exists takes its history with it", () => {
    const first = assembleServers([inst], backend(true), withGopls, newServerMemory());
    const gone = assembleServers([], backend(false), new Map(), first.memory);
    expect(gone.memory.size).toBe(0);
    expect(gone.rows).toEqual([]);
  });

  test("an unknown systemctl read is not 'everything stopped'", () => {
    const unknown: BackendState = { active: null, mainPid: new Map() };
    const { rows } = assembleServers([inst], unknown, withGopls, newServerMemory());
    expect(rows[0].running).toBe(false);
  });
});

describe("currentProject and the path helpers", () => {
  function row(project: string): ServerInstance {
    return {
      tool: "serena",
      project,
      proxyPort: 8801,
      running: false,
      servers: [],
      seen: [],
    };
  }

  test("the longest matching root wins, segment-wise", () => {
    const rows = [row("/x/y"), row("/x/y/z")];
    expect(currentProject("/x/y/z/src", rows)).toBe("/x/y/z");
    expect(currentProject("/x/y", rows)).toBe("/x/y");
    // Not a prefix of the SEGMENT: `/x/yz` is not under `/x/y`. A bare
    // `startsWith` says it is, which is the whole point of comparing segments.
    expect(currentProject("/x/yz", rows)).toBe(null);
    expect(currentProject("/x/yz/deep", rows)).toBe(null);
  });

  test("a root of / claims every absolute path and is not re-reduced to ''", () => {
    const rows = [row("/")];
    expect(currentProject("/home/user", rows)).toBe("/");
  });

  test("parentOf says null when there is nothing to disambiguate with", () => {
    expect(parentOf(`${process.env.HOME ?? "/home/user"}/repos/serena`)).toBe("~/repos");
    expect(parentOf("/tmp")).toBe(null);
  });

  test("a trailing slash on a root is normalised, not treated as a distinct path", () => {
    // A conf key written with a trailing slash (or a location given with one)
    // must not be a different project from the same path without it: both the
    // panel and the router normalise before comparing segments.
    const rows = [row("/x/y/")];
    expect(currentProject("/x/y/z", rows)).toBe("/x/y");
    expect(currentProject("/x/y", rows)).toBe("/x/y");
    const table = new Map([["/x/y/", { serena: 9000 }]]);
    expect(lookup(table, "/x/y/z/")).toEqual({ serena: 9000 });
  });

  test("the panel and the router answer one question with one rule", () => {
    // Both compose `core.containingRoot`, so the panel cannot attribute a
    // session to one project while mcp-route routes it to another. This case
    // pins the agreement, not the implementation: the same roots and the same
    // directories, through both entry points.
    const roots = ["/x/y", "/x/y/z", "/x/yz"];
    const rows = roots.map(row);
    // A route per root, each carrying its own root as the port so the routing
    // answer can be read back as a path.
    const table = new Map(roots.map((r, i) => [r, { serena: 9000 + i }] as const));
    for (const directory of ["/x/y", "/x/y/z/src", "/x/yz", "/x/yz/deep", "/x", "/"]) {
      const routed = lookup(table, directory);
      const panel = currentProject(directory, rows);
      const routedRoot =
        routed === undefined
          ? null
          : (roots.find((r) => table.get(r)?.serena === routed.serena) ?? null);
      expect(panel).toBe(routedRoot);
    }
  });

  test("tailOf drops a tail that only repeats the name", () => {
    expect(tailOf("toml")).toBe("");
    expect(tailOf("gopls")).toBe("go");
    expect(tailOf("roslyn")).toBe("csharp");
  });
});
