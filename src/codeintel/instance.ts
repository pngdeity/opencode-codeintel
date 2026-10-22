// codeintel/instance — the full socket-activated instance lifecycle, server
// agnostic. One operation set (`enable`, `disable`, `describe`, `report`) over a
// ServerDescriptor, so `mcp-instance` (the fallback) and `serena-instance`
// (serena) share a single code path for ALL THREE verbs, not just `enable`.
//
// The original split — the fallback's enable extracted, its disable/status left
// inline, serena's lifecycle duplicated — was the drift hazard this module
// removes: a `disable` that stopped tracking a `resolveRoot` fallback or a
// conf-write change would only be noticed in one of the two servers.
//
// What differs per server is the descriptor, not the pipeline:
//   - serena needs per-project state (project.yml, a serena_config.yml
//     registration) before a conf is meaningful; the fallback does not. That is
//     `provision()`, called here as a hook, not a branch.
//   - serena keeps its registration on disable and has extra post-provision
//     warnings; both are hooks (`onDisableExtra`, `enableExtra`).
//
// Results: `enable`/`disable` return an `OperationResult` — `message` is the
// report each surface prints verbatim, `ok` says whether the operation actually
// succeeded. They never throw; every failure is prose. A surface must carry BOTH
// fields into its own result, because the failure text is indistinguishable from
// success text: "the route is a dead conf" arrives as a sentence, and a caller
// that prints it as a success tells the user the opposite of what happened.
//
// `ok` from `enable` means the instance ANSWERS, not that a listener exists:
// every success path ends with the descriptor's `verify` step, one MCP
// `initialize` through the instance's own proxy port (codeintel/probe). A socket
// unit is enabled and listening whether or not anything can answer behind it, so
// "the socket is enabled" was never evidence of a working server.
//
// FOUR renderers emit prose about the same servers, and which one a caller sees
// depends only on the verb it used. The contract, so a change to one is made
// knowing what the others say:
//
//   renderer            lives in          answers                        audience
//   refusalAdvice       this module       "why was THIS server refused"  one server, any verb
//   refusalLines        core              "what else could serve this"   serena's surface
//   coverageTable       coverage          "what serves this LOCATION"    codeintel, /lsp
//   enableExtra         descriptors       "what did the enable miss"     after a serena enable
//
// The split is by QUESTION, not by caller: `refusalAdvice` names the mechanism
// and stops at what the descriptor knows; `refusalLines` adds the inventory
// (children, the fallback conf) because the serena surface has listed the
// directory; `coverageTable` speaks about a location rather than a server and
// never names a command it did not just run; `enableExtra` reports side effects
// of a write that already happened. A fact belongs in exactly one of them — when
// two said the same thing they drifted, which is how the tables and refusals came
// to disagree about whether an instance was covered.

import { rm } from "node:fs/promises";
import {
  claimPort,
  defaultInstanceName,
  describe,
  disableSocket,
  enableSocket,
  readConfs,
  resolveRoot,
  unitState,
  socketEnabledFrom,
  writeConf,
  type Conf,
  type ConfSource,
  type DriftReport,
  type ProvisionResult,
  type RootResult,
  type ServerDescriptor,
  type VerifyResult,
} from "./core";
import { ALL_DESCRIPTORS } from "./descriptors";

// A lifecycle result: `message` is the prose a surface prints, `ok` lets a
// caller branch (e.g. the tool envelope should not dress a failure as success).
export type OperationResult = { ok: boolean; message: string };

// A result as a tool result. Every tool surface returns this shape, and each one
// that rebuilt it inline was free to forget `ok` — which is the defect
// `ok-propagation.test.ts` exists to catch, one coincidence per surface. One
// function here makes the property structural: a surface cannot return a
// message without also deciding what its `ok` means.
//
// Takes any result-shaped value, not `OperationResult`, because the coverage
// runner's outcome is the same shape with more fields and is not a lifecycle
// result.
export function envelope(result: { ok: boolean; message: string }): {
  content: string;
  isError: boolean;
} {
  return { content: result.message, isError: !result.ok };
}

