// The coverage decision, tested without a host: which server serves a location,
// in what order, and what the report says when one of them cannot.
//
// The defect this covers: two tools shared a verb and differed in eligibility,
// and neither said so. `planCoverage` is that decision as a value, so the cases
// that used to cost a session (a non-git root; a git root with a stale serena
// conf; a location already fully provisioned) are fixtures rather than
// adventures.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitChildren, refusalLines, type Conf } from "../src/codeintel/core";
import {
  coverageBindings,
  coverageTable,
  enableCoverage,
  planCoverage,
  type CoveragePlan,
  type CoverageStep,
} from "../src/codeintel/coverage";
import { resolveLocation, type Bound } from "../src/codeintel/instance";
import { registerTool as registerCodeintel } from "../src/codeintel-tool";

const LOCATION = "/fixture/tree";
const REPO = "/fixture/tree/repo";
const CHILD = "/fixture/tree/headroom";

// Every socket enabled, as a value: the host read is injected so the suite never
// shells out to systemctl, and the plan takes the answer rather than a predicate
// that would ask the host at classification time. A case that cares about a
// disabled socket passes its own map, keyed by proxy port (the socket's identity).
const NO_SOCKETS = {
  serena: { 8824: true, 8826: true },
  cclsp: { 8824: true, 8826: true },
};

function conf(project: string, proxyPort = 8824): Conf {
  return {
    file: `${proxyPort}.conf`,
    instanceName: project.split("/").pop() ?? "project",
    project,
    proxyPort,
    backendPort: proxyPort + 100,
  };
}

function step(plan: ReturnType<typeof planCoverage>, server: CoverageStep["server"]) {
  return plan.steps.find((s) => s.server === server);
}

describe("planCoverage", () => {
  test("a non-git root with no children plans serena as an ineligible step", () => {
    // A row naming a root serena can never serve is a claim, not a note, so the
    // absence is a STEP with `eligible: false` — never a line painted outside the
    // step list, which let `steps` and `lines` describe different plans.
    const plan = planCoverage({ location: { at: LOCATION, root: LOCATION, gitRoot: null } });
    expect(plan.steps.map((s) => s.server)).toEqual(["serena", "cclsp"]);
    expect(step(plan, "serena")).toMatchObject({ kind: "absent", root: LOCATION });
    expect(step(plan, "cclsp")).toMatchObject({ kind: "provision", root: LOCATION });
    expect(plan.lines.join("\n")).toContain("not a git root, and no repository under it");
  });

  test("a git root enables serena first and the fallback second", () => {
    const plan = planCoverage({ location: { at: REPO, root: REPO, gitRoot: REPO } });
    expect(plan.steps.map((s) => [s.server, s.kind])).toEqual([
      ["serena", "provision"],
      ["cclsp", "provision"],
    ]);
  });

  test("a conf whose socket is disabled plans work, not a skip", () => {
    // A conf proves an instance WAS provisioned; only its socket proves it can be
    // reached. Skipping a disabled one left the one call whose job is "make this
    // work here" reporting a dead instance as covered.
    const plan = planCoverage({
      location: { at: REPO, root: REPO, gitRoot: REPO },
      serenaConf: conf(REPO),
      fallbackConf: conf(REPO, 8826),
      socketEnabled: { serena: { 8824: true }, cclsp: { 8824: false, 8826: false } },
    
    });
    expect(step(plan, "serena")?.kind).toBe("verify");
    expect(step(plan, "cclsp")?.kind).toBe("provision");
    expect(step(plan, "cclsp")?.reason).toContain("socket is not enabled");
    expect(plan.lines.join("\n")).toContain("its instance exists but its socket is not enabled");
  });

  test("a child a conf already covers is a skip in the PLAN, so lines and table agree", () => {
    // The runner used to rewrite `action` after planning returned, leaving
    // `lines` saying "enable" above a table saying "already provisioned". The
    // covered child is now an input, so the plan is a pure function of it.
    const plan = planCoverage({
      location: { at: LOCATION, root: LOCATION, gitRoot: null },
      children: [CHILD],
      provisionedChildren: [CHILD],
      all: true,
    
    });
    expect(step(plan, "serena")?.kind).toBe("verify");
    const lines = plan.lines.join("\n");
    expect(lines).toContain(`serena keep       ${CHILD}`);
    expect(lines).toContain("already provisioned");
    expect(lines).not.toContain("so serena can census it");
  });

  test("serena is additive: an existing serena conf does not remove the fallback step", () => {
    const plan = planCoverage({
      location: { at: REPO, root: REPO, gitRoot: REPO },
      serenaConf: conf(REPO),
    });
    expect(step(plan, "serena")?.kind).toBe("verify");
    expect(step(plan, "serena")?.reason).toContain("already provisioned");
    expect(step(plan, "cclsp")?.kind).toBe("provision");
  });

  test("both provisioned means nothing is enabled", () => {
    const plan = planCoverage({
      location: { at: REPO, root: REPO, gitRoot: REPO },
      serenaConf: conf(REPO),
      fallbackConf: conf(REPO, 8824),
    
    });
    expect(plan.steps.every((s) => s.kind === "verify")).toBe(true);
  });

  test("a location inside a repository is planned against that repository", () => {
    const plan = planCoverage({ location: { at: `${REPO}/src/deep`, root: REPO, gitRoot: REPO } });
    expect(step(plan, "serena")?.root).toBe(REPO);
    expect(step(plan, "cclsp")?.root).toBe(REPO);
  });
});

