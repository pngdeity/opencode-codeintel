#!/usr/bin/env python3
"""codeintel-instance-prune - auto-disable idle serena/cclsp MCP instances.

The provisioned-root set (~/.config/{serena,cclsp}/instances/*.conf plus their
enabled sockets) is declarative state that never self-prunes. This script
disables instances whose project has gone cold, then notifies if anything was
touched. It is the automation behind the "Code-Intelligence Instance Registry"
monitor in ~/.config/opencode/TODO.md.

A root is IDLE when BOTH hold:
  * no commit in the project in IDLE_DAYS days, AND
  * its backend has not been dialed in IDLE_DAYS days.
Two signals, not one: git commit age alone would disable a root you are
actively reading but not committing to, and last-dialed alone would miss a root
whose session is parked. Both cold is the safe predicate.

Non-git roots (cclsp serves any directory) have no commit signal at all, so the
two-signal rule degrades to a single signal there: a non-git root is IDLE when
its backend has not been dialed in IDLE_DAYS days. There is nothing else to
weigh - no commits exist to prove recent activity - so last-dial alone is the
whole predicate, and the log line says so.

Disabling is reversible by construction:
  * cclsp needs only a conf + socket; re-enable regenerates both losslessly.
  * serena keeps project.yml and its serena_config.yml registration through a
    disable, and provision() is now idempotent, so re-enable is lossless.
This reversibility is the reason auto-disable is acceptable at all; see the
plugin headers (codeintel/descriptors.ts) for the serena idempotency fix.

Dry-run: CODEINTEL_PRUNE_DRY=1 reports candidates without touching anything.
Also accepts `--dry-run` as an argument, because a systemd service does not
inherit the caller's environment - an env-var-only switch cannot be exercised
through `systemctl start`, which is exactly how a "dry" test ran live once.
"""

from __future__ import annotations

import fcntl
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

def _xdg(name: str, default: str) -> Path:
    value = os.environ.get(name)
    return Path(value) if value else Path.home() / default


CONFIG = _xdg("XDG_CONFIG_HOME", ".config")
STATE = _xdg("XDG_STATE_HOME", ".local/state") / "opencode"
LOG = STATE / "codeintel-prune.log"
LOCK = STATE / "codeintel-prune.lock"

IDLE_DAYS = int(os.environ.get("CODEINTEL_PRUNE_DAYS", "14"))
DRY = os.environ.get("CODEINTEL_PRUNE_DRY", "0") == "1"
if "--dry-run" in sys.argv[1:]:
    DRY = True
if "-h" in sys.argv[1:] or "--help" in sys.argv[1:]:
    # Answered before anything on disk is touched: a run that evaluates the
    # predicate must not be the same command as one that asks what it does.
    print(__doc__.strip())
    print("\nflags: --dry-run   report what would be disabled, change nothing")
    print("env  : CODEINTEL_PRUNE_DAYS (default 14), CODEINTEL_PRUNE_DRY=1")
    raise SystemExit(0)

IDLE_SECS = IDLE_DAYS * 86400

INSTANCES = (
    ("serena", CONFIG / "serena" / "instances", "SERENA_PROJECT", "SERENA_PROXY_PORT"),
    ("cclsp", CONFIG / "cclsp" / "instances", "CCLSP_PROJECT", "CCLSP_PROXY_PORT"),
)


def now_epoch() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def log(msg: str, *, to_stderr: bool = False) -> None:
    print(msg, file=sys.stderr if to_stderr else sys.stdout)


def read_conf(path: Path, project_key: str, port_key: str) -> tuple[str, str]:
    project = ""
    port = ""
    for line in path.read_text().splitlines():
        if line.startswith(project_key + "="):
            project = line.split("=", 1)[1]
        elif line.startswith(port_key + "="):
            port = line.split("=", 1)[1]
    return project, port


