// Regression net for the pure scanners in codeintel/descriptors.ts. These are
// the load-bearing parses behind serena's idempotency guard and the read-only
// registry reconciliation: projectDirName decides where project.yml lives, and
// the two block scanners read Serena's own files without a YAML parse. Pure —
// fixtures are the exact text shapes Serena writes.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depositedCensus, diffRegistry, parseRegisteredProjects, SERENA } from "./descriptors";
import { parseLanguageServers, projectDirName } from "./serena-project";

describe("projectDirName", () => {
  test("keys the on-disk directory on the root basename, not --name", () => {
    expect(projectDirName("/home/user/repos/serena")).toBe("serena");
  });

  test("ignores a trailing slash", () => {
    expect(projectDirName("/a/b/c/")).toBe("c");
  });

  test("root and empty collapse to 'project'", () => {
    expect(projectDirName("/")).toBe("project");
    expect(projectDirName("")).toBe("project");
  });
});

describe("parseLanguageServers", () => {
  test("reads the list under language_servers", () => {
    const text = [
      "project_name: x",
      "language_servers:",
      "  - python",
      "  - typescript",
      "other: 1",
      "",
    ].join("\n");
    expect(parseLanguageServers(text)).toEqual(["python", "typescript"]);
  });

  test("stops at the first non-list line (one block only)", () => {
    const text = [
      "language_servers:",
      "  - go",
      "  - rust",
      "settings:",
      "  - not_a_server",
      "",
    ].join("\n");
    expect(parseLanguageServers(text)).toEqual(["go", "rust"]);
  });

  test("absent block is an empty list, not an error", () => {
    expect(parseLanguageServers("project_name: x\n")).toEqual([]);
  });
});

describe("parseRegisteredProjects", () => {
  test("reads the projects list, stripping quotes", () => {
    const text = [
      "projects:",
      '  - "/home/user/.config/opencode"',
      "  - /home/user/keeb",
      "other_key: 1",
      "",
    ].join("\n");
    expect(parseRegisteredProjects(text)).toEqual([
      "/home/user/.config/opencode",
      "/home/user/keeb",
    ]);
  });

  test("tolerates blank lines and comments inside the block", () => {
    const text = ["projects:", "", "  # a comment", "  - /a", "", "  - /b", "settings: x", ""].join(
      "\n",
    );
    expect(parseRegisteredProjects(text)).toEqual(["/a", "/b"]);
  });

  test("absent projects block is empty, not a failure", () => {
    expect(parseRegisteredProjects("other: 1\n")).toEqual([]);
  });
});

// diffRegistry: the read-only reconciliation, now reachable without reading
// serena_config.yml or the instance confs. The two divergence lists are the
// whole point — a filter direction flipped here would be silent otherwise.
describe("diffRegistry", () => {
  test("a registered root with no instance is registered_no_instance", () => {
    const d = diffRegistry(["/a", "/b"], ["/a"]);
    expect(d.registered_no_instance).toEqual(["/b"]);
    expect(d.instance_no_registration).toEqual([]);
  });

  test("an instance with no registration is instance_no_registration", () => {
    const d = diffRegistry(["/a"], ["/a", "/c"]);
    expect(d.instance_no_registration).toEqual(["/c"]);
    expect(d.registered_no_instance).toEqual([]);
  });

  test("in-sync lists produce no divergence, and both sides ride through", () => {
    const d = diffRegistry(["/a", "/b"], ["/a", "/b"]);
    expect(d.registered).toEqual(["/a", "/b"]);
    expect(d.provisioned).toEqual(["/a", "/b"]);
    expect(d.registered_no_instance).toEqual([]);
    expect(d.instance_no_registration).toEqual([]);
  });

  test("both directions can be non-empty at once (disjoint sets)", () => {
    const d = diffRegistry(["/a"], ["/b"]);
    expect(d.registered_no_instance).toEqual(["/a"]);
    expect(d.instance_no_registration).toEqual(["/b"]);
  });

  test("empty inputs are both-empty divergences, not a throw", () => {
    const d = diffRegistry([], []);
    expect(d.registered_no_instance).toEqual([]);
    expect(d.instance_no_registration).toEqual([]);
  });
});

describe("inspect", () => {
  test("reuses the census provision deposited, instead of walking the tree again", async () => {
    // The defect this pins: the inspection recomputed a census — a `git ls-files`
    // over the whole repository plus a `rg` per submodule — inside the enable that
    // had just computed the same thing. The root below does not exist, so a
    // recompute errors out and yields no submodule lines and no drift: any line
    // here can only come from the census `provision` deposited.
    const root = "/tmp/opencode/does-not-exist-enable-extra";
    const census = {
      root,
      name: "x",
      extCounts: new Map<string, number>(),
      servers: ["typescript"],
      unmapped: [],
      tracked: 1,
      submodules: [{ path: "sub", initialized: true }],
    };
    depositedCensus(root, census);
    const inspected = await SERENA.inspect!(root);
    expect(inspected.extras).toContain(
      `submodule sub is not its own serena project; provision it with serena-instance enable for ${root}/sub`,
    );
    // The drift comes from the SAME census: without the deposit the walk fails
    // and the report would carry an error instead of the deposited servers.
    expect(inspected.drift.error).toBeUndefined();
    expect(inspected.drift.present).toEqual(["typescript"]);
  });

  test("a deposit is consumed once, so a second call recomputes rather than re-serving it", async () => {
    // The map is a hand-off, not a cache: an entry that survived its read would
    // report a submodule list that may no longer be true, and would grow for the
    // life of the session.
    const root = "/tmp/opencode/does-not-exist-enable-extra-twice";
    const census = {
      root,
      name: "x",
      extCounts: new Map<string, number>(),
      servers: ["typescript"],
      unmapped: [],
      tracked: 1,
      submodules: [{ path: "sub", initialized: true }],
    };
    depositedCensus(root, census);
    expect((await SERENA.inspect!(root)).extras).not.toEqual([]);
    // Second call: nothing deposited, the root does not exist, so no submodules.
    expect((await SERENA.inspect!(root)).extras).toEqual([]);
  });

  test("enableExtra renders the warnings it is handed, and walks nothing", async () => {
    // The hook takes its lines from the caller: a second walk here is the cost
    // the signature exists to remove, so a `root` that cannot be read must still
    // return exactly what it was given.
    expect(
      await SERENA.enableExtra!("/tmp/opencode/does-not-exist-enable-extra", ["warning: x"]),
    ).toEqual(["warning: x"]);
    expect(await SERENA.enableExtra!("/tmp/opencode/does-not-exist-enable-extra", [])).toEqual([]);
  });
});

describe("the project.yml write", () => {
  // `refresh` and `provision` write the same file from the same census: a second
  // copy of the write was a second place for the mode and the failure text to
  // drift. Both now call one writer, and the failure arm is what a caller sees
  // when the census itself cannot be taken — here because the root is not a
  // repository, so the failure is reported before any file is touched.
  test("a root with no census reports the reason, not a silent success", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "serena-yml-"));
    try {
      const result = await SERENA.refresh!(scratch);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not inside a git repository");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
