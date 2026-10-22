// codeintel/core — shared machinery for provisioning socket-activated
// code-intelligence servers (serena, the mcpls-backed fallback) for a project
// root.
//
// The operation is singular: resolve the git root, allocate a port, write an
// instance conf, enable the socket. What differs per server (a per-project
// config, a registry entry) is a ServerDescriptor, not a separate pipeline.
//
// The allocator is the reason this lives in one place: serena and the fallback
// share the 88xx band, so a per-server allocator would be a latent collision. See
// claimPort.

import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";

export const HOME = process.env.HOME ?? "";

// The confs are hand-numbered in the 88xx range by convention (proxy = client
// port, backend = proxy + 100). Nothing enforces that, so allocation scans what
// is actually on disk rather than assuming a contiguous block.
export const PORT_MIN = 8801;
export const PORT_MAX = 8899;
export const BACKEND_OFFSET = 100;

export type Conf = {
  file: string;
  instanceName: string;
  project: string;
  proxyPort: number;
  backendPort: number;
};

// `inspect` is the one-walk answer a successful provision ALSO hands back, when
// it made one: the enable needs the warnings and the drift, and re-deriving them
// afterwards would walk the tree a second time for a census already in hand. It
// rides on the result rather than through a side channel because it is typed in
// this module, which both servers share.
export type ProvisionResult =
  | {
      ok: true;
      message: string;
      inspect?: Inspection;
    }
  | { ok: false; message: string };

// The post-enable proof that an instance ANSWERS, not merely that its socket
// exists. `detail` is prose the lifecycle appends verbatim, so the driver never
// formats a protocol result and each descriptor stays a one-liner. A descriptor
// that omits `verify` keeps the old "the socket is enabled" meaning; both
// descriptors here supply it.
export type VerifyResult = { ok: true; detail: string } | { ok: false; detail: string };

export type DriftReport = {
  present: string[];
  configured: string[];
  missing: string[];
  extra: string[];
  error?: string;
};

// One read of a root, answering both post-enable questions at once. `extras` are
// the warnings a caller renders verbatim; `drift` is project.yml against the
// census. They are bundled because they are two answers to one walk — a caller
// that asked them separately paid for the walk twice, which on a large repository
// is the difference between one `git ls-files` and three.
export type Inspection = {
  extras: string[];
  drift: DriftReport;
};

// serena's registry reconciliation, as prose. Here rather than in a surface
// because the drift TYPE is here and two renderers need it (the `serena-instance`
// status view and `/lsp status`); a surface that owned it would be imported by a
// sibling, which is the coupling the module seam exists to avoid.
//
// Pure: an error renders the unknown line, divergence renders the counts and
// each side of the difference, a healthy registry renders nothing.
export type RegistryDrift = {
  registered: string[];
  provisioned: string[];
  registered_no_instance: string[];
  instance_no_registration: string[];
  error?: string;
};

export function registryLines(reg: RegistryDrift, label = "registry"): string[] {
  if (reg.error) return ["", `${label} : unknown (${reg.error})`];
  if (!reg.registered_no_instance.length && !reg.instance_no_registration.length) return [];
  const lines = [
    "",
    `${label} : ${reg.registered.length} registered, ${reg.provisioned.length} provisioned`,
  ];
  for (const r of reg.registered_no_instance) {
    lines.push(`  registered, no instance : ${r}`);
  }
  for (const p of reg.instance_no_registration) {
    lines.push(`  instance, not registered : ${p}`);
  }
  return lines;
}

// The subset of a descriptor that reading instance confs actually needs. Kept
// separate from ServerDescriptor so a read-only consumer (the sidebar panel)
// can scan the conf directory without carrying the provisioning surface
// (provision/refresh/coverageDrift) it does not use.
export type ConfSource = {
  instancesDir: string;
  instanceNameKey: string;
  projectKey: string;
  proxyKey: string;
  backendKey: string;
};