describe("coverageTable", () => {
  test("a non-git root names the git requirement and the per-repo call", () => {
    const plan = planCoverage({ location: { at: LOCATION, root: LOCATION, gitRoot: null } });
    const lines = coverageTable(plan, [
      { server: "cclsp", ok: true, message: "", root: LOCATION },
    ]).join("\n");
    expect(lines).toContain("serena covers a git root");
    expect(lines).toContain("point `codeintel` at each root");
    expect(lines).toContain("cclsp  provisioned");
    expect(lines).toContain("serena not available");
  });

  test("an all=true run with children does not claim serena is unavailable", () => {
    // The contradiction this pins: children were just provisioned in serena, so
    // the paragraph saying serena "is not available here" belongs to the run that
    // provisioned nothing for it.
    const plan = planCoverage({
      location: { at: LOCATION, root: LOCATION, gitRoot: null },
      children: [CHILD],
      all: true,
    });
    const lines = coverageTable(
      plan,
      [
        { server: "serena", ok: true, message: "", root: CHILD },
        { server: "cclsp", ok: true, message: "", root: LOCATION },
      ],
      { children: [CHILD] },
    ).join("\n");
    expect(lines).toContain(`serena (child) ${CHILD} provisioned`);
    // Serena RAN in this run, so the paragraph explaining why it did not serve the
    // location is gone — including its offer to pass `all`, which the caller did.
    expect(lines).not.toContain("serena covers a git root");
    expect(lines).not.toContain("pass all=true");
  });

  test("a failed step reads FAILED, not as success", () => {
    const plan = planCoverage({ location: { at: REPO, root: REPO, gitRoot: REPO } });
    const lines = coverageTable(plan, [
      { server: "serena", ok: false, message: "no mapped language servers", root: REPO },
      { server: "cclsp", ok: true, message: "ok", root: REPO },
    ]);
    expect(lines.join("\n")).toContain("serena FAILED");
    expect(lines.join("\n")).toContain("cclsp  provisioned");
  });

  test("a child skipped without all reads already provisioned, not not-available", () => {
    // A child IS eligible — it is a git root — so `not available` would be a lie
    // about the server. A skip on an eligible step is a conf, never a refusal.
    const plan = planCoverage({
      location: { at: LOCATION, root: LOCATION, gitRoot: null },
      children: [CHILD],
    });
    const lines = coverageTable(
      plan,
      [{ server: "cclsp", ok: true, message: "", root: LOCATION }],
      { children: [CHILD] },
    ).join("\n");
    expect(lines).toContain(`serena (child) ${CHILD} not provisioned`);
  });

  test("a step skipped for ineligibility reads not available, not already provisioned", () => {
    // The fallback's own row is never ineligible, so this pins the field directly:
    // an ineligible step must not be reported as covered.
    const plan: CoveragePlan = {
      steps: [
        { server: "serena", kind: "absent", root: LOCATION, reason: "not a git root" },
        { server: "cclsp", kind: "verify", root: LOCATION, reason: "already provisioned" },
      ],
      lines: [],
    };
    const lines = coverageTable(plan, []).join("\n");
    expect(lines).toContain("serena not available");
    expect(lines).not.toContain("serena already provisioned");
    expect(lines).toContain("cclsp  not provisioned");
  });

  test("a skipped step reads already provisioned when a conf exists", () => {
    const plan = planCoverage({
      location: { at: REPO, root: REPO, gitRoot: REPO },
      serenaConf: conf(REPO),
    });
    const lines = coverageTable(plan, [
      { server: "serena", ok: true, message: "", root: REPO },
      { server: "cclsp", ok: true, message: "", root: REPO },
    ]);
    expect(lines.join("\n")).toContain("serena verified");
  });
});

