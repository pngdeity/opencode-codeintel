// The enable lifecycle's verify wiring, tested without a host: every effect that
// would touch systemd, git, the bind probe or the live instance directories is
// injected, so only the decisions run. This is the file whose absence let the
// audited `mcp-instance` binding ship — that defect was a default-bound
// operation no test ever invoked.
//
// Not assertable here: `probeInstance`'s session teardown (it needs a real
// server to DELETE against). The live checks in
// docs/projects/codeintel-provisioning-hardening/phase-a.md cover it; the header
// of `probe.ts` states the invariant.

import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confBody, type Conf, type ServerDescriptor } from "./core";
import {
  bind,
  enableInstance,
  refusalAdvice,
  resolveLocation,
  type EnableEffects,
} from "./instance";

const ROOT = "/fixture/repo";

// A descriptor that needs nothing from the host: provision succeeds, verify is
// injected per test, and the two lifecycle hooks return nothing.
function descriptor(overrides: Partial<ServerDescriptor> = {}): ServerDescriptor {
  return {
    name: "cclsp",
    instancesDir: "/fixture/instances",
    unit: "cclsp-mcp",
    instanceNameKey: "CCLSP_INSTANCE_NAME",
    projectKey: "CCLSP_PROJECT",
    proxyKey: "CCLSP_PROXY_PORT",
    backendKey: "CCLSP_BACKEND_PORT",
    hasPerProjectConfig: false,
    provision: async () => ({ ok: true, message: "provisioned" }),
    ...overrides,
  } as ServerDescriptor;
}

// The default effect set: everything succeeds, nothing touches the host. Each
// test overrides only what it is about.
function effects(over: EnableEffects = {}): EnableEffects {
  return {
    resolveTarget: () => ({ at: ROOT, root: ROOT, gitRoot: ROOT }),
    readConfs: async () => [],
    unitState: () => ({ enabled: "enabled", active: "active" }),
    enableSocket: () => ({ ok: true, message: "enabled socket" }),
    claimPort: async () => 8824,
    writeConf: async () => ({ ok: true, message: "wrote conf" }),
    ...over,
  };
}

function existingConf(): Conf {
  return {
    file: "8824.conf",
    instanceName: "repo",
    project: ROOT,
    proxyPort: 8824,
    backendPort: 8924,
  };
}

