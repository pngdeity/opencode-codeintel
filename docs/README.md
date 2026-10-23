# OpenCode plugin: per-project MCP code intelligence

`@pngdeity/opencode-codeintel` routes two MCP servers — Serena and a `mcpls`
fallback — per project directory, over socket-activated systemd instances.

## Documentation

| Document | Covers |
|---|---|
| [INSTALL.md](./INSTALL.md) | Prerequisites, `codeintel install`, `codeintel doctor`, enabling a project, lingering, the catalog for languages that need extra environment, uninstall |
| [architecture.md](./architecture.md) | How the two servers differ, routing, verification, instances, idle TTL, reclamation, and the unit gotchas a deployment must not undo |
| [serena.md](./serena.md) | Serena setup: the three per-project layers, directory keying, language selection, socket activation, disable semantics, 2.0.0 conformance |
| [cclsp-retirement.md](./cclsp-retirement.md) | The fallback backend: why it is `mcpls` behind a `cclsp` name, the traps, the mcpls contract, timing, cost |
| [lsp-router-design.md](./lsp-router-design.md) | Unimplemented proposal: routing by the *file* being touched rather than the directory OpenCode started in |
| [plugin-quality-plan.md](./plugin-quality-plan.md) | The FCIS remediation plan for this repository: target states and the grading instruments |
| [records/README.md](./records/README.md) | Index of settled findings and disproofs |
| [records/mcpls-session-reaping.md](./records/mcpls-session-reaping.md) | The withdrawn "leak" finding (F-P3-1): why `--stateful` does not leak, the retest that disproved it, and the supergateway issues that were real |
| [records/codeintel-provisioning-incident.md](./records/codeintel-provisioning-incident.md) | The audited session that produced five surface deficiencies, and the two lessons that generalise |

## Where this came from

This plugin was developed inside a personal OpenCode configuration directory
and extracted into its own repository. Documents under `docs/` describe the
plugin; they cite identifiers and measurements carried over from that
development, which is why some references name a live host rather than a
fixture.