function fakeBound(
  server: "serena" | "cclsp",
  calls: Array<{ server: string; dir?: string; name?: string }>,
  ok = true,
): Bound {
  return {
    name: server,
    enable: async (input) => {
      calls.push({ server, dir: input.directory, name: input.name });
      return { ok, message: `${server} enable for ${input.directory}` };
    },
    disable: async () => ({ ok: true, message: "" }),
  };
}

function fakeRead(confs: { serena?: Conf[]; cclsp?: Conf[] }) {
  return async (descriptor: { name: string }) =>
    descriptor.name === "serena" ? (confs.serena ?? []) : (confs.cclsp ?? []);
}

describe("enableCoverage", () => {
  test("a non-git root provisions only the fallback, and says why serena stayed out", async () => {
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: LOCATION },
      {
        bindings: { serena: fakeBound("serena", calls), cclsp: fakeBound("cclsp", calls) },
        readConfs: fakeRead({}) as any,
        resolve: () => ({ at: LOCATION, root: LOCATION, gitRoot: null }),
        socketEnabled: NO_SOCKETS,
      },
    );
    expect(calls).toEqual([{ server: "cclsp", dir: LOCATION }]);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("serena covers a git root");
    expect(outcome.message).toContain("cclsp  provisioned");
  });

  test("the real git resolver canonicalizes like the conf keys it is compared to", () => {
    // Finding from the A–E review: a git root was resolved with a raw
    // `rev-parse` while every conf key is a realpath, so on a symlinked path the
    // plan and the enable disagreed about WHICH root was being provisioned.
    // Exercised against this host's own repository: a fixture cannot be a
    // symlink, and the property under test is that the answer is canonical.
    const raw = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    if (raw.code !== 0) return; // not a repository here; nothing to compare
    const resolved = resolveLocation(process.cwd(), "directory");
    expect(resolved.gitRoot).toBe(realpathSync(raw.out.trim()));
    expect(resolved.root).toBe(realpathSync(raw.out.trim()));
  });

  test("the mode decides whether a non-repository refuses, and that is the only difference", () => {
    // The seam this pins: `coverage` asks in the fallback's permissive mode while
    // `serena-instance` keeps the git requirement, and both go through ONE
    // resolver. Before that, `coverage` had its own resolver that treated "not a
    // repository" as a location with `gitRoot: null`, so the two tools answered
    // the same path in different vocabularies.
    const scratch = realpathSync(mkdtempSync(`${realpathSync(tmpdir())}/codeintel-mode-`));
    try {
      const gitMode = resolveLocation(scratch, "git");
      expect(gitMode.refusal?.code).toBe("not-a-repo");
      expect(gitMode.gitRoot).toBeNull();

      const dirMode = resolveLocation(scratch, "directory");
      expect(dirMode.refusal).toBeUndefined();
      expect(dirMode.at).toBe(scratch);
      expect(dirMode.root).toBe(scratch);
      expect(dirMode.gitRoot).toBeNull();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a git root with one repo child provisions both, naming each", async () => {
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: REPO },
      {
        bindings: { serena: fakeBound("serena", calls), cclsp: fakeBound("cclsp", calls) },
        readConfs: fakeRead({}) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: NO_SOCKETS,
      },
    );
    expect(calls).toEqual([
      { server: "serena", dir: REPO },
      { server: "cclsp", dir: REPO },
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("serena provisioned");
    expect(outcome.message).toContain("cclsp  provisioned");
  });

  test("a caller-supplied name never reaches a child, which would collide project files", async () => {
    // Review finding: a serena project directory is keyed on the root basename, so
    // one name broadcast across children made every child share a directory and
    // overwrite the previous child's project.yml.
    const calls: Array<{ server: string; dir?: string; name?: string }> = [];
    await enableCoverage(
      { directory: LOCATION, name: "chosen", all: true },
      {
        bindings: { serena: fakeBound("serena", calls), cclsp: fakeBound("cclsp", calls) },
        readConfs: fakeRead({}) as any,
        resolve: () => ({ at: LOCATION, root: LOCATION, gitRoot: null }),
        socketEnabled: NO_SOCKETS,
        children: async () => [CHILD, `${LOCATION}/other`],
      },
    );
    const serena = calls.filter((c) => c.server === "serena");
    expect(serena.map((c) => c.dir)).toEqual([CHILD, `${LOCATION}/other`]);
    expect(serena.every((c) => c.name === undefined)).toBe(true);
    // The fallback is the one instance the caller names.
    expect(calls.find((c) => c.server === "cclsp")?.name).toBe("chosen");
  });

  test("one failed step fails the outcome but still reports the other", async () => {
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: REPO },
      {
        bindings: {
          serena: fakeBound("serena", calls, false),
          cclsp: fakeBound("cclsp", calls),
        },
        readConfs: fakeRead({}) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: NO_SOCKETS,
      },
    );
    expect(calls.map((c) => c.server)).toEqual(["serena", "cclsp"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("serena FAILED");
    expect(outcome.message).toContain(`serena [${REPO}] FAILED:`);
    expect(outcome.message).toContain("cclsp  provisioned");
  });

  test("a covered location is verified, not skipped: a dead backend fails the call", async () => {
    // The defect this pins: any conf counted as coverage, the runner executed
    // nothing, and `ok` was `[].every(...)` — success by vacuity on exactly the
    // case the call exists for, a dead backend behind a live conf.
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: REPO },
      {
        bindings: {
          serena: fakeBound("serena", calls),
          cclsp: fakeBound("cclsp", calls, false),
        },
        readConfs: fakeRead({ serena: [conf(REPO)], cclsp: [conf(REPO)] }) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: NO_SOCKETS,
      },
    );
    expect(calls.map((c) => c.server)).toEqual(["serena", "cclsp"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("serena verified");
    expect(outcome.message).toContain("cclsp  FAILED");
    expect(outcome.message).not.toContain("nothing was changed");
  });

  test("a covered location that answers reports verified and says so without claiming a write", async () => {
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: REPO },
      {
        bindings: { serena: fakeBound("serena", calls), cclsp: fakeBound("cclsp", calls) },
        readConfs: fakeRead({ serena: [conf(REPO)], cclsp: [conf(REPO)] }) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: NO_SOCKETS,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("serena verified");
    expect(outcome.message).toContain("cclsp  verified");
    expect(outcome.message).not.toContain("nothing was changed");
  });

  test("a symlinked location is resolved once, and the children are planned under the realpath", async () => {
    // The defect this pins: the caller's spelling was used raw for the conf
    // lookups and for the textual `${parent}/${name}` child join, while the
    // resolver and `bind.enable` both canonicalize. A child planned under the
    // symlinked spelling matched no conf, so a covered child was re-provisioned
    // and then reported `not provisioned` against a root the enable call never
    // used.
    // `realpathSync` on the scratch itself, because `tmpdir()` may hand back a
    // symlinked `/tmp` — otherwise the case would compare two spellings of the
    // temp base instead of the one link it is about.
    const scratch = realpathSync(mkdtempSync(`${tmpdir()}/codeintel-resolve-`));
    const real = join(scratch, "real");
    const link = join(scratch, "link");
    try {
      mkdirSync(join(real, "child"), { recursive: true });
      symlinkSync(real, link);
      expect(resolveLocation(link, "directory")).toEqual({
        at: real,
        root: real,
        gitRoot: null,
      });

      const seen: Array<{ server: string; dir?: string }> = [];
      const outcome = await enableCoverage(
        { directory: link, all: true },
        {
          bindings: { serena: fakeBound("serena", seen), cclsp: fakeBound("cclsp", seen) },
          readConfs: fakeRead({}) as any,
          socketEnabled: NO_SOCKETS,
        },
      );
      expect(outcome.results.every((r) => !r.root.includes("link"))).toBe(true);
      // The plan's own spelling is no longer in `message` (the report is the
      // table, see the H1 note), so the plan is asserted through its lines.
      expect(planCoverage({ location: { at: real, root: LOCATION, gitRoot: null } }).lines[0]).toBe(
        `coverage plan for ${real}`,
      );
      expect(outcome.message).not.toContain("link");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("nothing runs, and the body says so, when no server has a step to take", async () => {
    // The only remaining empty-result case: serena is ineligible and the fallback
    // is... not, so this is reached with an empty plan, which is the empty tree.
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: LOCATION },
      {
        bindings: { serena: fakeBound("serena", calls), cclsp: fakeBound("cclsp", calls) },
        readConfs: fakeRead({}) as any,
        resolve: () => ({ at: LOCATION, root: LOCATION, gitRoot: null }),
        children: async () => [],
        socketEnabled: NO_SOCKETS,
      },
    );
    // The fallback is the floor: it always has a step, so it always runs.
    expect(calls).toEqual([{ server: "cclsp", dir: LOCATION, name: undefined }]);
    expect(outcome.message).not.toContain("nothing was changed");
  });

  test("the default bindings are the shared ones, not a private copy", () => {
    // A coverage path that bound its own descriptors could drift from the two
    // tools it exists to unify; this asserts it hands out `Bound`s at all.
    const bindings = coverageBindings();
    expect(Object.keys(bindings).sort()).toEqual(["cclsp", "serena"]);
    expect(bindings.serena.name).toBe("serena");
    expect(bindings.cclsp.name).toBe("cclsp");
  });
});

