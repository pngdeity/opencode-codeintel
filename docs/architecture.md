# Architecture — how routing and instances fit together

OpenCode V2 has no LSP runtime of its own. Code intelligence comes from two MCP
servers configured under `mcp.servers`, both routed per location by
`src/mcp-route.ts`. Outside a known project root both are **disabled** — that is
by design, not a failure.

## Servers and roles

- **serena** — semantic navigation and refactoring, symbol-level editing,
  memories, and per-file diagnostics. **Project-scoped**: it selects language
  servers from the active project's config, so it needs a resolvable project. See
  [serena.md](./serena.md).
- **cclsp** — universal extension-keyed LSP over an `mcpls.toml` catalog.
  **Location-scoped**: it needs no project marker, so it is the only working LSP
  in directories that are not git repositories. The backend is **mcpls**, and the
  `cclsp` name is the retained routing slot. See
  [cclsp-retirement.md](./cclsp-retirement.md).

Two behaviours of the fallback are easy to misread: language servers start
**eagerly, all applicable at once**, not lazily per touched file; and cold start
takes several seconds, during which tools return `-32051 "still initializing"`
and must be **retried**. Most catalog entries are marker-gated, so a server whose
build file is absent from the project is not started at all, which is what keeps
the server count and memory down.

They are complementary rather than redundant: serena offers semantic editing the
fallback lacks, and the fallback covers extensions serena cannot serve. Neither
is a context-cost problem — the combined Code Mode catalog is a fraction of a
percent of a large window, and it is cacheable prefix content. Disabling a server
mid-session invalidates that prefix and costs more than keeping it, so there is no
MCP enable/disable logic.

**Provisioning is intentionally asymmetric.** The fallback is provisioned for
every project root; serena is provisioned **on demand**, only for roots where deep
semantic work happens. A root may therefore route fallback-only with serena
disabled. That is design, not a gap: adding a root to the fallback table is one
conf plus one socket, whereas serena additionally needs a `project.yml` and a
registration before it can serve at all. `serena-instance enable` does all three
in one call, but it remains a **deliberate act**, not automatic. The two servers
are **additive, never a switch**: serena is provisioned in addition to the
fallback, which stays the extension-coverage floor.

## Routing

`mcp.servers` is a single global map, but the socket-activated instances are
project-bound. `mcp-route` closes that gap with `ctx.mcp.transform`, rewriting the
`serena` and `cclsp` entries per **location**:

- Inside a known project root, both servers are enabled as `remote` at that
  project's client ports. The fallback stays enabled alongside serena to cover
  extensions serena cannot serve.
- Outside every known root, both are `disabled: true`. There is no stdio
  fallback: a per-location stdio server would reintroduce the process duplication
  the socket design exists to eliminate. Code intelligence is therefore an
  explicit act outside a known project — run `/lsp`, or call the `mcp-instance`
  tool, to add a fallback instance. `opencode mcp add` cannot do it: the transform
  rewrites both entries on every tick, so a hand-added entry is erased, and what
  is actually missing is the instance conf and socket, not the MCP entry.
- The route table is **derived** from `<config>/{serena,cclsp}/instances/*.conf`
  and their `*_PROJECT` and `*_PROXY_PORT` keys. Those confs are the single
  source of truth; the plugin polls a size and mtime fingerprint and calls
  `ctx.mcp.reload()` when they change.
- Matching is **longest-prefix** against the project roots, so a subdirectory
  resolves to its most specific root — a nested project wins over its parent.
- The transform is total and non-throwing: any unexpected input disables both
  servers. It runs inside a reconciliation loop, so throwing is not an option.
- Scope caveat: the location directory is captured once, when the plugin instance
  loads. One plugin instance is loaded per location — that is what makes
  per-location routing possible — but a session that changes its working directory
  after load keeps the servers it was loaded with. Routing is per-location, not
  per-session.
- `mcp.servers` ships both entries as `disabled: true` placeholders deliberately:
  a location where the plugin has not loaded must not dial an arbitrary project's
  instance.
- Disabling a server rewrites its URL to the placeholder
  `http://127.0.0.1:0/mcp`, so OpenCode may log a low-volume
  `mcp http request failed ... ConnectionRefused` WARN with
  `origin=http://127.0.0.1:0` for a location that resolves to no project root.
  That is the disable path, not a fault.

`applyRoute` in `src/mcp-route.ts` is the single emission point. Anything that
wants to change how a route is emitted should change that function, not add a
second writer.

## Verifying

`opencode mcp list` reports **config-level** status for `type: remote` entries and
does **not** prove connectivity — it prints `connected` with zero dialing. The
authoritative checks are:

