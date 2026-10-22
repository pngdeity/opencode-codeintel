// The pure half of codeintel/probe.ts: the budget decision, the two request
// payloads, the two transport framings, the handshake classifier, the tool-count
// reader and the retry policy. No network, no timers — except the one case that
// pins `probeInstance`'s handshake BUDGET, which needs a server to count.

import { describe, expect, test } from "bun:test";
import {
  decodeBody,
  handshakeRequest,
  parseHandshake,
  parseTools,
  PROBE_DEFAULT_TIMEOUT_MS,
  probeBudget,
  probeInstance,
  toolsRequest,
  verdict,
} from "./probe";

describe("probeBudget", () => {
  test("unset means the default", () => {
    expect(probeBudget({})).toBe(PROBE_DEFAULT_TIMEOUT_MS);
  });

  test("a positive integer means itself, whitespace tolerated", () => {
    expect(probeBudget({ CODEINTEL_PROBE_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(probeBudget({ CODEINTEL_PROBE_TIMEOUT_MS: " 7500 " })).toBe(7500);
  });

  test("zero, negative, empty and garbage all fall back to the default", () => {
    // A zero budget would make every enable report failure instantly, which is
    // worse than ignoring the setting.
    expect(probeBudget({ CODEINTEL_PROBE_TIMEOUT_MS: "0" })).toBe(PROBE_DEFAULT_TIMEOUT_MS);
    expect(probeBudget({ CODEINTEL_PROBE_TIMEOUT_MS: "-1" })).toBe(PROBE_DEFAULT_TIMEOUT_MS);
    expect(probeBudget({ CODEINTEL_PROBE_TIMEOUT_MS: "" })).toBe(PROBE_DEFAULT_TIMEOUT_MS);
    expect(probeBudget({ CODEINTEL_PROBE_TIMEOUT_MS: "soon" })).toBe(PROBE_DEFAULT_TIMEOUT_MS);
  });
});

describe("handshakeRequest", () => {
  test("posts to the instance's own proxy port", () => {
    expect(handshakeRequest(8824).url).toBe("http://127.0.0.1:8824/mcp");
  });

  test("the body is a JSON-RPC initialize carrying a client identity", () => {
    const body = JSON.parse(handshakeRequest(8824).body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("initialize");
    expect(typeof body.id).toBe("number");
    expect(body.params.clientInfo.name).toBe("codeintel-probe");
    expect(typeof body.params.protocolVersion).toBe("string");
  });

  test("tools/list reuses the same endpoint under its own id", () => {
    expect(toolsRequest(8824).url).toBe("http://127.0.0.1:8824/mcp");
    const body = JSON.parse(toolsRequest(8824).body);
    expect(body.method).toBe("tools/list");
    expect(body.id).not.toBe(JSON.parse(handshakeRequest(8824).body).id);
  });
});

describe("decodeBody", () => {
  test("a bare JSON document decodes", () => {
    expect(decodeBody("application/json", '{"a":1}')).toEqual({ a: 1 });
  });

  test("an SSE frame decodes through its data line", () => {
    const sse = 'event: message\ndata: {"a":1}\n\n';
    expect(decodeBody("text/event-stream", sse)).toEqual({ a: 1 });
  });

  test("comments, blank separators and multiple events do not defeat it", () => {
    const sse = ': keepalive\nevent: message\ndata: {"first":true}\n\ndata: {"second":true}\n\n';
    expect(decodeBody("text/event-stream", sse)).toEqual({ first: true });
  });

  test("a data payload split across lines is rejoined", () => {
    const sse = 'data: {"a":\ndata: 1}\n\n';
    expect(decodeBody("text/event-stream", sse)).toEqual({ a: 1 });
  });

  test("CRLF line endings decode", () => {
    expect(decodeBody("text/event-stream", 'data: {"a":1}\r\n\r\n')).toEqual({ a: 1 });
  });

  test("an empty or undecodable body yields undefined, not a throw", () => {
    expect(decodeBody("text/event-stream", "")).toBeUndefined();
    expect(decodeBody("text/event-stream", "not json at all")).toBeUndefined();
  });
});

describe("parseHandshake", () => {
  const ok = (serverInfo: object) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo } });

  test("a JSON answer with serverInfo is answered, with name and version", () => {
    expect(
      parseHandshake(200, "application/json", ok({ name: "Serena", version: "2.0.0" })),
    ).toEqual({ kind: "answered", server: "Serena", version: "2.0.0" });
  });

  test("the same answer over SSE is answered", () => {
    const sse = `event: message\ndata: ${ok({ name: "mcpls", version: "0.7.0" })}\n\n`;
    expect(parseHandshake(200, "text/event-stream", sse)).toEqual({
      kind: "answered",
      server: "mcpls",
      version: "0.7.0",
    });
  });

  test("a missing serverInfo field degrades to unknown rather than failing", () => {
    expect(parseHandshake(200, "application/json", ok({}))).toEqual({
      kind: "answered",
      server: "unknown",
      version: "unknown",
    });
  });

  test("-32051 is pending, in both framings: not yet is not a failure", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32051, message: "still initializing" },
    });
    expect(parseHandshake(200, "application/json", body).kind).toBe("pending");
    expect(parseHandshake(200, "text/event-stream", `data: ${body}\n\n`).kind).toBe("pending");
  });

  test("any other JSON-RPC error is a definitive failure carrying the code", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found" },
    });
    const result = parseHandshake(200, "application/json", body);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.detail).toContain("-32601");
  });

  test("a non-2xx status is a failure even when the body is a valid answer", () => {
    const result = parseHandshake(503, "application/json", "upstream closed");
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.detail).toContain("503");
  });

  test("a 2xx with no serverInfo is a failure, with the body excerpted", () => {
    const result = parseHandshake(200, "application/json", '{"jsonrpc":"2.0","id":1}');
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.detail).toContain("serverInfo");
  });

  test("a long body is excerpted so the message cannot become the log", () => {
    const result = parseHandshake(200, "application/json", "x".repeat(5000));
    expect(result.kind === "failed" && result.detail.length).toBeLessThan(400);
  });
});