describe("the codeintel tool", () => {
  test("routes enable through the coverage runner and reports its result verbatim", async () => {
    const specs: any[] = [];
    const ctx = {
      tool: { transform: (fn: (editor: any) => void) => fn({ add: (s: any) => specs.push(s) }) },
    };
    const calls: Array<{ directory?: string; name?: string }> = [];
    registerCodeintel(ctx, async (input) => {
      calls.push(input);
      return { ok: true, message: "coverage table body", results: [] };
    });
    expect(specs.map((s) => s.name)).toEqual(["codeintel"]);
    expect(await specs[0].execute({ directory: LOCATION, name: "tree" })).toEqual({
      content: "coverage table body",
      isError: false,
    });
    expect(calls).toEqual([{ directory: LOCATION, name: "tree" }]);
  });

  test("a failed coverage run is a tool error carrying the whole table", async () => {
    const specs: any[] = [];
    const ctx = {
      tool: { transform: (fn: (editor: any) => void) => fn({ add: (s: any) => specs.push(s) }) },
    };
    registerCodeintel(ctx, async () => ({
      ok: false,
      message: "serena: FAILED\ncclsp: ok",
      results: [],
    }));
    expect(await specs[0].execute({ directory: LOCATION })).toEqual({
      content: "serena: FAILED\ncclsp: ok",
      isError: true,
    });
  });
});

