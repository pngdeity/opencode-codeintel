// codeintel/status — what is provisioned on this host, as one report.
//
// Why a module: two surfaces answer that question — `/lsp status` and the
// `codeintel` tool's `action=status` — and a second rendering is how they come to
// disagree about the same host. It lives in the library, below both, because a
// surface that reached into a sibling surface for it made the two dependent on
// each other's internals; here they both depend downward, like every other
// consumer of this library.
//
// It is read-only: it reads conf directories and the serena registry, and writes
// nothing. (`registryLines` may render "unknown" when the registry cannot be
// read, which is a report of ignorance, not a failure to report.)

import { readConfs, registryLines } from "./core";
import { CCLSP, SERENA, serenaRegistryDrift } from "./descriptors";
import { instanceTable } from "./instance";

// The fallback instances, then serena's instances and registry reconciliation, in
// one report.
export async function codeIntelStatus(): Promise<string> {
  const lines: string[] = [];

  const fallbackConfs = await readConfs(CCLSP);
  lines.push(`codeintel instances (${fallbackConfs.length}):`);
  lines.push(...instanceTable(CCLSP, fallbackConfs));

  const serenaConfs = await readConfs(SERENA);
  lines.push("", `serena instances (${serenaConfs.length}):`);
  lines.push(...instanceTable(SERENA, serenaConfs));

  lines.push(...registryLines(await serenaRegistryDrift(), "serena registry"));

  return lines.join("\n");
}
