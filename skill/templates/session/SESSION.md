# SESSION — {{ID}}
SCHEMA: collab-board/SESSION/v1
Catalog: ../../index.md
Protocol: ../../PROTOCOL.md

Type: {{TYPE}}
Reset: {{RESET}}
Topic: —
Goal: —
Done: —
Stall: CHECK=15m, HANDOFF=10m
Roles: PRIMARY={{PRIMARY}}, SECONDARY={{SECONDARY}}
SecondaryAdapter: {{ADAPTER}}

<!--
Default pairing: PRIMARY=CLAUDE, SECONDARY=CODEX, SecondaryAdapter=codex-cli.
Adapter values: codex-cli | claude-cli | subagent:<name> | manual (peer mode included);
`codex` is a legacy alias of codex-cli. A CLI executor dispatches the named CLI as the
SECONDARY, so it must match the secondary actor (codex-cli => SECONDARY=CODEX, claude-cli =>
SECONDARY=CLAUDE; lint L18) — see the skill's references/executors/ for the exact dispatch
specs and references/hosts/ for host preflights. Other pairings use `manual` or
`subagent:<name>`. Optional `SecondaryModel:` / `SecondaryEffort:` keys pin the executor's
model/effort for this session; omit them to inherit the user's CLI config.

PRIMARY: fill Topic / Goal / Done before opening TURN-P1 (Rule 2).
  Topic — one line: what this session is about.
  Goal  — the concrete end state.
  Done  — the objective, checkable completion condition.
This file is write-once. Do not edit it after the first turn.
-->
