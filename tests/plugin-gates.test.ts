import { describe, expect, test } from "bun:test";
import codeintel from "../src/index";
import mcpInstance from "../src/mcp-instance";
import serenaProvision from "../src/serena-provision";

type Edits = { added: string[]; sets: string[]; commands: string[] };

function fakeCtx(options?: Record<string, unknown>): { ctx: any; edits: Edits } {
  const edits: Edits = { added: [], sets: [], commands: [] };
  const editor = {
    add: (spec: { name: string }) => edits.added.push(String(spec?.name)),
    set: (name: string) => edits.sets.push(String(name)),
  };
  const cmdEditor = {
    add: (spec: { name: string }) => edits.commands.push(String(spec?.name)),
  };
  const ctx = {
    options,
    location: { directory: "/fixture/dir", project: { canonical: "/fixture/repo" } },
    mcp: {
      transform: async (fn: (editor: any) => void) => {
        fn(editor);
        return { dispose: () => {} };
      },
      reload: async () => {},
    },
    tool: { transform: (fn: (editor: any) => void) => fn(editor) },
    command: { transform: (fn: (editor: any) => void) => fn(cmdEditor) },
  };
  return { ctx, edits };
}

function gateOn(name: string, value = "1") {
  process.env[name] = value;
  return () => delete process.env[name];
}

describe("env gates: no registration at all", () => {
  test("SERENA_PROVISION_DISABLE=1 registers nothing", () => {
    const off = gateOn("SERENA_PROVISION_DISABLE");
    try {
      const { ctx, edits } = fakeCtx();
      serenaProvision.setup(ctx);
      expect(edits.added).toEqual([]);
    } finally {
      off();
    }
  });

  test("serena-provision registers when the gate is absent", () => {
    const { ctx, edits } = fakeCtx();
    serenaProvision.setup(ctx);
    expect(edits.added).toEqual(["serena-provision"]);
  });

  test("MCP_INSTANCE_DISABLE=1 registers nothing", async () => {
    const off = gateOn("MCP_INSTANCE_DISABLE");
    try {
      const { ctx, edits } = fakeCtx();
      await mcpInstance.setup(ctx);
      expect(edits.added).toEqual([]);
    } finally {
      off();
    }
  });

  test("CODEINTEL_DISABLE=1 suppresses all unified codeintel surfaces", async () => {
    const off = gateOn("CODEINTEL_DISABLE");
    try {
      const { ctx, edits } = fakeCtx();
      await codeintel.setup(ctx);
      expect(edits.added).toEqual([]);
      expect(edits.sets).toEqual([]);
      expect(edits.commands).toEqual([]);
    } finally {
      off();
    }
  });

  test("unified codeintel setup registers all 4 tools, 1 command, and 2 MCP routes", async () => {
    const { ctx, edits } = fakeCtx();
    const dispose = await codeintel.setup(ctx);
    try {
      expect(edits.added.sort()).toEqual([
        "codeintel",
        "mcp-instance",
        "serena-instance",
        "serena-provision",
      ]);
      expect(edits.commands).toEqual(["lsp"]);
      expect(edits.sets.sort()).toEqual(["cclsp", "serena"]);
    } finally {
      await dispose?.();
    }
  });
});