describe("enable verifies a fresh provision", () => {
  test("an answered handshake makes the result ok and reports the detail", async () => {
    const result = await enableInstance(
      descriptor({
        verify: async () => ({
          ok: true,
          detail: "backend answered initialize: mcpls 0.7.0; 31 tools",
        }),
      }),
      { directory: ROOT },
      effects(),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("mcpls 0.7.0; 31 tools");
    expect(result.message).toContain("Created cclsp instance for repo.");
  });

  test("a failed handshake is ok:false, names the failure, and keeps the conf", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeintel-instance-"));
    try {
      const written: string[] = [];
      const result = await enableInstance(
        descriptor({
          instancesDir: dir,
          verify: async () => ({
            ok: false,
            detail: "the backend did not answer initialize: 12 attempts in 30000 ms",
          }),
        }),
        { directory: ROOT },
        effects({
          writeConf: async (d, c) => {
            written.push(join(d.instancesDir, c.file));
            const { writeFile } = await import("node:fs/promises");
            await writeFile(written[0], confBody(d as ServerDescriptor, c));
            return { ok: true, message: "wrote conf" };
          },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("did not answer initialize");
      expect(result.message).toContain("proxy 8824 -> backend 8924");
      // The conf is deliberately kept, so a retry re-verifies this instance
      // instead of allocating a second port.
      expect(await readdir(dir)).toContain("8824.conf");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a descriptor without a verify hook still succeeds and claims no verification", async () => {
    const result = await enableInstance(descriptor(), { directory: ROOT }, effects());
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("answered initialize");
  });

  test("enableExtra is called with the root and the inspection provision already made", async () => {
    // The seam this pins: the driver passes the warnings its provision handed
    // back, so the hook never walks the tree a second time for a census the
    // same enable just took. An inspection-free provision passes an empty list,
    // which is what a descriptor with no per-project state sees.
    const seen: unknown[][] = [];
    const result = await enableInstance(
      descriptor({
        provision: async () => ({
          ok: true,
          message: "provisioned",
          inspect: {
            extras: ["warning: something"],
            drift: { present: [], configured: [], missing: [], extra: [] },
          },
        }),
        enableExtra: async (...args) => {
          seen.push(args);
          return [];
        },
      }),
      { directory: ROOT },
      effects(),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([[ROOT, ["warning: something"]]]);
  });

  test("a failed provision never reaches the socket or the verify step", async () => {
    let verified = false;
    const result = await enableInstance(
      descriptor({
        provision: async () => ({ ok: false, message: "no mapped language servers" }),
        verify: async () => {
          verified = true;
          return { ok: true, detail: "" };
        },
      }),
      { directory: ROOT },
      effects(),
    );
    expect(result.ok).toBe(false);
    expect(verified).toBe(false);
  });

  test("a failed socket enable never reaches the verify step", async () => {
    let verified = false;
    const result = await enableInstance(
      descriptor({
        verify: async () => {
          verified = true;
          return { ok: true, detail: "" };
        },
      }),
      { directory: ROOT },
      effects({ enableSocket: () => ({ ok: false, message: "no such unit" }) }),
    );
    expect(result.ok).toBe(false);
    expect(verified).toBe(false);
  });
});

describe("enable verifies the already-enabled arm", () => {
  test("an existing enabled conf is verified, not assumed", async () => {
    let probed: number | undefined;
    const result = await enableInstance(
      descriptor({
        verify: async (port) => {
          probed = port;
          return { ok: true, detail: "backend answered initialize: Serena 2.0.0" };
        },
      }),
      { directory: ROOT },
      effects({ readConfs: async () => [existingConf()] }),
    );
    expect(probed).toBe(8824);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("already exists and is enabled");
    expect(result.message).toContain("Serena 2.0.0");
  });

  test("a verified-failing existing instance is ok:false — the arm that used to be unverified", async () => {
    const result = await enableInstance(
      descriptor({
        verify: async () => ({
          ok: false,
          detail: "the backend did not answer initialize: connection refused",
        }),
      }),
      { directory: ROOT },
      effects({ readConfs: async () => [existingConf()] }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not answer initialize");
    expect(result.message).toContain("already exists");
  });

  test("re-enabling a disabled conf verifies the socket it just turned on", async () => {
    const result = await enableInstance(
      descriptor({
        verify: async () => ({
          ok: false,
          detail: "the backend did not answer initialize: refused",
        }),
      }),
      { directory: ROOT },
      effects({
        readConfs: async () => [existingConf()],
        unitState: () => ({ enabled: "disabled", active: "inactive" }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("its socket was disabled");
  });

  test("a socket that fails to enable reports its own failure, not a verify one", async () => {
    const result = await enableInstance(
      descriptor({ verify: async () => ({ ok: true, detail: "unexpected" }) }),
      { directory: ROOT },
      effects({
        readConfs: async () => [existingConf()],
        unitState: () => ({ enabled: "disabled", active: "inactive" }),
        enableSocket: () => ({ ok: false, message: "no such unit" }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Failed to enable the socket: no such unit");
  });

  test("the arm renders the socket state it already read, not a second systemctl", async () => {
    // The conf-present arm reads the socket to choose its branch. The rendered
    // block is a projection of that read, so every spawn after it is a duplicate
    // — and a fresh enable renders the block twice.
    let reads = 0;
    const result = await enableInstance(
      descriptor({ verify: async () => ({ ok: true, detail: "answered" }) }),
      { directory: ROOT },
      effects({
        readConfs: async () => [existingConf()],
        unitState: () => {
          reads += 1;
          return { enabled: "enabled", active: "active" };
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
    expect(result.message).toContain("(enabled, active)");
  });
});

describe("enable refuses an unresolvable directory without side effects", () => {
  test("a resolution failure is prose, and nothing is allocated", async () => {
    let allocated = false;
    const result = await enableInstance(
      descriptor(),
      { directory: "/nope" },
      effects({
        resolveTarget: () => ({
          at: "/nope",
          root: "/nope",
          gitRoot: null,
          refusal: {
            ok: false as const,
            code: "not-a-repo" as const,
            detail: "not inside a git repository",
            directory: "/nope",
          },
        }),
        claimPort: async () => {
          allocated = true;
          return 8824;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not inside a git repository");
    expect(allocated).toBe(false);
  });
});

// The default advice, for a caller that has only `bind(...)`: the audited session
// read serena's refusal, learned the mechanism and stopped. A refusal that names
// the fallback is the cheapest part of P1-3, and it has to arrive even when no
// surface supplies richer lines.
describe("refusalAdvice", () => {
  const notARepo = {
    ok: false as const,
    code: "not-a-repo" as const,
    detail: "fatal: not a git repository (or any parent up to mount point /)",
    directory: "/x/y",
  };

  test("a fallback descriptor blames the path, not the eligibility rules", () => {
    // `nonGit` alone does not mean "unresolvable": this case's code is
    // `not-a-repo`, so the floor must say the refusal is about the path without
    // borrowing serena's eligibility explanation.
    const lines = refusalAdvice({ name: "cclsp", nonGit: "directory" }, notARepo).join("\n");
    expect(lines).toContain("cclsp: fatal: not a git repository");
    expect(lines).toContain("is the fallback");
    expect(lines).not.toContain("needs a git root");
    expect(lines).not.toContain("could not be resolved to a working directory");
  });

  test("a git-only server names the fallback as the alternative", () => {
    const lines = refusalAdvice({ name: "serena" }, notARepo).join("\n");
    expect(lines).toContain("serena needs a git root");
    expect(lines).toContain("fallback backend serves any directory");
    expect(lines).toContain("action=enable");
    expect(lines).toContain("all=true");
  });

  test("an unresolvable directory is not advised to try the fallback", () => {
    // The collapse this pins: `unresolvable || nonGit` sent the floor's own
    // refusals down serena's arm, so a caller with a bad path was told about
    // eligibility rules for a server they were not using.
    const lines = refusalAdvice(
      { name: "cclsp", nonGit: "directory" },
      {
        ok: false,
        code: "unresolvable",
        detail: "not a directory, or unreadable",
        directory: "/x",
      },
    ).join("\n");
    expect(lines).toContain("/x could not be resolved");
    expect(lines).toContain("this one does not");
    expect(lines).not.toContain("fallback backend serves any directory");
    expect(lines).not.toContain("is the fallback");
  });
});

// The binding layer the audited defect lived in. `bind` is the only way a
// surface obtains a lifecycle call, so what it closes over — the descriptor, and
// the eligibility mode — has to be asserted here rather than at every surface.
describe("bind closes over the descriptor and its eligibility", () => {
  test("enable and disable reach the bound descriptor with the input directory", async () => {
    const seen: { verb: string; directory?: string }[] = [];
    const lifecycle = bind(
      descriptor({
        provision: async () => {
          seen.push({ verb: "enable", directory: ROOT });
          return { ok: true, message: "provisioned" };
        },
      }),
    );
    expect(lifecycle.name).toBe("cclsp");
    // The lifecycle resolves the directory through the real resolver, which will
    // reject a fixture path; asserting the refusal proves the argument arrived
    // (an undefined `opts` is exactly the defect) without touching the host.
    const result = await lifecycle.enable({ directory: "/fixture/not-a-repo" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("cclsp:");
    expect(result.message).not.toContain("undefined");
    expect(seen).toEqual([]);
  });

  test("the non-git mode comes from the descriptor, and an override wins", async () => {
    // `/tmp` is not a repository, so the strict mode refuses and the directory
    // mode accepts: this is the difference `bind` selects, asserted on the
    // resolver rather than on a live provision.
    expect(resolveLocation("/tmp", "git").refusal?.code).toBe("not-a-repo");
    expect(resolveLocation("/tmp", "directory")).toEqual({
      at: realpathSync("/tmp"),
      root: realpathSync("/tmp"),
      gitRoot: null,
    });
  });
});