// The effects `enable` performs, injectable so the orchestration — which arm
// runs, and what the verify step does to the result — is testable without
// touching systemd, git or the live instance directories. The real functions
// are the defaults; a test supplies fakes. This is the same granularity as
// `pickFreePort(claimed, isFree)` and `registerTool(ctx, bound)`:
// injection at the orchestrator, not a general effect-runner port.
export type EnableEffects = {
  resolveTarget?: typeof resolveFor;
  readConfs?: (descriptor: ConfSource) => Promise<Conf[]>;
  unitState?: typeof unitState;
  enableSocket?: (descriptor: ServerDescriptor, proxyPort: number) => ProvisionResult;
  claimPort?: (descriptors: ServerDescriptor[]) => Promise<number | null>;
  writeConf?: typeof writeConf;
  // The descriptor's verify hook, overridable so a test can assert the
  // answered/failed branches without a listening backend. It is a descriptor
  // hook rather than an effect by nature, so this is the one entry that stands
  // in for the descriptor instead of for a host call.
  verify?: (proxyPort: number) => Promise<VerifyResult>;
  // Renders a resolution refusal as advice. `enableInstance` has no idea which
  // repositories sit next to the directory or which confs exist, so a surface
  // that does can supply better lines than the default one-sentence refusal.
  refusal?: (descriptor: ServerDescriptor, refusal: Refusal) => Promise<string[]>;
};

// The structured refusal a resolver returns, as the lifecycle sees it.
export type Refusal = Extract<RootResult, { ok: false }>;

// What an enable call takes: the directory to resolve, the instance name to use
// for a NEW conf, and (internal) the eligibility mode the lifecycle applies.
// One type for the boundary and the implementation. Two names for this shape — a
// `Target` the lifecycle read and an `EnableOptions` the runner built — let the
// two sets of defaults drift while both typecheck.
export type Target = { directory?: string; name?: string; nonGit?: "directory" };

// A directory resolved once, for both servers and every caller. `at` is where
// the caller is (canonical); `root` is the project key an instance for this
// location takes — the git root when there is one, `at` otherwise; `gitRoot` is
// that repository top level, present exactly when the location resolves through
// a repository. `refusal` is set when the mode's rules forbid serving it.
//
// This is the ONE resolution contract in the plugin. `coverage` and the
// lifecycle both read it, so a path that `codeintel` describes can never be a
// different path than `serena-instance` refuses: a second resolver beside this
// one is how they came to disagree.
export type ResolvedLocation = {
  at: string;
  root: string;
  gitRoot: string | null;
  refusal?: Refusal;
};

// `mode` is the descriptor's eligibility rule, not a preference: `git` is the
// strict rule a census-based server needs, `directory` also accepts a plain
// directory (the fallback's rule). Resolving under the wrong mode is what a
// caller does by forgetting one, so it is a required parameter.
export function resolveLocation(directory: string, mode: "git" | "directory"): ResolvedLocation {
  const target = resolveRoot(directory, mode === "directory" ? { nonGit: "directory" } : {});
  if (!target.ok) return { at: directory, root: directory, gitRoot: null, refusal: target };
  const gitRoot = target.gitRoot ?? null;
  return { at: gitRoot ?? target.root, root: target.root, gitRoot };
}

// The lifecycle's own binding of the one resolver: the descriptor's non-git mode
// is the mode, so a call site never chooses it. `ResolvedLocation` carries the
// refusal rather than returning a second union, so the lifecycle branches on
// `target.refusal` and every consumer of a resolved path agrees about what was
// resolved.
function resolveFor(directory: string, nonGit?: "directory"): ResolvedLocation {
  return resolveLocation(directory, nonGit ? "directory" : "git");
}

// A descriptor's lifecycle with the descriptor already supplied. This is what a
// surface holds: it cannot accidentally call the lifecycle with the wrong
// argument order, because the descriptor is no longer a parameter it can pass.
// `bind` is the only way to obtain one.
//
// Why a factory and not a stricter function type: `Operation` used to be
// `(input) => Promise<OperationResult>`, and a default-bound
// `enableInstance(descriptor, opts)` is assignable to it — both are structural
// and both begin with one argument — so the compiler accepted a binding that
// read `opts.directory` off the INPUT and got `undefined` on every call. A
// signature can always be widened; a value that has already closed over its
// descriptor cannot produce an argument list the lifecycle rejects.
export type Bound = {
  name: ServerDescriptor["name"];
  enable(input: Target): Promise<OperationResult>;
  disable(input: Pick<Target, "directory">): Promise<OperationResult>;
};

