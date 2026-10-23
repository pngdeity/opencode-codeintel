# Plugin quality — functional core / imperative shell remediation

Status: §4.1 executed for `src/agy.ts` and `src/serena-instance.ts`
(mutation-verified); `src/context-tools.ts` found already-thin (no extraction).
§4.2 executed for `src/mcp-route.ts` (pure seams exported + boundary tests). §4.3
executed (skill now grades on mutation/branch-density/Dependency-Rule, with the
Bun-reporter caveat recorded).

Scope: the TypeScript under `src/`. This document is the *plan*; it describes
target states, not the running system. Concrete values (file lists, line counts,
branch counts) are evidence gathered at writing time and will drift — re-measure
before acting on a number.

> **Provenance.** This plan was written when these sources lived in a single
> OpenCode configuration directory alongside five other plugins, and its scope
> then covered all of them. Only the codeintel files remain in this repository;
> references to `agy.ts`, `rtk.ts`, `tui.tsx`, `tui-status/` and `context/` name
> sibling plugins that were extracted to their own repositories. They are kept
> because the measurements and the cross-file comparison are the argument. Paths
> below are the original ones; the codeintel files now live under `src/`.

## 1. The problem, stated objectively

The plugin surface was graded against the FCIS literature (Bernhardt, *Boundaries*
2012; Lange; Google Testing Blog 2025) and the empirical testing-metric literature
(coverage vs mutation score; the oracle-gap work). Two findings:

- **The Dependency Rule holds and is structural.** The import graph is acyclic and
  every edge points shell → core. Core files (`src/codeintel/core.ts`,
  `tui-status/git.ts`, `tui-status/occupancy.ts`) import only `type`-erased
  modules, so they carry *zero runtime coupling* — a core file physically cannot
  call a shell. This is the property the literature calls load-bearing, and it is
  satisfied by construction.
- **Several shell files carry untested branching.** Measured at writing time (the
  plan's baseline, before §4.1/4.2 ran): `serena-instance.ts` (38 branch-tokens /
  238 lines), `tui.tsx` (32/440), `context-tools.ts` (26/398), `serena-provision.ts`
  (26/469), `agy.ts` (25/216), `mcp-route.ts` (22/257). Eight files had **zero pure
  exports and zero tests** at that point — `agy.ts`, `rtk.ts`, `lsp-command.ts`,
  `mcp-instance.ts`, `mcp-route.ts`, `context-tools.ts`, `serena-instance.ts`, and
  `tui.tsx`. This is the named failure mode: *"the shell accumulates branches,
  transformations, exception handlers — and slowly becomes a parallel core that
  nobody tests."* After execution, `agy.ts`, `serena-instance.ts`, and `mcp-route.ts`
  export tested pure functions; the counts above are the pre-work baseline, not the
  current state.

The first finding is why the fix is cheap: the architecture is already correct, so
remediation is *completing a boundary*, not re-architecting.

## 2. Why coverage is not the instrument here

Bun's coverage reporter misattributes these files. Measured: `git.ts` reports
`13-163` as uncovered even when `parseGitStatus` is directly exercised by a
one-line probe. `git.ts` reported 12% lines / 67% funcs simultaneously. The
reporter is unreliable for this tree, so **it cannot be the grading signal.**

Per the literature, coverage is in any case a *navigational* tool — "execution,
not testedness," with low-to-moderate correlation to fault detection once suite
size is controlled. The instrument to grade on is the **oracle gap** (coverage
minus mutation score) and **mutation score**, the strongest available predictor of
real-fault detection.

Two instruments we can actually trust today:

1. **Mutation verification** — apply a change, revert it, confirm the test FAILS.
   Already the mandated countermeasure in the configuration's own testing rules
   (`A test built from the same mental model as the code cannot falsify it`). Four
   extractions were verified this way (`parseGitStatus`, `assembleServers`,
   `pickFreePort`, `diffRegistry`).
2. **Structural metrics** — branch density per shell (*branches the shell should
   not have*) and the import direction (the Dependency Rule). Both are
   deterministic greps, immune to the coverage-reporter fault.

## 3. Principles the plan obeys

Derived in order from §1–2:

- **Extract decisions, not orchestration.** A branch is a decision and belongs in
  the core; a spawn/read/write is orchestration and stays in the shell. Push the
  *reasoning* inward, leave the *doing* at the edge.
- **The core never names the shell.** Preserve the type-only-import discipline.
  New pure modules must import `type` only, or nothing.
- **No general effect-runner port.** A port with one implementation per call site
  buys indirection, not testability — the over-abstraction failure the sources
  warn against. The correct granularity is **function-parameter injection at the
  specific orchestrator**.
- **Do not force FCIS on I/O-dominated shells.** For genuine orchestration, the
  right move is a boundary test, not an extraction.
- **Mutation-verify every extraction.** A test written from the same mental model
  as the code cannot falsify it; revert the logic and require a failure.

## 4. The work, in priority order

### 4.1 Extract the entangled decisions

**`agy.ts` (25 branches / 216 lines).** *Executed. In another repository now.* It
exports five pure functions — `stripComments`, `parseConfig`, `parseModels`,
`getTimeout` (exported for test), and `buildArgs` — with the executor reduced to a
one-path orchestrator.

- `stripComments(text: string): string` — comment stripping, a pure decision.
- `parseConfig(text: string): Config` — the raw-bytes-to-config transform, taking
  input the executor previously read via `Bun.file`. Handles the `defaultModel`
  coercion and validation.
- `parseModels(text: string): ModelEntry[]` — tab-split, skip malformed, join
  display labels.