export type ServerDescriptor = ConfSource & {
  name: "serena" | "cclsp";
  unit: string;
  // The fallback has no per-project state (global catalog); serena has
  // project.yml, which can go stale. This flag, not a branch in the driver,
  // decides whether refresh/drift apply.
  hasPerProjectConfig: boolean;
  provision(root: string, opts: { name?: string }): Promise<ProvisionResult>;
  // Post-enable proof through the instance's own proxy port. Optional so a
  // descriptor can opt out; the lifecycle treats a missing hook as "unverified"
  // and says so rather than silently claiming success.
  verify?(proxyPort: number): Promise<VerifyResult>;
  // What one read of `root` answers about this server: whether project.yml
  // matches the tree (drift) and the post-enable warnings. One call because they
  // are two answers to one census — walking the tree per question made a status
  // poll two `git ls-files` walks and a refresh three. Optional only for
  // descriptors with no per-project state, which ask neither question.
  inspect?(root: string): Promise<Inspection>;
  refresh?(root: string): Promise<ProvisionResult>;
  // Post-enable warnings. One argument: the hook owns whether it needs a census
  // (serena's does, and reuses the one its own `provision` ran), so a call site
  // cannot be asked to decide the cost of a tree walk. Optional only for
  // descriptors that have no per-project state (the fallback declares none).
  enableExtra?(root: string, extras?: Inspection["extras"]): Promise<string[]>;
  // Permission for a server that cannot hard-require a git root. Only the
  // fallback has one today (the `cclsp` descriptor); a surface reads it instead
  // of hardcoding `nonGit: "directory"` into an operation's input object.
  nonGit?: "directory";
  // Post-disable notes (e.g. serena's registration is deliberately kept). The
  // shared lifecycle appends these so each server explains its own residue.
  onDisableExtra?(): Promise<string[]>;
};