// Bind a descriptor for a surface. `opts.nonGit` overrides the descriptor's own
// declaration, so the eligibility decision is made once, here, and never spread
// into an operation's input where a type error could not see it.
//
// `effects` is the same injected set `enableInstance` already takes, carried by
// the bound object so a surface can pass it through without ever seeing the
// descriptor's argument list. The descriptor alone cannot keep a test off the
// host — `bind` closes over it, but its pipeline still reaches systemd, git and
// the bind probe — so the two holes are opened together or neither is usable.
export function bind(
  descriptor: ServerDescriptor,
  opts: { nonGit?: "directory"; effects?: EnableEffects } = {},
): Bound {
  const nonGit = opts.nonGit ?? descriptor.nonGit;
  const effects = opts.effects;
  return {
    name: descriptor.name,
    enable: (input) =>
      enableInstance(descriptor, { ...input, ...(nonGit ? { nonGit } : {}) }, effects),
    disable: (input) =>
      disableInstance(descriptor, { ...input, ...(nonGit ? { nonGit } : {}) }, effects),
  };
}

// Prose for a failed verify. Pure: the caller passes the rendered describe
// block, so this can be asserted without systemd. It states what IS true (the
// instance exists), what is not (the backend did not answer), and what to check
// next — a bare "failed" would send the reader back to hand-probing.
//
// `preamble` replaces the "was provisioned" sentence rather than preceding it:
// on the already-existing arms nothing was just provisioned, and printing both
// sentences said "left unchanged" and "was provisioned" about the same instance.
export function verifyFailureLines(
  descriptor: Pick<ServerDescriptor, "name" | "unit">,
  proxyPort: number,
  detail: string,
  describeBlock: string,
  preamble?: string,
): string[] {
  const sentence = detail.replace(/\.+$/, "");
  return [
    `${descriptor.name}: ${preamble ?? `the instance was provisioned but ${sentence}.`}`,
    "",
    describeBlock,
    "",
    "The instance itself is in place, so the next things to check are the backend",
    `unit (systemctl --user status ${descriptor.unit}@${proxyPort}.service) and the`,
    "port it binds. A cold backend can take longer than the probe budget",
    "(CODEINTEL_PROBE_TIMEOUT_MS): re-run enable to re-verify, or action=status to",
    "inspect without probing.",
  ];
}

// A project.yml that does not match the tree, as one line for the enable that
// just wrote it. Silence when the inspection is absent or clean: a healthy
// project says nothing, and a descriptor without per-project state has no drift
// to report. `extra` is not a fault on its own (a server configured by hand and
// then removed from the tree), so only `missing` — recorded, but no longer
// present — is stated as a problem.
function driftWarning(
  descriptor: Pick<ServerDescriptor, "name">,
  drift: DriftReport | undefined,
): string[] {
  if (!drift || drift.error || drift.missing.length === 0) return [];
  return [
    `${descriptor.name}: project config is missing ${drift.missing.join(", ")} ` +
      `(configured: ${drift.configured.join(", ") || "(none)"}; present: ${drift.present.join(", ")}).`,
    `  Re-run ${descriptor.name}-instance action=refresh to rewrite it.`,
  ];
}