- `buildArgs(input, config, directory): string[]` — a decision, previously buried
  in the executor: `chosen` → `modelArg`, `addDir`, `timeout`. The full argv for
  one `agy --print` run, as a pure function of the request.
- `parseUsage(text): UsageRow[]`, `usagePoolFor(model, pools)`,
  `missingPools(rows, expected)`, `assessQuota(model, rows, pools, minRemaining)`,
  `options(candidates, rows, pools, minRemaining)` and `gateMessage(...)` — the
  quota gate added later: the `/usage` table parse, the model-to-pool resolution,
  the binding-row verdict, and the refusal text. `fetchUsage` stays impure in
  setup; every decision above it is testable without spawning `agy`.

**`src/serena-instance.ts` (38 branches / 238 lines).** *Executed.* Now exports
`submoduleLines`, `refreshLines`, `coverageLines`, and `registryLines`; the read
paths are thin orchestrators over `readConfs`, whose *formatting* decisions were
entangled.

- `submoduleLines(sub, existing, root)` — the per-submodule report lines.
- `refreshLines(before, after)` — the refresh diff and its completeness verdict.
- `coverageLines(drift: DriftReport | undefined): string[]` — the coverage-drift
  block, including the `STALE:` line.
- `registryLines(reg: RegistryDrift): string[]` — the registry reconciliation
  block.

**`src/context-tools.ts` (26 branches / 398 lines).** *Re-measured during
execution: already thin. In another repository now.* Its decisions lived in
`context/occupancy.ts` (19 pure functions, 33 exports); it is a shell per its own
header. No extraction done or needed.

### 4.2 Boundary tests where extraction is not warranted

For `src/mcp-route.ts` (conf watching + MCP transform reload) and the
systemctl-driving code paths (`src/codeintel/core.ts`, `src/serena-provision.ts`),
extraction is artificial — these are "read, call, write" orchestration. The
prescription is a small number of tests that feed a **fake `ctx`** (a stub object
exposing `ctx.mcp.transform`, `ctx.location`, `console.warn`) and assert the
*wiring*: that a conf change triggers a reload, that a transform failure disables
the servers rather than throwing. Assert the seam, not the logic.

**`src/mcp-route.ts` — executed, with a better seam than planned.** The file
already had the seams; they are now exported and tested. `isPort` (the port
guard), `parseConf(text)`, `lookup(table, directory)` (longest-prefix
resolution), and `applyRoute(editor, route, directory, seen)` (the enable/disable
wiring, with `seen` injectable so tests avoid the live module singleton).
`tests/mcp-route.test.ts` covers the parser, the port guard, the longest-prefix
lookup, the enable/disable wiring, and notice-once.

### 4.3 Demote coverage in the docs; cite the trustworthy instruments

*Executed.* The configuration's plugin documentation now grades on **mutation
score + branch density + Dependency Rule**, not a coverage percentage, records the
Bun-reporter caveat, and points at this document for the full reasoning. The
test-file-location gotcha is recorded there too (see §4.4).

### 4.4 Explicitly out of scope

- **No new dependency** (Stryker, a coverage fix) without a separate decision —
  the manual mutation discipline already in use is sufficient and needs no
  install.
- **No rename of the `cclsp` slot** or any of the legacy-named plumbing; that
  naming is deliberate and documented in
  [cclsp-retirement.md](./cclsp-retirement.md). (Reconsidering the slot's
  *display* name was proposed and withdrawn on 2026-10-17 — the change is not a
  string substitution and the cost exceeds the benefit.)
- **No cross-cutting refactor.** Only the files named in §4.1 and the shells in
  §4.2. The remaining pure-heavy files (`occupancy.ts` 19 exports,
  `src/codeintel/core.ts` 14) already grade well and are left alone.

## 5. Verification contract

Every item in §4.1 must, before it is considered done:

1. Preserve the file's exported signatures (callers untouched — verify with a
   grep for the old symbol at its call sites).
2. Add tests whose fixtures include **the orientation the author did not have in
   mind** (spaces in ids, empty docs, detached HEAD, absent blocks, both divergence
   directions).
3. **Pass the mutation check**: revert the extracted logic, observe a specific
   test FAIL, restore, observe green.
4. Keep the formatter/linter clean and the full `bun test` suite at 0 fail.

§4.2 items are done when the fake-`ctx` test asserts the documented behavior and
fails if the wiring is broken.

## 6. Success criteria

- The *decisions* in `agy.ts`, `src/serena-instance.ts`, and `src/mcp-route.ts`
  move into exported, tested pure functions, leaving a reduced untestable shell
  residue.
- Every extracted function has a mutation-verified test.
- `src/mcp-route.ts` has boundary tests; the systemctl-driving path gets them next.
- The docs grade on mutation + structure, not coverage.

**Measured outcome (2026-10-16).** Raw branch-token counts stayed *flat*
(`agy.ts` 25→26, `serena-instance.ts` 38→38, `mcp-route.ts` 22→22) — because the
extractions moved decisions into **same-file exports**, so the file's total branch
count is unchanged even as the *untestable* portion shrinks. The metric that moved
is the **exported-pure-function count** (0→5, 0→4, 0→4) and the residual
untestable branch tokens outside exports (`agy.ts` 9, `mcp-route.ts` 10,
`serena-instance.ts` 16). Test suite on the day: 148 pass / 6 files → **218 pass /
0 fail across 9 files**; formatter clean throughout. Nine mutants checked, three
initially survived (real test gaps, closed).

The suite has grown well past that figure, and this repository carries only the
codeintel files — so the 218 is a dated measurement of a superset, not the current
suite size. Re-measure rather than quoting it.