export function systemctl(args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(["systemctl", "--user", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? 1, out: `${proc.stdout}${proc.stderr}`.trim() };
}

export function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

// The project key stored in an instance conf is a plain path prefix: mcp-route
// longest-prefix-matches the session location against it, and the backend unit
// `cd`s into it. It does NOT have to be a git root — the existing `opencode`
// conf is a non-git directory. So a git repo resolves to its toplevel, and a
// non-git directory resolves to itself, canonicalized with realpath so the key
// matches the `location.project.canonical` the router sees.
//
// Non-git fallback is opt-in (`nonGit: "directory"`): the fallback backend serves
// any directory, but serena's census is `git ls-files`-based and cannot, so
// serena-instance keeps the hard git requirement and reports it.
// A tagged union rather than `string | { error }`, so callers branch on `ok`
// instead of probing the value's type at each call site.
//
// A refusal is STRUCTURED, not a pre-rendered sentence: `code` says which kind of
// refusal it is, `detail` carries the mechanism (git's own stderr — evidence),
// and `directory` says what was asked for. Only the surface knows which
// alternatives exist for its descriptor, so composing the advice belongs there
// (`refusalLines` in this module); a `resolveRoot` that returned prose could only
// ever name the mechanism. See docs/projects/codeintel-provisioning-hardening.md
// P1-3.
export type RefusalCode = "not-a-repo" | "unresolvable";

// `gitRoot` is the repository top level git reported — present exactly when the
// location resolves through a repository. It is returned here rather than
// re-derived by a caller running `git rev-parse` a second time: one query, one
// answer, and no chance of two modules disagreeing about whether a directory is
// a repository.
export type RootResult =
  | { ok: true; root: string; gitRoot?: string }
  | { ok: false; code: RefusalCode; detail: string; directory: string };

export function resolveRoot(directory: string, opts: { nonGit?: "directory" } = {}): RootResult {
  const top = git(directory, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0) {
    const out = top.out.trim();
    // Canonicalized because every conf key and route key is a realpath, and a
    // plan that compared a symlinked spelling against them would enable under a
    // root the reports then show differently (macOS `/tmp`). git has already
    // resolved the symlinks it walked, so the realpath is normally a no-op; it
    // is here so the invariant is stated where the value is produced rather than
    // assumed from git's behaviour. When it fails the path git spelled is still
    // usable, which is better than calling a repository non-git.
    try {
      const real = realpathSync(out);
      return { ok: true, root: real, gitRoot: real };
    } catch {
      return { ok: true, root: out, gitRoot: out };
    }
  }
  if (opts.nonGit === "directory") {
    try {
      return { ok: true, root: realpathSync(directory) };
    } catch {
      return {
        ok: false,
        code: "unresolvable",
        detail: "not a directory, or unreadable",
        directory,
      };
    }
  }
  return {
    ok: false,
    code: "not-a-repo",
    detail: top.err.trim(),
    directory,
  };
}

// Which repositories sit directly under `parent`. Pure: the caller lists the
// directory and reports, per entry, whether it is a directory and whether it
// carries a `.git`; the decision ("that one is a repository") is the part worth
// testing, and it needs no filesystem to make.
//
// Depth 1 is the cap, and it is deliberate: a vendored tree is a wall of repos,
// and the caller the advice is written for is standing one level above a repo.
// Nested repositories are reached by descending, not by enumerating here.
export type DirEntry = { name: string; isDir: boolean; hasGit: boolean };

export function gitChildren(parent: string, entries: DirEntry[]): string[] {
  return entries
    .filter((e) => e.isDir && e.hasGit)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${parent.replace(/\/+$/, "")}/${e.name}`);
}

// The listing `gitChildren` needs, read from disk: one `readdir`, then two
// `stat`s per non-dot entry. Here rather than in each caller because the coverage
// runner and the serena surface both need it, and two copies of "which entries
// count" is how the two answers drift apart. Depth 1 is the cap; an unreadable
// parent is an empty list, since the caller's refusal is the message worth
// printing, not an ENOENT.
//
// `.git` is checked with `lstat`, not `stat`, because a git root's `.git` is a
// DIRECTORY only in a plain checkout: a linked worktree, a submodule, and a
// `--separate-git-dir` clone all carry a `.git` FILE pointing elsewhere. Asking
// whether the path exists — of any kind — is the question "is this a git root";
// asking whether it is a directory silently omitted every worktree and submodule
// from the child list, and then reported the parent as containing no repositories.
export async function listDirEntries(parent: string): Promise<DirEntry[]> {
  const { readdir, stat, lstat } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  const entries: DirEntry[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const full = `${parent.replace(/\/+$/, "")}/${name}`;
    try {
      if (!(await stat(full)).isDirectory()) continue;
    } catch {
      continue;
    }
    const hasGit = await lstat(`${full}/.git`).then(
      () => true,
      () => false,
    );
    entries.push({ name, isDir: true, hasGit });
  }
  return entries;
}

// The refusal, as advice: what was asked for, which mechanism refused it, which
// repositories the directory contains (with the instance that already covers
// each), and the command that provisions this directory anyway. Pure — the child
// list and the conf set are supplied by the shell.
//
// `fallbackRoot` is the root the fallback would take for `directory`, and
// `fallbackConf` whether one already exists: the fallback is the answer for the
// non-git case, so the advice names it instead of stopping at serena's refusal.
export function refusalLines(input: {
  subject: string;
  refusal: { code: RefusalCode; detail: string; directory: string };
  children: string[];
  confs: Conf[];
  fallbackRoot: string;
  fallbackConf?: Conf;
}): string[] {
  const { subject, refusal, children, confs, fallbackRoot, fallbackConf } = input;
  const lines = [`${subject} cannot serve ${refusal.directory}.`, `  ${refusal.detail}`];

  if (children.length > 0) {
    lines.push(
      "",
      `  this directory contains ${children.length} repository(ies), each its own git`,
      `  root, so each can be provisioned for ${subject}:`,
    );
    for (const child of children) {
      const existing = confs.find((c) => c.project === child);
      lines.push(
        existing
          ? `    ${child}  — already provisioned (instance ${existing.proxyPort})`
          : `    ${child}  — not provisioned; the codeintel tool with all=true covers it`,
      );
    }
  }

  lines.push(
    "",
    "  the fallback backend serves any directory, so this location is covered by it:",
    fallbackConf
      ? `    ${fallbackRoot}  — already provisioned (instance ${fallbackConf.proxyPort})`
      : "    the codeintel tool with action=enable and this directory provisions it here",
  );
  return lines;
}

export function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export async function readConfs(descriptor: ConfSource): Promise<Conf[]> {
  let files: string[];
  try {
    files = await readdir(descriptor.instancesDir);
  } catch {
    return [];
  }
  const confs: Conf[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".conf")) continue;
    try {
      const conf = parseConf(await readFile(`${descriptor.instancesDir}/${file}`, "utf8"));
      const proxyPort = Number.parseInt(conf[descriptor.proxyKey] ?? "", 10);
      const backendPort = Number.parseInt(conf[descriptor.backendKey] ?? "", 10);
      const project = conf[descriptor.projectKey] ?? "";
      if (!project || !Number.isInteger(proxyPort) || !Number.isInteger(backendPort)) continue;
      confs.push({
        file,
        instanceName: conf[descriptor.instanceNameKey] ?? "",
        project,
        proxyPort,
        backendPort,
      });
    } catch {
      // unreadable or malformed — skip; a missing conf just means no route
    }
  }
  return confs;
}

// Belt-and-braces: the conf scan is the authoritative test, but a bind check
// catches a foreign listener squatting on the chosen port. A listener can hold
// the proxy port without any conf naming it (for example another project's
// server on the overlapping 88xx band), so a bind failure is a reason to skip
// the port, not to fail the call. TCP-connect probing is the wrong test: a
// socket-activated unit answers on its port while its backend is down.
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

// The port choice, pure: given the set of ports already claimed by any conf,
// return the first port in the band (and whose backend offset is also) unclaimed
// and for which `isFree` resolves true. `isFree` is the bind probe, injected so
// the scan — the collision logic — is testable without opening sockets; the
// probe itself stays in claimPort.
export async function pickFreePort(
  claimed: Set<number>,
  isFree: (port: number) => Promise<boolean>,
): Promise<number | null> {
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    if (claimed.has(port) || claimed.has(port + BACKEND_OFFSET)) continue;
    if (await isFree(port)) return port;
  }
  return null;
}

// A port is free when no conf in ANY instance directory claims it and nothing is
// bound to it. Scanning every descriptor is what makes serena and the fallback
// share one collision domain: a serena conf squatting a port is skipped by the
// fallback allocator for the same reason a fallback conf is.
export async function claimPort(descriptors: ServerDescriptor[]): Promise<number | null> {
  const claimed = new Set<number>();
  for (const descriptor of descriptors) {
    for (const c of await readConfs(descriptor)) {
      claimed.add(c.proxyPort);
      claimed.add(c.backendPort);
    }
  }
  return pickFreePort(claimed, canBind);
}

export function confBody(
  descriptor: ServerDescriptor,
  c: { instanceName: string; project: string; proxyPort: number; backendPort: number },
): string {
  return [
    `# ${descriptor.name} MCP instance: ${c.instanceName} (${c.project})`,
    `${descriptor.instanceNameKey}=${c.instanceName}`,
    `${descriptor.projectKey}=${c.project}`,
    `${descriptor.proxyKey}=${c.proxyPort}`,
    `${descriptor.backendKey}=${c.backendPort}`,
    "",
  ].join("\n");
}

