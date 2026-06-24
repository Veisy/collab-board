---
description: Start a new clean collab-board session — scaffold the split board, fill the contract, and open the PLAN phase between two AIs (Claude + Codex by default)
argument-hint: "[BUG_FIX|FEATURE|REFACTOR|META|INVESTIGATION] [slug]  (e.g. FEATURE jwt-auth)"
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Agent, AskUserQuestion
---

Start a **new** collab-board collaboration session. Follow the **collab-board** skill
(`SKILL.md`) for the full turn protocol; this command is just the entry point.

`SCRIPT` = `.claude/skills/collab-board/scripts/collab-board.mjs` if it exists in this project,
otherwise `$HOME/.claude/skills/collab-board/scripts/collab-board.mjs`. Run it from the project
root so the board lands in `./.collab-board/`.

Requested session: `$ARGUMENTS` (interpreted as `<type> <slug>`; both optional).

Do this:

1. Decide `<type>` (BUG_FIX | FEATURE | REFACTOR | META | INVESTIGATION) and a short kebab
   `<slug>` from `$ARGUMENTS`. If either is missing or ambiguous, ask with `AskUserQuestion`.
   Also get the **Topic / Goal / Done** for the contract (ask if not obvious from context).
   To use a non-default pairing, pass `--primary`/`--secondary`/`--adapter` (default is
   `CLAUDE` / `CODEX` / `codex`).
2. Scaffold: `node "<SCRIPT>" new --type <type> --slug <slug>`. This creates
   `.collab-board/sessions/<id>/` and bootstraps `.collab-board/PROTOCOL.md` + `index.md` on
   first use. Note the printed `<id>`.
3. Read `.collab-board/PROTOCOL.md` once. Fill `sessions/<id>/SESSION.md` Topic/Goal/Done
   (Rule 2; the file is write-once).
4. Take **TURN-P1** as the PRIMARY per the skill (first-turn bootstrap: activate yourself,
   author the shard, update points/log/HEAD), then hand off to the SECONDARY and drive the
   turn loop. After every turn run `node "<SCRIPT>" lint --session <id>` and fix any `FAIL`.

Stop and report when the board is awaiting the user (a `USER_QUESTION`), the session reaches a
gate you want the user to confirm, or you are blocked. Otherwise continue the loop; the user
can resume any time with `/collab-continue`.
