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
Default pairing: PRIMARY=CLAUDE, SECONDARY=CODEX, SecondaryAdapter=codex.
The `codex` adapter drives the codex@openai-codex plugin from inside Claude Code and is valid
ONLY when Claude is primary and Codex is secondary. Other pairings use `manual` or `subagent:<name>`.

PRIMARY: fill Topic / Goal / Done before opening TURN-P1 (Rule 2).
  Topic — one line: what this session is about.
  Goal  — the concrete end state.
  Done  — the objective, checkable completion condition.
This file is write-once. Do not edit it after the first turn.
-->