// What a refusal says to a caller who only has `bind(...)`: the mechanism is
// real but it is not advice, and the audited session read exactly this sentence
// and stopped. So the descriptor declares whether its server is the floor (serves
// any directory) or the one that needs a git root, and the default refusal names
// the other one — the surface that can replace it (serena-instance,
// mcp-instance, coverage) passes `effects.refusal` to say more, having listed the
// directory and the confs.
//
// The two arms are per-descriptor, not per-code. A git-root server is refused for
// `not-a-repo` with advice to use the fallback; the floor is refused only when the
// directory cannot be resolved at all, so its arm is a resolution one and names
// the path rather than offering another server.
//
// `unresolvable` is checked FIRST and independently of `nonGit`: collapsing the
// two made the floor's refusal explain serena's eligibility rules — "not the
// eligibility rules — the fallback accepts any directory that exists" — to a
// caller who was already using the floor and had only a bad path.
export function refusalAdvice(
  descriptor: Pick<ServerDescriptor, "name" | "nonGit">,
  refusal: Refusal,
): string[] {
  const mechanism = `${descriptor.name}: ${refusal.detail}`;
  if (refusal.code === "unresolvable") {
    return [
      mechanism,
      "",
      `${refusal.directory} could not be resolved to a working directory, so there is`,
      "nothing for any server to serve here: the path does not exist, is not a",
      "directory, or is a symlink loop. No eligibility rule changes that — the",
      "fallback accepts any directory that exists, and this one does not.",
    ];
  }
  if (descriptor.nonGit) {
    return [
      mechanism,
      "",
      `${descriptor.name} is the fallback: it serves any directory that exists, so a`,
      "refusal here is about the path rather than about git or language support.",
    ];
  }
  // Every command named here is the TOOL call, not a shell command: `codeintel`
  // and `serena-instance` are MCP tool names with an `action`, so `codeintel
  // enable <dir>` is not runnable at a prompt and quoting the path would not make
  // it so. The advice therefore names the tool, the argument, and leaves the
  // directory unquoted only where it is prose rather than a command.
  return [
    mechanism,
    "",
    `${descriptor.name} needs a git root (its census is \`git ls-files\`), so it cannot`,
    "serve a directory that is not a repository. Two ways forward:",
    "  · the fallback backend serves any directory, git or not. The `codeintel` tool",
    "    with action=enable and this directory provisions it here;",
    "  · if this directory contains repositories, serena covers each as its own",
    "    project: point `codeintel` at each repository root, or pass all=true to",
    "    provision every repository directly under this one.",
  ];
}

