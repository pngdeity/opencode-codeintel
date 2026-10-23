# Records

Settled findings, disproofs, and case studies, kept apart from the open backlog.
Each record exists so a conclusion is not re-derived from intuition, and each one
carries the measurement that settled it: a query, a count, a log line, a
reproduction command.

A record is not a task. If a record implies remaining work, the task lives in the
project's issue tracker and cites the record by path.

| Record | Records |
| --- | --- |
| [mcpls-session-reaping.md](./mcpls-session-reaping.md) | The withdrawn "leak" finding: why `--stateful` does not leak, the graceful and ungraceful retest that disproved it, and the supergateway issues (#141, #160, #108) that were real |
| [codeintel-provisioning-incident.md](./codeintel-provisioning-incident.md) | A single audited provisioning session, its five distinct deficiencies, and what each repair is now held by — including the two lessons: a suite that fakes every seam proves the seam and not the wiring, and a refusal that reports a syscall instead of an alternative costs a session |
