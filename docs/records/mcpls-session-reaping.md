# mcpls session reaping — the withdrawn "leak" finding (F-P3-1)

**Status: withdrawn. Do not re-derive the finding.** The defect described here
does not exist in this setup. Kept because the arithmetic in it looks convincing
if you have not sent the MCP `DELETE`, and it was rediscovered once already.

Originally recorded as `F-P3-1.md` in the mcpls migration's scratch artifacts;
kept in the documentation because the record outlived the scratch directory that
produced it.

## What the original finding claimed

That `--stateful` leaked one `mcpls` child per session because supergateway
never reaped the child when a session ended. Evidence offered: 4 sessions
produced 4 `mcpls` children, and one probing run accumulated 9 generations
(~92 language-server processes, ~6.3 GB RSS). It was upgraded to a Phase 3
blocker because a leaked child is a *cold* child, so a
connect-query-disconnect client would pay the cold start, fail, and leave the
child behind.

## Why it was wrong

**The sessions were never closed.** In `--stateful` mode an open session
legitimately owns one live stdio child; that is the design, not a leak. The
probe opened sessions, counted children, and moved on without ever sending the
HTTP `DELETE` that tears a session down. Counting children of sessions still
open cannot distinguish "one child per live session" (correct) from
"children accumulate forever" (the defect) — the original test had no way to
tell them apart, and the conclusion drawn from it was an artifact of that.

A second confounder: the probing ran on a host already at load average 14.5 on
8 CPUs with six serena instances live, and the ~6.3 GB figure mixed these
sessions with genuinely unrelated LSP load.

## What the retest showed

Both supergateway versions reap correctly on **both** the graceful and the
ungraceful path. The ungraceful path is the one upstream's issues were actually
about, and it was simulated by abandoning sessions with no `DELETE` and no
stream close — what a killed client looks like:

| Test | 4.0.0 (ours) | 4.1.0 |
|---|---|---|
| 3 sessions, graceful `DELETE` | 3 during -> **0 after** | 3 during -> **0 after** |
| 3 sessions abandoned, then wait for `--sessionTimeout` | 3 -> **0 after** | 3 -> **0 after** |
| supergateway process stopped | **0** remain | **0** remain |

Harness (ephemeral, no longer present — it was scratch): `ab-reap.py`
(graceful), `ungraceful.py` (abandoned), `run-ab.sh` (driver), with logs
`ab-v400.log`, `ab-v410.log`, `ungraceful-400.log`, `ungraceful-410.log`.
The method is described above in enough detail to reconstruct it.

Also withdrawn as a consequence: the "orphan gate FAILS" reading. Nothing was
re-parented to init. Every counted child still had a live `mcpls` parent under a
live supergateway, and the apparent "escape" in one run was a false positive --
that PID belonged to a different instance (8815).

## What upstream says (investigated, and it agrees)

supergateway is actively maintained again ("back to maintaining this full
time"), at 4.1.0 stable with 4.2.0-rc.2 in flight. Per-session child reaping is
a known and now-fixed upstream concern:

- **#141** "Orphan stdio child after transport close" — production data, linear
  PID growth 44 -> 308 and OOM at a 2 GiB limit.
- **#160** "`--sessionTimeout` never arms while the GET SSE stream is open".
- **#108** "Memory Leak in Stateless streamableHttp Mode".

**#141 and #160 were both closed on 2026-09-30, the day 4.1.0 shipped.** The
maintainer's closing comment: *"this is covered now: v4 reaps the whole process
group (not just the sh wrapper), and v4.1.0 also cleans up when the transport
closes without its session id, with a real process-tree test."* PR #152 (the
community fix) is closed-unmerged; the maintainer landed their own v4 version.

Verified in the 4.1.0 source rather than taken from the changelog: 4.1.0 ships
`lib/ownedChildProcesses.js`, which spawns with `detached: true` and kills via
`process.kill(-pid, ...)` with a bounded SIGTERM -> SIGKILL escalation, fired on
the child's `exit` and **not** gated on session id. That is the architectural
fix for the class the original finding claimed.

## Why this was never blocking

The one real symptom is **cold start** (~8 s per fresh session, longer under
load), which both versions share and which is inherent to any
per-session-child design. It is a latency cost, not a resource leak, and it is
not fixed by the reaper options the original finding proposed — only the
supervisor option addresses it, and that is an optimisation, not a defect fix.

## The one open upstream issue that looked relevant, and is not

**#155** "Server keeps running after its launching process dies" is still open,
but is **already covered for us**: on 4.0.0 the gateway shuts down when its
stdin pipe closes, and systemd gives the unit a stdin pipe. That is the same
stdin-EOF behaviour observed when mcpls exited on EOF — the mechanism is working
in our favour, not against us. It is also why the `--stateful` requirement
exists: stateless mode closes the child's stdin after each response, which mcpls
reads as a shutdown signal.

## Residual, recorded so it is not lost

Two things from the original investigation remain true and useful:

1. **systemd's kill is cgroup-membership-scoped and fires only on unit stop.**
   Verified against `systemd.kill(5)` (systemd 262) and empirically: a `sleep`
   reparented to PID 1, then moved into the unit's cgroup, was killed by
   `systemctl --user stop` despite not being in the main process's subtree. So
   the unit is a reliable backstop for anything that has not left the cgroup.
   `KillMode=control-group` is the documented default, so the explicit line in
   `share/systemd/user/cclsp-backend@.service` is defensive documentation rather
   than load-bearing.
2. **The readiness-gate and quoting traps** (systemd strips backslashes from
   `ExecStart=`, forcing the probe into a file) are unrelated to this finding
   and are documented in the unit file and in
   [cclsp-retirement.md](../cclsp-retirement.md).