// Enable (idempotently) the instance for `directory`. If a conf already exists
// for the resolved root it is reused: enabled sockets are left untouched, and a
// conf whose socket is merely disabled is re-enabled in place — a re-enable
// after `disable` never allocates a new port.
//
// `ok` is true only when the instance ANSWERS: every success path ends with the
// verify step, an MCP `initialize` through the instance's own proxy port
// (`effects.verify` when a caller supplies one, else `descriptor.verify`). A
// socket that is enabled proves only that a listener exists.
//
// Returns an OperationResult so callers can branch on success (a failed enable
// must not be reported as if it succeeded), while `message` is the prose each
// surface prints verbatim.
//
// A refusal is rendered by the refusing server's own descriptor, because the
// advice differs per server: serena's refusal is an eligibility one (name the
// fallback), the fallback's is a resolution one (name the path). `refusalAdvice` is
// that default; `effects.refusal` lets a surface say more, since it can list the
// directory and read the confs and this module can do neither.
export async function enableInstance(
  descriptor: ServerDescriptor,
  opts: Target,
  effects: EnableEffects = {},
): Promise<OperationResult> {
  const resolve = effects.resolveTarget ?? resolveFor;
  const read = effects.readConfs ?? readConfs;
  const socketState = effects.unitState ?? unitState;
  const openSocket = effects.enableSocket ?? enableSocket;
  const allocate = effects.claimPort ?? claimPort;
  const write = effects.writeConf ?? writeConf;
  const probe = effects.verify ?? descriptor.verify?.bind(descriptor);

  const directory = opts.directory ?? process.cwd();
  const target = resolve(directory, opts.nonGit ?? descriptor.nonGit);
  // Either refusal — the resolver's, or the gate's for a server whose identity
  // is a git root — takes the same advice path, so a caller sees one shape of
  // message regardless of which check caught the directory.
  if (target.refusal) {
    const advice = effects.refusal
      ? await effects.refusal(descriptor, target.refusal)
      : refusalAdvice(descriptor, target.refusal);
    return { ok: false, message: advice.join("\n") };
  }
  const root = target.root;

  const confs = await read(descriptor);
  const existing = confs.find((c) => c.project === root);
  if (existing) {
    const state = socketState(descriptor, existing.proxyPort);
    // One read serves both the decision and the messages below; the decision is
    // asked of the shared predicate so the spelling lives in one place.
    if (socketEnabledFrom(state)) {
      const verify = await probe?.(existing.proxyPort);
      if (verify && !verify.ok) {
        return {
          ok: false,
          message: verifyFailureLines(
            descriptor,
            existing.proxyPort,
            verify.detail,
            describe(descriptor, existing, state),
            `instance for ${root} already exists and is enabled, and its backend did not answer: ${verify.detail.replace(/\.+$/, "")}.`,
          ).join("\n"),
        };
      }
      return {
        ok: true,
        message: [
          `${descriptor.name} instance for ${root} already exists and is enabled; left unchanged.`,
          describe(descriptor, existing, state),
          ...(verify ? ["", verify.detail] : []),
          "",
          "mcp-route picks it up on its next 5 s poll; no restart needed.",
        ].join("\n"),
      };
    }
    const enabled = openSocket(descriptor, existing.proxyPort);
    if (!enabled.ok) {
      return {
        ok: false,
        message: [
          `${descriptor.name} instance for ${root} already had a conf; its socket was ${state.enabled}.`,
          describe(descriptor, existing, state),
          "",
          `Failed to enable the socket: ${enabled.message}`,
        ].join("\n"),
      };
    }
    const verify = await probe?.(existing.proxyPort);
    if (verify && !verify.ok) {
      return {
        ok: false,
        message: verifyFailureLines(
          descriptor,
          existing.proxyPort,
          verify.detail,
          describe(descriptor, existing, state),
          `instance for ${root} already had a conf; its socket was ${state.enabled} and has now been enabled, but its backend did not answer: ${verify.detail.replace(/\.+$/, "")}.`,
        ).join("\n"),
      };
    }
    return {
      ok: true,
      message: [
        `${descriptor.name} instance for ${root} already had a conf; its socket was ${state.enabled}.`,
        describe(descriptor, existing, state),
        ...(verify ? ["", verify.detail] : []),
        "",
        "Socket enabled. mcp-route picks it up on its next 5 s poll.",
      ].join("\n"),
    };
  }

  // Per-server preparation (serena writes project.yml + registers). Runs before
  // a port is claimed, so a provision failure neither burns a port nor leaves a
  // dangling conf.
  const name = opts.name?.trim() || defaultInstanceName(root);
  const prepared = await descriptor.provision(root, { name });
  if (!prepared.ok) return { ok: false, message: `${descriptor.name}: ${prepared.message}` };

  const proxyPort = await allocate(ALL_DESCRIPTORS);
  if (proxyPort === null) {
    return {
      ok: false,
      message: `${descriptor.name}: no free port in 8801-8899 (every candidate is claimed by a conf or bound by another process)`,
    };
  }

  const conf: Omit<Conf, "file"> = {
    instanceName: name,
    project: root,
    proxyPort,
    backendPort: proxyPort + 100,
  };
  const written = await write(descriptor, { ...conf, file: `${proxyPort}.conf` });
  if (!written.ok) return { ok: false, message: `${descriptor.name}: ${written.message}` };

  const result = openSocket(descriptor, proxyPort);
  if (!result.ok) {
    // Deliberately leave the conf: it is inert without a socket, and keeping it
    // makes the retry idempotent (the next call finds the conf and just enables
    // the socket) instead of allocating a new port each attempt.
    return {
      ok: false,
      message: [
        `${descriptor.name}: wrote ${descriptor.instancesDir}/${proxyPort}.conf but failed to enable the socket:`,
        `  ${result.message}`,
        "",
        "The conf was left in place; re-run enable to finish, or action=disable to roll back.",
      ].join("\n"),
    };
  }

  // The socket state was just proven by the enable above, so the blocks below
  // are rendered from it rather than asking systemd the same question twice.
  const state = socketState(descriptor, proxyPort);

  // The proof. Without it `ok` would mean "a listener exists", which is the
  // state in which the audited session had to hand-probe the backend. The conf
  // is kept on a failed verify for the same reason it is kept on a failed
  // socket: a retry then re-verifies the same instance instead of allocating a
  // second port.
  const verify: VerifyResult | undefined = await probe?.(proxyPort);
  if (verify && !verify.ok) {
    return {
      ok: false,
      message: verifyFailureLines(
        descriptor,
        proxyPort,
        verify.detail,
        describe(descriptor, { file: `${proxyPort}.conf`, ...conf }, state),
      ).join("\n"),
    };
  }

  // The post-enable warnings, from the inspection `provision` already made: the
  // hook takes them rather than walking the tree a second time, so one enable is
  // one census.
  const extra = [
    ...((await descriptor.enableExtra?.(root, prepared.inspect?.extras ?? [])) ?? []),
    // What the inspection saw that the caller would otherwise have to repeat: a
    // project.yml that does not match the tree is reported here, on the enable
    // that wrote it, rather than waiting for a status poll to notice.
    ...driftWarning(descriptor, prepared.inspect?.drift),
  ];
  return {
    ok: true,
    message: [
      `Created ${descriptor.name} instance for ${name}.`,
      describe(descriptor, { file: `${proxyPort}.conf`, ...conf }, state),
      ...(verify ? ["", verify.detail] : []),
      "",
      prepared.message,
      ...extra,
      "",
      "The socket is listening on first connect; the backend and its language",
      "servers start lazily and idle out after the unit's --exit-idle-time.",
      "mcp-route picks the new route up on its next 5 s poll.",
    ].join("\n"),
  };
}

