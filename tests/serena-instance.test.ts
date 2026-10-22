// Regression net for serena-instance.ts's pure core: the submodule listing, the
// post-refresh verdict, the coverage block, and the registry block. Pure — the
// filesystem and systemctl reads happen in the shell, so every fixture here is a
// constructed value. The orientations that matter are the ones a shell author
// tends to have not pictured: an uninitialized submodule, a still-stale refresh,
// and a healthy registry that must render nothing.

import { describe, expect, test } from "bun:test";
import type { DriftReport } from "../src/codeintel/core";
import { coverageLines, refreshLines, submoduleLines } from "../src/serena-instance";

describe("submoduleLines", () => {
  test("an initialized, unprovisioned submodule gets the enable instruction", () => {
    const lines = submoduleLines({ path: "sub", initialized: true }, undefined, "/root");
    expect(lines[0]).toBe("  sub");
    expect(lines.join("\n")).toContain("serena-instance enable for /root/sub");
  });

  test("an uninitialized submodule is flagged and told to init first", () => {
    const lines = submoduleLines({ path: "sub", initialized: false }, undefined, "/root");
    expect(lines[0]).toBe("  sub [not initialized]");
    expect(lines.join("\n")).toContain("git submodule update --init sub");
    expect(lines.join("\n")).not.toContain("serena-instance enable");
  });

  test("an already-provisioned submodule reports its instance and no instruction", () => {
    const lines = submoduleLines({ path: "sub", initialized: true }, { proxyPort: 8801 }, "/root");
    expect(lines.join("\n")).toContain("already provisioned (instance 8801)");
    expect(lines.join("\n")).not.toContain("serena-instance enable");
  });

  test("an already-provisioned uninitialized submodule still flags the init need", () => {
    const lines = submoduleLines({ path: "sub", initialized: false }, { proxyPort: 8802 }, "/root");
    expect(lines.join("\n")).toContain("[not initialized]");
    expect(lines.join("\n")).toContain("already provisioned");
    expect(lines.join("\n")).not.toContain("serena-instance enable");
  });
});

describe("refreshLines", () => {
  function drift(over: Partial<DriftReport> = {}): DriftReport {
    return { present: [], configured: [], missing: [], extra: [], ...over };
  }

  test("a drift error produces the unverifiable line", () => {
    const lines = refreshLines(drift(), drift({ error: "boom" }));
    expect(lines.join("\n")).toContain("Could not verify coverage after refresh: boom");
  });

  test("no missing and no extra reports the census as complete", () => {
    const lines = refreshLines(drift({ configured: ["ts"] }), drift({ present: ["ts"] }));
    expect(lines).toEqual(["", "Coverage is complete; project.yml matches the census."]);
  });

  test("still-missing after a refresh reports the missing set", () => {
    const lines = refreshLines(drift(), drift({ missing: ["rust", "go"] }));
    expect(lines.join("\n")).toContain("Still stale after refresh — missing rust, go");
  });

  test("an extra with nothing missing is not 'complete'", () => {
    const lines = refreshLines(drift(), drift({ present: ["go"], extra: ["go"] }));
    expect(lines.join("\n")).toContain("Still stale after refresh");
  });

  test("missing with no before-report is not reported (nothing to compare)", () => {
    expect(refreshLines(undefined, drift({ missing: ["rust"] }))).toEqual([]);
  });
});

describe("coverageLines", () => {
  function drift(over: Partial<DriftReport> = {}): DriftReport {
    return { present: [], configured: [], missing: [], extra: [], ...over };
  }

  test("undefined drift renders nothing", () => {
    expect(coverageLines(undefined)).toEqual([]);
  });

  test("a drift error renders the unknown line", () => {
    expect(coverageLines(drift({ error: "no census" })).join("\n")).toContain(
      "coverage : unknown (no census)",
    );
  });

  test("a covered census reports the count and both lists", () => {
    const lines = coverageLines(
      drift({ configured: ["ts", "rust"], present: ["ts", "rust"] }),
    ).join("\n");
    expect(lines).toContain("coverage : 2/2 language servers present");
    expect(lines).toContain("configured : ts, rust");
  });

  test("a stale census adds the STALE line", () => {
    const lines = coverageLines(
      drift({ configured: ["ts", "rust"], present: ["ts"], missing: ["rust"] }),
    ).join("\n");
    expect(lines).toContain("STALE      : missing rust — run action=refresh");
  });

  test("extra servers add the extra line", () => {
    const lines = coverageLines(drift({ present: ["ts"], extra: ["go"] })).join("\n");
    expect(lines).toContain("extra      : go (no longer present in census)");
  });

  test("empty lists render the (none) sentinel", () => {
    const lines = coverageLines(drift()).join("\n");
    expect(lines).toContain("configured : (none)");
    expect(lines).toContain("present    : (none)");
  });
});

// The refusal the audited session received was one sentence naming git's
// mechanism and nothing else. These drive the real surface: a fixture tree with
// one repository child, no git anywhere, so the enable arm refuses — and the
// refusal must name the child and the fallback.
describe("serena-instance enable on a non-git parent", () => {
  test("the refusal names the repository child and the fallback", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "serena-refusal-"));
    try {
      await mkdir(join(dir, "headroom", ".git"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });

      const specs: any[] = [];
      const ctx = {
        tool: { transform: (fn: (editor: any) => void) => fn({ add: (s: any) => specs.push(s) }) },
      };
      (await import("../src/serena-instance")).default.setup(ctx);
      const result = await specs[0].execute({ action: "enable", directory: dir });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("serena cannot serve");
      expect(result.content).toContain(`${dir}/headroom`);
      expect(result.content).toContain("the codeintel tool with all=true");
      expect(result.content).toContain("the fallback backend serves any directory");
      // The non-repository sibling is not offered as a next step.
      expect(result.content).not.toContain(`${dir}/src  —`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the refusal and the coverage runner are one resolution, not two", async () => {
    // Both tools used to resolve the directory themselves and disagreed about
    // what "not a repository" meant. Same path, both surfaces, with the coverage
    // runner's enable call faked so the assertion costs no instance.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { enableCoverage } = await import("../src/codeintel/coverage");
    const dir = await mkdtemp(join(tmpdir(), "serena-same-refusal-"));
    try {
      const specs: any[] = [];
      const ctx = {
        tool: { transform: (fn: (editor: any) => void) => fn({ add: (s: any) => specs.push(s) }) },
      };
      (await import("../src/serena-instance")).default.setup(ctx);
      const surface = await specs[0].execute({ action: "enable", directory: dir });
      expect(surface.isError).toBe(true);

      const calls: string[] = [];
      const fake = (server: string) => ({
        name: server,
        enable: async (input: { directory?: string }) => {
          calls.push(`${server} ${input.directory}`);
          return { ok: true, message: "" };
        },
        disable: async () => ({ ok: true, message: "" }),
      });
      const coverage = await enableCoverage(
        { directory: dir },
        { bindings: { serena: fake("serena"), cclsp: fake("cclsp") } as any },
      );
      // The fallback serves any directory, so the coverage run succeeds — and it
      // resolved the same path to the same root the surface refused.
      expect(coverage.ok).toBe(true);
      expect(calls).toEqual([`cclsp ${dir}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
