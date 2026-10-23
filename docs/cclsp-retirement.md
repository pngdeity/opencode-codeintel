# The code-intelligence fallback is mcpls

**The `cclsp` name is deliberately retained** in configuration, systemd units and
the MCP entry; only the binary behind it changed.

## What changed and what did not

| Layer | Before | Now |
|---|---|---|
| Backend binary | `cclsp` (npm) | `mcpls` (`mcpls` on `PATH`) |
| Catalog | `cclsp.json` | `mcpls.toml` |
| Env selection | `CCLSP_CONFIG_PATH` | `MCPLS_CONFIG` |
| MCP entry name | `cclsp` | **`cclsp`** (unchanged — it is the routing slot) |
| systemd units | `cclsp-backend@` / `cclsp-mcp@` | **unchanged names** |
| Instance confs | `~/.config/cclsp/instances/*.conf` | **unchanged** (`CCLSP_*` keys) |
| Plugin surfaces | `mcp-route`, `mcp-instance`, `/lsp` | **unchanged names** |

**Do not rename the `cclsp` identifiers.** That is a deliberate decision, not
an oversight. Renaming would touch every plugin, both systemd unit templates,
every instance conf, the TUI panel's `SOURCES` table and the test fixtures,
for no functional gain. The name now means *the fallback-instance slot*; the
implementation behind it is mcpls.

## Why cclsp was replaced