def last_dialed_epoch(unit: str) -> int:
    """Last-dialed epoch for an instance's backend unit.

    Empty => never dialed since boot, which counts as cold (epoch 0). systemd's
    ActiveEnterTimestamp is the last time the unit entered "active"; a
    socket-activated backend that has never started has an empty timestamp.
    """
    try:
        out = subprocess.run(
            ["systemctl", "--user", "show", unit, "-p", "ActiveEnterTimestamp", "--value"],
            capture_output=True, text=True, check=False,
        ).stdout.strip()
    except OSError:
        return 0
    if not out:
        return 0
    try:
        return int(datetime.strptime(out, "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return 0


def last_commit_epoch(root: str) -> int:
    """Last commit epoch in a project root. Non-git or no commits => 0 (cold)."""
    try:
        out = subprocess.run(
            ["git", "-C", root, "log", "-1", "--format=%ct"],
            capture_output=True, text=True, check=False,
        ).stdout.strip()
    except OSError:
        return 0
    return int(out) if out.isdigit() else 0


def is_git_root(root: str) -> bool:
    """Is this root inside a git work tree?

    Non-git roots (cclsp serves any directory) have no commit signal, so the
    idle predicate drops to last-dial alone for them.
    """
    try:
        return subprocess.run(
            ["git", "-C", root, "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True, check=False,
        ).returncode == 0
    except OSError:
        return False


def classify(project: str, tool: str, port: str, *, now: int | None = None) -> str | None:
    """Decide whether one instance is idle.

    Returns "<cmsg>|dialed=<n>d" when it qualifies for pruning, else None.
    The git/non-git branch is the load-bearing policy and is unit-tested in
    codeintel-instance-prune_test.py.
    """
    if now is None:
        now = now_epoch()

    # Never-dialed (epoch 0) and never-committed (epoch 0) must read as cold,
    # not as a huge "age since 1970". Clamp both to just past the window so the
    # reported label is meaningful.
    dialed_epoch = last_dialed_epoch(f"{tool}-backend@{port}.service")
    dialed_age = now - dialed_epoch if dialed_epoch else IDLE_SECS + 1
    if dialed_age >= IDLE_SECS:
        if is_git_root(project):
            commit_epoch = last_commit_epoch(project)
            commit_age = now - commit_epoch if commit_epoch else IDLE_SECS + 1
            if commit_age < IDLE_SECS:
                return None
            cmsg = f"commit={commit_age // 86400}d"
        else:
            cmsg = "nongit"
        return f"{cmsg}|dialed={dialed_age // 86400}d"
    return None


def collect_candidates() -> list[tuple[str, str, str, str, Path]]:
    candidates: list[tuple[str, str, str, str, Path]] = []
    for tool, directory, project_key, port_key in INSTANCES:
        if not directory.is_dir():
            continue
        for conf in sorted(directory.glob("*.conf")):
            project, port = read_conf(conf, project_key, port_key)
            if not project or not port:
                continue
            verdict = classify(project, tool, port)
            if verdict is None:
                continue
            candidates.append((tool, port, project, verdict, conf))
    return candidates


def notify(count: int) -> None:
    if count <= 0:
        return
    try:
        active = subprocess.run(
            ["systemctl", "--user", "is-active", "graphical-session.target"],
            capture_output=True, text=True, check=False,
        ).returncode == 0
    except OSError:
        return
    if active:
        subprocess.run(
            ["notify-send", "-u", "normal", "Code-intel instances pruned",
             f"Disabled {count} idle MCP instance(s) (>= {IDLE_DAYS}d). See {LOG}"],
            check=False,
        )


def main() -> int:
    STATE.mkdir(parents=True, exist_ok=True)

    # Single-flight: a weekly timer cannot overlap, but a manual run can.
    lock_file = open(LOCK, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log(f"codeintel-instance-prune: another run holds {LOCK}; exiting", to_stderr=True)
        return 0

    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    candidates = collect_candidates()

    if not candidates:
        log(f"== {stamp} == idle={IDLE_DAYS}d  no idle instances")
        return 0

    disabled_count = 0
    for tool, port, project, verdict, conf in candidates:
        unit = f"{tool}-mcp@{port}.socket"
        if DRY:
            log(f"DRY: would disable {unit}  ({project}  {verdict})")
            continue
        result = subprocess.run(
            ["systemctl", "--user", "disable", "--now", unit],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0:
            conf.unlink(missing_ok=True)
            disabled_count += 1
            log(f"disabled {unit}  ({project}  {verdict})  removed {conf}")
        else:
            log(f"FAILED to disable {unit}  ({project}); conf left in place")

    with LOG.open("a") as fh:
        fh.write(f"== {stamp} == idle={IDLE_DAYS}d  disabled={disabled_count}/{len(candidates)}\n")

    if not DRY:
        notify(disabled_count)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
