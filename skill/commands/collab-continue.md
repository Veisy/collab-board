---
description: Continue (resume) an existing collab-board session — pick up the strict turn loop exactly where it left off
argument-hint: "[session-id]  (optional; omit to choose among active sessions)"
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Agent, AskUserQuestion
---

**Resume** a collab-board session. Follow the **collab-board** skill (`SKILL.md`) for the turn
mechanics; this command picks the session and re-enters the loop.

`SCRIPT` = `.claude/skills/collab-board/scripts/collab-board.mjs` (project) or
`$HOME/.claude/skills/collab-board/scripts/collab-board.mjs` (global).

Do this:

1. List sessions: `node "<SCRIPT>" status --all`. Choose the target:
   - if `$ARGUMENTS` names a session id, use it;
   - else if exactly one session is `ACTIVE`, use it;
   - else `AskUserQuestion` to pick among the listed ids (show status/phase/whose-turn).
2. Verify first: `node "<SCRIPT>" lint --session <id>`. If it `FAIL`s, resolve per the skill's
   remediation (complete a missing write, or delete an orphan shard and re-take the turn)
   **before** continuing — do not build on an inconsistent board.
3. Read `.collab-board/PROTOCOL.md` once (then rely on memory), then `sessions/<id>/HEAD.md`.
   Act on the hand at `START`:
   - if it is the **PRIMARY** (you), take the turn per the skill;
   - if it is the **SECONDARY**, delegate via its adapter: dispatch per the executor spec
     matching the session's adapter under the skill's `references/executors/` (legacy
     `codex` = `codex-cli`) — foreground with an explicit long timeout, prompt from a
     per-session+turn+attempt unique file, fresh thread default — then verify + lint by
     the board advancing (not the process narration).
4. Drive the loop until a `USER_QUESTION` needs the user, the session reaches
   `COMPLETED`/`ABORTED`, or you are blocked. Lint after every turn. A **limit-shaped**
   dispatch failure does not end the loop and does not wait for the user: schedule your own
   wake at the limit's reset time and retry when it fires (skill "Resource limits" +
   `PROTOCOL.md` §4; wait mechanism per the host file). A stale-board L9 WARN right after
   such a wait is expected — the wait note in `agents/<primary>.md` answers it.

If the chosen session is already terminal, say so and offer `/collab-new` or
`node "<SCRIPT>" reset --session <id>` instead.