// Stop the socket and delete the conf. The route reverts on mcp-route's next
// poll. What is deliberately NOT removed (serena's serena_config.yml
// registration) is the descriptor's `onDisableExtra`.
export async function disableInstance(
  descriptor: ServerDescriptor,
  opts: { directory?: string; nonGit?: "directory" },
  effects: Pick<EnableEffects, "resolveTarget" | "readConfs" | "refusal"> = {},
): Promise<OperationResult> {
  const resolve = effects.resolveTarget ?? resolveFor;
  const read = effects.readConfs ?? readConfs;

  const directory = opts.directory ?? process.cwd();
  const target = resolve(directory, opts.nonGit ?? descriptor.nonGit);
  if (target.refusal) {
    const advice = effects.refusal
      ? await effects.refusal(descriptor, target.refusal)
      : refusalAdvice(descriptor, target.refusal);
    return { ok: false, message: advice.join("\n") };
  }
  const root = target.root;

  const match = (await read(descriptor)).find((c) => c.project === root);
  if (!match)
    return { ok: false, message: `${descriptor.name}: no ${descriptor.name} instance for ${root}` };

  const stopped = disableSocket(descriptor, match.proxyPort);
  if (!stopped.ok) {
    return {
      ok: false,
      message: [`${descriptor.name}: ${stopped.message}`, "The conf was left in place."].join("\n"),
    };
  }

  try {
    await rm(`${descriptor.instancesDir}/${match.file}`);
  } catch (error) {
    return {
      ok: false,
      message: [
        `Disabled the socket but failed to remove ${descriptor.instancesDir}/${match.file}:`,
        `  ${String(error)}`,
        "Remove it by hand; until then the route is a dead conf.",
      ].join("\n"),
    };
  }

  const extra = (await descriptor.onDisableExtra?.()) ?? [];
  return {
    ok: true,
    message: [
      `Removed the ${descriptor.name} instance for ${root}.`,
      `  ${stopped.message}`,
      `  deleted ${descriptor.instancesDir}/${match.file}`,
      ...extra,
      "",
      `mcp-route disables ${descriptor.name} for this location on its next 5 s poll.`,
    ].join("\n"),
  };
}

// One instance row, shared by every table so formatting cannot drift.
export function instanceRow(descriptor: ServerDescriptor, c: Conf): string {
  const state = unitState(descriptor, c.proxyPort);
  return `  ${c.proxyPort}  ${c.project}${socketEnabledFrom(state) ? "" : `  [${state.enabled}]`}`;
}

// The `known instances` table, used by both the per-location status and the
// combined `/lsp status`.
export function instanceTable(descriptor: ServerDescriptor, confs: Conf[]): string[] {
  return confs.map((c) => instanceRow(descriptor, c));
}

// The status block three surfaces print for one server: what covers THIS
// location (the conf's ports and socket state, or the sentence saying nothing
// does), then every instance that exists. Extracted because it was written out
// three times — `mcp-instance status`, `serena-instance status`, `/lsp status` —
// and the three copies had already drifted in their wording. The caller supplies
// its own noun (`fallback`/`serena`) and its own "disabled" explanation, which is
// the only part that genuinely differs.
export function locationStatus(
  descriptor: ServerDescriptor,
  confs: Conf[],
  opts: { root: string; noun: string; none: string },
): string[] {
  const match = confs.find((c) => c.project === opts.root);
  return [
    ...(match
      ? ["", `${opts.noun} instance for this location:`, describe(descriptor, match)]
      : ["", `${opts.noun} instance for this location: none (${opts.none})`]),
    "",
    `known instances (${confs.length}):`,
    ...instanceTable(descriptor, confs),
  ];
}
