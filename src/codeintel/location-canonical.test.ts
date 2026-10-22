import { describe, expect, test } from "bun:test";

// Question under test: `instanceDirectory` prefers `location.project.canonical`
// over `location.directory`, and a git session opened on a SUBDIRECTORY has the
// repository root as canonical while its directory is below it. Does preferring
// canonical cost a route the directory would have matched?
import { instanceDirectory } from "../codeintel/location";
import { lookup } from "../mcp-route";

const table = new Map<string, { serena?: number; cclsp?: number }>([
  ["/repo", { serena: 8801, cclsp: 8802 }],
]);

const ctx = (directory: string, canonical: string) => ({
  location: { directory, project: { canonical } },
  session: { get: async () => undefined },
});

describe("canonical vs directory disagreement", () => {
  test("canonical is the repository root, the session is a subdirectory", () => {
    const resolved = instanceDirectory(ctx("/repo/sub/dir", "/repo"));
    expect(resolved).toBe("/repo");
    expect(lookup(table, resolved)).toEqual({ serena: 8801, cclsp: 8802 });
  });

  test("canonical is the subdirectory, the conf holds the repository root", () => {
    const resolved = instanceDirectory(ctx("/repo/sub/dir", "/repo/sub/dir"));
    expect(resolved).toBe("/repo/sub/dir");
    expect(lookup(table, resolved)).toEqual({ serena: 8801, cclsp: 8802 });
  });

  test("canonical outside every conf while the directory is inside one", () => {
    // The divergence: preferring canonical misses, the directory matches.
    const crossMounted = ctx("/repo/sub/dir", "/mnt/other/repo");
    expect(lookup(table, instanceDirectory(crossMounted))).toBeUndefined();
    expect(lookup(table, crossMounted.location.directory)).toEqual({ serena: 8801, cclsp: 8802 });
  });
});

describe("lookup against both location forms", () => {
  test("consulting the second form recovers the route the first missed", () => {
    const crossMounted = ctx("/repo/sub/dir", "/mnt/other/repo");
    expect(lookup(table, instanceDirectory(crossMounted), crossMounted.location.directory)).toEqual(
      { serena: 8801, cclsp: 8802 },
    );
  });

  test("the alternate alone can supply the route", () => {
    const crossMounted = ctx("/repo/sub/dir", "/mnt/other/repo");
    expect(lookup(table, instanceDirectory(crossMounted))).toBeUndefined();
    expect(lookup(table, instanceDirectory(crossMounted), crossMounted.location.directory)).toEqual(
      {
        serena: 8801,
        cclsp: 8802,
      },
    );
  });

  test("the more specific form wins when the two forms match different roots", () => {
    // "/repo" (canonical-side) and "/repo/sub/dir" (directory-side) both match,
    // and the directory's root is longer, so its route wins.
    const wider = new Map([...table, ["/repo/sub/dir", { serena: 8809 }]]);
    const crossMounted = ctx("/repo/sub/dir", "/repo");
    expect(lookup(wider, instanceDirectory(crossMounted))).toEqual({ serena: 8801, cclsp: 8802 });
    expect(lookup(wider, instanceDirectory(crossMounted), crossMounted.location.directory)).toEqual(
      {
        serena: 8809,
      },
    );
  });

  test("the preferred form still wins when it is the more specific one", () => {
    const wider = new Map([...table, ["/repo/sub/dir", { serena: 8809 }]]);
    const nested = ctx("/repo", "/repo/sub/dir");
    expect(lookup(wider, instanceDirectory(nested), nested.location.directory)).toEqual({
      serena: 8809,
    });
  });

  test("an empty alternate changes nothing", () => {
    expect(lookup(table, "/repo", "")).toEqual({ serena: 8801, cclsp: 8802 });
  });
});