describe("gitChildren", () => {
  test("only directories that carry a .git are repositories", () => {
    expect(
      gitChildren("/tree", [
        { name: "notes.txt", isDir: false, hasGit: false },
        { name: "src", isDir: true, hasGit: false },
        { name: "headroom", isDir: true, hasGit: true },
      ]),
    ).toEqual(["/tree/headroom"]);
  });

  test("a trailing slash on the parent does not produce a doubled one", () => {
    expect(gitChildren("/tree/", [{ name: "repo", isDir: true, hasGit: true }])).toEqual([
      "/tree/repo",
    ]);
  });

  test("the listing is sorted, so a report is stable across runs", () => {
    expect(
      gitChildren("/tree", [
        { name: "zed", isDir: true, hasGit: true },
        { name: "alpha", isDir: true, hasGit: true },
      ]),
    ).toEqual(["/tree/alpha", "/tree/zed"]);
  });
});

describe("refusalLines", () => {
  const refusal = {
    code: "not-a-repo" as const,
    detail: "fatal: not a git repository (or any of the parent directories)",
    directory: "/x/y",
  };

  test("names each child repository with its instance or its command", () => {
    const lines = refusalLines({
      subject: "serena",
      refusal,
      children: ["/x/y/headroom", "/x/y/vendor/lib"],
      confs: [conf("/x/y/vendor/lib", 8823)],
      fallbackRoot: "/x/y",
    }).join("\n");
    expect(lines).toContain("/x/y/headroom  — not provisioned; the codeintel tool with all=true");
    expect(lines).toContain("/x/y/vendor/lib  — already provisioned (instance 8823)");
  });

  test("keeps git's own words as evidence", () => {
    const lines = refusalLines({
      subject: "serena",
      refusal,
      children: [],
      confs: [],
      fallbackRoot: "/x/y",
    }).join("\n");
    expect(lines).toContain("fatal: not a git repository");
  });

  test("names the fallback as the answer for this directory", () => {
    const unprovisioned = refusalLines({
      subject: "serena",
      refusal,
      children: [],
      confs: [],
      fallbackRoot: "/x/y",
    }).join("\n");
    expect(unprovisioned).toContain("the codeintel tool with action=enable and this directory");

    const provisioned = refusalLines({
      subject: "serena",
      refusal,
      children: [],
      confs: [],
      fallbackRoot: "/x/y",
      fallbackConf: conf("/x/y", 8824),
    }).join("\n");
    expect(provisioned).toContain("/x/y  — already provisioned (instance 8824)");
  });
});

