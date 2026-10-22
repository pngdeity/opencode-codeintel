// serena-instance — provision serena's per-project state and socket-activated
// instance for a directory, or refresh it when the project grows new languages.
//
// serena is the hard half of code intelligence: unlike the fallback backend it
// needs three things per project, not one:
//
//   1. ~/.config/serena/projects/<name>/project.yml   (extension census)
//   2. registration in ~/.config/serena/serena_config.yml `projects:`
//   3. ~/.config/serena/instances/<proxy>.conf + serena-mcp@<proxy>.socket
//
// This tool does all three. Registration is done by Serena's own writer,
// `serena project create` (which appends via add_registered_project ->
// _persist_projects, ruamel-safe, comments preserved); this plugin never edits
// serena_config.yml itself. project.yml's *content* comes from the shared
// census renderer in serena-provision.ts, so the extension table lives in one
// place.
//
// serena and the fallback backend are additive, never a switch. Provisioning
// serena for a root ADDS a route member; the fallback stays enabled as the
// extension-coverage floor.
//
// Coverage: the fallback's coverage is total and static (global catalog).
// serena's is a census of the project's extensions as of the last run, so it can
// go stale when new file types arrive. action=status reports that drift, and
// action=refresh re-censuses project.yml. Leaving the socket and conf alone.
//
// Scope: only ~/.config/serena and the serena systemd unit templates.
//
// Env: SERENA_INSTANCE_DISABLE=1 disables the tool.

import {
  gitChildren,
  listDirEntries,
  readConfs,
  refusalLines,
  registryLines,
  resolveRoot,
  type DriftReport,
} from "./codeintel/core";
import { CCLSP, SERENA, serenaRegistryDrift } from "./codeintel/descriptors";
import {
  bind,
  envelope,
  locationStatus,
  type EnableEffects,
  type OperationResult,
} from "./codeintel/instance";

// serena's lifecycle, bound once for the read-only and disable paths: the
// descriptor is supplied here, not passed by a surface, and serena keeps its
// hard git requirement (the descriptor declares no `nonGit`), which is exactly
// what its census needs.
const SERENA_LIFECYCLE = bind(SERENA);

// serena's lifecycle with the refusal advice attached. Built per call rather
// than at module load because the advice needs the directory, which only the
// call has.
function serenaLifecycle(directory?: string): ReturnType<typeof bind> {
  const dir = directory ?? process.cwd();
  const effects: EnableEffects = {
    refusal: async (_descriptor, refusal) => refusalAdvice(dir, refusal),
  };
  return bind(SERENA, { effects });
}

// Pure: one submodule's block in the `submodules` listing, as a function of the
// submodule record and whether an instance conf already covers its root. No
// filesystem — `existing` is passed in by the shell.
export function submoduleLines(
  sub: { path: string; initialized: boolean },
  existing: { proxyPort: number } | undefined,
  root: string,
): string[] {
  const state = sub.initialized ? "" : " [not initialized]";
  const lines = [`  ${sub.path}${state}`];
  if (!sub.initialized) {
    lines.push(
      `    run \`git submodule update --init ${sub.path}\` first; an uninitialized`,
      "    submodule has no working tree to census.",
    );
  }
  if (existing) {
    lines.push(`    already provisioned (instance ${existing.proxyPort}); nothing to do.`);
  } else if (sub.initialized) {
    lines.push(`    provision with: serena-instance enable for ${root}/${sub.path}`);
  }
  return lines;
}

// Pure: the verdict lines appended after a refresh, from the before/after drift.
// `after.error` means the re-census could not be verified; no missing and no
// extra means the census now matches; otherwise it is still stale.
export function refreshLines(
  before: DriftReport | undefined,
  after: DriftReport | undefined,
): string[] {
  if (after?.error) return ["", `Could not verify coverage after refresh: ${after.error}`];
  if (after && after.missing.length === 0 && after.extra.length === 0) {
    return ["", "Coverage is complete; project.yml matches the census."];
  }
  if (after && before) {
    return ["", `Still stale after refresh — missing ${after.missing.join(", ") || "(none)"}`];
  }
  return [];
}