export function unitState(
  descriptor: ServerDescriptor,
  proxyPort: number,
): { enabled: string; active: string } {
  const unit = `${descriptor.unit}@${proxyPort}.socket`;
  // `is-enabled` exits non-zero for both "disabled" and "not-found" but still
  // prints the distinguishing word, so trust stdout over the exit code.
  const enabled = systemctl(["is-enabled", unit]);
  const active = systemctl(["is-active", unit]);
  const state = enabled.out.trim();
  return {
    enabled: state || "not-found",
    active: active.code === 0 ? active.out : "inactive",
  };
}

// The one predicate every caller asks: is this instance's socket enabled? It
// lived as `state.enabled === "enabled"` in five places (the plan's socket read,
// the lifecycle's two conf-present arms, the instance table), each comparing a
// string that `systemctl` is free to spell differently. Two spellings of the
// predicate: `socketIsEnabled` reads the host, `socketEnabledFrom` applies it to
// a state a caller already had to read for its own message. `unitState`
// additionally runs `is-active` and is for the readers that render both to a
// human.
export function socketIsEnabled(descriptor: ServerDescriptor, proxyPort: number): boolean {
  const unit = `${descriptor.unit}@${proxyPort}.socket`;
  return systemctl(["is-enabled", unit]).out.trim() === "enabled";
}