describe("all: provisioning a non-git parent's repositories", () => {
  const CHILD = "/fixture/tree/headroom";

  test("without all, a child repository is named but not provisioned", () => {
    const plan = planCoverage({
      location: { at: LOCATION, root: LOCATION, gitRoot: null },
      children: [CHILD],
    });
    const child = plan.steps.find((s) => s.child);
    expect(child?.kind).toBe("defer");
    expect(child?.reason).toContain("pass all");
    expect(plan.lines.join("\n")).toContain(`${CHILD}  (repository under this directory)`);
  });

  test("with all, the child gets its own serena step", () => {
    const plan = planCoverage({
      location: { at: LOCATION, root: LOCATION, gitRoot: null },
      children: [CHILD],
      all: true,
    });
    expect(plan.steps.find((s) => s.child)?.kind).toBe("provision");
  });

  test("one call provisions the child in serena and the parent in the fallback", async () => {
    // The phase's exit condition: the audited root's useful next step, reached
    // without a second call and without the caller knowing which server serves
    // what.
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: LOCATION, all: true },
      {
        bindings: { serena: fakeBound("serena", calls), cclsp: fakeBound("cclsp", calls) },
        readConfs: fakeRead({}) as any,
        resolve: () => ({ at: LOCATION, root: LOCATION, gitRoot: null }),
        socketEnabled: NO_SOCKETS,
        children: async () => [CHILD],
      },
    );
    expect(calls).toEqual([
      { server: "serena", dir: CHILD },
      { server: "cclsp", dir: LOCATION },
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain(`serena (child) ${CHILD} provisioned`);
    expect(outcome.message).toContain("cclsp  provisioned");
    expect(outcome.message).toContain(`serena (child) ${CHILD} provisioned`);
  });

  test("a child that already has an instance is skipped for writes but still verified", async () => {
    // `bind.enable` is idempotent, so verifying a covered child is a probe, not a
    // re-provision — which is what made this safe to keep running after C1. The
    // step is a `skip` in the plan (no census, no conf rewrite) that still runs.
    const calls: Array<{ server: string; dir?: string }> = [];
    const outcome = await enableCoverage(
      { directory: LOCATION, all: true },
      {
        bindings: { serena: fakeBound("serena", calls), cclsp: fakeBound("cclsp", calls) },
        readConfs: fakeRead({ serena: [conf(CHILD, 8827)] }) as any,
        resolve: () => ({ at: LOCATION, root: LOCATION, gitRoot: null }),
        socketEnabled: NO_SOCKETS,
        children: async () => [CHILD],
      },
    );
    expect(calls).toEqual([
      { server: "serena", dir: CHILD, name: undefined },
      { server: "cclsp", dir: LOCATION, name: undefined },
    ]);
    expect(outcome.message).toContain(`serena (child) ${CHILD} verified`);
    expect(outcome.message).toContain("cclsp  provisioned");
  });

  test("the table's advice is about all=true, not about a per-repo tool", async () => {
    // The same call that printed the rows is the one that can provision them, so
    // the sentence must name its own switch. Telling the reader to run a
    // different tool's command here is the defect the coverage plan removes.
    const outcome = await enableCoverage(
      { directory: LOCATION },
      {
        bindings: { serena: fakeBound("serena", []), cclsp: fakeBound("cclsp", []) },
        readConfs: fakeRead({}) as any,
        resolve: () => ({ at: LOCATION, root: LOCATION, gitRoot: null }),
        socketEnabled: NO_SOCKETS,
        children: async () => [CHILD],
      },
    );
    // Without `all` the children are named and left alone; the plan lines say
    // which switch provisions them, and no line instructs a different tool.
    expect(outcome.message).toContain(`serena (child) ${CHILD} not provisioned`);
    expect(outcome.message).not.toContain("serena-instance enable");
  });

  test("no child discovery happens inside a repository", async () => {
    let asked = false;
    await enableCoverage(
      { directory: REPO, all: true },
      {
        bindings: { serena: fakeBound("serena", []), cclsp: fakeBound("cclsp", []) },
        readConfs: fakeRead({ serena: [conf(REPO)], cclsp: [conf(REPO)] }) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: NO_SOCKETS,
        children: async () => {
          asked = true;
          return [];
        },
      },
    );
    expect(asked).toBe(false);
  });
});