describe("parseTools", () => {
  test("the length of result.tools", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{}, {}, {}] } });
    expect(parseTools(200, "application/json", body)).toBe(3);
  });

  test("an empty tool list is zero, not undefined", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(parseTools(200, "application/json", body)).toBe(0);
  });

  test("a missing or malformed tools field is undefined", () => {
    expect(parseTools(200, "application/json", '{"result":{}}')).toBeUndefined();
    expect(parseTools(200, "application/json", '{"result":{"tools":"no"}}')).toBeUndefined();
    expect(parseTools(200, "application/json", "garbage")).toBeUndefined();
  });

  test("a non-2xx answer is undefined even with a tool list body", () => {
    const body = JSON.stringify({ result: { tools: [{}] } });
    expect(parseTools(500, "application/json", body)).toBeUndefined();
  });
});

describe("verdict", () => {
  const at = (kind: "transport" | "pending" | "failed" | "answered") => ({ kind, atMs: 1 });

  test("answered anywhere in the sequence wins", () => {
    expect(verdict([at("transport"), at("pending"), at("answered")])).toBe("answered");
    expect(verdict([at("answered")])).toBe("answered");
  });

  test("a refusal stops the loop even after pending answers", () => {
    // Retrying a refusal only burns the budget: it will refuse again.
    expect(verdict([at("pending"), at("failed")])).toBe("failed");
  });

  test("transport errors and pending answers alone mean keep retrying", () => {
    expect(verdict([at("transport"), at("pending")])).toBe("retry");
    expect(verdict([])).toBe("retry");
  });
});

describe("probeInstance's handshake budget", () => {
  test("a successful probe is one handshake, one tools/list, one close", async () => {
    // The defect this pins: the tool count used to be read from a SECOND
    // session, because the handshake's was already closed — two handshakes for
    // every verify. Counting the requests is the only way to see it, since both
    // spellings return the same answer.
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        seen.push(request.method);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(await request.text());
        if (body.method === "initialize") {
          return Response.json(
            { jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "fake", version: "1" } } },
            { headers: { "mcp-session-id": "probe-test" } },
          );
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{}, {}] } });
      },
    });
    try {
      const result = await probeInstance(server.port, { timeoutMs: 2000 });
      expect(result.ok).toBe(true);
      expect(result.ok && result.tools).toBe(2);
      expect(seen.filter((m) => m === "POST").length).toBe(2);
      expect(seen.filter((m) => m === "DELETE").length).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
