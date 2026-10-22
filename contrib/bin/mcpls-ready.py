#!/usr/bin/env python3
"""Readiness gate for an mcpls backend on the given port.

mcpls answers the MCP handshake immediately but starts its language servers in
the background, holding whole-workspace tools behind a "still initializing"
error until each is ready. Waiting for the port to bind -- which is all cclsp
needed -- would declare readiness while every tool call still fails, so the gate
is the MCP initialize response rather than the socket.

Usage: mcpls-ready.py PORT

Exits 0 as soon as the initialize response arrives. The caller wraps this in
`timeout` so a never-ready backend fails the unit instead of hanging. Any
transport error is treated as "not ready yet" and retried, which also covers the
window before the listener binds.

The probe tears its own session down. Under supergateway `--stateful`, an
`initialize` *is* a session that owns a live stdio child, so a probe that only
posts `initialize` and walks away leaves one mcpls process behind for the life
of the unit. Sending the MCP `DELETE` hands the session back and the child is
reaped; without it every unit start costs a stray process.
"""

import json
import sys
import time
import urllib.error
import urllib.request

RETRY_INTERVAL_SECONDS = 0.5
REQUEST_TIMEOUT_SECONDS = 5

PAYLOAD = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "readiness", "version": "1"},
    },
}


def ready(port: int) -> bool:
    """Probe once. Returns True if the backend answered a handshake.

    The session is always torn down, whether the handshake succeeded or not, so
    a probe never leaves a stdio child behind.
    """
    url = f"http://127.0.0.1:{port}/mcp"
    session_id = None
    answered = False

    request = urllib.request.Request(
        url,
        data=json.dumps(PAYLOAD).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            session_id = response.headers.get("Mcp-Session-Id")
            body = response.read().decode("utf-8", "replace")
        answered = "serverInfo" in body
    except (urllib.error.URLError, OSError, TimeoutError):
        answered = False

    if session_id:
        teardown = urllib.request.Request(
            url,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Mcp-Session-Id": session_id,
            },
            method="DELETE",
        )
        try:
            urllib.request.urlopen(teardown, timeout=REQUEST_TIMEOUT_SECONDS).read()
        except (urllib.error.URLError, OSError, TimeoutError):
            # A failed teardown must not turn a healthy backend into "not ready".
            pass

    return answered


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: mcpls-ready.py PORT", file=sys.stderr)
        return 2
    try:
        port = int(sys.argv[1])
    except ValueError:
        print(f"readiness: not a port: {sys.argv[1]}", file=sys.stderr)
        return 2

    while not ready(port):
        time.sleep(RETRY_INTERVAL_SECONDS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