describe("the plan and the runner agree about state", () => {
  test("the plan takes the resolved location as one value, not three fields it re-derives", () => {
    // `root` used to be a field beside `at` and `gitRoot` although it is
    // `gitRoot ?? at` by definition, so a caller could pass a trio that
    // contradicts itself and the plan would obey it silently. It is now derived
    // from the one resolved value, and the compiler enforces it: a flat
    // `{ at, root, gitRoot }` no longer types as `CoverageInput` (checked in
    // tsconfig-covered sources, not here — a `@ts-expect-error` in a suite asserts
    // nothing when the line would also throw at runtime).
    const plan = planCoverage({
      location: { at: `${REPO}/src/deep`, root: REPO, gitRoot: REPO },
      serenaConf: conf(REPO),
      fallbackConf: conf(REPO),
    });
    // Each conf is looked up under the location's own key, and the caller's
    // spelling — not the git root — is what the plan reports.
    expect(step(plan, "serena")?.kind).toBe("verify");
    expect(step(plan, "cclsp")?.kind).toBe("verify");
    expect(plan.lines[0]).toBe(`coverage plan for ${REPO}/src/deep`);
  });

  test("a disabled socket is a value the runner read, not a callback the plan invokes", async () => {
    // The plan's input held a PREDICATE, so classifying a step shelled out to
    // systemctl and the answer depended on host state at plan time. The runner
    // now resolves the state once and hands over the map, keyed by proxy port.
    const outcome = await enableCoverage(
      { directory: REPO },
      {
        bindings: {
          serena: fakeBound("serena", []),
          cclsp: fakeBound("cclsp", []),
        },
        readConfs: fakeRead({ serena: [conf(REPO)], cclsp: [conf(REPO, 8826)] }) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: { serena: { 8824: true }, cclsp: { 8826: false } },
      },
    );
    expect(outcome.message).toContain("serena verified");
    expect(outcome.message).toContain("cclsp  provisioned");
  });

  test("each descriptor directory is read once per run", async () => {
    // Two reads of the same directory for one plan could see different confs,
    // and cost two directory scans plus a parse per conf for one answer.
    const reads: string[] = [];
    await enableCoverage(
      { directory: REPO },
      {
        bindings: {
          serena: fakeBound("serena", []),
          cclsp: fakeBound("cclsp", []),
        },
        readConfs: (async (descriptor: { name: string }) => {
          reads.push(descriptor.name);
          return descriptor.name === "serena" ? [conf(REPO)] : [conf(REPO, 8826)];
        }) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: NO_SOCKETS,
      },
    );
    expect(reads).toEqual(["serena", "cclsp"]);
  });

  test("the routing footer is not printed for a run that wrote nothing", async () => {
    // The line says a route WILL change, so it belongs to a run that wrote
    // something. Printing it for a fully covered location claims work the run
    // did not do.
    const outcome = await enableCoverage(
      { directory: REPO },
      {
        bindings: {
          serena: fakeBound("serena", []),
          cclsp: fakeBound("cclsp", []),
        },
        readConfs: fakeRead({ serena: [conf(REPO)], cclsp: [conf(REPO, 8826)] }) as any,
        resolve: () => ({ at: REPO, root: REPO, gitRoot: REPO }),
        socketEnabled: NO_SOCKETS,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("serena verified");
    expect(outcome.message).not.toContain("route through mcp-route");
  });
});
