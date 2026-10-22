#!/usr/bin/env python3
"""Post-upgrade verification for the OpenCode MCP stack.

Why this exists: an upgrade can move a dep (supergateway, mcpls, serena) or
change a handshake, and a version string does not tell you whether the stack
still answers calls. Worse, a version bump can leave a backend holding stale
in-memory state while the new code sits on disk, so the post-upgrade check has
to make a real call, not read a version.

Process topology, which the orphan logic depends on:

    client (opencode) --TCP--> proxy port (88xx) --socket-activation-->
    backend (89xx) --stdio--> supergateway "node" bridge --stdio--> mcpls

The mcpls child holds no socket of its own; the *supergateway bridge* holds the
ESTAB connection to the backend port (89xx). So "is this mcpls child part of a
live session?" is answered by asking whether its parent bridge still holds that
connection. A bridge with no backend connection is an orphan: the client went
away and the child was not reaped.

Liveness is decided by socket inode, not by parsing `ss` text: the backend port's
ESTAB inode is read from /proc/net/tcp{,6}, and the bridge's open sockets are read
from /proc/<pid>/fd. An inode in both sets means the bridge holds that connection.

What it checks, per provisioned instance:
  1. the backend unit is active
  2. an MCP handshake answers, and serverInfo.name is the expected backend
  3. tools/list returns at least one tool
  4. sessions are torn down with DELETE, and the child count does not grow
  5. every mcpls child still alive afterwards is classified: one backing a live
     client is reported as info (normal during real work); one whose bridge has
     no backend connection is a leak and fails the run

Exit status: 0 always, unless --strict is given, in which case failures exit 1.
An unattended updater that hard-fails on a cold start is worse than one that
reports, so the default is report-only. Run with --strict by hand.

Usage:
  opencode-stack-smoke [--strict] [--quiet] [--timeout SECONDS]
  opencode-stack-smoke --orphans-only   # classify current children, no probing
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

# Language-server process names this stack can produce, from both backends:
# mcpls's commands in mcpls.toml, plus serena's own servers. `omnisharp` was
# dropped when its catalog entry was removed (2026-10-15) — it can no longer
# spawn, and a name here that cannot appear only inflates the count.
LSP_NAMES = (
    "gopls",
    "pyright-langserver",
    "clangd",
    "rust-analyzer",
    "jdtls",
    "typescript-language-server",
    "yaml-language-server",
    "taplo",
    "bash-language-server",
    "lua-language-server",
    "regal",
    "terraform-ls",
    "dart",
    "roslyn-language-server",
    "pkl-lsp",
    "docker-langserver",
)

# The serverInfo.name each backend must report. A wrong name means the handshake
# reached something other than the backend we meant to test.
EXPECTED_SERVER_NAME = {"cclsp": "mcpls", "serena": "Serena"}

TCP_LISTENING_STATE = "0A"
TCP_ESTABLISHED_STATE = "01"


@dataclass(frozen=True)
class Child:
    """One live mcpls process, plus what its parent bridge is connected to."""

    pid: int
    bridge: int | None
    backend_port: int | None

    @property
    def is_live(self) -> bool:
        return self.backend_port is not None

    def describe(self, indent: str = "          ") -> str:
        if self.is_live:
            return (
                f"{indent}live   pid={self.pid} bridge={self.bridge} "
                f"backend=:{self.backend_port} (a client is connected)"
            )
        return f"{indent}ORPHAN pid={self.pid} bridge={self.bridge or '-'} (no client connected)"


@dataclass(frozen=True)
class Instance:
    """A provisioned MCP instance, derived from its conf file."""

    tool: str
    proxy_port: int
    project: str | None

    @property
    def unit(self) -> str:
        return f"{self.tool}-backend@{self.proxy_port}.service"

    @property
    def expected_server(self) -> str:
        return EXPECTED_SERVER_NAME.get(self.tool, "")


class Reporter:
    """Counts and prints check outcomes; --quiet suppresses only the printing."""

    def __init__(self, quiet: bool = False) -> None:
        self.quiet = quiet
        self.passed = 0
        self.failed = 0
        self.skipped = 0

    def say(self, message: str = "") -> None:
        if not self.quiet:
            print(message, flush=True)

    def ok(self, message: str) -> None:
        self.passed += 1
        self.say(f"  ok    {message}")

    def bad(self, message: str) -> None:
        self.failed += 1
        self.say(f"  FAIL  {message}")

    def skip(self, message: str) -> None:
        self.skipped += 1
        self.say(f"  skip  {message}")

    def fail_without_counting(self) -> None:
        """Used by --orphans-only, which reports a single aggregate result."""
        self.failed += 1


def run(args: list[str]) -> str:
    """Run a command, returning stdout; empty string if it fails."""
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout


def pids_of(comm: str) -> list[int]:
    """PIDs whose executable name is exactly `comm`.

    Uses pgrep -x, which matches the process name exactly. Note it silently
    matches nothing for names longer than 15 characters, so long-named binaries
    (pyright-langserver) must be matched by pattern elsewhere, not here.
    """
    out = run(["pgrep", "-x", comm])
    return [int(line) for line in out.split() if line.isdigit()]


def ppid_of(pid: int) -> int | None:
    try:
        # Field 4 of /proc/<pid>/stat is the parent pid. The comm field (field 2)
        # can contain spaces and parentheses, so parse from the last ')'.
        stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
        return int(stat[stat.rindex(")") + 2 :].split()[1])
    except (OSError, ValueError, IndexError):
        return None


def comm_of(pid: int) -> str:
    try:
        return pathlib.Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


def socket_inodes(pid: int) -> set[str]:
    """Inodes of every socket held open by `pid`, from /proc/<pid>/fd."""
    inodes: set[str] = set()
    fd_dir = pathlib.Path(f"/proc/{pid}/fd")
    try:
        entries = list(fd_dir.iterdir())
    except OSError:
        return inodes
    for entry in entries:
        try:
            target = os.readlink(entry)
        except OSError:
            continue
        if target.startswith("socket:["):
            inodes.add(target[len("socket:[") : -1])
    return inodes


def established_backend_inodes(backend_ports: set[int]) -> dict[str, int]:
    """{socket inode: local port} for ESTABLISHED sockets on those local ports."""
    found: dict[str, int] = {}
    for table in ("tcp", "tcp6"):
        try:
            lines = pathlib.Path(f"/proc/net/{table}").read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != TCP_ESTABLISHED_STATE:
                continue
            local, inode = fields[1], fields[9]
            try:
                port = int(local.rsplit(":", 1)[1], 16)
            except (ValueError, IndexError):
                continue
            if port in backend_ports:
                found[inode] = port
    return found


def listening_ports() -> set[int]:
    """Every port this user has a listening socket on (informational)."""
    ports: set[int] = set()
    for table in ("tcp", "tcp6"):
        try:
            lines = pathlib.Path(f"/proc/net/{table}").read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != TCP_LISTENING_STATE:
                continue
            try:
                ports.add(int(fields[1].rsplit(":", 1)[1], 16))
            except (ValueError, IndexError):
                continue
    return ports


def backend_ports_from_confs(conf_dirs: list[pathlib.Path]) -> set[int]:
    """Backend ports named by the instance confs.

    Read from the confs so the classifier tracks provisioning rather than a
    hardcoded range. Falls back to the 89xx convention when nothing is
    provisioned.
    """
    ports: set[int] = set()
    pattern = re.compile(r"^\w*_BACKEND_PORT=(\d+)", re.MULTILINE)
    for conf_dir in conf_dirs:
        if not conf_dir.is_dir():
            continue
        for conf in conf_dir.glob("*.conf"):
            try:
                text = conf.read_text(errors="replace")
            except OSError:
                continue
            ports.update(int(m) for m in pattern.findall(text))
    return ports or set(range(8900, 9000))


def classify_mcpls(backend_ports: set[int]) -> list[Child]:
    """Classify each live mcpls child as backing a client, or orphaned.

    The bridge must be a node process (supergateway) AND hold an established
    connection to a backend port. Either alone is not enough: a node process
    could be something else, and a backend port could be held by a
    systemd-socket- acceptor rather than by a client-facing bridge.
    """
    if not backend_ports:
        return []
    by_inode = established_backend_inodes(backend_ports)
    children: list[Child] = []
    for pid in pids_of("mcpls"):
        bridge = ppid_of(pid)
        port: int | None = None
        if bridge is not None and comm_of(bridge).startswith("node"):
            for inode in socket_inodes(bridge):
                if inode in by_inode:
                    port = by_inode[inode]
                    break
        children.append(Child(pid=pid, bridge=bridge, backend_port=port))
    return children


def lsp_count() -> int:
    """Language-server processes, matched by the binaries mcpls.toml names.

    Counted machine-wide, like the mcpls count, because a leak anywhere is a
    leak. ps is used rather than pgrep because the names here exceed pgrep -x's
    15-character limit.
    """
    out = run(["ps", "-eo", "comm="])
    names = {line.strip() for line in out.splitlines()}
    return sum(1 for name in names for lsp in LSP_NAMES if name == lsp)


def mcpls_count() -> int:
    return len(pids_of("mcpls"))


# --- MCP probing -------------------------------------------------------------


class McpSession:
    """A single MCP session over streamable HTTP, with DELETE-on-exit."""

    def __init__(self, port: int, timeout: float) -> None:
        self.url = f"http://127.0.0.1:{port}/mcp"
        self.timeout = timeout
        self.session_id: str | None = None

    def _post(self, payload: dict | None, method: str = "POST") -> str:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.url, data=body, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            sid = response.headers.get("Mcp-Session-Id")
            if sid:
                self.session_id = sid
            return response.read().decode("utf-8", "replace")

    @staticmethod
    def _results(raw: str):
        for line in raw.splitlines():
            if line.startswith("data:"):
                yield json.loads(line[5:].strip())

    def initialize(self) -> dict:
        raw = self._post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "opencode-stack-smoke", "version": "1"},
                },
            }
        )
        info: dict = {}
        for message in self._results(raw):
            info = message.get("result", {}).get("serverInfo", {}) or info
        return info

    def tools(self) -> list:
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        raw = self._post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools: list = []
        for message in self._results(raw):
            tools = message.get("result", {}).get("tools", []) or tools
        return tools

    def close(self) -> None:
        """Always hand the session back, so the probe cannot be the leak."""
        try:
            self._post(None, method="DELETE")
        except (urllib.error.URLError, OSError, TimeoutError, ValueError):
            # A failed teardown is reported by the caller's count assertion.
            pass


def probe_instance(port: int, expect: str, timeout: float) -> tuple[bool, str]:
    """Handshake, assert serverInfo, list tools, DELETE. Returns (ok, detail)."""
    session = McpSession(port, timeout)
    try:
        try:
            info = session.initialize()
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            return False, f"handshake: {type(error).__name__}"
        if not info:
            return False, "handshake: no serverInfo in the initialize response"
        name = info.get("name", "")
        version = info.get("version", "?")
        if name != expect:
            return False, f"handshake: expected serverInfo.name {expect!r}, got {name!r}"
        try:
            tools = session.tools()
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            return False, f"tools/list: {type(error).__name__}"
        if not tools:
            return False, "tools/list: no tools returned"
        return True, f"{name} {version}, {len(tools)} tools"
    finally:
        session.close()


# --- instance discovery ------------------------------------------------------


def discover_instances(conf_dirs: list[tuple[str, pathlib.Path]]) -> list[Instance]:
    """Collect instances from the confs, the source of truth for provisioning."""
    instances: list[Instance] = []
    for tool, conf_dir in conf_dirs:
        if not conf_dir.is_dir():
            continue
        for conf in sorted(conf_dir.glob("*.conf")):
            proxy = project = None
            try:
                text = conf.read_text(errors="replace")
            except OSError:
                continue
            for line in text.splitlines():
                key, _, value = line.partition("=")
                if key.endswith("_PROXY_PORT") and value.isdigit():
                    proxy = int(value)
                elif key.endswith("_PROJECT"):
                    project = value
            if proxy is not None:
                instances.append(Instance(tool=tool, proxy_port=proxy, project=project))
    return instances


def unit_is_active(unit: str) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["systemctl", "--user", "is-active", unit],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return False, "unknown"
    state = result.stdout.strip() or "unknown"
    return state == "active", state


# --- checks ------------------------------------------------------------------

INSPECT_HINT = "          pgrep -x mcpls | xargs -r ps -o pid,ppid,etime,args -p"


def report_children(reporter: Reporter, children: list[Child], *, pre_run: bool) -> None:
    """Print one line per child, and fail if any is orphaned."""
    orphans = [child for child in children if not child.is_live]
    for child in children:
        if child.is_live and not pre_run:
            reporter.say(child.describe())
        elif child.is_live:
            reporter.say(
                f"          live   pid={child.pid} bridge={child.bridge} "
                f"backend=:{child.backend_port} (a client is connected)"
            )
        elif pre_run:
            reporter.say(
                f"          ORPHAN pid={child.pid} bridge={child.bridge or '-'} "
                "(no client; leaked before this run)"
            )
        else:
            reporter.say(f"          ORPHAN pid={child.pid} bridge={child.bridge or '-'}")
    if orphans:
        if pre_run:
            reporter.bad(f"{len(orphans)} mcpls process(es) were already orphaned before probing")
        else:
            reporter.bad(f"{len(orphans)} orphaned mcpls process(es): child alive, no client connected")
        reporter.say("        Something opened a session and never sent DELETE. Common cause: a")
        reporter.say("        readiness probe or health check that calls initialize and walks")
        reporter.say("        away. Inspect with:")
        reporter.say(INSPECT_HINT)


def run_orphans_only(reporter: Reporter, backend_ports: set[int]) -> int:
    """Classify what is alive right now and stop, opening no sessions."""
    reporter.say("")
    reporter.say("orphan classification (no probing):")
    children = classify_mcpls(backend_ports)
    if not children:
        reporter.ok("no mcpls children alive")
    else:
        for child in children:
            if child.is_live:
                reporter.say(
                    f"  info  live   pid={child.pid} bridge={child.bridge} "
                    f"backend=:{child.backend_port} (a client is connected)"
                )
            else:
                reporter.say(
                    f"  FAIL  ORPHAN pid={child.pid} bridge={child.bridge or '-'} "
                    "(no client connected)"
                )
        if any(not child.is_live for child in children):
            reporter.fail_without_counting()
        else:
            reporter.passed += 1
    reporter.say("")
    summary = f"orphans-only: {reporter.passed} ok, {reporter.failed} failed"
    reporter.say(summary if reporter.failed == 0 else f"*** {summary} ***")
    return 1 if reporter.failed else 0


def run_full(
    reporter: Reporter,
    instances: list[Instance],
    backend_ports: set[int],
    timeout: float,
) -> int:
    baseline_mcpls = mcpls_count()
    baseline_lsp = lsp_count()
    reporter.say(f"at start: mcpls={baseline_mcpls} language-servers={baseline_lsp}")

    # The delta invariant cannot by itself catch a leak that predates the run, so
    # pre-existing children are classified here too, even though only the delta is
    # a hard failure below.
    if baseline_mcpls == 0:
        reporter.ok("clean slate: no mcpls processes before probing")
    else:
        reporter.say(f"  info  {baseline_mcpls} mcpls process(es) alive before probing")
        children = classify_mcpls(backend_ports)
        for child in children:
            reporter.say(child.describe())
        orphans = [child for child in children if not child.is_live]
        if orphans:
            reporter.bad(f"{len(orphans)} mcpls process(es) were already orphaned before probing")
            reporter.say("        Something opened a session and never sent DELETE. Common cause: a")
            reporter.say("        readiness probe or health check that calls initialize and walks")
            reporter.say("        away. Inspect with:")
            reporter.say(INSPECT_HINT)
        else:
            reporter.ok("all pre-existing children back a live client — not a leak")

    reporter.say("")
    reporter.say("backends:")
    for instance in instances:
        active, state = unit_is_active(instance.unit)
        if not active:
            reporter.skip(f"{instance.unit} ({state}) — idle, not a failure")
            continue
        # Reached through the proxy socket, which is what a client uses.
        ok, detail = probe_instance(instance.proxy_port, instance.expected_server, timeout)
        if ok:
            reporter.ok(f"{instance.unit}  :{instance.proxy_port}  {detail}")
        else:
            reporter.bad(f"{instance.unit}  :{instance.proxy_port}  {detail}")

    reporter.say("")
    reporter.say("process accounting:")
    # Give the reaper a moment: each DELETE above hands its session back, and the
    # child exit is asynchronous.
    time.sleep(5)
    after_mcpls = mcpls_count()
    after_lsp = lsp_count()

    # Two invariants, deliberately separate:
    #   delta   — the count must not have grown vs. the start. Failure is a leak
    #             THIS script caused, and nothing can excuse it.
    #   orphans — every child still alive must back a live client. A child whose
    #             bridge has no backend connection is a leak from some source.
    # A raw "count must be 0" invariant cannot tell an orphan from the user's own
    # open TUI session, so it fired on every run made during real work.
    if after_mcpls <= baseline_mcpls:
        reporter.ok(
            f"no growth: mcpls {baseline_mcpls} -> {after_mcpls} "
            f"(language-servers {baseline_lsp} -> {after_lsp})"
        )
    else:
        reporter.bad(f"mcpls grew {baseline_mcpls} -> {after_mcpls}; this run leaked a session")
        reporter.say("        Every session this script opens is closed with DELETE, so growth")
        reporter.say("        means a teardown failed. Inspect with:")
        reporter.say(INSPECT_HINT)

    children = classify_mcpls(backend_ports)
    if after_mcpls == 0:
        reporter.ok("no stray sessions: stack holds no mcpls children at idle")
    elif all(child.is_live for child in children):
        reporter.ok(
            f"{len(children)} mcpls child(ren) alive, all backing a live client — not a leak"
        )
        for child in children:
            reporter.say(child.describe())
        reporter.say("        Normal whenever a TUI session is open. These are reaped on DELETE.")
    else:
        reporter.bad(
            f"{sum(1 for c in children if not c.is_live)} orphaned mcpls process(es): "
            "child alive, no client connected"
        )
        for child in children:
            if not child.is_live:
                reporter.say(f"          ORPHAN pid={child.pid} bridge={child.bridge or '-'}")
        reporter.say("        A child exists only while a session is open. An orphan means a")
        reporter.say("        session nobody closed — suspect a probe or health-check client")
        reporter.say("        that calls initialize without sending DELETE. Inspect with:")
        reporter.say(INSPECT_HINT)

    reporter.say("")
    summary = f"smoke: {reporter.passed} ok, {reporter.failed} failed, {reporter.skipped} skipped"
    reporter.say(summary if reporter.failed == 0 else f"*** {summary} ***")
    return 1 if reporter.failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="opencode-stack-smoke",
        description="Post-upgrade verification for the OpenCode MCP stack.",
    )
    parser.add_argument("--strict", action="store_true", help="exit 1 on any failure")
    parser.add_argument("--quiet", action="store_true", help="suppress all output")
    parser.add_argument(
        "--orphans-only",
        action="store_true",
        help="classify live mcpls children and exit, opening no sessions",
    )
    parser.add_argument("--timeout", type=float, default=45.0, help="handshake timeout in seconds")
    args = parser.parse_args(argv)

    config_home = pathlib.Path(os.environ.get("XDG_CONFIG_HOME") or pathlib.Path.home() / ".config")
    cclsp_conf_dir = config_home / "cclsp" / "instances"
    serena_conf_dir = config_home / "serena" / "instances"
    conf_dirs = [(("cclsp"), cclsp_conf_dir), ("serena", serena_conf_dir)]

    reporter = Reporter(quiet=args.quiet)
    reporter.say(f"OpenCode stack smoke — {time.strftime('%Y-%m-%d %H:%M:%S')}")

    backend_ports = backend_ports_from_confs([cclsp_conf_dir, serena_conf_dir])

    if args.orphans_only:
        code = run_orphans_only(reporter, backend_ports)
        return code if args.strict else 0

    instances = discover_instances(conf_dirs)
    reporter.say(f"instances from confs: {len(instances)}")
    code = run_full(reporter, instances, backend_ports, args.timeout)
    return code if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
