# Installing `@pngdeity/opencode-codeintel`

This package is an OpenCode plugin **plus** the systemd machinery it needs. The
plugin half is ordinary: OpenCode fetches npm plugins itself. The machinery half
is not, and npm cannot do it for you — see [Why there is no
postinstall](#why-there-is-no-postinstall).

## Prerequisites

| What | Why | Check |
| --- | --- | --- |
| `mcpls` | the fallback LSP bridge | `command -v mcpls` |
| `supergateway` | wraps mcpls's stdio in streamable HTTP | `command -v supergateway` |
| `serena` | the project-scoped semantic server (optional) | `command -v serena` |
| systemd **user** manager | every instance is a user socket unit | `systemctl --user show-environment` |
| the language servers you want | mcpls starts them; it does not ship them | see below |

All three binaries must be on the `PATH` of your **systemd user manager**, not
just your shell. A user service does not read your shell's rc files. If a binary
lives somewhere unusual, either put it in a directory the manager already has,
or set `Environment=PATH=...` in a `systemctl --user edit` drop-in. Do not
replace the manager's `PATH` wholesale — it typically carries toolchain
directories (`/usr/lib/rustup/bin`, cargo, `~/.local/bin`) that language servers
need to start.

## Install

```sh
opencode plugin add @pngdeity/opencode-codeintel    # the plugin itself
npx @pngdeity/opencode-codeintel install           # the units and scripts
```

`install` copies the unit templates from the package into
`$XDG_CONFIG_HOME/systemd/user/` (default `~/.config/systemd/user/`) and the
maintenance scripts into `$XDG_DATA_HOME/opencode-codeintel/bin/`, then runs
`systemctl --user daemon-reload`. `$XDG_CONFIG_HOME` is used because that is
where systemd itself looks; installing to a hardcoded `~/.config` would put the
units somewhere the user manager never scans. The scripts stay off your
interactive `PATH`. It enables nothing: instances are per-project and are
created explicitly.

`codeintel-instance-prune.service` names its script bare and resolves it
through `ExecSearchPath=`, so it works even when a distribution or nix package
installs the unit without running `install`. That unit needs no placeholder.
`cclsp-backend@.service` is different: its readiness probe is a required
`ExecStartPost`, and `ExecSearchPath=` resolves only the first word of a command
line, so that one carries a `@CODEINTEL_SCRIPTS@` placeholder which `install`
substitutes. A package shipping the units untouched must point that unit at its
own copy with `systemctl --user edit cclsp-backend@.service`.

Preview first with `npx @pngdeity/opencode-codeintel install --dry-run`.

## Enable a project

From an OpenCode session, use the `codeintel` tool with `action=enable`, or the
dedicated surfaces:

- `codeintel` — provision and inspect both servers for a directory
- `mcp-instance` — the mcpls fallback specifically (`enable`, `disable`, `status`)
- `serena-instance` — Serena specifically (`enable`, `refresh`, `disable`, `status`)
- `/lsp` — the TUI command; `/lsp status` is the status surface

Each enabled project gets an instance conf under
`~/.config/{cclsp,serena}/instances/<port>.conf` and an enabled socket unit.

## Verify

```sh
npx @pngdeity/opencode-codeintel doctor
```

`doctor` checks the binaries, the installed templates, and — the part that
matters — asks each live backend's `get_tool_support` whether a language server
actually attached. A backend that answers its MCP handshake but reports every
route as `no_server` is a backend that will answer no query, and `doctor` says so.

A cold backend starts its language servers *after* the handshake, so the first
answers are `initializing`. `doctor` waits for that to settle; it does not report
a starting server as broken.

## Keeping it running

Two systemd facts this package depends on:

- **Lingering.** Units only run while you are logged in unless user lingering is
  on. If you want the sockets available over SSH or from a TTY-less session:

  ```sh
  loginctl enable-linger "$USER"
  ```

- **Socket activation, not a daemon.** Nothing runs until a client connects.
  Backends exit when the proxy idles out. Do not "fix" a stopped backend by
  enabling it at boot: that is the design.

A weekly `codeintel-instance-prune.timer` disables instances that have gone idle.
It ships disabled; enable it with
`systemctl --user enable --now codeintel-instance-prune.timer` if you want it.
Read `codeintel-instance-prune.py --help` for the idle predicate before
trusting it with a repository you care about. `--help` prints the predicate and
flags and exits without touching anything; `--dry-run` reports what it would
disable without changing state.

## Why there is no postinstall

OpenCode installs plugins with `@npmcli/arborist` configured with
`ignoreScripts: true`, hardcoded. A `postinstall` in this package would never
run under OpenCode. It would also be blocked under Bun (no lifecycle scripts by
default), pnpm 10 (disabled by default), and npm 12 (blocking). Shipping one
would be dead code that looks like it works.

So installation is an explicit command you run, which is the same choice other
editor ecosystems make: a plugin that needs system-level files tells you to
install them.

## Languages that need extra environment

mcpls starts each language server with a **reduced environment** — `PATH`,
`HOME`, `TMPDIR` and similar, plus whatever the catalog entry's `env` table
adds. This matters for proxies. `rust-analyzer` installed via rustup is a shim
that reads `RUSTUP_HOME`; with that variable dropped it exits with
`rustup could not choose a version of rust-analyzer to run`. The unit cannot fix
this, because mcpls does not forward what it filters.

Point mcpls at a catalog that carries the variable:

```toml
[[lsp_servers]]
language_id = "rust"
command = "rust-analyzer"
file_patterns = ["*.rs"]

[lsp_servers.env]
RUSTUP_HOME = "/home/you/.local/share/rustup"
CARGO_HOME = "/home/you/.local/share/cargo"
```

Note that a catalog file **replaces** mcpls's built-in server list rather than
extending it, so a catalog must describe every language you want. Set
`MCPLS_CONFIG` in the per-instance conf, not in the unit:

```sh
# ~/.config/cclsp/instances/<port>.conf
MCPLS_CONFIG=/home/you/.config/mcpls/mcpls.toml
```

## Uninstall

```sh
opencode plugin remove @pngdeity/opencode-codeintel
systemctl --user disable --now 'cclsp-mcp@*.socket' 'serena-mcp@*.socket'
rm ~/.config/systemd/user/{cclsp,serena}-*@.service ~/.config/systemd/user/*-mcp@.socket
rm ~/.config/systemd/user/codeintel-instance-prune.{service,timer}
rm -r ~/.local/share/opencode-codeintel
systemctl --user daemon-reload
```

Instance confs are left behind deliberately; they describe projects, not the
plugin. Remove them with `mcp-instance action=disable` / `serena-instance
action=disable` so Serena's own registration is handled too.
