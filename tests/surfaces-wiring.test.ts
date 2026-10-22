// Every provisioning surface, invoked through its REAL registration path — the
// one test whose absence let the audited defect ship.
//
// `ok-propagation.test.ts` drives each surface with a fake lifecycle and is the
// right test for the envelope. It is the wrong test for wiring: the default
// binding was never executed, so `mcp-instance enable` threw
// `undefined is not an object (evaluating 'opts.directory')` on every call while
// 317 tests passed. Here a real `bind(...)` is what the surface runs.
//
// The host stays untouched because the bound lifecycle is given the same
// injectable effects `enableInstance` already exposes — resolver, conf reader and
// verify hook. The descriptor, the eligibility mode and the envelope are the
// production ones; only git, systemd and the probe are faked.
//
// The registry suite is the completeness assertion: a new provisioning surface
// that is not covered here fails, rather than being discovered by a model.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conf, ServerDescriptor } from "../src/codeintel/core";
import { bind, type Bound, type EnableEffects } from "../src/codeintel/instance";
import { SERENA } from "../src/codeintel/descriptors";
import lspCommand from "../src/lsp-command";
import mcpInstance, { registerTool as registerMcpInstance } from "../src/mcp-instance";
import serenaInstance from "../src/serena-instance";

const ROOT = "/fixture/surfaces-repo";

// A descriptor with the conf/unit shape a real one declares and nothing on the
// host behind it: `provision` succeeds and `verify` answers.
function fakeDescriptor(instancesDir = "/fixture/instances"): ServerDescriptor {
  return {
    name: "cclsp",
    instancesDir,
    unit: "cclsp-mcp",
    instanceNameKey: "CCLSP_INSTANCE_NAME",
    projectKey: "CCLSP_PROJECT",
    proxyKey: "CCLSP_PROXY_PORT",
    backendKey: "CCLSP_BACKEND_PORT",
    hasPerProjectConfig: false,
    provision: async () => ({ ok: true, message: "provisioned" }),
    verify: async () => ({ ok: true, detail: "backend answered initialize: fake 1.0.0" }),
  };
}

function conf(): Conf {
  return {
    file: "8824.conf",
    instanceName: "surfaces-repo",
    project: ROOT,
    proxyPort: 8824,
    backendPort: 8924,
  };
}

// Everything `enableInstance` would otherwise get from the host. With a conf
// already present, `enable` stops at the already-enabled arm — the arm whose
// verify the audited session had to run by hand.
function effects(over: { confs?: Conf[]; verified?: boolean } = {}): EnableEffects {
  return {
    resolveTarget: () => ({ at: ROOT, root: ROOT, gitRoot: ROOT }),
    readConfs: async () => over.confs ?? [],
    verify: async () =>
      over.verified === false
        ? { ok: false, detail: "the backend did not answer initialize: ECONNREFUSED" }
        : { ok: true, detail: "backend answered initialize: fake 1.0.0" },
  };
}

function fakeToolCtx() {
  const specs: any[] = [];
  const ctx = {
    tool: { transform: (fn: (editor: any) => void) => fn({ add: (s: any) => specs.push(s) }) },
  };
  return { ctx, specs };
}

function expectEnvelope(result: any) {
  expect(result).toBeDefined();
  expect(typeof result.content).toBe("string");
  expect(result.content.length).toBeGreaterThan(1);
  expect(typeof result.isError).toBe("boolean");
}

describe("mcp-instance runs a real bound lifecycle", () => {
  test("enable reaches the lifecycle, verifies, and returns an envelope", async () => {
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(ctx, bind(fakeDescriptor(), { effects: effects({ confs: [conf()] }) }));
    expect(specs.map((s) => s.name)).toEqual(["mcp-instance"]);

    const result = await specs[0].execute({ action: "enable", directory: ROOT });
    expectEnvelope(result);
    expect(result.content).toContain("already exists and is enabled");
    expect(result.content).toContain("backend answered initialize: fake 1.0.0");
    expect(result.isError).toBe(false);
  });

  test("a failed verify is a tool error, not prose that reads as success", async () => {
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(
      ctx,
      bind(fakeDescriptor(), { effects: effects({ confs: [conf()], verified: false }) }),
    );
    const result = await specs[0].execute({ action: "enable", directory: ROOT });
    expectEnvelope(result);
    expect(result.content).toContain(
      "already exists and is enabled, and its backend did not answer",
    );
    expect(result.content).not.toContain("was provisioned but");
    expect(result.isError).toBe(true);
  });

  test("disable reaches the lifecycle and returns an envelope", async () => {
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(ctx, bind(fakeDescriptor(), { effects: effects({ confs: [] }) }));
    const result = await specs[0].execute({ action: "disable", directory: ROOT });
    expectEnvelope(result);
    expect(result.content).toContain("no cclsp instance");
    expect(result.isError).toBe(true);
  });

  test("a bare registration (the shipped default) yields a usable surface", async () => {
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(ctx);
    const status = await specs[0].execute({ action: "status", directory: "/nonexistent/surfaces" });
    expect(typeof status.content).toBe("string");
    expect(status.isError).toBeUndefined();
  });

  test("the shipped default's enable arm is a bound lifecycle, not a dead binding", async () => {
    // The defect was invisible on `status` — that arm reads confs directly and
    // never touches the binding. Only the enable/disable arms do, so a test that
    // stops at `status` cannot falsify it. Here the real `bind(CCLSP)` runs and
    // is driven to a resolution refusal, which is a well-formed result; the
    // audited binding instead threw before any result existed.
    const { ctx, specs } = fakeToolCtx();
    registerMcpInstance(ctx);
    const result = await specs[0].execute({ action: "enable", directory: "/nonexistent/surfaces" });
    expectEnvelope(result);
    expect(result.content).toContain("cclsp:");
    expect(result.content).not.toContain("undefined");
  });
});