```bash
# per-location status (deepObject query; pass as ONE argument)
opencode api get "/api/mcp?location[directory]=<an absolute directory>"

# real dialing, in the server log
rg 'mcp connected' <opencode state>/log/opencode.log
```

The `mcp connected` lines also record the tool count and the resolved directory.
Routed locations show both servers as `connected`; unrouted ones show `disabled`.
`mcp-instance action=status` is the third check, and the only one that looks at
the instance layer — conf and socket — rather than at OpenCode's view of it.
`/lsp status` prints the same for the fallback plus the serena instances and
registry reconciliation in one report.

`action=enable` is a **fourth** check, because it performs one itself: every
successful enable ends with an MCP `initialize` (plus a `tools/list` count) in
that one session through the instance's own proxy port, so `ok: true` means the
backend answered, not merely that a socket is enabled. The probe
(`src/codeintel/probe.ts`) is protocol-level and shared by both descriptors; it
retries `-32051 "still initializing"` and transport errors, always sends the
session `DELETE` (under supergateway `--stateful` an `initialize` owns a stdio
child), and is bounded by `CODEINTEL_PROBE_TIMEOUT_MS` (default 30 s). A failed
verify returns `ok: false` and **keeps the conf**, so a retry re-verifies the same
instance instead of allocating a second port. `status` never probes: it is
read-only, and a probe would start a socket-activated backend just to look.

**What the probe does not prove.** It answers "did the MCP server handshake", not
"did a language server attach". mcpls completes the MCP handshake before any
language server starts, by design, so a healthy probe on an instance whose
language server has failed to start looks identical to a working one. The
instrument that would distinguish them is `get_tool_support`, which reports which
languages actually have a route. A status-time probe using it is a known,
deferred improvement.

Caveat on the `location[directory]` query: it only returns data for a location
**currently materialised** in the running server. A directory never opened in this
server returns an empty result, and the no-location form defaults to `$HOME`,
which is unrouted. An empty result is therefore a
missing-materialisation signal, not a routing failure; the `mcp connected` log
lines are the location-independent check.

## Instances (systemd, socket-activated)

Both code-intelligence servers run behind the same socket-activated chain, one
instance per project, so nothing is resident until a client connects and nothing
survives its idle TTL. The instance confs are the single source of truth for the
port-to-project mapping and for the idle time; never hardcode a port table.

Both servers use the same three-tier template chain, shipped in
`share/systemd/user/`. The templates are the source of truth for the flags; the
shape is:

- `<tool>-mcp@.socket` — owns the client-facing port. The instance name **is** the
  port (`ListenStream=127.0.0.1:%i`), with `Accept=no` and a `TriggerLimit` to
  prevent restart storms.
- `<tool>-mcp@.service` — the proxy:
  `systemd-socket-proxyd --exit-idle-time=<TTL> 127.0.0.1:${<TOOL>_BACKEND_PORT}`.
  It reads the per-instance conf. `Restart=no`, so a failed backend cannot spin.
- `<tool>-backend@.service` — the real server, with
  `PartOf=<tool>-mcp@%i.service`, `StopWhenUnneeded=yes`,
  `KillMode=control-group`, and an `ExecStartPost` readiness gate, because neither
  backend calls `sd_notify`.

The fallback backend additionally carries `IPAddressDeny=any` and
`IPAddressAllow=localhost`, because its bind address is not ours to set.

Per-instance config, both at mode 600:

- serena: `<config>/serena/instances/<port>.conf` — `SERENA_PROJECT`,
  `SERENA_PROXY_PORT`, `SERENA_BACKEND_PORT`.
- cclsp: `<config>/cclsp/instances/<port>.conf` — `CCLSP_PROJECT`,
  `CCLSP_PROXY_PORT`, `CCLSP_BACKEND_PORT`.

The `.conf` extension is required in the original deployment because `.env` was
denied by its file-read rules. List live instances by listing those directories
rather than trusting a hardcoded port table. Backend ports are client plus 100 by
convention.

Behaviour: the socket listens with no backend process; the first client connect
starts proxy, then backend, then language servers; after the idle TTL the proxy
exits and the backend is reaped. Multiple clients share one backend, but one
backend serves **one active project at a time**, which is why the sharing boundary
is per-project and why the client ports are the routing key.

### Idle TTL

