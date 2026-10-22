// The lifecycle's `ok` must survive every surface. `enableInstance` and
// `disableInstance` report failure as prose, so a surface that prints `.message`
// without reading `.ok` turns "the route is a dead conf" into a success. Each
// surface is driven here with an injected failing operation, because the defect
// is only visible by invoking the registration — not by checking that setup ran.

import { describe, expect, test } from "bun:test";
import lspCommand from "../src/lsp-command";
import mcpInstance, { registerTool as registerMcpInstance } from "../src/mcp-instance";
import serenaInstance from "../src/serena-instance";
import { registerTool as registerCodeintel, type CoverageRun } from "../src/codeintel-tool";
import { envelope, type Bound } from "../src/codeintel/instance";

const FAILED = { ok: false, message: "fallback: wrote 8899.conf but failed to enable the socket" };
const OK = { ok: true, message: "fallback: instance created" };

function fakeBound(enable = OK, disable = OK): Bound {
  return { name: "cclsp", enable: async () => enable, disable: async () => disable };
}

function fakeEditor() {
  const specs: any[] = [];
  const editor = { add: (spec: any) => specs.push(spec), set: () => {} };
  return { specs, editor };
}

function fakeToolCtx() {
  const { specs, editor } = fakeEditor();
  const ctx = { tool: { transform: (fn: (editor: any) => void) => fn(editor) } };
  return { ctx, specs };
}

describe("tool envelopes carry ok", () => {
  test("mcp-instance reports a failed enable as a tool error", async () => {
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(ctx, fakeBound(FAILED, FAILED));
    const result = await specs[0].execute({ action: "enable" });
    expect(result).toEqual({ content: FAILED.message, isError: true });
  });

  test("mcp-instance reports a failed disable as a tool error", async () => {
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(ctx, fakeBound(OK, FAILED));
    expect(await specs[0].execute({ action: "disable" })).toEqual({
      content: FAILED.message,
      isError: true,
    });
  });

  test("mcp-instance reports success without an error flag", async () => {
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(ctx, fakeBound(OK, OK));
    expect(await specs[0].execute({ action: "enable" })).toEqual({
      content: OK.message,
      isError: false,
    });
  });

  test("mcp-instance still registers its tool through setup", () => {
    const { ctx, specs } = fakeToolCtx();
    mcpInstance.setup(ctx);
    expect(specs.map((s) => s.name)).toEqual(["mcp-instance"]);
  });

  test("a failed coverage run is a tool error that still carries the table", async () => {
    const { ctx, specs } = fakeToolCtx();
    const run: CoverageRun = async () => ({
      ok: false,
      message: "coverage:\n  cclsp  FAILED",
      results: [{ server: "cclsp", root: "/x", ok: false, message: "did not answer" }],
    });
    registerCodeintel(ctx, run);
    expect(await specs[0].execute({ directory: "/x" })).toEqual({
      content: "coverage:\n  cclsp  FAILED",
      isError: true,
    });
  });

  test("codeintel declares the verbs it honours and refuses to accept a silent third", () => {
    const { ctx, specs } = fakeToolCtx();
    registerCodeintel(ctx, async () => ({ ok: true, message: "", results: [] }));
    expect(specs[0].input.properties.action.enum).toEqual(["enable", "status"]);
  });

  test("codeintel's status verb reports the host without running the plan", async () => {
    const { ctx, specs } = fakeToolCtx();
    let ran = 0;
    registerCodeintel(ctx, (async () => {
      ran += 1;
      return { ok: true, message: "provisioned", results: [] };
    }) as CoverageRun);
    const result = await specs[0].execute({ action: "status" });
    expect(ran).toBe(0);
    expect(result.content).toContain("instances (");
    expect(result.isError).toBeUndefined();
  });

  test("the envelope is one function, so one test covers every surface", () => {
    expect(envelope(FAILED)).toEqual({ content: FAILED.message, isError: true });
    expect(envelope(OK)).toEqual({ content: OK.message, isError: false });
  });

  test("serena-instance registers its tool through setup", () => {
    const { ctx, specs } = fakeToolCtx();
    serenaInstance.setup(ctx);
    expect(specs.map((s) => s.name)).toEqual(["serena-instance"]);
    expect(specs[0].input.properties.action.enum).toEqual([
      "enable",
      "refresh",
      "disable",
      "status",
      "submodules",
    ]);
  });
});

describe("/lsp announces a failed provision", () => {
  async function runLsp(text: string) {
    const emitted: string[] = [];
    const commands: any[] = [];
    const ctx = {
      location: { directory: "/fixture/dir" },
      command: {
        transform: (fn: (editor: any) => void) => fn({ add: (s: any) => commands.push(s) }),
      },
      session: {
        get: async () => ({ directory: "/fixture/dir" }),
        synthetic: async ({ text: t }: { text: string }) => emitted.push(t),
      },
    };
    await lspCommand.setup(ctx);
    await commands[0].execute({ sessionID: "ses_x", prompt: { text } });
    return emitted.join("\n");
  }

  test("a bare `/lsp` still reports the enable outcome it was given", async () => {
    const text = await runLsp("");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("/lsp failed");
  });

  test("`/lsp status` does not claim a failure", async () => {
    const text = await runLsp("status");
    expect(text).not.toContain("/lsp failed");
  });
});