describe("serena-instance's arms are enveloped", () => {
  test("enable, disable and status return without throwing", async () => {
    const { ctx, specs } = fakeToolCtx();
    serenaInstance.setup(ctx);
    expect(specs.map((s) => s.name)).toEqual(["serena-instance"]);
    // serena's lifecycle reads real confs; a fixture path is not a repository,
    // so the refusal itself is the assertion: it arrives as an envelope.
    expectEnvelope(
      await specs[0].execute({ action: "enable", directory: "/nonexistent/surfaces" }),
    );
    expectEnvelope(
      await specs[0].execute({ action: "disable", directory: "/nonexistent/surfaces" }),
    );
    const status = await specs[0].execute({ action: "status", directory: "/nonexistent/surfaces" });
    expect(typeof status.content).toBe("string");
  });
});

describe("serena's descriptor runs through a real lifecycle", () => {
  // Every other test substitutes a bound lifecycle or a fake descriptor, so the
  // REAL `SERENA.provision` had no covered caller at all: breaking its first
  // statement changed no test result. Here the shipped descriptor is driven
  // through the shipped driver, with only the host's side effects faked — the
  // resolver, the conf read, the port claim, the socket and the probe. A root
  // that cannot be censused is refused by `provision` itself, which is the one
  // arm reachable without writing to the host.
  test("a provision that cannot census reports serena's own reason", async () => {
    const result = await bind(SERENA).enable({
      directory: "/tmp/opencode/does-not-exist-serenaprovision",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("serena:");
    expect(result.message).not.toContain("undefined");
  });

  test("a successful provision hands its inspection to the enable's warnings", async () => {
    // A real repository root whose project.yml is written to a scratch home, so
    // `provision` census-walks and overwrites the file — its whole body runs
    // without spawning serena, because the create is skipped when the config
    // already exists. What is pinned is the hand-off: the enable decides drift
    // from the census `provision` already walked, which reaches it as an
    // inspection riding on the result.
    const home = await mkdtemp(join(tmpdir(), "serena-wiring-"));
    const { SERENA_HOME, serenaYml } = await import("../src/codeintel/serena-project");
    const root = join(home, "sample-repo");
    const wrote: string[] = [];
    const priorInspect = SERENA.inspect;
    const priorEnableExtra = SERENA.enableExtra;
    const priorHome = process.env.SERENA_HOME;
    try {
      process.env.SERENA_HOME = home;
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "app.py"), "x = 1\n");
      await writeFile(join(root, "index.ts"), "export const y = 2;\n");
      Bun.spawnSync(["git", "-C", root, "init", "-q"]);
      Bun.spawnSync(["git", "-C", root, "add", "app.py", "index.ts"]);
      await mkdir(join(SERENA_HOME, "projects", "sample-repo"), { recursive: true });
      // The census reports more servers than this file configures, so drift has
      // something to say — and only a census can know what is missing.
      await writeFile(serenaYml(root), "language_servers:\n  - python\n");
      await writeFile(join(SERENA_HOME, "serena_config.yml"), `projects:\n  - ${root}\n`);
      SERENA.inspect = async (target) => {
        wrote.push("inspect");
        return priorInspect!.call(SERENA, target);
      };
      SERENA.enableExtra = async (target, extras) => {
        wrote.push(`enableExtra:${extras.length}`);
        return priorEnableExtra!.call(SERENA, target, extras);
      };
      const result = await bind(SERENA, {
        effects: {
          readConfs: async () => [],
          claimPort: async () => 8824,
          unitState: () => ({ enabled: "enabled", active: "active" }),
          enableSocket: () => ({ ok: true, message: "enabled" }),
          writeConf: async () => ({ ok: true, message: "wrote conf" }),
          verify: async () => ({ ok: true, detail: "backend answered initialize: serena 2.0.0" }),
        },
      }).enable({ directory: root });
      expect(result.ok).toBe(true);
      // One inspection for the whole enable: `provision` makes it, and the
      // enable's warnings are rendered from it rather than from a second walk.
      expect(wrote.filter((w) => w === "inspect").length).toBe(1);
      expect(wrote.filter((w) => w.startsWith("enableExtra:")).length).toBe(1);
      const inspected = await priorInspect!.call(SERENA, root);
      // The provision overwrote project.yml with the census's own server list,
      // and set each server exactly once: no missing, no extra, no error.
      expect(inspected.drift.missing).toEqual([]);
      expect(inspected.drift.extra).toEqual([]);
      expect(inspected.drift.error).toBeUndefined();
      expect(inspected.drift.present.length).toBeGreaterThan(1);
      expect(inspected.drift.present).toEqual(inspected.drift.configured);
    } finally {
      SERENA.inspect = priorInspect;
      SERENA.enableExtra = priorEnableExtra;
      if (priorHome === undefined) delete process.env.SERENA_HOME;
      else process.env.SERENA_HOME = priorHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("/lsp emits without injection", () => {
  test("a bare /lsp produces a synthetic message", async () => {
    const emitted: string[] = [];
    const commands: any[] = [];
    const ctx = {
      location: { directory: "/nonexistent/surfaces" },
      command: {
        transform: (fn: (editor: any) => void) => fn({ add: (s: any) => commands.push(s) }),
      },
      session: {
        get: async () => ({ directory: "/nonexistent/surfaces" }),
        synthetic: async ({ text }: { text: string }) => emitted.push(text),
      },
    };
    await lspCommand.setup(ctx);
    await commands[0].execute({ sessionID: "ses_x", prompt: { text: "" } });
    expect(emitted.join("\n").length).toBeGreaterThan(1);
  });
});

// If a fourth module starts binding a descriptor, the scan finds it and this
// fails; the fix is to add it above, not to relax the expectation. The expected
// list is exact, so a surface that disappears also fails — a scan that returned
// nothing would otherwise read as "all clear". `codeintel/coverage.ts` binds both
// descriptors, which is the point of it: it is the module that decides per
// location which server applies, and it is covered by tests/coverage.test.ts
// rather than by a surface arm.
describe("surface registry", () => {
  test("every module that binds a descriptor is covered by this file", async () => {
    const glob = new Bun.Glob("**/*.ts");
    const srcDir = new URL("../src/", import.meta.url).pathname;
    const found: string[] = [];
    for await (const rel of glob.scan({ cwd: srcDir })) {
      if (rel.includes(".test.")) continue;
      const text = await Bun.file(`${srcDir}${rel}`).text();
      if (/bind\((SERENA|CCLSP)/.test(text)) found.push(`src/${rel}`);
    }
    expect(found.sort()).toEqual([
      "src/codeintel/coverage.ts",
      "src/mcp-instance.ts",
      "src/serena-instance.ts",
    ]);
  });
});

describe("surfaces do not import other surfaces", () => {
  const SURFACES = [
    "src/codeintel-tool.ts",
    "src/lsp-command.ts",
    "src/mcp-instance.ts",
    "src/serena-instance.ts",
  ];

  test("no surface names another surface in an import", async () => {
    const srcDir = new URL("../src/", import.meta.url).pathname;
    const offences: string[] = [];
    for (const file of SURFACES) {
      const text = await Bun.file(`${srcDir}${file.replace(/^src\//, "")}`).text();
      for (const other of SURFACES) {
        if (other === file) continue;
        const specifier = `./${other.replace(/^src\//, "").replace(/\.ts$/, "")}`;
        if (new RegExp(`from\\s+["']${specifier}["']`).test(text)) {
          offences.push(`${file} -> ${other}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("the bound object is opaque", () => {
  test("bind returns exactly a name and two callables", () => {
    const bound: Bound = bind(fakeDescriptor());
    expect(Object.keys(bound).sort()).toEqual(["disable", "enable", "name"]);
    expect(bound.name).toBe("cclsp");
  });

  test("an effect set on the bound object is the one the lifecycle runs", async () => {
    // The audited defect was a binding whose arguments were discarded. This
    // asserts the effects survive the same way: the resolver here answers for a
    // path no real resolver would accept, and the refusal it produces is the
    // proof it was consulted.
    const bound = bind(fakeDescriptor(), {
      effects: {
        resolveTarget: () => ({
          at: "/nowhere",
          root: "/nowhere",
          gitRoot: null,
          refusal: {
            ok: false as const,
            code: "unresolvable" as const,
            detail: "resolver was consulted",
            directory: "/nowhere",
          },
        }),
        readConfs: async () => [],
      },
    });
    const result = await bound.enable({ directory: "/nowhere" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("resolver was consulted");
  });
});