cclsp is effectively abandoned: issue #40 carries a discontinuation
announcement, the last commit is 2026-02-22, there have been no releases, and
there is no viable fork. Separately, **OpenCode V2 has no LSP runtime at all**
(v2.0.29's OpenAPI exposes 118 paths and zero `lsp`), so the MCP layer is the
only path to code intelligence — this is a standing decision, not a stopgap.

The short version: mcpls is maintained, ships a strict superset of cclsp's tools
(31 vs 8), and measured better on coverage parity.

## Traps that will bite the next person

**1. `--stateful` on supergateway is required, not a preference.** In
supergateway's default stateless mode the child's stdin is closed after each
response, and **mcpls reads stdin EOF as a shutdown signal**. The unit exits, the
proxy reconnects to nothing, and every call returns `-32051 "still initializing"`.
The failure looks like a slow start and is not one.

**2. systemd strips backslashes from `ExecStart=`.** A readiness probe written
inline therefore cannot be quoting-correct. That is why the probe is a separate
file (`mcpls-ready.py`, shipped in `bin/`) rather than a `sh -c` one-liner
inside the unit.

**2b. A readiness probe is itself an MCP session and must send `DELETE`.** Under
`--stateful` an `initialize` owns a stdio child. The first version of the probe
posted `initialize` and walked away, leaking one `mcpls` per unit start. Keep this
as a class of bug to watch: any health-check or probe client that initializes
without tearing down costs a process.

**3. Readiness is gated on `experimental/serverStatus`, and that gate is a
protocol mismatch rather than a slow start.** Servers that never emit
`serverStatus` stay `initializing` **forever**. OmniSharp is the measured case —
55 notifications captured, none of them `serverStatus` — so its routes can never
become ready. pkl-lsp behaves the same way. The remedy was to remove those catalog
entries rather than wait.

**4. `-32051` is retry-means-retry, and it is documented behaviour.** mcpls starts
language servers in a background task and completes the MCP handshake with the
client *immediately*; a tool call for a language whose server has not finished
starting returns the retryable `ServerInitializing` (`-32051`), whereas a failed
start returns `ServerFailedToStart` carrying the command and the reason. So a
fast handshake proves mcpls started, not that any language server will answer.
See [the mcpls limits](#the-mcpls-contract-we-depend-on) below.

**5. supergateway has no `--host` and binds the wildcard address
unconditionally.** Loopback confinement is therefore the unit's job, via
`IPAddressDeny=any` plus `IPAddressAllow=localhost`. That filter is transitive to
language servers and filters *connect*, not bind. An empty port variable expands
to `0.0.0.0/0`, so the unit carries a fail-closed `test -n` gate ahead of the
exec.

**6. `StopWhenUnneeded=yes` must NOT be on the proxy unit** (it would loop), but
it **is** correct on the backend.

## The mcpls contract we depend on

mcpls is pre-1.0 and releases roughly weekly, but it is documented and specified
(a full mdBook, per-feature `specs/`, CHANGELOG). Three behaviours that look like
defects and are not:

1. **Language servers start with a reduced environment.** An allowlist (`PATH`,
   `HOME`, `USERPROFILE`, `TMPDIR`, `TEMP`, `TMP`, and the Windows system
   variables) is passed, then the catalog entry's `env` table. `environment.d`
   variables do **not** reach a spawned server. On a rustup-proxied host this
   breaks `rust-analyzer`, whose proxy needs `RUSTUP_HOME`; the fix is an explicit
   `env` block in the catalog entry. Documented in `advanced/security.md` and
   `advanced/limits.md` upstream. **Do not generalise it** — a measured
   counter-example on the development host had an OmniSharp child carrying the
   entire desktop environment. Re-check before relying on either direction.
2. **A configuration file replaces the built-in server list.** A file with no
   `[[lsp_servers]]` starts no servers, so wherever `MCPLS_CONFIG` is set the
   catalog is load-bearing.
3. **No authentication on any transport.** Upstream's instruction is to use
   loopback or an authenticating reverse proxy. The BPF confinement above is our
   obligation, not mcpls's.

## supergateway version

supergateway 4.1.0 is the floor, for upstream child reaping (#141, #160, both
closed 2026-09-30 when 4.1.0 shipped). 4.1.0 ships `lib/ownedChildProcesses.js`,
which spawns with `detached: true` and kills via `process.kill(-pid, ...)` with a
bounded SIGTERM → SIGKILL escalation, fired on the child's `exit` and not gated on
session id. PR #152 (the community fix) is closed-unmerged; the maintainer landed
their own v4 version.

## Timing and cold start

A fresh session pays ~8 s, longer under load, before a language server can answer.
That is inherent to a per-session-child design and is a latency cost, not a
resource leak. See
[records/mcpls-session-reaping.md](./records/mcpls-session-reaping.md) for why the
"leak" finding was withdrawn.

## Cost, measured

mcpls **eagerly starts every applicable server** per instance rather than lazily
per touched file. Measured with the cgroup `memory.peak` counter (the only
apples-to-apples instrument; RSS summed over a process tree double-counts shared
pages):

| | cclsp | mcpls |
|---|---|---|
| Steady state, servers warm | 699 MB | ~940 MB |
| Peak during a run | 1,842 MB | 1,007 MB |
| Backend alone, no servers | 114 MB | 4.1 MB |
| Processes | ~20 | 53 |

The three heavy servers are the same in both (`java` ~350 MB, `omnisharp`
~180 MB, `roslyn-language-server` ~150 MB) and account for ~680 MB. The lever for
reducing this is per-entry `[lsp_servers.heuristics] project_markers`, which skips
servers whose build markers are absent.

**That lever works, and it has sharp edges.** Gating took a C#-only repository from
16 servers / 1114 MB to 9 servers / 566 MB (49% off). But the marker search
**recurses**, is **filesystem-based rather than git-aware**, and honours
**untracked** markers, so a vendored dependency's build file satisfies a gate. Two
gates were added and then removed because measurement caught them suppressing real
work, and `heuristics_max_depth` is a `[workspace]` key where `0` silently disables
every gated server. Markers must be single file names, so `*.csproj` and `*.tf` are
inexpressible.

The full gating measurements, the depth table, and the per-gate verification live
in the catalog's own header comment in the deployment that uses it. They describe
one host's project set and are not reproducible elsewhere, which is why this
document states the mechanism rather than the numbers.

## What this means for a new installation

The fallback's backend is *this repository's units plus a catalog you supply*.
Nothing about the socket chain requires any particular catalog: mcpls ships a
built-in list of marker-gated servers, and a catalog file replaces it entirely.
A new installation that has no catalog gets protocol-only answers — a working MCP
server with no language server attached — which is why the plugin's health check
must distinguish "handshake answered" from "a language server attached".
