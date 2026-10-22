// codeintel/coverage — one decision, taken over both servers, for one location.
//
// Why this exists: serena and the fallback are two tools with the same verb and
// an eligibility difference that was documented nowhere the caller could see.
// The audited session (`ses_ea3f13d01ffeqeNXJ51e1Z5jJO`) ran `serena-instance
// enable` on a non-git root, was refused, and had no signal that a second tool
// existed, would accept the directory, and was the whole answer. Choosing the
// server is not the caller's job: it follows from the location, which is known
// here and was never the thing in doubt.
//
// The rules are the ones already documented, unchanged:
//   - serena is provisioned for the GIT ROOT only (its census is `git ls-files`),
//     and only when that root is a repository;
//   - the fallback is provisioned for whatever `resolveLocation` says the location
//     is, which for a non-git directory is the directory itself;
//   - the two are ADDITIVE. serena is never a replacement for the floor.
//
// What is new is the shape: the outcome is a coverage table, so a root served by
// one server says so and names the exact call that would change it, instead of
// reporting success because the half it ran succeeded.
//
// The plan is pure (`planCoverage`) and the runner (`enableCoverage`) only
// executes it, each step enveloped, so "serena first, fallback as floor" is a
// tested decision rather than an ordering that happens to be true in the shell.
//
// The plan is a pure function of the location and the confs: it holds the
// values, not a predicate that reads the host when a step is classified.
//
// A step's KIND is one discriminant, not a pair of booleans. "Skip" used to mean
// two different things — do nothing, or run the idempotent enable to verify what
// a conf claims — and every reader had to re-derive which by testing `skip` and
// `verify` together. The kind says it once: `provision` writes, `verify` checks
// an existing instance, `defer` leaves a coverable child alone, `absent` names a
// location no server can serve. Only the first two run.

import {
  readConfs as readInstanceConfs,
  gitChildren,
  listDirEntries,
  socketIsEnabled,
  type Conf,
  type ServerDescriptor,
} from "./core";
import { CCLSP, SERENA } from "./descriptors";
import {
  bind,
  refusalAdvice,
  resolveLocation,
  type Bound,
  type EnableEffects,
  type OperationResult,
  type ResolvedLocation,
} from "./instance";

export type CoverageInput = {
  // Where the caller is, exactly as the ONE resolver answered it, minus the
  // project key. `root` is deliberately NOT a field: it is `gitRoot ?? at` by
  // definition, so a caller that passed it could spell a location whose key is
  // not the key the conf stores and the plan would obey it silently. Derived
  // here, in one place, so the plan cannot be handed an inconsistent triple.
  // The refusal arm is not part of the plan: a location no server resolves is
  // answered before planning (see `enableCoverage`).
  location: Pick<ResolvedLocation, "at" | "gitRoot">;
  serenaConf?: Conf;
  fallbackConf?: Conf;
  // Repository children discovered under a non-git location, already filtered by
  // `gitChildren`. A child gets its own serena step: it is a git root, so serena
  // can census it, even though the parent cannot be served.
  children?: readonly string[];
  // Roots that already have a serena conf. Supplied rather than re-derived from
  // `children`, so the child a conf covers is decided inside the PLAN — the
  // plan's own lines and the table it feeds then agree without the runner
  // editing a step after the fact.
  provisionedChildren?: readonly string[];
  // `all` also plans a serena step for each child. Without it they are listed in
  // the report but not provisioned, so "provision every repo under this tree" is
  // an explicit request rather than a side effect of being near one.
  all?: boolean;
  // Whether an existing conf's socket is enabled, per server, as a VALUE read by
  // the runner. A conf proves an instance was provisioned; only the socket
  // proves it can still be reached, so a conf whose socket is disabled plans a
  // PROVISION rather than a verify. A value rather than a predicate because the
  // plan is pure: a callable here made `planCoverage` shell out to systemd per
  // conf and its answer depend on host state at call time. Absent means "assume
  // enabled", which is what the plan's own tests want.
  socketEnabled?: Partial<Record<ServerDescriptor["name"], Readonly<Record<number, boolean>>>>;
};