async function submodulesAction(input: { directory?: string; name?: string }): Promise<string> {
  const directory = input.directory ?? process.cwd();
  const root = resolveRoot(directory);
  if (!root.ok) return (await refusalAdvice(directory, root)).join("\n");

  const mod = await import("./serena-provision.ts");
  const c = mod.census(root.root);
  if ("error" in c) return `serena-instance: ${c.error}`;
  if (c.submodules.length === 0) {
    return `serena-instance: ${root.root} has no submodules; nothing to recurse into.`;
  }

  const lines: string[] = [
    `${root.root} has ${c.submodules.length} submodule(s). Each is a separate git root,`,
    "so serena covers it as its own project (own project.yml + instance), not by",
    "descending into the parent:",
    "",
  ];
  for (const sub of c.submodules) {
    const subRoot = `${root.root}/${sub.path}`;
    const confs = await readConfs(SERENA);
    const existing = confs.find((conf) => conf.project === subRoot);
    lines.push(...submoduleLines(sub, existing, root.root));
  }
  return lines.join("\n");
}

async function enable(input: { directory?: string; name?: string }): Promise<OperationResult> {
  return serenaLifecycle(input.directory).enable(input);
}

// serena's refusal, rendered with what only this module can see: the repository
// children of the directory it was asked about, each with the instance that
// already covers it, and the fallback line that says this location is served
// anyway. `refusalLines` in codeintel/core is pure; the child list comes from
// the filesystem here.
async function refusalAdvice(
  directory: string,
  refusal: Extract<ReturnType<typeof resolveRoot>, { ok: false }>,
): Promise<string[]> {
  const confs = await readConfs(SERENA);
  const fallbackRoot = resolveRoot(directory, { nonGit: "directory" });
  const fallbackConfs = await readConfs(CCLSP);
  return refusalLines({
    subject: "serena",
    refusal,
    children: gitChildren(directory, await listDirEntries(directory)),
    confs,
    fallbackRoot: fallbackRoot.ok ? fallbackRoot.root : directory,
    fallbackConf: fallbackConfs.find(
      (c) => c.project === (fallbackRoot.ok ? fallbackRoot.root : directory),
    ),
  });
}

async function refresh(input: { directory?: string }): Promise<string> {
  const directory = input.directory ?? process.cwd();
  const root = resolveRoot(directory);
  if (!root.ok) return (await refusalAdvice(directory, root)).join("\n");

  const before = await SERENA.inspect?.(root.root);
  const result = await SERENA.refresh?.(root.root);
  if (!result) return "serena-instance: this server has no refresh step";
  if (!result.ok) return `serena-instance: ${result.message}`;

  // The refresh inspected the root it wrote, so the "after" side is the one it
  // handed back: re-reading would be a fourth walk of the same tree.
  const after = result.inspect?.drift;
  const lines = [result.message, ...refreshLines(before?.drift, after)];
  lines.push(
    "",
    "The instance conf and socket were left untouched. Restart the backend if it",
    "is already running, or it keeps the old language-server set until it idles out.",
  );
  return lines.join("\n");
}

async function disable(input: { directory?: string }): Promise<OperationResult> {
  return SERENA_LIFECYCLE.disable(input);
}

// Pure: the coverage block from a drift report. `undefined` drift (no coverage
// step for this server) renders nothing; `.error` renders the unknown line; a
// report renders the count plus configured/present, then STALE and extra when
// present.
export function coverageLines(drift: DriftReport | undefined): string[] {
  if (!drift) return [];
  if (drift.error) return ["", `coverage : unknown (${drift.error})`];
  const total = drift.present.length;
  const covered = total - drift.missing.length;
  const lines = [
    "",
    `coverage : ${covered}/${total} language servers present`,
    `  configured : ${drift.configured.join(", ") || "(none)"}`,
    `  present    : ${drift.present.join(", ") || "(none)"}`,
  ];
  if (drift.missing.length > 0) {
    lines.push(`  STALE      : missing ${drift.missing.join(", ")} — run action=refresh`);
  }
  if (drift.extra.length > 0) {
    lines.push(`  extra      : ${drift.extra.join(", ")} (no longer present in census)`);
  }
  return lines;
}

