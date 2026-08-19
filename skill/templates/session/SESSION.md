# SESSION — {{ID}}
SCHEMA: collab-board/SESSION/v1
Catalog: ../../index.md
Protocol: PROTOCOL.md

Type: {{TYPE}}
Reset: {{RESET}}
Topic: —
Goal: —
Done: —
Stall: CHECK=15m, HANDOFF=10m
Converge: BARREN=8, CHURN=2
Roles: PRIMARY={{PRIMARY}}, SECONDARY={{SECONDARY}}
SecondaryAdapter: {{ADAPTER}}

<!--
Key grammar, adapter registry, actor families, and the optional SecondaryModel/SecondaryEffort,
BoardWriteMode and SecondaryPanel keys: PROTOCOL.md section 9. Converge semantics: Rule 11.
Dispatch specs are in the skill's references/executors/, host preflights in references/hosts/.

Two ACTORS must be distinct; two MODELS need not be. Running one model in both seats is the
ordinary rule, not a mode — and it is the weakest adversarial gate available, because a fresh
context removes anchoring but not a blind spot the model holds by construction. Prefer a second
vendor whenever you have one.

PRIMARY: fill Topic / Goal / Done before opening TURN-P1 (Rule 2).
  Topic — one line: what this session is about.
  Goal  — the concrete end state.
  Done  — the objective, checkable completion condition.
This file is write-once. Do not edit it after the first turn.
-->