// What a step asks the runner to do. One field rather than a flag per
// behaviour: the previous `action` + `verify` + `eligible` triple could spell
// combinations that have no meaning ("skip" that runs, "verify" on a server that
// cannot serve the root), and every reader had to know which combinations the
// writer avoided.
export type StepKind =
  // Provision: there is no usable instance here, write one and verify it.
  | "provision"
  // An instance exists and answers to a conf, but not yet to this run: run the
  // idempotent enable, which probes (or re-enables the socket and probes).
  | "verify"
  // Coverable, but not requested: a child under a non-git parent without `all`.
  | "defer"
  // Not coverable at all: no server can serve this root.
  | "absent";

export type CoverageStep = {
  server: "serena" | "cclsp";
  kind: StepKind;
  root: string;
  // Prose explaining the kind in this step's own terms. Presentation only:
  // nothing branches on it, which is what lets the table and the plan agree
  // without either re-deriving state from the wording.
  reason: string;
  // A child step is reported under its parent, so the table can say "these are
  // the repositories under this directory" without re-deriving the hierarchy.
  child?: boolean;
};

export type CoveragePlan = {
  steps: CoverageStep[];
  // The same steps as the plan's own dry-run rendering. Derived from `steps`, so
  // the two cannot describe different plans.
  lines: string[];
};

// Which servers can serve this location, in the order they are applied. Serena
// goes first because it is the richer server and the one whose provisioning can
// FAIL for a reason the caller needs to read (an empty census); the fallback is
// the floor, so it runs afterwards and its outcome stands on its own.
//
// An absent conf means "not provisioned", not "not eligible". A server that is
// eligible but unprovisioned gets a `provision` step, and a step is what a
// caller's `enable` turns into a provisioning call.
//
// For a location that is not a git root there is NO serena step for the location
// itself: serena cannot serve it, so a row for it would name a root that can
// never be provisioned. Its children are the only serena rows, and when it has
// none the absence is an `absent` step — a step, not a line painted outside the
// list, so `steps` and `lines` describe the same plan.
export function planCoverage(input: CoverageInput): CoveragePlan {
  const { at, gitRoot } = input.location;
  // Derived, never taken: the conf key is the git root when there is one and the
  // directory otherwise, and a caller that could override it could spell a root
  // no conf would ever match.
  const root = gitRoot ?? at;
  const { serenaConf, fallbackConf, all } = input;
  const socketEnabled = input.socketEnabled;
  const children = input.children ?? [];
  const provisionedChildren = new Set(input.provisionedChildren ?? []);
  const steps: CoverageStep[] = [];

  // A conf is coverage only as far as it can be reached: a conf whose socket is
  // disabled plans work, because the caller asked for a working instance and
  // that is the state where nothing answers. The port is the socket's identity
  // (`<unit>@<port>.socket`), so it is the key the runner recorded.
  const covered = (server: "serena" | "cclsp", conf: Conf | undefined): boolean =>
    Boolean(conf) && (socketEnabled?.[server]?.[(conf as Conf).proxyPort] ?? true);

  // The one place a conf becomes a kind, shared by the git-root step and the
  // fallback. `verify` is the point: covered-but-unproven still runs, which is
  // what makes a dead backend behind a live conf visible.
  const fromConf = (
    server: "serena" | "cclsp",
    conf: Conf | undefined,
    fresh: string,
  ): { kind: StepKind; reason: string } => {
    if (!conf) return { kind: "provision", reason: fresh };
    return covered(server, conf)
      ? { kind: "verify", reason: "already provisioned" }
      : { kind: "provision", reason: "its instance exists but its socket is not enabled" };
  };

  if (gitRoot) {
    const state = fromConf("serena", serenaConf, "git root, so serena can census it");
    steps.push({ server: "serena", kind: state.kind, root, reason: state.reason });
  } else {
    // Each child IS a git root, so serena can serve it — under its own project,
    // never by descending from the parent. `all` turns that into work; without
    // it the child is named so the caller can decide. A child a conf already
    // covers is decided HERE, so `lines` and the table cannot disagree.
    for (const child of children) {
      const already = provisionedChildren.has(child);
      steps.push({
        server: "serena",
        kind: already ? "verify" : all ? "provision" : "defer",
        root: child,
        child: true,
        reason: already
          ? "already provisioned"
          : all
            ? "repository under this directory, so serena can census it"
            : "repository under this directory; pass all to provision it too",
      });
    }
    if (children.length === 0) {
      steps.push({
        server: "serena",
        kind: "absent",
        root: at,
        reason: "not a git root, and no repository under it to census",
      });
    }
  }

  // The fallback's root is the same `root` the serena step uses: resolveTarget
  // gives the fallback exactly that key, so the plan does not re-derive it. A
  // location inside a repository is served by that repository's instance.
  const fallbackState = fromConf(
    "cclsp",
    fallbackConf,
    "the coverage floor; it serves any directory",
  );
  steps.push({
    server: "cclsp",
    kind: fallbackState.kind,
    root,
    reason: fallbackState.reason,
  });

  return { steps, lines: planLines(at, steps) };
}

