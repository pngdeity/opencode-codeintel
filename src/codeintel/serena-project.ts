// codeintel/serena-project — the facts about a serena project's on-disk identity
// that BOTH modules need: the one that provisions serena (`plugins/serena-provision.ts`)
// and the one that drives it (`plugins/codeintel/descriptors.ts`).
//
// Why this module exists: those two used to hold a copy each. The descriptor kept
// a hand-written `Census` type and a hand-written `ProvisionModule` type purely to
// describe what it imported lazily, and the path/parse helpers lived in the
// descriptor while the renderer lived in the plugin — so "where does project.yml
// live" and "what does a census contain" each had two statements, one of which
// could not be type-checked against the other.
//
// It must not import `codeintel/server`-level code: `serena-provision.ts` is a
// plugin whose census is the serena half of the descriptor, and a static cycle
// through `descriptors.ts` would make its load depend on the fallback's.

export const SERENA_HOME = process.env.SERENA_HOME ?? `${process.env.HOME}/.config/serena`;

export type Submodule = { path: string; initialized: boolean };

// One `git ls-files` walk of a repository, summarised. `extCounts` is kept rather
// than only the server list so a caller can explain WHY a server was chosen (the
// `serena-provision` report does), and so the unmapped extensions can be named.
export type Census = {
  root: string;
  name: string;
  extCounts: Map<string, number>;
  servers: string[];
  unmapped: string[];
  tracked: number;
  submodules: Submodule[];
};

// Serena writes a project's directory as the BASENAME OF THE PROJECT ROOT, not
// the --name argument: `serena project create /x/foo --name bar` writes
// projects/foo/project.yml with project_name: bar (verified on 1.7.0 and 2.0.0).
// So the on-disk path must be keyed on the root basename, or an explicit --name
// override silently points at a directory that does not exist.
export function projectDirName(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? "project";
}

// The project directory serena creates for `root`.
export function projectDir(root: string): string {
  return `${SERENA_HOME}/projects/${projectDirName(root)}`;
}

// The project.yml for `root`, which `serena project create` writes.
export function serenaYml(root: string): string {
  return `${projectDir(root)}/project.yml`;
}

// The `language_servers` block scan. Deliberately a line scan, not a YAML parse:
// the file is Serena's, and we only need the one block to detect drift.
export function parseLanguageServers(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^language_servers:\s*$/.test(l));
  if (start < 0) return [];
  const servers: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*-\s*(\S+)\s*$/);
    if (!match) break;
    servers.push(match[1]);
  }
  return servers;
}

// The project.yml body. One renderer for both writers (`serena project create`
// followed by the curated overwrite), so the file's shape has a single source.
export function renderProjectYml(name: string, servers: string[]): string {
  const list = servers.map((s) => `  - ${s}`).join("\n");
  return [
    `project_name: "${name}"`,
    "language_servers:",
    list,
    'encoding: "utf-8"',
    "activation_command:",
    "activation_command_timeout: 180.0",
    "line_ending:",
    "language_backend:",
    "ignore_all_files_in_gitignore: true",
    "ls_specific_settings: {}",
    'ls_workspace_folders: ["."]',
    "ls_additional_workspace_folders: []",
    "ignored_paths: []",
    "read_only: false",
    "excluded_tools: []",
    "included_optional_tools: []",
    "fixed_tools: []",
    "default_modes:",
    "added_modes:",
    "",
  ].join("\n");
}
