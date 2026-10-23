// codeintel/descriptors — the per-server half of the provisioning pipeline.
//
// Two servers, one operation. The code-intelligence fallback (now mcpls, started
// under the `cclsp` instance name — see below) needs only a conf + socket;
// serena additionally needs project.yml (an extension census) and a registration
// in serena_config.yml. That difference is data here, so the driver in each tool
// stays server-agnostic.
//
// serena's provision() shells out to the `serena` CLI and depends on Serena's
// on-disk layout. The fallback's touches nothing but files and systemd. They are
// separate descriptors partly so that dependency never enters the fallback path.
//
// The fallback descriptor is still named `CCLSP` and still uses the
// `cclsp-*` unit names, the `~/.config/cclsp/instances` directory, and the
// `CCLSP_*` env keys. That is deliberate, not an oversight: the binary changed
// (cclsp → mcpls), the *provisioning plumbing* did not, and renaming it would
// touch every plugin, the systemd templates, every instance conf in
// `~/.config/cclsp/instances`, and the test fixtures for no functional gain. The
// name now denotes the
// fallback-instance slot, not the retired npm package.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  HOME,
  readConfs,
  type DriftReport,
  type Inspection,
  type ProvisionResult,
  type RegistryDrift as CoreRegistryDrift,
  type ServerDescriptor,
  type VerifyResult,
} from "./core";
import { probeInstance } from "./probe";
import {
  parseLanguageServers,
  renderProjectYml,
  serenaYml,
  SERENA_HOME,
  type Census,
} from "./serena-project";

// The census, which is a `serena-provision` result rather than something this
// module computes. Its shape lives in `serena-project` so both modules type it
// from one place; only the walk itself is the plugin's.
type ProvisionModule = { census(directory: string): Census | { error: string } };

async function loadProvision(): Promise<ProvisionModule> {
  return import("../serena-provision.ts") as unknown as ProvisionModule;
}

// Serena's project.yml for `root`, and the language_servers list out of an
// existing one. The path and the parse come from `serena-project` (shared with
// the writer); only the READ is here, because only this module treats a missing
// file as drift.
async function configuredServers(root: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(serenaYml(root), "utf8");
  } catch {
    return null;
  }
  return parseLanguageServers(text);
}

// Register the project through Serena's own writer. `serena project create`
// appends to serena_config.yml via add_registered_project -> _persist_projects,
// which reloads the persisted config and copies ONLY the projects list back
// through ruamel, preserving comments and runtime overrides. We never edit that
// file ourselves.
//
// Passing --ls for every census server means `languages is not None`, so
// autogenerate never infers (no interactive prompt, no single-language stub).
//
// Idempotency (serena 2.0.0, verified; 1.7.0 exited 0 here): `create` REFUSES
// to run when the project's project.yml already exists —
//   "Error: Project already exists: ... project.yml already exists."
// — printing it to stderr and exiting NON-ZERO (1) on 2.0.0, where 1.7.0 exited
// 0. It also registers the path in serena_config.yml. Since `serena-instance
// disable` deletes the conf but leaves project.yml, a re-enable lands exactly
// here; therefore create is skipped whenever the config already exists, and the
// skip is answered from the same `existsSync` the pre-check read rather than
// from a regex over the CLI's wording in a third, neither-success-nor-failure
// outcome. The CLI's own writer is authoritative for the file's CONTENT (see the
// caller: it is overwritten with the curated body afterwards); its
// "already exists" wording is not something this code should parse.
function serenaCreate(root: string, name: string, servers: string[]): ProvisionResult {
  const target = serenaYml(root);
  if (existsSync(target)) {
    return { ok: true, message: `project config already exists at ${target}; skipped create` };
  }
  const args = ["project", "create", root, "--name", name];
  for (const server of servers) args.push("--ls", server);
  const proc = Bun.spawnSync(["serena", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = `${proc.stdout}${proc.stderr}`.trim();
  const code = proc.exitCode ?? 1;
  if (code !== 0) {
    // A create that failed but left a config behind is the one case the pre-check
    // cannot cover (a concurrent run): the config exists, so the project is
    // usable and the failure is about the SECOND writer, not this one.
    return existsSync(target)
      ? { ok: true, message: `project config already exists at ${target}; create was a no-op` }
      : { ok: false, message: `serena project create failed: ${out}` };
  }
  return { ok: true, message: out };
}

// The post-enable proof, written once for both servers: the probe is
// protocol-level, and serena answers the same `initialize` handshake mcpls does
// (`serverInfo {name: Serena, version: 2.0.0}` measured 2026-10-20). Sharing it
// means the two descriptors cannot drift in what "answering" means.
export async function verifyInstance(proxyPort: number): Promise<VerifyResult> {
  const outcome = await probeInstance(proxyPort);
  if (!outcome.ok) {
    return { ok: false, detail: `the backend did not answer initialize: ${outcome.detail}` };
  }
  const tools = outcome.tools === undefined ? "" : `; ${outcome.tools} tools`;
  return {
    ok: true,
    detail: `backend answered initialize: ${outcome.server} ${outcome.version}${tools}`,
  };
}

function isRegistered(root: string): boolean {
  // Read rather than shell out: `rg` is not present on every host that runs
  // this (a CI runner has none), and a missing tool would read as "not
  // registered" and invent a divergence that does not exist.
  try {
    const text = readFileSync(`${SERENA_HOME}/serena_config.yml`, "utf8");
    return text.includes(root);
  } catch {
    return false;
  }
}

// The curated project.yml, written over whatever `serena project create` left.
// One body for both writers (`provision` and `refresh`): the file's content is a
// function of the census, so a second copy of the write was a second place for
// the mode and the failure text to drift.
async function writeProjectYml(
  root: string,
  name: string,
  servers: string[],
): Promise<ProvisionResult> {
  const target = serenaYml(root);
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, renderProjectYml(name, servers), { mode: 0o600 });
    await chmod(target, 0o600);
  } catch (error) {
    return { ok: false, message: `failed to write ${target}: ${String(error)}` };
  }
  return { ok: true, message: `wrote ${target}` };
}

