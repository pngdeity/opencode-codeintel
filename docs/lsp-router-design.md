# File-keyed LSP router — design

Status: proposal, not implemented.

Supersedes the per-directory instance model (`mcp-instance`, socket-per-project)
as the *primary* mechanism. That model survives only as an accelerator cache.

> **Current system, for contrast.** What actually ships is the *opposite* of this
> proposal: a directory-keyed model, deliberately. Both code-intelligence servers
> run behind socket-activated per-project instances, and `src/mcp-route.ts`
> selects the instance by longest-prefix match on the session's location. That is
> correct for partitioned repositories and is documented in the repository's
> `README.md` and in [cclsp-retirement.md](./cclsp-retirement.md). This document
> is a *future* redesign for the case where work is not confined to such a
> directory; read it as a proposal, not a description of the running system.

## 1. The requirement

> LSP availability must be a function of the **file** being touched, not of the
> **directory** OpenCode was started in.

Every mechanism in the current setup is keyed on a directory fixed at session
start: the fallback backend's `rootDir`, serena's `--project`, `mcp-route`'s
location-prefix lookup, `mcp-instance`'s per-root conf. That key is only correct
when the work is confined to a partitioned repository. The user's own framing:

> LSP is crucial for LLMs to work effectively in OpenCode, but not all work done
> with LLMs in OpenCode is in well-defined partitioned project directories.

So the failure is not "the fallback backend is bad" — it is that the *whole
stack*, the fallback included, is keyed on the wrong axis. The fallback's
per-request, extension-keyed model is closer to correct than the
directory-keyed wrapper around it; its two sins (an eager preload scan, and
`rootDir` resolved from `process.cwd()`) are exactly the two places where it
rejoins the wrong axis.

## 2. What the research established

### 2.1 Serena cannot be the answer (structural)

- `--project` is single-valued (`cli.py:234`); exactly one project is active
  (`agent.py:670-672`). Switching projects calls `shutdown()` on the outgoing
  one (`agent.py:1233-1236` → `project.py:623-626`). Never two alive at once.
- `activate_project` can adopt an unregistered path at runtime and even
  autogenerates + persists a `project.yml` — **but our unit runs
  `--context ide`, and `ide.yml:26` sets `single_project: true`**, which strips
  `ActivateProjectTool` from the session tool set (`agent.py:797-808`).
- `--project-from-cwd` resolves once, at startup (`cli.py:358-372`).
- No file-driven activation path exists anywhere in the package.
- No idle TTL or eviction: language servers live until project shutdown.

Serena is therefore unusable as a file-keyed router under the current flags.
Its niche — deep semantic refactoring on a known project — stands unchanged.

Line numbers above are from the Serena versions named in
[serena.md](./serena.md); re-check them before relying on them, since Serena's
internal module layout moves between releases.

### 2.2 OpenCode V2 does expose a pre-touch hook

The plugin context is a single literal with no `file` namespace. But:

- **`ctx.tool.hook("before", cb)`** fires per tool call, **before execution**,
  with the *decoded* arguments. Registered under the key `tool.before`, called
  as `rs({name, input}, r["tool.before"], ...)` where `input` is the validated
  object. A `read`/`write`/`edit` call therefore exposes `input.file_path`
  before it runs. This is the hook the design needs.
- `ctx.event.subscribe` offers `file.edited` and `filesystem.changed`, both
  post-hoc.
- `ctx.mcp = {list, transform, reload}` — no `add`/`connect`/`register`.
  Dynamic registration means mutating the map inside `transform`, then
  `reload()`.
- `ctx.location` is read-only.

### 2.3 Cost (measured on the development host)

| Thing | RSS | Cold start |
|---|---|---|
| gopls idle | 33.3 MB | 112 ms to accept a connection |
| serena backend (1 project) | 314 MB current / 500 MB peak / 24 tasks | — |
| `cclsp` backend (1 project, preloaded) | 73 MB current / **831 MB peak** / 11 tasks | — |
| `mcpls` backend (1 project, all servers eager) | ~940 MB steady state / **1,007 MB peak** / 53 tasks | — |

The `cclsp` row is the pre-swap measurement this proposal was written against.
The `mcpls` row (2026-10-15) is its successor on the same 13-language fixture,
measured the same way — cgroup `memory.peak`, the only apples-to-apples
instrument, since RSS summed over a process tree double-counts shared pages. The
pattern is unchanged and is the argument this section makes: **both start
eagerly**, mcpls more so. ~680 MB of the mcpls total is the same three heavy
servers (`java`, `omnisharp`, `roslyn-language-server`). Per-entry
`[lsp_servers.heuristics] project_markers` is mcpls's lever for shrinking this
and is the closest thing to the laziness this document argues for. See
[cclsp-retirement.md](./cclsp-retirement.md) for the gating measurements.

