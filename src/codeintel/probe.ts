// codeintel/probe — prove that a provisioned instance ANSWERS, not merely that
// its socket exists.
//
// `enableInstance` used to stop at `systemctl --user is-enabled` on a
// `systemd-socket-proxyd` listener, and that is not evidence of a working
// server: the socket is enabled and listening whether or not anything can ever
// answer behind it (a wrong backend port in the conf, a project path serena
// cannot load, a catalog mcpls rejects, a backend that never binds). All of
// those reported success. This module supplies the missing evidence: one MCP
// `initialize` through the instance's own proxy port, within a bounded budget.
//
// The protocol is the one `~/.local/bin/mcpls-ready.py` already speaks for the
// unit's readiness gate, restated here because that script is mcpls-specific and
// unbounded (it loops `until ready` with no ceiling) while this probe must serve
// BOTH servers and must return. The duplication is deliberate and is why the
// payloads are pinned in one place below.
//
// Two invariants, both load-bearing:
//
//   1. A pending answer is not a failure. Under supergateway `--stateful` mcpls
//      holds whole-workspace tools behind JSON-RPC `-32051 "still initializing"`
//      while its language servers come up, and a large serena project stays
//      busy through its own startup. Both mean "not yet", so they are retried.
//   2. The probe tears its own session down, always. An `initialize` IS a
//      session that owns a stdio child, so a probe that posts and walks away
//      leaks one process per call. See docs/records/code-intelligence-operations.md;
//      a readiness probe already caused exactly that leak once.
//
// Env: CODEINTEL_PROBE_TIMEOUT_MS overrides the per-probe budget (default
// PROBE_DEFAULT_TIMEOUT_MS). Garbage, zero and negative values fall back to the
// default rather than disabling the probe.

export const PROBE_DEFAULT_TIMEOUT_MS = 30_000;

// Same interval as mcpls-ready.py: fast enough that a warm backend answers on
// the second attempt, slow enough not to spin during a 20 s cold start.
export const RETRY_INTERVAL_MS = 500;

// Per-request timeout. A hung connection must not silently consume the whole
// budget: each attempt is bounded independently and a timeout counts as a
// transport-level retry.
export const REQUEST_TIMEOUT_MS = 5_000;

const PROTOCOL_VERSION = "2024-11-05";

export type ProbeResult =
  | { kind: "answered"; server: string; version: string }
  | { kind: "pending"; detail: string }
  | { kind: "failed"; detail: string };

export type ProbeAttempt = { kind: "transport" | "pending" | "failed" | "answered"; atMs: number };

export type ProbeOutcome =
  | { ok: true; server: string; version: string; tools?: number }
  | { ok: false; reason: "exhausted" | "failed"; detail: string };

// The budget as a decision rather than a branch in the shell: unset means the
// default, a positive integer means itself, and anything a user can mistype
// (empty, zero, negative, non-numeric) also means the default. A zero budget
// would otherwise make every enable report failure instantly.
export function probeBudget(env: { CODEINTEL_PROBE_TIMEOUT_MS?: string } = {}): number {
  const raw = env.CODEINTEL_PROBE_TIMEOUT_MS;
  if (raw === undefined) return PROBE_DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return PROBE_DEFAULT_TIMEOUT_MS;
  return parsed;
}

function endpoint(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function rpc(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

// The handshake request: URL and body in one place, so the shell never composes
// protocol text and a test can assert the exact payload.
export function handshakeRequest(port: number): { url: string; body: string } {
  return {
    url: endpoint(port),
    body: rpc(1, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codeintel-probe", version: "1" },
    }),
  };
}

export function toolsRequest(port: number): { url: string; body: string } {
  return { url: endpoint(port), body: rpc(2, "tools/list", {}) };
}

// The transport may answer in either legal framing: one JSON document, or an
// SSE stream of `event:`/`data:` lines. Assuming one would make the probe fail
// against a server that chose the other, so both are decoded here and the first
// value that parses wins. `contentType` is accepted for callers that want to
// reason about framing, but decoding is driven by the body so a mislabelled
// content type cannot break a working probe.
export function decodeBody(contentType: string, body: string): unknown | undefined {
  void contentType;
  const text = body.trim();
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    // Not a bare JSON document; try SSE framing below.
  }

  const events: string[] = [];
  let data: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.trim() === "") {
      if (data.length > 0) {
        events.push(data.join("\n"));
        data = [];
      }
      continue;
    }
    if (trimmed.startsWith("data:")) {
      data.push(trimmed.slice("data:".length).replace(/^ /, ""));
    }
    // `event:`, `id:`, `retry:` and comment lines carry nothing we need.
  }
  if (data.length > 0) events.push(data.join("\n"));

  for (const event of events) {
    try {
      return JSON.parse(event);
    } catch {
      continue;
    }
  }
  return undefined;
}

// A JSON-RPC envelope, whichever framing carried it.
type Envelope = {
  result?: { serverInfo?: { name?: unknown; version?: unknown }; tools?: unknown };
  error?: { code?: unknown; message?: unknown };
};

