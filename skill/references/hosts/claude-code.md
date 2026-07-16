# Host: claude-code — orchestrating from Claude Code

How the PRIMARY runs the collab-board loop when it is Claude inside Claude Code. The
protocol, board files, and lint are host-independent; only the mechanics below vary.

## Skill loading

Native: this skill loads from `.claude/skills/collab-board/` (project) or
`~/.claude/skills/collab-board/` (global); the `/collab-*` slash commands ship with it.

## Running commands (script + dispatch)

- The Bash tool runs `node .../collab-board.mjs` subcommands and executor dispatches
  directly. Foreground default timeout is 120 s — **always pass an explicit
  `timeout: 600000`** (the tool maximum) on a dispatch, since secondary turns typically
  run 3–6 minutes.
- For a turn expected to exceed 10 minutes, run the same dispatch with Bash
  `run_in_background: true` — but **never wait on the completion notification alone**: a
  hung child or a lost notification would otherwise stall the loop with nothing scheduled
  to wake you. Pair every background dispatch with the **dispatch watchdog** (the note is
  written in two stages — the spawn PID does not exist until spawn):
  1. **Before** dispatching, persist a dispatch note in `agents/<primary>.md`
     `PRIVATE_NOTES` (turn id, attempt, start UTC, expected duration) — the §4 wait note's
     sibling; it is what `/collab-continue` recovers from if the session dies mid-wait.
  2. Dispatch with the executor's PID-capture form (`<dispatch> & echo $! > <pidfile>;
     wait $!` — in background mode the whole compound runs inside the backgrounded Bash
     call, so `$!` is captured the instant the child spawns), then **immediately update the
     note** with the root PID by atomic whole-file replacement. A capture that failed
     leaves the identity UNKNOWN in the note — kill-confirm then treats the dispatch as
     possibly alive (executor rule), never as dead.
  3. Alongside the dispatch, start a background `sleep` sized to the session's `CHECK`
     window (chain bounded sleeps if capped).
  4. On **whichever wakes first** (notification or watchdog): check the board first (the
     turn's `HANDOFF` line = landed), then the dispatch's process tree via the noted
     PID. Tree alive → reschedule the watchdog and keep waiting. Tree dead + board not
     landed → the executor's failure path. Clear the note once the turn is confirmed.
  The watchdog is a bounded fallback **within the same host channel** (a background sleep's
  wake is itself a notification), not an independent one — the persisted note plus
  `/collab-continue` remains the crash backstop. Strict alternation means blocking
  foreground loses nothing — the PRIMARY has no legal board work while the SECONDARY holds
  `START`; prefer foreground whenever the turn fits the window.

## Waiting out a usage limit (the host wait mechanism)

When a dispatch classifies as limit-shaped (executor signatures + the shared auto-resume in
`adapters.md`), the wait mechanism here is a **background sleep**: compute the seconds until
the reset time + ~2 min buffer and run `sleep <n>` with Bash `run_in_background: true` — a
background command survives across turns and re-invokes the orchestrator when it exits
(a foreground `sleep` is blocked in this host). If the host caps a single background run
below the needed wait, chain bounded sleeps, recomputing the remaining seconds at each
wake. The §4 wait note is written before the wait begins; during the wait itself, touch
nothing further on the board (strict alternation — the SECONDARY still holds `START`) and
spend no calls polling the limit; on the wake notification, retry the dispatch once per the
shared rule. The sleep is process-local: if the host session dies, the wake is lost — the
persisted wait note in `agents/<primary>.md` plus `/collab-continue` recover the session;
no OS scheduler is involved.

## Scratch files

Use the session-provided scratchpad directory (outside the project and the session tree)
for prompt/output/stdout/stderr files, named unique per session+turn+attempt per the
executor spec.

## Available adapters

All of them: `codex-cli` (default pairing), the `claude-cli` executor is N/A here (PRIMARY
is CLAUDE, and an executor must differ from the PRIMARY), `subagent:<name>` (the Agent tool
exists here — spawn with `run_in_background: false`), `manual` (incl. peer mode).

## Host quirks

- The file-edit tools require reading a file before overwriting it; engine commands
  (`advance`, `terminal`) rewrite `HEAD.md` on disk, so re-read `HEAD.md` before the next
  Write to it.
- Windows: prefer `rg` over Git-for-Windows `grep` (CreateFileMapping errors); write board
  files as clean UTF-8 without BOM.