A cold language server is cheap. The expense is entirely in *how many* start and
*how eagerly*. Both current tools start eagerly. A lazy file-keyed router is
therefore **cheaper** than what exists now, not more expensive.

### 2.4 `reload()` cost — the load-bearing measurement

Measured by isolating CLI process spawn from API cost using a stub server:

- `opencode api get ...` against a **stub**: 167–181 ms
- the same CLI call against the **real server**: 168–219 ms

Identical. So **CLI spawn (~170 ms) dominates**; the real `/api/mcp` round-trip
is inside the noise floor (< ~50 ms). This does *not*, however, measure reload
from inside the plugin — see below.

`POST /api/location/reload` (the blunt lever): 380–2702 ms round-trip. It
**tears down and rebuilds the whole location** — after it, `/api/mcp` returned
`data: []` and `mcp-route` had to re-materialise on the next access, re-running
plugin setup, re-baselining the fingerprint, and re-running `ctx.tool.transform`.
It also **emits `location.shutdown` and cancels pending permissions**.

`ctx.mcp.reload()` — as `mcp-route` already calls it — is a *different, cheaper*
operation: it forces MCP re-reconciliation for the loaded location without
rebuilding the location. Measured indirectly: triggering it left
`serena-backend@<port>.service` and `cclsp-backend@<port>.service` `active` with
`NRestarts=0`, i.e. **the transform flip did not tear down the backends**. (Ports
are illustrative; live values are in the instance confs.) The systemd
socket/backend tier is therefore untouched by a routing change; only the MCP
client is re-established.

**Conclusion for the design:** calling `ctx.mcp.reload()` per file-touch is
affordable *on the target state* (one endpoint, one client, warm server). It is
NOT affordable as a per-file habit on the current state, where a reload means
re-dialing a socket-activated backend whose language servers were preloaded
eagerly. This is the argument for a single always-on router with warm, pooled
language servers: after the first touch of a given (server, root), a rewire is a
map write plus a client re-dial, not a process tree rebuild.

## 3. The architecture decision

**The router cannot be an MCP server.**

An MCP server is discovered once at location load; its tool list is fixed at that
moment; it has no view of which file the agent is *about to* touch, and no way to
re-key itself per request. A plugin does have that view, via `tool.before`.

Therefore:

```
  tool.before(file_path)
        │
        ▼
  plugin: resolve (server, root) by walking up from the file
        │
        ▼
  ctx.mcp.transform(editor => editor.set(name, {url: routerUrl, disabled:false}))
        │
        ▼
  ctx.mcp.reload()
        │
        ▼
  ONE always-on MCP server  ──►  pool of language servers
  (the router)                   keyed by (server, root),
                                 started lazily, idle-TTL'd
```

The plugin's job shrinks to *routing*: tell OpenCode which endpoint answers for
this file. The router's job is *the pool*: spawn, cache, and evict language
servers. Splitting them this way keeps the plugin thin and puts the long-lived
state (warm servers) somewhere it can survive a rewire.

### 3.1 Why the pool must be one always-on endpoint

If each (server, root) were its own MCP entry, a rewire would have to add and
remove entries, and each new endpoint would pay its own process start plus MCP
handshake on first use. One long-lived router process:

- costs its own RSS once (a thin LSP client + MCP surface, no language servers of
  its own until asked);
- keeps warm language servers across rewires, so a rewire is a map write;
- makes the context cost fixed: one tool list, not one per root.

The measured 33 MB / 112 ms per cold server is what makes lazy-pooling viable;
the measured 831 MB peak is what makes eager-pooling not viable.

## 4. Root resolution: up from the file

Replace `rootDir: "."` + `process.cwd()` with a marker walk starting at the
touched file:

1. From `dirname(file)`, walk up.
2. Stop at the first directory containing a **project marker** for the language
   in question (`.git`, `go.mod`, `Cargo.toml`, `package.json`, `pyproject.toml`,
   `setup.py`, `build.gradle`, `*.csproj`, …). A per-language marker table, not a
   single universal list — `package.json` should not claim a Go tree.