// The plan as a dry run: one block per step, in the order they run. `absent` is
// a note rather than a row — it names a location no server can serve, so it has
// no root to print — and that is a property of the KIND, not of the root
// happening to equal the location.
export function planLines(at: string, steps: CoverageStep[]): string[] {
  const lines = [`coverage plan for ${at}`];
  for (const step of steps) {
    if (step.kind === "absent") {
      lines.push(`  ${step.server.padEnd(6)} —       ${step.reason}`);
      continue;
    }
    const verdict = step.kind === "provision" ? "provision" : "keep     ";
    const root = step.child ? `${step.root}  (repository under this directory)` : step.root;
    lines.push(`  ${step.server.padEnd(6)} ${verdict}  ${root}`);
    lines.push(`         ${step.reason}`);
  }
  return lines;
}

// One step's failure must not hide the other step's success, so `ok` is the
// conjunction and each result is reported. Unlike `message` (the table, which is
// what a caller reads), a result carries the server's own report verbatim — that
// is the evidence, and the only place the backend's words survive.
export type CoverageResult = {
  server: CoverageStep["server"];
  root: string;
  ok: boolean;
  message: string;
};

export type CoverageOutcome = {
  ok: boolean;
  message: string;
  results: CoverageResult[];
};

// The table: what serves this location and in what state, then — when serena
// could not serve it at all — why and what would change that. This is the
// report; the per-server bodies are returned as `results` rather than pasted
// above it, because a caller that wants the backend's own words can read them
// and a caller that wants the answer gets one paragraph instead of three.
//
// The explanation is gated on an `absent` step in the PLAN, not on a
// caller-supplied restatement of the location's shape: a run that provisioned
// children in serena must not then be told serena is unavailable here.
export function coverageTable(
  plan: CoveragePlan,
  results: CoverageResult[],
  opts: { children?: readonly string[] } = {},
): string[] {
  const lines: string[] = ["", "coverage:"];
  const ranSerena = plan.steps.some((s) => s.server === "serena" && s.kind === "verify");
  // Matched on server AND root: the parent's serena step and a child's are the
  // same server, so matching on the server alone would report the parent's
  // outcome for every child.
  const stateOf = (step: CoverageStep): string => {
    if (step.kind === "absent") return "not available";
    if (step.kind === "defer") return "not provisioned";
    const result = results.find((r) => r.server === step.server && r.root === step.root);
    if (!result) return "not provisioned";
    if (!result.ok) return "FAILED";
    // A verified step was checked, not written: saying "provisioned" would claim
    // a write that did not happen.
    return step.kind === "verify" ? "verified" : "provisioned";
  };

  for (const step of plan.steps) {
    const label = step.child
      ? `  ${step.server} (child) ${step.root}`
      : `  ${step.server.padEnd(6)}`;
    lines.push(`${label} ${stateOf(step)}`);
  }

  const children = opts.children ?? [];
  const ineligible = plan.steps.some((s) => s.server === "serena" && s.kind === "absent");
  if (ineligible && !ranSerena) {
    lines.push(
      "",
      "  serena covers a git root, because its project identity is the root and",
      "  `git ls-files` is its census. This directory is not one, so it can only be",
      "  served here by the fallback.",
    );
    if (children.length > 0) {
      lines.push(
        `  Each of the ${children.length} ${
          children.length === 1 ? "repository" : "repositories"
        } under it is a git root and`,
        "  can be provisioned for serena as its own project (pass all=true to this",
        "  call, or point `codeintel` at that root).",
      );
    } else {
      lines.push(
        "  If this directory contains repositories, point `codeintel` at each root",
        "  to give serena a project of its own.",
      );
    }
  }
  // The routing footer is earned: it says a route WILL change, so it belongs to a
  // run that WROTE. A verified step was checked, not written, so a run of nothing
  // but verifies changes no route and must not say it does — the same class of
  // unearned claim as reporting a skip as "provisioned".
  if (plan.steps.some((s) => s.kind === "provision")) {
    lines.push(
      "",
      "  Both instances route through mcp-route on its next 5 s poll; no restart is needed.",
    );
  }
  return lines;
}

