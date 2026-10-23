# Code-intelligence provisioning: the audited session and the five fixes

Settled finding, one session's evidence plus the repairs it forced. The project
document and per-phase files that produced them are deleted; every repair they
specified has landed. What follows is what a future reader needs — the diagnosis,
the standing evidence, and the costs still open — so the diagnosis is not
re-derived: what one agent actually had to do, how long it took, and which code
shapes let it happen.

## The measurement that started it

Session `ses_ea3f13d01ffeqeNXJ51e1Z5jJO` needed code intelligence for a directory
that was not a git repository but contained one repository (`headroom/`) directly
under it. Reconstructing the work from that session's rows:

- `serena-instance enable` refused with
  `not inside a git repository (git rev-parse failed: fatal: …)` — a mechanism,
  naming neither the fallback nor the repository one level down.
- Nothing in either tool's description said the other existed or would accept the
  directory, so the refusal read as "code intelligence is unavailable here".
- `mcp-instance enable` then threw
  `undefined is not an object (evaluating 'opts.directory')` on **every** call,
  because the surface's default binding was `enableInstance` itself and the
  descriptor became `opts`. 317 tests passed while this was true.
- A socket that came up was reported `ok` without anything proving the backend
  answered; the agent had to hand-probe the port to find out.

Five distinct deficiencies, one session, no single cause: an unverified success
claim, a type-erased binding, a missing test of the real default, two verbs where
one was needed, and a refusal that named the mechanism instead of the alternative.

## What was fixed, and the evidence that it holds

| Deficiency | Repair | Standing evidence |
| --- | --- | --- |
| `ok` meant "a listener exists" | `src/codeintel/probe.ts`: one MCP `initialize` through the instance's own proxy port ends every success arm; `code: "not-a-repo"`-style failures keep the conf so a re-run re-verifies | `probe.test.ts`, `instance.test.ts`; live both ways |
| descriptor-erased default binding | `bind(descriptor)` returns an opaque `Bound`; `Operation` deleted; surfaces hold the bound object | restoring the audited binding is `TS2322`, and fails `surfaces-wiring.test.ts` with `bound.enable is not a function` |
| no test invoked a surface's real defaults | `tests/surfaces-wiring.test.ts` drives every surface through its registration path with a real `bind(...)` over a fake descriptor, plus a registry scan for a fourth surface | removing the reload or the registry scan fails it |
| two verbs, undocumented eligibility difference | `codeintel` tool + bare `/lsp` run one coverage plan (`src/codeintel/coverage.ts`), reporting a coverage table | live: git root gets serena + fallback, non-git parent gets the fallback and the reason |
| refusal named the mechanism | `resolveRoot` returns `code`/`detail`/`directory`; `core.refusalLines` and `instance.refusalAdvice` compose the advice; `gitChildren` discovers repositories one level down and `all: true` provisions them | live on the audited shape: the refusal names `headroom/` and the fallback; `all: true` provisions both in one call |

Final state at the time of the audit: `bun test` → 438 pass / 0 fail, 842
expect() calls across 18 files for the whole set of plugins then living in one
configuration directory; this repository's suite is a subset of that figure. The
count moved after two review passes over the finished code, which found and fixed
nine contract defects (a plan and an enable disagreeing about a symlinked root, a
table claiming serena was unavailable while provisioning its children, step state
inferred from prose, a caller's `name` colliding children's serena projects, a
verify-failure message that contradicted itself, and a duplicated directory
listing), and then three more that made the coverage report untrustworthy at the
level of its central claim: a conf read as coverage without the instance ever
being probed, a symlinked root planned under a spelling no conf or enable call
used, and a `.git` *file* (worktree, submodule) not recognised as a repository. A
third pass then reviewed the module for quality rather than correctness and found
the same shape again: repairs bolted beside invariants instead of replacing them.
A step's state had become four fields for one decision, so the runner and the
renderer both re-derived it; the report printed the plan, every lifecycle and the
table, saying the same thing three ways. Both are now one discriminant and one
table. A fourth pass reviewed the *seams* — which module owns which fact — and
found the same pattern one level up: target resolution had two owners (so the two
tools answered the same path differently), the serena census crossed three modules
as `unknown`, and serena's on-disk project identity was stated twice. Resolution
is now one contract in `src/codeintel/instance.ts`, the census is deposited by its
producer and consumed by its hook, and the shared project facts live in
`src/codeintel/serena-project.ts`. A fifth pass then asked the layer *above* the
module: whether the shells that drive it form a system. It found one surface
importing another (a status renderer living in `/lsp`'s file), two exported
resolvers of which only the poorer one had a surface consumer, and two separate
descriptions of `/lsp` that had drifted apart, both still promising a no-op after
the plan stopped being one. It also found the pure half over-determined (a plan
input that could spell a location contradicting itself) and two round-trip budgets
nobody had counted: two MCP handshakes per verify, and two `systemctl` spawns per
rendered block. `src/codeintel/status.ts` now sits below both surfaces and an
import-direction assertion pins it; one resolver is exported; the plan takes its
location as one value and its socket state as data.
Every pass found defects in the same place — a repair landing beside an existing
owner rather than moving it — which is the argument for reviewing ownership as its
own question rather than as a by-product of reviewing behaviour.

## The two lessons worth carrying

1. **A test that injects a fake into every seam proves the seam, not the wiring.**
   The audited defect lived exactly in the one place no test looked: the default
   argument. Any surface with an injectable default needs one case that passes
   nothing.
2. **A refusal is a place to put advice, not a place to report a syscall.** The
   mechanism (`fatal: not a git repository`) is evidence and belongs in the
   message; it is not the message. The reader's next step has to be present, or
   the refusal costs the session that produced it.

## What this record does not claim

- The `codeintel` tool's coverage table is not a health check: it reports what is
  provisioned, and each enable step proves the backend answered at that moment.
  A `status`-time probe remains deferred (P2). A probe that asks mcpls which
  languages it actually attached would be the natural instrument; see
  [cclsp-retirement.md](../cclsp-retirement.md) on the documented `-32051`
  handshake behaviour.
- Depth-1 child discovery is the cap. A repository two levels down is reached by
  descending, not by enumerating more.
- `serena-instance status` runs the census twice per poll — `coverageDrift` walks
  the tree, then `enableExtra` walks it again when no deposit is waiting (three
  times for a `refresh`). Worth fixing, but it is a design question rather than a
  deletion: the deposit is a hand-off inside one enable, and a status is two
  enables' worth of questions asked in one call.
