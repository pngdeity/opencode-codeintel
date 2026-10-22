// Boundary tests for mcp-route.ts. The plugin is an imperative shell — reading
// conf directories and driving OpenCode's reconciliation loop — so there is no
// logic to extract. What is testable is the wiring: the conf parser, the port
// guard, the longest-prefix lookup, and the editor calls the shell makes. The
// editor and the notice set are both injected fakes, so the live module
// singleton is never touched and the tests are order-independent.

import { describe, expect, test } from "bun:test";
import { applyRoute, isPort, lookup, parseConf } from "../src/mcp-route";
import plugin from "../src/mcp-route";

type SetCall = [string, Record<string, unknown>];

function fakeEditor(): { calls: SetCall[]; set: (name: string, value: any) => void } {
  const calls: SetCall[] = [];
  return { calls, set: (name: string, value: any) => calls.push([name, value]) };
}

describe("parseConf", () => {
  test("reads key=value pairs", () => {
    expect(parseConf("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  test("ignores blank lines and comments", () => {
    expect(parseConf("# note\n\nA=1")).toEqual({ A: "1" });
  });

  test("splits on the first = only", () => {
    expect(parseConf("A=x=y")).toEqual({ A: "x=y" });
  });

  test("trims surrounding whitespace on key and value", () => {
    expect(parseConf("  A  =  1  ")).toEqual({ A: "1" });
  });

  test("a line with no = is skipped", () => {
    expect(parseConf("noequals\nA=1")).toEqual({ A: "1" });
  });
});

describe("isPort", () => {
  test("accepts an in-range integer", () => {
    expect(isPort(8801)).toBe(true);
  });

  test("rejects a non-number", () => {
    expect(isPort("8801")).toBe(false);
  });

  test("rejects a non-integer", () => {
    expect(isPort(88.5)).toBe(false);
  });

  test("rejects zero and negatives", () => {
    expect(isPort(0)).toBe(false);
    expect(isPort(-1)).toBe(false);
  });

  test("rejects 65536 and above", () => {
    expect(isPort(65536)).toBe(false);
  });
});

describe("lookup", () => {
  const table = new Map<string, { serena?: number; cclsp?: number }>([
    ["/repo", { serena: 8801 }],
    ["/repo/nested", { cclsp: 8802 }],
  ]);

  test("an exact root matches", () => {
    expect(lookup(table, "/repo")).toEqual({ serena: 8801 });
  });

  test("a subdirectory matches its root", () => {
    expect(lookup(table, "/repo/src")).toEqual({ serena: 8801 });
  });

  test("the most specific root wins", () => {
    expect(lookup(table, "/repo/nested/deep")).toEqual({ cclsp: 8802 });
  });

  test("a sibling prefix without a slash does not match", () => {
    expect(lookup(table, "/repository")).toBeUndefined();
  });

  test("a trailing slash on the location is normalised", () => {
    expect(lookup(table, "/repo/")).toEqual({ serena: 8801 });
  });

  test("an empty or non-string directory matches nothing", () => {
    expect(lookup(table, "")).toBeUndefined();
    expect(lookup(table, undefined as unknown as string)).toBeUndefined();
  });
});

describe("applyRoute", () => {
  test("a routed server is enabled at its project endpoint", () => {
    const editor = fakeEditor();
    applyRoute(editor, { serena: 8801, cclsp: 8802 }, "/repo", new Set());
    expect(editor.calls).toEqual([
      ["serena", { type: "remote", url: "http://127.0.0.1:8801/mcp", disabled: false }],
      ["cclsp", { type: "remote", url: "http://127.0.0.1:8802/mcp", disabled: false }],
    ]);
  });

  test("an unrouted location disables both servers without notifying", () => {
    const editor = fakeEditor();
    applyRoute(editor, undefined, "/elsewhere", new Set());
    expect(editor.calls.map((c) => c[1].disabled)).toEqual([true, true]);
  });

  test("a routed root with no instance for one server disables it", () => {
    const editor = fakeEditor();
    applyRoute(editor, { cclsp: 8802 }, "/repo", new Set());
    const serena = editor.calls.find((c) => c[0] === "serena");
    expect(serena?.[1].disabled).toBe(true);
    const cclsp = editor.calls.find((c) => c[0] === "cclsp");
    expect(cclsp?.[1].disabled).toBe(false);
  });

  test("the notice is emitted once per (server, directory)", () => {
    const seen = new Set<string>();
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (...args: any[]) => warns.push(String(args[0]));
    try {
      applyRoute(fakeEditor(), { cclsp: 8802 }, "/repo", seen);
      applyRoute(fakeEditor(), { cclsp: 8802 }, "/repo", seen);
    } finally {
      console.warn = original;
    }
    expect(warns.length).toBe(1);
  });

  test("an invalid port is treated as unrouted", () => {
    const editor = fakeEditor();
    applyRoute(editor, { serena: 0 }, "/repo", new Set());
    const serena = editor.calls.find((c) => c[0] === "serena");
    expect(serena?.[1].disabled).toBe(true);
  });
});

// The shell's wiring, against a fake ctx. Two regressions are held here:
//   1. setup() must apply the table it just built. Without a reload at setup, a
//      conf that already existed when the plugin loaded is baselined by the
//      fingerprint and never applied, so the entry keeps its shipped
//      `disabled: true` — silently indistinguishable from an unprovisioned
//      project.
//   2. setup() must route against BOTH forms of the location (canonical and
//      directory), because they can disagree.
function fakeCtx(location: { directory?: string; project?: { canonical?: string } }): {
  ctx: any;
  reloads: () => number;
  transforms: () => number;
  routed: () => SetCall[];
} {
  let reloads = 0;
  let transforms = 0;
  let routed: SetCall[] = [];
  const ctx = {
    location,
    mcp: {
      transform: async (fn: (editor: any) => void) => {
        transforms += 1;
        const editor = fakeEditor();
        fn(editor);
        routed = editor.calls;
        return { dispose: () => {} };
      },
      reload: async () => {
        reloads += 1;
      },
    },
  };
  return { ctx, reloads: () => reloads, transforms: () => transforms, routed: () => routed };
}

describe("setup", () => {
  test("applies the route table once, regardless of the fingerprint", async () => {
    const { ctx, reloads, transforms, routed } = fakeCtx({
      directory: "/nonexistent-route-test-root",
    });
    const dispose = await (plugin as any).setup(ctx);
    try {
      expect(transforms()).toBe(1);
      expect(reloads()).toBe(1);
      expect(routed().map((c) => c[1].disabled)).toEqual([true, true]);
    } finally {
      await dispose?.();
    }
  });

  test("an unrouted location still reloads once and disables both servers", async () => {
    const { ctx, reloads } = fakeCtx({ directory: "/nonexistent-route-test-root" });
    const seen: any[] = [];
    ctx.mcp.transform = async (fn: (editor: any) => void) => {
      fn({ set: (name: string, value: any) => seen.push([name, value]) });
      return { dispose: () => {} };
    };
    const dispose = await (plugin as any).setup(ctx);
    try {
      expect(reloads()).toBe(1);
      expect(seen.map((c) => c[1].disabled)).toEqual([true, true]);
    } finally {
      await dispose?.();
    }
  });

  test("the environment gate suppresses setup entirely", async () => {
    const { ctx, reloads, transforms } = fakeCtx({ directory: "/nonexistent-route-test-root" });
    process.env.MCP_ROUTE_DISABLE = "1";
    try {
      const dispose = await (plugin as any).setup(ctx);
      expect(transforms()).toBe(0);
      expect(reloads()).toBe(0);
      await dispose?.();
    } finally {
      delete process.env.MCP_ROUTE_DISABLE;
    }
  });
});

// The location has two forms and `instanceDirectory` prefers `project.canonical`.
// This is the wiring leg: `lookup` is given both forms, so a route reachable
// only from the unresolved form is applied instead of disabled. The fixture root
// comes from a real instance conf, because the conf directories are this
// plugin's own input and a hand-made root would prove nothing about routing.
import { readdirSync, readFileSync } from "node:fs";

function routeFixtureRoot(): string | undefined {
  const home = process.env.HOME ?? "";
  for (const dir of [`${home}/.config/serena/instances`, `${home}/.config/cclsp/instances`]) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".conf"));
    } catch {
      continue;
    }
    for (const file of files) {
      const conf = parseConf(readFileSync(`${dir}/${file}`, "utf8"));
      const project = conf.SERENA_PROJECT ?? conf.CCLSP_PROJECT;
      if (project) return project;
    }
  }
  return undefined;
}

describe("setup with disagreeing location forms", () => {
  test("a route reachable only from the unresolved form is applied, not disabled", async () => {
    const root = routeFixtureRoot();
    if (!root) return;
    const { ctx, routed } = fakeCtx({
      directory: root,
      project: { canonical: "/nonexistent-canonical-root" },
    });
    const dispose = await (plugin as any).setup(ctx);
    try {
      expect(routed().some((c) => c[1].disabled === false)).toBe(true);
    } finally {
      await dispose?.();
    }
  });
});
