// Regression net for the pure helpers in codeintel/core.ts. The process- and
// fs-touching functions (systemctl, git, readConfs, claimPort) are covered by
// integration checks elsewhere; what is tested here is the parsing and
// formatting that every provisioning path depends on.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKEND_OFFSET,
  confBody,
  defaultInstanceName,
  gitChildren,
  listDirEntries,
  parseConf,
  pickFreePort,
  PORT_MAX,
  PORT_MIN,
  registryLines,
  type RegistryDrift,
  type ServerDescriptor,
} from "./core";

const DESCRIPTOR = {
  instancesDir: "/tmp/instances",
  instanceNameKey: "CCLSP_INSTANCE_NAME",
  projectKey: "CCLSP_PROJECT",
  proxyKey: "CCLSP_PROXY_PORT",
  backendKey: "CCLSP_BACKEND_PORT",
  name: "cclsp",
  unit: "cclsp-mcp",
  hasPerProjectConfig: false,
} as unknown as ServerDescriptor;

describe("parseConf", () => {
  test("reads key=value pairs, trimming key and value", () => {
    const text = "CCLSP_PROJECT = /home/x\nCCLSP_PROXY_PORT=8811\n";
    expect(parseConf(text)).toEqual({ CCLSP_PROJECT: "/home/x", CCLSP_PROXY_PORT: "8811" });
  });

  test("skips blanks, comments, and lines without a key", () => {
    const text = "# comment\n\n=nokey\nGOOD=1\n";
    expect(parseConf(text)).toEqual({ GOOD: "1" });
  });

  test("keeps the value verbatim past the first '=' (paths may contain '=')", () => {
    const text = "CCLSP_PROJECT=/a=b/c\n";
    expect(parseConf(text).CCLSP_PROJECT).toBe("/a=b/c");
  });
});

describe("confBody", () => {
  test("emits the comment line then the four keys in order, with a trailing newline", () => {
    const body = confBody(DESCRIPTOR, {
      instanceName: "opencode",
      project: "/home/user/.config/opencode",
      proxyPort: 8811,
      backendPort: 8911,
    });
    expect(body).toBe(
      [
        "# cclsp MCP instance: opencode (/home/user/.config/opencode)",
        "CCLSP_INSTANCE_NAME=opencode",
        "CCLSP_PROJECT=/home/user/.config/opencode",
        "CCLSP_PROXY_PORT=8811",
        "CCLSP_BACKEND_PORT=8911",
        "",
      ].join("\n"),
    );
  });

  test("round-trips through parseConf back to the input values", () => {
    const input = {
      instanceName: "proj",
      project: "/p",
      proxyPort: 8801,
      backendPort: 8901,
    };
    const parsed = parseConf(confBody(DESCRIPTOR, input));
    expect(parsed.CCLSP_INSTANCE_NAME).toBe("proj");
    expect(parsed.CCLSP_PROJECT).toBe("/p");
    expect(Number.parseInt(parsed.CCLSP_PROXY_PORT, 10)).toBe(8801);
    expect(Number.parseInt(parsed.CCLSP_BACKEND_PORT, 10)).toBe(8901);
  });
});

describe("defaultInstanceName", () => {
  test("is the last path component", () => {
    expect(defaultInstanceName("/home/user/.config/opencode")).toBe("opencode");
  });

  test("ignores a trailing slash", () => {
    expect(defaultInstanceName("/a/b/c/")).toBe("c");
  });

  test("root and empty collapse to 'project'", () => {
    expect(defaultInstanceName("/")).toBe("project");
    expect(defaultInstanceName("")).toBe("project");
  });
});

describe("port conventions", () => {
  test("backend offset is 100 so proxy and backend never collide", () => {
    expect(BACKEND_OFFSET).toBe(100);
  });
});

