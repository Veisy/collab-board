---
description: Show all collab-board sessions and verify their invariants (status + lint) — use to see what's in flight and whose turn it is
argument-hint: "[session-id]  (optional; omit for all sessions)"
allowed-tools: Bash(node:*), Read
---

Report the state of collab-board sessions in this project.

`SCRIPT` = `.claude/skills/collab-board/scripts/collab-board.mjs` (project) or
`$HOME/.claude/skills/collab-board/scripts/collab-board.mjs` (global).

- If `$ARGUMENTS` names a session id: run `node "<SCRIPT>" status --session $ARGUMENTS` and
  `node "<SCRIPT>" lint --session $ARGUMENTS`.
- Otherwise: run `node "<SCRIPT>" status --all` and `node "<SCRIPT>" lint --all`.

Then summarize for the user: per session, its `STATUS`/`PHASE`, whose turn it is
(`NEXT_ACTOR` → `NEXT_TURN_ID`), open points, the plan/impl gate states, and any lint
`WARN`/`FAIL` findings with a one-line suggested fix. Recommend `/collab-continue <id>` for the
session most worth resuming. Do not modify any files.
