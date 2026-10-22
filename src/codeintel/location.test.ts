// Regression net for the one-resolver contract in location.ts. Pure — the
// session lookup is a fake, no runtime context. The cases mirror the two
// meanings the module exists to keep distinct: the plugin instance's location
// (routing) and the invoking session's location (provisioning), plus every
// fallback so a resolution failure can never yield an empty path.

import { describe, expect, test } from "bun:test";
import { instanceDirectory, sessionDirectory, type LocationContext } from "./location";

function ctx(over: Partial<LocationContext> = {}): LocationContext {
  return {
    location: { directory: "/inst/dir", project: { canonical: "/inst/canon" } },
    session: { get: async () => ({ location: { directory: "/sess/dir" } }) },
    ...over,
  };
}

describe("instanceDirectory", () => {
  test("project.canonical wins over the raw directory", () => {
    expect(instanceDirectory(ctx())).toBe("/inst/canon");
  });

  test("falls back to the raw directory when canonical is absent", () => {
    expect(instanceDirectory(ctx({ location: { directory: "/inst/dir" } }))).toBe("/inst/dir");
  });

  test("empty context yields empty string (caller decides the fallback)", () => {
    expect(instanceDirectory(ctx({ location: undefined }))).toBe("");
  });
});

describe("sessionDirectory", () => {
  test("the invoking session's location wins over the instance location", async () => {
    expect(await sessionDirectory(ctx(), "ses_1")).toBe("/sess/dir");
  });

  test("a session with no location falls back to the instance location", async () => {
    const c = ctx({ session: { get: async () => ({}) } });
    expect(await sessionDirectory(c, "ses_1")).toBe("/inst/canon");
  });

  test("an undefined session falls back to the instance location", async () => {
    const c = ctx({ session: { get: async () => undefined } });
    expect(await sessionDirectory(c, "ses_1")).toBe("/inst/canon");
  });

  test("a throwing lookup falls back to the instance location, never throws", async () => {
    const c = ctx({
      session: {
        get: async () => {
          throw new Error("session vanished");
        },
      },
    });
    expect(await sessionDirectory(c, "ses_1")).toBe("/inst/canon");
  });

  test("total failure (no session, no instance location) yields the cwd", async () => {
    const c = ctx({
      location: undefined,
      session: { get: async () => undefined },
    });
    expect(await sessionDirectory(c, "ses_1")).toBe(process.cwd());
  });
});