`--exit-idle-time` is the grace window a project's proxy, backend, and language
servers linger after the last client disconnects. **Read the value from the unit
files** — `systemctl --user cat <tool>-mcp@.service`. A skew between the serena
and fallback templates is a bug, not a tuned difference. Serena backends are the
heavy tier, holding hundreds of megabytes on a multi-language project; fallback
backends range from tens to a few hundred megabytes. That is a tuning choice, not
a defect.

### Long-term reclamation

The TTL reaps *processes*; the instance conf and enabled socket for a provisioned
root persist until explicitly disabled. This repository ships an operator script,
`bin/codeintel-instance-prune.py`, that disables an instance when it looks
idle. The predicate is **two-signal for a git root** — commit age and last-dial age
both past the threshold, the latter read from the backend unit's
`ActiveEnterTimestamp` — and **single-signal for a non-git root**, last-dial age
alone, because there is no commit signal to consult. The log line records which
basis applied. `--dry-run` and `CODEINTEL_PRUNE_DRY=1` print candidates without
acting; the day threshold is `CODEINTEL_PRUNE_DAYS`. Re-enable is lossless for the
fallback, because the conf is pure project plus ports, and safe for serena,
because `disable` leaves `project.yml` and the registration. The script is Python
and unit-tested with stdlib `unittest`.

Scheduling is the deployment's choice; the repository ships a weekly timer as an
example, not as policy.

### Unit gotchas

**`StopWhenUnneeded=yes` must NOT be set on the proxy unit.** Nothing `Requires=`
the proxy — the socket only adds `Before=` — so it would stop itself immediately
and the socket would re-trigger it in a loop. On the **backend** it is correct,
because the proxy `Wants=` it.

**`supergateway` reaps its own child process group**, so `KillMode=control-group`
is belt-and-braces rather than the sole orphan prevention. A backend running
alone on stdio orphans its language-server tree when the client disconnects
without closing the stream, which is why it runs behind a socket rather than as an
OpenCode `type: local` server.

**`supergateway` has no `--host` flag** and always binds the wildcard address, so
a `--host 127.0.0.1` on the ExecStart line is a silent no-op and the backend
listens on all interfaces even though the proxy and socket tiers are
loopback-only. `ss` showing a wildcard listener there is expected, not a misbind,
and the loopback-only invariant is enforced with the backend unit's
`IPAddressDeny`/`IPAddressAllow` sandbox instead. That sandbox is transitive,
which is what makes it the right control: the language servers are spawned by
supergateway, inherit the unit's network sandbox, and take no address flag at all,
so no bind-address fix could cover them. It also filters **connect**, not `bind`,
so the wildcard listen remains and only reachability changes; loopback egress,
which is the LSP traffic, is unaffected. Note for any follow-up unit: an empty
port variable expands to `0.0.0.0/0` — allow-all — in `IPAddressAllow`, so the
ExecStart carries a fail-closed `test -n` gate to keep a misconfigured conf from
inverting the sandbox.

**Preload noise (expected).** The fallback preloads one language server per
configured extension group on connect and logs `Initialization timeout` for any
that do not answer in time, then reports `Successfully preloaded`. It is cosmetic;
it explains slow cold connects and the occasional multi-second `http.span`
outlier. The timeout is backend-side and not tunable here.

## Operational verification

To confirm the servers are running as expected — no ports hardcoded, because the
instances are the source of truth:

```bash
# Unit layer: what is loaded, active, and whether anything restarted
systemctl --user list-units 'serena-*' 'cclsp-*' --no-pager
systemctl --user show <backend-unit> -p NRestarts -p ActiveState

# Instance layer: live listeners and their owning project confs
ls <config>/{serena,cclsp}/instances/
ss -ltn | rg '127.0.0.1:88'

# Health signals from the server log
rg 'mcp connected' <opencode state>/log/opencode.log | tail
rg -i 'mcp .*(error|fail|refused)' <opencode state>/log/opencode.log | tail
```

Health expectations: one listener per instance conf; `NRestarts=0` on every unit,
since any nonzero count is a restart storm rather than a cold start;
`mcp connected` lines with a low `http.span`, single-digit milliseconds warm and a
few seconds cold; and no connect failures except the known disable-path WARN.
`Restart=no` on the proxy and backend means a failed chain stays down until the
next client connect rather than spinning, so a `failed` unit is investigated, not
restarted blindly.

The systemd setup was reviewed against `systemd.socket(5)`, `systemd.service(5)`,
`systemd.unit(5)`, `systemd.kill(5)`, and `systemd-socket-proxyd(8)`: the
templates are correct and internally consistent, and no unit change is warranted.
In particular `StopWhenUnneeded=yes` on the **backend** is correct, and the
caution above applies only to the **proxy**.