// The census for `root`, walking the tree once per enable. `provision` deposits
// what it walked and `enableExtra` — which runs in the same enable — reads the
// deposit instead of walking again; a hook reached without a deposit (a refresh,
// a status poll) walks its own.
async function censusFor(root: string): Promise<Census | { error: string }> {
  return (await loadProvision()).census(root);
}

// The census `provision` ran, waiting for the `enableExtra` of the same enable.
// Keyed on the canonical root because the two hooks are reached with the paths
// their callers hold, and a symlinked spelling is the same repository.
//
// A map rather than a field on `ProvisionResult`: the result type is declared in
// `core`, which drives both servers and cannot name a serena value. Holding the
// hand-off here keeps it typed end to end, and the entry is deleted when read, so
// its size is bounded by the enables in flight rather than by the session.
const pendingCensus = new Map<string, Census | { error: string }>();

// The deposit, named rather than inlined so the suite can exercise the hand-off
// without shelling out to `serena project create`.
export function depositedCensus(root: string, census: Census | { error: string }): void {
  pendingCensus.set(realpathKey(root), census);
}

function realpathKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}
export const SERENA: ServerDescriptor = {
  name: "serena",
  instancesDir: `${SERENA_HOME}/instances`,
  unit: "serena-mcp",
  instanceNameKey: "SERENA_INSTANCE_NAME",
  projectKey: "SERENA_PROJECT",
  proxyKey: "SERENA_PROXY_PORT",
  backendKey: "SERENA_BACKEND_PORT",
  hasPerProjectConfig: true,

  verify(proxyPort) {
    return verifyInstance(proxyPort);
  },

  async provision(root, opts) {
    const mod = await loadProvision();
    const c = mod.census(root);
    if ("error" in c) return { ok: false, message: c.error };
    if (opts.name) c.name = opts.name;
    if (c.servers.length === 0) {
      return {
        ok: false,
        message:
          `no mapped language servers for ${c.root} (git ls-files found no recognizable extensions); ` +
          "serena cannot serve this repository",
      };
    }
    const create = serenaCreate(root, c.name, c.servers);
    if (!create.ok) return create;
    // Overwrite the template create() wrote with the fuller curated body, so
    // project.yml content has a single source of truth (the census renderer).
    const written = await writeProjectYml(root, c.name, c.servers);
    if (!written.ok) return written;
    // Deposit the census for `inspect`, which runs inside the same enable and
    // would otherwise walk the tree a second time. The census travels through
    // this module, so it stays typed: it never appears on `ProvisionResult`,
    // which core declares and both servers share.
    return {
      ok: true,
      message:
        `registered ${c.root} in serena_config.yml and wrote ${serenaYml(root)} ` +
        `(servers: ${c.servers.join(", ")})`,
      inspect: await SERENA.inspect!(root),
    };
  },

  async refresh(root) {
    const mod = await loadProvision();
    const c = mod.census(root);
    if ("error" in c) return { ok: false, message: c.error };
    if (c.servers.length === 0) {
      return { ok: false, message: `no mapped language servers for ${c.root}` };
    }
    if (!isRegistered(root)) {
      // Not registered yet: fall back to the full provision path.
      return SERENA.provision(root, {});
    }
    const written = await writeProjectYml(root, c.name, c.servers);
    if (!written.ok) return written;
    // The census this refresh just took, handed on so the caller does not walk
    // again for the state it is about to report.
    depositedCensus(root, c);
    return {
      ok: true,
      message: `refreshed ${serenaYml(root)} (servers: ${c.servers.join(", ")})`,
      inspect: await SERENA.inspect!(root),
    };
  },

  // One walk, both answers. The census is read once per call: `drift` compares
  // project.yml against it and `extras` reports what the census cannot see
  // (submodules), so asking the two questions separately walked the tree twice —
  // and a status poll asks both. The deposit `provision` left behind is consumed
  // here too, so an enable that just walked does not repeat it.
  async inspect(root): Promise<Inspection> {
    const { stat } = await import("node:fs/promises");
    // A stale in-repo .serena/ overrides the centralized project path.
    const isDir = await stat(`${root}/.serena`)
      .then((s: { isDirectory(): boolean }) => s.isDirectory())
      .catch(() => false);
    const extras = isDir
      ? [`warning: ${root}/.serena exists and takes precedence over ${SERENA_HOME}/projects`]
      : [];

    // The census `provision` just ran, when there is one, else a fresh walk. The
    // deposit is a hand-off inside one enable: it is read at most once per root
    // and deleted on read, so a long-lived session holds no stale trees and a
    // second call cannot be served a census that has since changed.
    const key = realpathKey(root);
    const deposited = pendingCensus.get(key);
    pendingCensus.delete(key);
    const c = deposited ?? (await censusFor(root));
    if ("error" in c) {
      return {
        extras,
        drift: { present: [], configured: [], missing: [], extra: [], error: c.error },
      };
    }

    // Submodule contents are invisible to the census (one project per git root).
    // Surface any that are not yet their own registered project, with the exact
    // next step, so the blind spot is actionable rather than silent.
    for (const sub of c.submodules) {
      const subRoot = `${root}/${sub.path}`;
      const registered = isRegistered(subRoot);
      const state = sub.initialized ? "" : " [not initialized]";
      if (!registered) {
        extras.push(
          `submodule ${sub.path}${state} is not its own serena project; ` +
            `provision it with serena-instance enable for ${subRoot}`,
        );
      } else {
        extras.push(`submodule ${sub.path}${state} is registered as its own project`);
      }
    }

    const configured = (await configuredServers(root)) ?? [];
    const present = new Set(c.servers);
    const have = new Set(configured);
    return {
      extras,
      drift: {
        present: c.servers,
        configured,
        missing: c.servers.filter((s) => !have.has(s)),
        extra: configured.filter((s) => !present.has(s)),
      },
    };
  },

  // The post-enable warnings, from an inspection the caller already made. The
  // argument is required, not defaulted: a default would be a second walk, which
  // is the cost this signature exists to remove.
  async enableExtra(root: string, extras: Inspection["extras"]): Promise<string[]> {
    return extras;
  },

  async onDisableExtra() {
    return [
      "The serena_config.yml registration was left in place deliberately; re-enable",
      "is then cheap. This is policy, not a limitation: serena 2.0.0 has",
      "`serena project remove` and would cleanly remove it (see docs/serena.md §5).",
      "The fallback backend remains enabled: serena and the fallback are additive,",
      "and the fallback is the coverage floor.",
    ];
  },
};