3. If no marker is found, fall back to a bounded ancestor (the nearest git root,
   else the file's own directory) rather than a global default.

This is the whole fix. It means a `.ts` file in an OpenCode config directory
resolves to the directory holding its `package.json`, while a stray `.conf`
resolves to something bounded and harmless.

Note that marker matching has a documented trap on the mcpls side: markers must
be single file names (no globs), so `*.csproj` and `*.tf` are inexpressible
there. That is a limitation of the *current* backend, and an argument for the
router owning its own marker table rather than delegating the walk.

## 5. Trigger policy

- **On `tool.before` for `read`/`write`/`edit` (and any tool carrying
  `file_path`):** resolve `(server, root)`; if it differs from the currently
  routed pair for this session, rewire and `reload()`.
- **On nothing else.** No directory watcher, no session-start scan.
- **Coalesce:** a burst of tool calls in one assistant step resolves to one
  rewire, not one per call.
- **Never block:** the hook resolves and rewires asynchronously; the tool call
  proceeds. The first LSP call for a cold server pays the spawn; subsequent ones
  do not.

## 6. Eviction

- Idle TTL **per language server**, not per socket: a warm server unused for
  `N` minutes is stopped, freeing its ~33 MB.
- LRU cap on the pool (e.g. 4–6 servers) so a wide session degrades predictably.
- The router process itself is always-on and cheap; only language servers are
  evicted. This is the opposite of the current `--exit-idle-time=3600` on the
  proxy, which evicts the *entry point* and therefore cannot keep anything warm.

## 7. What happens to the current machinery

| Component | Fate |
|---|---|
| `src/mcp-route.ts` | **Replaced in role.** Location-prefix lookup is the wrong key. The plugin becomes the file-keyed router. |
| `src/mcp-instance.ts` | **Demoted to accelerator.** Still useful to pre-warm a known root, but no longer the way LSP is obtained. (It now deliberately accepts any directory, including non-git ones such as `~/.config/<tool>` — the file-keyed proposal would make that scope unnecessary, not forbidden.) |
| serena socket units | **Unchanged.** Serena keeps its project-bound role for deep work. |
| `mcpls` (formerly `cclsp`) | **Superseded as the baseline.** Either retired in favour of the router, or kept for the extensions the router does not cover, during migration. Note the backend swap (cclsp → mcpls, 2026-10-15) changed the binary but not this analysis: the `cclsp`-named entry, the per-project instance model, and `rootDir`-from-`cwd` all persist under mcpls's `[workspace].roots = []`, so its directory-keying sin is *inherited*, not fixed. See [cclsp-retirement.md](./cclsp-retirement.md). |
| per-project `.serena/project.yml` | Unchanged — no longer load-bearing for the "unknown directory" case, which is the point. |

The config-litter objection dissolves: *there is no per-project artifact to
litter if there are no per-project artifacts.*

## 8. Open risks

1. **`tool.before` coverage.** It fires for tool calls. An agent that never calls
   a file-bearing tool (pure shell work, or `bash`-based editing) gets no LSP.
   Mitigation: also subscribe to `filesystem.changed` for post-hoc warming.
2. **Rewire latency vs. first LSP call.** The rewire must complete before the
   LSP tool call arrives, or that call misses. The hook ordering (before
   execution) should cover it, but the *MCP client re-dial* after `reload()` is
   asynchronous and was not timed from inside the plugin. **This is the one
   measurement still owed before implementation.**
3. **Multi-language steps.** One step touching `.go` and `.py` cannot route to
   both with a single-entry map. Either the map grows to one entry per active
   (server, root), or routing picks the dominant one and accepts a miss.
   Recommendation: allow the router entry to be *one* MCP server that internally
   dispatches by tool argument, so the map never needs more than one entry.
4. **Build cost.** A thin LSP client + MCP surface + marker table + pool is real
   work — larger than `mcp-instance`, smaller than the fallback it replaces.
5. **Serena's silent failure mode** persists for the directories that still route
   to serena; the router does not fix that.

## 9. Recommendation

Build the router as a standalone MCP server with a thin plugin front-end:

- **Plugin:** `tool.before` → resolve `(server, root)` → `transform` + `reload`.
  Roughly the size of `mcp-route.ts`.
- **Router:** always-on MCP server, lazily spawning and pooling language servers
  keyed by `(server, root)`, with marker-based up-walk and idle LRU eviction.

Before writing either, take the one measurement still owed: **time the
`ctx.mcp.reload()` → client-reconnected window from inside a plugin**, to confirm
that a rewire lands before the next LSP tool call. If it does not, the design
shifts the trigger earlier (rewire on `read` of a file, which always precedes an
edit or a symbol query on it).