// pickFreePort: the allocator's collision logic, now reachable without opening
// a socket. `isFree` is injected, so every branch of the band scan is a unit
// test rather than an integration probe.
describe("pickFreePort", () => {
  const alwaysFree = async () => true;
  const neverFree = async () => false;

  test("an empty claim set picks the bottom of the band, if it binds", async () => {
    expect(await pickFreePort(new Set(), alwaysFree)).toBe(PORT_MIN);
  });

  test("a claimed proxy port is skipped", async () => {
    expect(await pickFreePort(new Set([PORT_MIN]), alwaysFree)).toBe(PORT_MIN + 1);
  });

  test("a claimed port's BACKEND offset also blocks the proxy port below it", async () => {
    // If 8901 (= 8801 + 100) is claimed, 8801 must be skipped: picking 8801
    // would put its backend on top of the claimed 8901.
    const claimed = new Set([PORT_MIN + BACKEND_OFFSET]);
    expect(await pickFreePort(claimed, alwaysFree)).toBe(PORT_MIN + 1);
  });

  test("a port that fails the bind probe is skipped", async () => {
    const bound = new Set([PORT_MIN]);
    const isFree = async (port: number) => !bound.has(port);
    expect(await pickFreePort(new Set(), isFree)).toBe(PORT_MIN + 1);
  });

  test("the band exhausting with everything bound returns null, not a throw", async () => {
    expect(await pickFreePort(new Set(), neverFree)).toBeNull();
  });

  test("an entirely claimed band returns null without probing", async () => {
    let probed = false;
    const claimed = new Set<number>();
    for (let p = PORT_MIN; p <= PORT_MAX; p += 1) claimed.add(p);
    const isFree = async () => {
      probed = true;
      return true;
    };
    expect(await pickFreePort(claimed, isFree)).toBeNull();
    expect(probed).toBe(false);
  });
});

describe("listDirEntries", () => {
  test("a linked worktree or submodule counts: `.git` is a file there, not a directory", async () => {
    // The defect this pins: the check was `stat(.git)` for a DIRECTORY, which a
    // plain checkout has and a worktree/submodule does not — its `.git` is a file
    // pointing at the real git dir. Those roots were invisible to `gitChildren`,
    // and the advice then said the parent contained no repositories.
    const scratch = mkdtempSync(`${tmpdir()}/codeintel-entries-`);
    try {
      mkdirSync(join(scratch, "plain", ".git"), { recursive: true });
      mkdirSync(join(scratch, "worktree"), { recursive: true });
      writeFileSync(join(scratch, "worktree", ".git"), "gitdir: /elsewhere\n");
      mkdirSync(join(scratch, "norepo"), { recursive: true });
      writeFileSync(join(scratch, "afile"), "not a directory\n");

      const entries = await listDirEntries(scratch);
      expect(entries.map((e) => [e.name, e.hasGit])).toEqual([
        ["norepo", false],
        ["plain", true],
        ["worktree", true],
      ]);
      expect(gitChildren(scratch, entries)).toEqual([
        join(scratch, "plain"),
        join(scratch, "worktree"),
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("registryLines", () => {
  function reg(over: Partial<RegistryDrift> = {}): RegistryDrift {
    return {
      registered: [],
      provisioned: [],
      registered_no_instance: [],
      instance_no_registration: [],
      ...over,
    };
  }

  test("a healthy registry renders nothing", () => {
    expect(registryLines(reg({ registered: ["a"], provisioned: ["a"] }))).toEqual([]);
  });

  test("a registry error renders the unknown line", () => {
    expect(registryLines(reg({ error: "nope" })).join("\n")).toContain("registry : unknown (nope)");
  });

  test("a registration with no instance is listed", () => {
    const lines = registryLines(
      reg({ registered: ["a", "b"], registered_no_instance: ["b"] }),
    ).join("\n");
    expect(lines).toContain("registry : 2 registered, 0 provisioned");
    expect(lines).toContain("registered, no instance : b");
  });

  test("an instance with no registration is listed", () => {
    const lines = registryLines(reg({ provisioned: ["a"], instance_no_registration: ["a"] })).join(
      "\n",
    );
    expect(lines).toContain("instance, not registered : a");
  });

  test("both directions of divergence are listed together", () => {
    const lines = registryLines(
      reg({
        registered: ["a"],
        provisioned: ["b"],
        registered_no_instance: ["a"],
        instance_no_registration: ["b"],
      }),
    ).join("\n");
    expect(lines).toContain("registered, no instance : a");
    expect(lines).toContain("instance, not registered : b");
  });

  test("the label is the caller's: the same block in two reports", () => {
    // `/lsp status` prints one report with two servers, so it names WHICH
    // registry it is reconciling; serena-instance's own status has only one.
    expect(registryLines(reg({ error: "nope" }), "serena registry").join("\n")).toContain(
      "serena registry : unknown (nope)",
    );
  });
});