// The step list as bound lifecycles. Built per call, not at module load, so a
// test can hand in effects: the descriptor and the eligibility still come from
// the same two bindings the surfaces use, which is what keeps this path from
// drifting from `mcp-instance` and `serena-instance`.
export function coverageBindings(effects?: EnableEffects): Record<CoverageStep["server"], Bound> {
  return { serena: bind(SERENA, { effects }), cclsp: bind(CCLSP, { effects }) };
}

// Run the plan. Serena is attempted only for a git root, the fallback always,
// and a failure in either is reported rather than swallowed — the whole point is
// that the caller learns which server ended up serving the location.
//
// Only `provision` and `verify` steps run; `defer` and `absent` are things the
// plan decided NOT to do, and they are reported by the table alone.
//
// The REPORT is the table. The per-server bodies are returned as `results`, not
// pasted above it: the plan lines said the same thing in a third vocabulary, and
// `enableInstance`'s full report (conf, ports, socket state) repeated what the
// table's one word already answered. A caller that needs the backend's own words
// reads `results`; one that needs to know whether it works reads three lines.
//
// `all` also provisions serena for each repository under a non-git location, in
// one call: the audited root's useful next step was one of its children, and
// making the caller find out which one, then call again per repo, was the cost
// this removes. Children are discovered by the caller-supplied `children`
// function so the runner keeps no filesystem of its own.
//
// `name` is the FALLBACK's instance name only, and child steps never receive it.
// A serena project's directory is keyed on the root's basename (`serena-provision`
// `projectDir`), so one name broadcast across children would make every child
// share a project directory and overwrite the previous child's project.yml.
export type CoverageDeps = {
  bindings?: Record<CoverageStep["server"], Bound>;
  readConfs?: typeof readInstanceConfs;
  resolve?: (directory: string) => ResolvedLocation;
  children?: (directory: string) => Promise<string[]>;
  // The socket state per server conf port, read once by the runner. Injected as
  // a VALUE for the same reason the plan takes one: a predicate here would make
  // the plan shell out, and a test saying "this conf is socket-down" would imply
  // a spawn it did not make.
  socketEnabled?: Partial<Record<ServerDescriptor["name"], Readonly<Record<number, boolean>>>>;
};