export function socketEnabledFrom(state: { enabled: string }): boolean {
  return state.enabled === "enabled";
}

// The instance block, from a socket read the caller already has. `state` is a
// parameter rather than a call because the arms that render this block have
// usually just read the socket to decide which arm to take — asking systemd the
// same question again per rendered block was two spawns per arm, and a fresh
// enable renders this block twice.
export function describe(
  descriptor: ServerDescriptor,
  c: Conf,
  state: { enabled: string; active: string } = unitState(descriptor, c.proxyPort),
): string {
  return [
    `  project : ${c.project}`,
    `  conf    : ${descriptor.instancesDir}/${c.file}`,
    `  ports   : proxy ${c.proxyPort} -> backend ${c.backendPort}`,
    `  socket  : ${descriptor.unit}@${c.proxyPort}.socket (${state.enabled}, ${state.active})`,
  ].join("\n");
}

export async function writeConf(
  descriptor: ServerDescriptor,
  c: {
    instanceName: string;
    project: string;
    proxyPort: number;
    backendPort: number;
    file: string;
  },
): Promise<ProvisionResult> {
  const target = `${descriptor.instancesDir}/${c.file}`;
  try {
    // fs.writeFile applies `mode` at open (atomic with creation), unlike
    // Bun.write whose `mode` option is ignored for string sources; chmod would
    // otherwise leave a brief non-0600 window between create and chmod.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, confBody(descriptor, c), { mode: 0o600 });
    return { ok: true, message: `wrote ${target}` };
  } catch (error) {
    return { ok: false, message: `failed to write ${target}: ${String(error)}` };
  }
}

export function enableSocket(descriptor: ServerDescriptor, proxyPort: number): ProvisionResult {
  const unit = `${descriptor.unit}@${proxyPort}.socket`;
  const result = systemctl(["enable", "--now", unit]);
  return result.code === 0
    ? { ok: true, message: `enabled ${unit}` }
    : { ok: false, message: `failed to enable ${unit}: ${result.out}` };
}

export function disableSocket(descriptor: ServerDescriptor, proxyPort: number): ProvisionResult {
  const unit = `${descriptor.unit}@${proxyPort}.socket`;
  const result = systemctl(["disable", "--now", unit]);
  return result.code === 0
    ? { ok: true, message: `disabled and stopped ${unit}` }
    : { ok: false, message: `failed to disable ${unit}: ${result.out}` };
}

export function defaultInstanceName(root: string): string {
  return root.split("/").filter(Boolean).pop() || "project";
}

// The project key stored in a conf is a path PREFIX, and both the router and the
// sidebar have to answer "which project is this directory in". They answer with
// the same rule, stated once here: roots are compared SEGMENT-WISE, so `/x/y`
// does not claim `/x/yz`, and the most specific (longest) containing root wins.
//
// `atRoot` is the special case a plain `startsWith` gets wrong: the filesystem
// root contains everything, and the naive form would also let the empty string
// (what a trailing-slash strip leaves behind) claim every relative path.
//
// Returns the matched root with its trailing slashes removed, or null.
export function containingRoot(roots: Iterable<string>, directory: string): string | null {
  let best: string | null = null;
  for (const raw of roots) {
    const root = raw.replace(/\/+$/, "") || "/";
    const contains =
      root === "/"
        ? directory.startsWith("/")
        : directory === root || directory.startsWith(`${root}/`);
    if (contains && (!best || root.length > best.length)) best = root;
  }
  return best;
}

// The last segment of a project path. The sidebar shows one project at a time,
// so this is the only segment worth spending columns on.
export function leafOf(project: string): string {
  const parts = project.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : project;
}

// The project a directory sits under, with the home directory abbreviated, or
// null when the directory IS a top-level path (nothing to disambiguate with).
// Null rather than "" because a caller renders this as a row: an empty string is
// a row that says nothing.
export function projectParent(project: string, home = HOME): string | null {
  const shown = project.startsWith(`${home}/`) ? `~/${project.slice(home.length + 1)}` : project;
  const parts = shown.split("/").filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}