async function status(input: { directory?: string }): Promise<string> {
  const directory = input.directory ?? process.cwd();
  const root = resolveRoot(directory);
  const target = root.ok ? root.root : directory;

  const confs = await readConfs(SERENA);

  const lines: string[] = [
    `location : ${directory}`,
    `root     : ${target}`,
    ...locationStatus(SERENA, confs, {
      root: target,
      noun: "serena",
      none: "serena is disabled here",
    }),
  ];

  if (root.ok) {
    // One inspection: the coverage block and the submodule warnings are two
    // answers to one census, and a status poll used to walk the tree for each.
    const inspected = await SERENA.inspect?.(root.root);
    lines.push("", ...coverageLines(inspected?.drift));
    lines.push(...((await SERENA.enableExtra?.(root.root, inspected?.extras ?? [])) ?? []));
  }

  // Registry reconciliation (read-only): serena_config.yml's `projects:` list and
  // the confs drift apart because a disable leaves the registration by policy
  // (serena 2.0.0 does have `serena project remove`; see docs/serena.md §5).
  // Report, never write.
  lines.push(...registryLines(await serenaRegistryDrift()));

  return lines.join("\n");
}

export default {
  id: "local:serena-instance",
  setup: (ctx: any) => {
    if (process.env.SERENA_INSTANCE_DISABLE === "1") return;

    ctx.tool.transform((editor: any) => {
      editor.add({
        name: "serena-instance",
        description:
          "Provision, refresh, disable, or inspect serena code intelligence for a " +
          "directory's git root. serena needs three per-project things the fallback " +
          "backend does not: project.yml (an extension census), a serena_config.yml " +
          "registration, and a socket-activated instance. action=enable does all " +
          "three and enables " +
          "serena-mcp@<port>.socket (registration goes through Serena's own " +
          "`serena project create`, so serena_config.yml is never hand-edited); " +
          "action=refresh re-censuses project.yml after new file types appear, " +
          "leaving the instance alone; action=disable stops the socket and deletes " +
          "the conf (the registration is left); action=status reports the instance " +
          "plus coverage drift; action=submodules lists this root's submodules and " +
          "how to provision each (submodule contents are not censused — one project " +
          "per git root). serena and the fallback backend are ADDITIVE, never a " +
          "switch: enabling serena leaves the fallback enabled as the " +
          "extension-coverage floor. Use " +
          "this when serena is disabled for a location, or when status reports STALE " +
          "coverage.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["enable", "refresh", "disable", "status", "submodules"],
              description:
                "enable provisions and enables; refresh re-censuses project.yml; " +
                "disable stops and removes the instance; status reports it plus " +
                "coverage drift; submodules lists this root's submodules and how to " +
                "provision each. Defaults to status.",
            },
            directory: {
              type: "string",
              description:
                "Directory whose git root should be provisioned. Defaults to the " +
                "current location.",
            },
            name: {
              type: "string",
              description:
                "Project/instance name, used for the project.yml path and the conf " +
                "comment. Defaults to the repository directory name.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: { action?: string; directory?: string; name?: string }) => {
          const action = input.action ?? "status";
          // `enable`/`disable` carry the lifecycle's `ok`: a failure printed as
          // plain text in a successful result is indistinguishable from success.
          if (action === "enable") return envelope(await enable(input));
          if (action === "refresh") return { content: await refresh(input) };
          if (action === "disable") return envelope(await disable(input));
          if (action === "submodules") return { content: await submodulesAction(input) };
          return { content: await status(input) };
        },
      });
    });
  },
};