// Registry reconciliation (read-only). serena_config.yml's `projects:` list and
// the instance confs are two independent records of "which roots serena serves",
// and nothing keeps them in sync: `serena-instance disable` deletes the conf but
// LEAVES the registration (re-enable is then cheap by policy — serena 2.0.0 does
// have `serena project remove`, which we deliberately do not call; see
// docs/serena.md §5). The registry therefore only grows. This reports the
// divergence so it is visible; it never writes — serena_config.yml is Serena's
// file (ruamel-managed), and re-serializing it would destroy comments.
export type RegistryDrift = CoreRegistryDrift;

// The registry as text, read in process. `cat` was a spawn whose `try` could not
// catch a missing file: `spawnSync` does not throw for ENOENT, it exits non-zero,
// so the guard was decorative. `readFile` throws, which is what the guard was
// written for, and it is the same read `configuredServers` already does.
async function registeredProjects(): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(`${SERENA_HOME}/serena_config.yml`, "utf8");
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  return parseRegisteredProjects(text);
}

// The `projects:` list scan, factored out for hermetic testing. A non-list,
// non-blank, non-comment line at column 0 ends the block (a new top-level key).
export function parseRegisteredProjects(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^projects:\s*$/.test(l));
  if (start < 0) return [];
  const roots: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*-\s*(\S.*?)\s*$/);
    if (!match) {
      // A non-list line ends the block (a new top-level key), but blank lines and
      // comments inside the block are tolerated.
      if (/^\s*$/.test(lines[i]) || /^\s*#/.test(lines[i])) continue;
      if (/^\S/.test(lines[i])) break;
      continue;
    }
    roots.push(match[1].replace(/^["']|["']$/g, ""));
  }
  return roots;
}

// The registry reconciliation, pure: two independent records of "which roots
// serena serves" in, the divergence out. No fs, no spawn — serenaRegistryDrift
// owns reading both sides and passes them here.
export function diffRegistry(
  registered: string[],
  provisioned: string[],
): Omit<RegistryDrift, "error"> {
  const regSet = new Set(registered);
  const provSet = new Set(provisioned);
  return {
    registered,
    provisioned,
    registered_no_instance: registered.filter((r) => !provSet.has(r)),
    instance_no_registration: provisioned.filter((p) => !regSet.has(p)),
  };
}

export async function serenaRegistryDrift(): Promise<RegistryDrift> {
  const registered = await registeredProjects();
  if (registered === null) {
    return {
      registered: [],
      provisioned: [],
      registered_no_instance: [],
      instance_no_registration: [],
      error: `could not read ${SERENA_HOME}/serena_config.yml`,
    };
  }
  const provisioned = (await readConfs(SERENA)).map((c) => c.project);
  return diffRegistry(registered, provisioned);
}

// mcpls needs no per-project config: its catalog at
// ~/.config/opencode/mcpls.toml is global and project-independent. Each server's
// workspace root is the process working directory (the catalog sets
// `roots = []`, which means the launch directory), and the backend unit sets
// that with `cd $CCLSP_PROJECT`. A conf plus a socket is the whole job.
export const CCLSP: ServerDescriptor = {
  name: "cclsp",
  instancesDir: `${HOME}/.config/cclsp/instances`,
  unit: "cclsp-mcp",
  instanceNameKey: "CCLSP_INSTANCE_NAME",
  projectKey: "CCLSP_PROJECT",
  proxyKey: "CCLSP_PROXY_PORT",
  backendKey: "CCLSP_BACKEND_PORT",
  hasPerProjectConfig: false,
  // The fallback's catalog and workspace are project-independent, so it serves
  // any directory. Declared here, not at each call site, so `nonGit` has one
  // home and a surface cannot forget it.
  nonGit: "directory",
  async provision(_root) {
    return { ok: true, message: "the code-intelligence backend needs no per-project config" };
  },
  verify(proxyPort) {
    return verifyInstance(proxyPort);
  },
};

// The shared collision domain: both instance directories. The allocator must
// see all of them, since serena and cclsp share the 88xx band.
export const ALL_DESCRIPTORS = [SERENA, CCLSP];