export async function enableCoverage(
  input: { directory?: string; name?: string; all?: boolean },
  deps: CoverageDeps = {},
): Promise<CoverageOutcome> {
  const requested = input.directory ?? process.cwd();
  const bindings = deps.bindings ?? coverageBindings();
  const read = deps.readConfs ?? readInstanceConfs;
  // The one resolver in the plugin. Coverage asks it in the fallback's mode —
  // the permissive one — because a location only one of the two servers can
  // serve is still a location this call has an answer for; a location neither
  // can serve is a refusal, and it is the same refusal `serena-instance` gives.
  const resolveLoc =
    deps.resolve ?? ((directory: string) => resolveLocation(directory, "directory"));
  const childrenOf = deps.children ?? defaultChildren;

  // Resolved ONCE and used for every root this call plans, looks up and enables.
  // Two spellings of one directory (a symlinked checkout, a subdirectory of one)
  // is how a conf key, a plan row and an enable call came to disagree.
  const location = resolveLoc(requested);
  const { at, root, gitRoot } = location;
  // A location no server can resolve is reported as the resolution refusal, not
  // as two independent step failures: the path is the problem, once. The refusal
  // names the spelling the caller typed, which is what they asked about.
  if (location.refusal) {
    const advice = refusalAdvice(CCLSP, location.refusal);
    return { ok: false, message: advice.join("\n"), results: [] };
  }
  // Only a non-git location has child repositories worth naming: inside a
  // repository, git already answered with the root, and its own children are
  // directories in the project, not separate roots to provision.
  const children = gitRoot ? [] : await childrenOf(at);

  // One read per descriptor directory, shared by the plan and the socket map: a
  // second read of the same directory could see a conf the first did not, and
  // two reads per plan is two system calls per conf for one answer.
  const confs = { serena: await read(SERENA), cclsp: await read(CCLSP) };
  const socketEnabled = deps.socketEnabled ?? socketStatesOf(confs);

  const plan = planCoverage({
    location: { at, root, gitRoot },
    serenaConf: confs.serena.find((c) => c.project === root),
    fallbackConf: confs.cclsp.find((c) => c.project === root),
    children,
    provisionedChildren: confs.serena.map((c) => c.project),
    all: input.all,
    socketEnabled,
  });

  const results: CoverageResult[] = [];
  for (const step of plan.steps) {
    if (step.kind !== "provision" && step.kind !== "verify") continue;
    const result: OperationResult = await bindings[step.server].enable({
      directory: step.root,
      // A child keeps its own basename: sharing `input.name` would collide the
      // serena project directories of two children (see the header note).
      name: step.child ? undefined : input.name,
    });
    results.push({ server: step.server, root: step.root, ok: result.ok, message: result.message });
  }

  const failures = results.filter((r) => !r.ok);
  const message = [
    ...coverageTable(plan, results, { children }),
    // The detail is the EVIDENCE, and only a failure leaves a question to
    // answer, so only a failure prints it. A success's backend words add nothing
    // the table's state does not already say.
    ...(failures.length === 0
      ? []
      : [
          "",
          ...failures.flatMap((r) => [
            `${r.server} [${r.root}] FAILED:`,
            ...r.message.split("\n").map((line) => `  ${line}`),
            "",
          ]),
        ]),
  ].join("\n");

  return { ok: results.every((r) => r.ok), message, results };
}

// The default socket read, per server, resolved to values once. `socketIsEnabled`
// is the one place the `systemctl is-enabled` answer becomes a boolean, and it
// takes the descriptor whose unit template it expands — the two servers have
// different unit names. Read per CONF, including a conf the plan will not use:
// the plan may look up a child's conf from the same list.
function socketStatesOf(
  confs: Record<"serena" | "cclsp", Conf[]>,
): Record<"serena" | "cclsp", Record<number, boolean>> {
  const states = (descriptor: ServerDescriptor, list: Conf[]): Record<number, boolean> =>
    Object.fromEntries(list.map((c) => [c.proxyPort, socketIsEnabled(descriptor, c.proxyPort)]));
  return { serena: states(SERENA, confs.serena), cclsp: states(CCLSP, confs.cclsp) };
}

// The default child discovery: shared with the serena surface so the two render
// the same list from the same rules (see `core.listDirEntries`).
async function defaultChildren(directory: string): Promise<string[]> {
  return gitChildren(directory, await listDirEntries(directory));
}