function asEnvelope(value: unknown): Envelope | undefined {
  return typeof value === "object" && value !== null ? (value as Envelope) : undefined;
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

// One handshake response as a verdict. Precedence is deliberate: a transport
// status first (a 5xx body is not a protocol answer), then a JSON-RPC error
// (-32051 is "not yet", anything else is a refusal), then serverInfo.
export function parseHandshake(status: number, contentType: string, body: string): ProbeResult {
  const value = asEnvelope(decodeBody(contentType, body));

  if (value?.error) {
    const code = typeof value.error.code === "number" ? value.error.code : undefined;
    const message = typeof value.error.message === "string" ? value.error.message : "";
    const detail = [code === undefined ? "error" : String(code), message]
      .filter(Boolean)
      .join(": ");
    return code === -32051 ? { kind: "pending", detail } : { kind: "failed", detail };
  }

  if (status < 200 || status >= 300) {
    return { kind: "failed", detail: `HTTP ${status}: ${excerpt(body) || "(empty body)"}` };
  }

  const info = value?.result?.serverInfo;
  if (info !== undefined && info !== null && typeof info === "object") {
    return {
      kind: "answered",
      server: typeof info.name === "string" ? info.name : "unknown",
      version: typeof info.version === "string" ? info.version : "unknown",
    };
  }

  return {
    kind: "failed",
    detail: `HTTP ${status} without a serverInfo: ${excerpt(body) || "(empty body)"}`,
  };
}

// The tool count from a `tools/list` answer. Never a verdict: an answered
// handshake stays answered even if this round trip fails, because the backend
// demonstrably answered — the count is the falsifiable detail, not the proof.
export function parseTools(status: number, contentType: string, body: string): number | undefined {
  if (status < 200 || status >= 300) return undefined;
  const tools = asEnvelope(decodeBody(contentType, body))?.result?.tools;
  return Array.isArray(tools) ? tools.length : undefined;
}

// The retry policy, pure. Three outcomes, not two, because the caller must
// distinguish "stop, it refused" from "stop, we ran out" when reporting:
// `answered` is success, `failed` is a definitive refusal (another attempt gets
// the same answer, so retrying only wastes the budget), and `retry` means the
// sequence so far holds only transport errors and/or pending answers.
export function verdict(attempts: ProbeAttempt[]): "answered" | "failed" | "retry" {
  for (const attempt of attempts) {
    if (attempt.kind === "answered") return "answered";
    if (attempt.kind === "failed") return "failed";
  }
  return "retry";
}

type AttemptOutcome =
  | {
      kind: "answered";
      server: string;
      version: string;
      sessionId: string | null;
      tools?: number;
    }
  | { kind: "pending"; detail: string; sessionId: string | null }
  | { kind: "failed"; detail: string; sessionId: string | null }
  | { kind: "transport"; detail: string; sessionId: null };

type HttpResult = { status: number; contentType: string; body: string; sessionId: string | null };

async function post(url: string, body: string, sessionId?: string | null): Promise<HttpResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
    sessionId: response.headers.get("mcp-session-id"),
  };
}

// The teardown. Best-effort and never decisive: a failed DELETE must not turn a
// healthy backend into "not ready", but it must be attempted, because under
// `--stateful` this is what hands the session (and its stdio child) back.
async function close(url: string, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try {
    await fetch(url, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Deliberately swallowed: see the module header.
  }
}

// One attempt: POST the handshake, classify the answer, and always tear the
// session down before returning. On an answer the tool count is read in THIS
// session, before the teardown: the handshake has already proved the server
// answers, so a second session only to count its tools doubled the round trips
// of every successful probe (two handshakes and two closes per verify).
async function attempt(port: number): Promise<AttemptOutcome> {
  const { url, body } = handshakeRequest(port);
  let sessionId: string | null = null;
  try {
    const response = await post(url, body);
    sessionId = response.sessionId;
    const result = parseHandshake(response.status, response.contentType, response.body);
    if (result.kind !== "answered") return classify(result, sessionId);
    return {
      kind: "answered",
      server: result.server,
      version: result.version,
      sessionId,
      tools: await listToolCount(url, sessionId),
    };
  } catch (error) {
    return {
      kind: "transport",
      detail: error instanceof Error ? error.message : String(error),
      sessionId: null,
    };
  } finally {
    await close(url, sessionId);
  }
}

function classify(result: ProbeResult, sessionId: string | null): AttemptOutcome {
  if (result.kind === "answered") {
    // Unreachable from `attempt` (it builds the answered arm itself, with the
    // tool count), kept total so the union stays exhaustive.
    return { kind: "answered", server: result.server, version: result.version, sessionId };
  }
  return { kind: result.kind, detail: result.detail, sessionId };
}

// The shell. Retries transport errors and pending answers until the budget is
// spent, stops on an answer or a refusal, and reports the tool count when the
// handshake succeeded. Always returns; never throws.
export async function probeInstance(
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const budget = opts.timeoutMs ?? probeBudget(process.env);
  const deadline = Date.now() + budget;
  const attempts: ProbeAttempt[] = [];
  let lastDetail = "";

  while (true) {
    const started = Date.now();
    const outcome = await attempt(port);
    attempts.push({ kind: outcome.kind, atMs: Date.now() - started });
    if (outcome.kind === "answered") {
      return {
        ok: true,
        server: outcome.server,
        version: outcome.version,
        ...(outcome.tools === undefined ? {} : { tools: outcome.tools }),
      };
    }
    lastDetail = outcome.detail;

    const state = verdict(attempts);
    if (state === "failed") {
      return { ok: false, reason: "failed", detail: lastDetail || "backend refused the handshake" };
    }

    if (Date.now() + RETRY_INTERVAL_MS >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }

  const summary = `${attempts.length} attempt${attempts.length === 1 ? "" : "s"} in ${budget} ms`;
  return {
    ok: false,
    reason: "exhausted",
    detail: lastDetail ? `${summary}; last: ${lastDetail}` : `${summary} without an answer`,
  };
}

// The tool count, read in the caller's live session. A failure here is silent by
// design — the handshake is the proof, the count is the detail — so this returns
// undefined rather than failing the probe.
async function listToolCount(url: string, sessionId: string | null): Promise<number | undefined> {
  const { body } = toolsRequest(0);
  try {
    const listed = await post(url, body, sessionId);
    return parseTools(listed.status, listed.contentType, listed.body);
  } catch {
    return undefined;
  }
}
