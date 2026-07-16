---
name: collab-board
description: Orchestrate a strict, turn-based PLAN→IMPL collaboration between two AI models (a PRIMARY and a SECONDARY) over a split, interlinked .collab-board session tree, so each turn reads only the few files it needs instead of one giant board. Default pairing is PRIMARY=Claude + SECONDARY=Codex via the local Codex CLI, but roles work with any models. Use this whenever the user wants two AIs to co-design and co-implement something with skeptical peer review, point tracking, gated phases, and bounded per-turn context — e.g. "have Claude and Codex collaborate on X", "start a collab session", "run the collab board", "kick off a Codex/Claude plan-then-build", or when they reference COLLAB_BOARD / a collab board / a two-agent review loop.
---

# Collab-Board

Two AI models collaborate on a task in strict alternating turns: a **PRIMARY** (the model
running this skill — Claude by default) and a **SECONDARY** (Codex by default, via the
local Codex CLI). They go through a **PLAN** phase, agree, then an
**IMPLEMENTATION** phase, tracking decisions as points and gating each phase.

The board is **not one file**. Each session is a small tree of interlinked Markdown files
under `.collab-board/` in the target project, so an agent taking a turn reads only the few
files that turn needs — never the whole history. The board is many small cross-linked files —
a catalog, an append-only event log, and a protocol doc read once — instead of one monolith.

**You are the orchestrator (the PRIMARY).** You run the loop, take the PRIMARY's turns
yourself, and *delegate* each SECONDARY turn to the other model through its adapter.

## Collaboration principles (carry these into every turn)

- **Adversarial but open** — review the other skeptically (claims are unproven until their
  evidence holds), yet concede plainly when they're right. The goal is the best answer. Find
  faults before agreeing; hold your position unless given a substantive technical reason; never
  concede merely to agree. Mutual agreement is **not** verification (§0, §4).
- **Occam's razor** — simplest solution that fully works; when two are similar, simpler wins.
- **Challenge and ask** — disagree with evidence; ask the questions you need answered.
- **Escalate when jointly unsure** — if both agents are unsure after exchanging evidence, ask
  the user (`USER_QUESTION:`), don't guess. A persistent evidence-backed disagreement neither
  can resolve is itself grounds to escalate; don't let stated confidence settle it (at a hard
  deadlock the PRIMARY still decides, Rule 6).
- **Stay lean** — a board, not a history book; record only what a future turn or the audit
  needs.

## Language

Narrate to the user in **the language of their prompt** — chat output is never parsed by
`lint` nor read by the SECONDARY, so it is free to localize. Board files are different:
**never translate a machine token** (the fixed ASCII literals enumerated in `PROTOCOL.md` §9;
lint `L2`), and default turn-body prose to ASCII while the `codex-cli` adapter is active — its
write path corrupts pre-existing non-ASCII to mojibake even in a file it merely re-touches
(lint `L21`).

## The bundled script

A dependency-free Node CLI does the deterministic, error-prone work (scaffolding + verifying).
It lives next to this file at `scripts/collab-board.mjs`. Call it from the **target project
root** (so `.collab-board/` lands there). Substitute the skill's directory for `$SKILL`
(Claude Code: `.claude/skills/collab-board/` in a project or
`~/.claude/skills/collab-board/` globally; Codex: `$CODEX_HOME/skills/collab-board/`,
default `~/.codex/skills/collab-board/`):

```bash
node "$SKILL/scripts/collab-board.mjs" new   --type FEATURE --slug jwt-auth   # scaffold a session
node "$SKILL/scripts/collab-board.mjs" lint  --session <id>                   # verify invariants
node "$SKILL/scripts/collab-board.mjs" status --all                           # quick overview
node "$SKILL/scripts/collab-board.mjs" advance --session <id>                 # PLAN→IMPL gate
node "$SKILL/scripts/collab-board.mjs" activate --session <id>                # mark live in catalog (first turn)
node "$SKILL/scripts/collab-board.mjs" terminal --session <id> --status COMPLETED
node "$SKILL/scripts/collab-board.mjs" reset --session <id> [--force]         # archive + re-scaffold
```

`new` also bootstraps `.collab-board/PROTOCOL.md` and `index.md` on first use (never
overwrites them).

## Slash commands & installation

These Claude Code slash commands ship under `commands/` and are placed in a project's
`.claude/commands/` by the default installer mode:

- **`/collab-new [type] [slug]`** — scaffold a new clean session, fill the contract, open PLAN.
- **`/collab-continue [id]`** — resume a session where it left off (lints first, then re-enters
  the turn loop).
- **`/collab-status [id]`** — list sessions + lint findings; see whose turn it is.
- **`/collab-install`** — copy the skill + commands into the current project's `.claude/`.

To install, run `/collab-install` from inside a project (or
`node "$HOME/.claude/skills/collab-board/scripts/install.mjs" .`); commit the resulting
`.claude/`. Session data (`.collab-board/`) is created later by `/collab-new`, separate from the
committed tooling. For Codex user-wide discovery, run
`node "$SKILL/scripts/install.mjs" --codex-global`; it respects `CODEX_HOME` (default
`~/.codex`) and copies only the skill, not Claude commands. See the README for the full story.

## Starting a session

1. **Read `.collab-board/PROTOCOL.md` once** at the start of your involvement, then rely on
   your memory of it. It is the full rule set + file schemas + lint invariants. (If it doesn't
   exist yet, `new` creates it.)
2. **Scaffold**: `new --type <BUG_FIX|FEATURE|REFACTOR|META|INVESTIGATION> --slug <slug>`
   (add `--topic` to derive a slug; `--primary`/`--secondary`/`--adapter` to override the
   defaults). Adapter defaults are secondary-keyed: CODEX -> `codex-cli`, CLAUDE ->
   `claude-cli`, any other actor -> `manual`. This creates `.collab-board/sessions/<id>/` (id =
   `<date>-<slug>`).
3. **Fill the contract**: edit `sessions/<id>/SESSION.md` `Topic` / `Goal` / `Done` (Rule 2).
   This file is write-once.
4. **Open TURN-P1.** A fresh board is `IDLE` with *both* hands `ON_HOLD`; the PRIMARY's first turn
   self-activates from `ON_HOLD` (the one turn that doesn't enter from `START` — see the bootstrap
   note below). Take your turn (below), then hand off.

## What to read for a turn (bounded — the whole point)

Read **only** these. Never bulk-read `turns/` or `log.md`. (The `lint` command *does* read the
full `log.md`, but it runs as a subprocess — its reads never enter your context window, so they
don't count against this per-turn budget. Use `lint --quick` per turn to skip even that.)

**PLAN turn:** `PROTOCOL.md` (once, cached) · `HEAD.md` · `points.md` · the one shard at
`HEAD.RESPONDS_TO` (none if `NEW`) · `SESSION.md` (first turn only) · your `agents/<you>.md`.

**IMPL turn:** `PROTOCOL.md` (cached) · `HEAD.md` · `points.md` · `plan/context.md` (the
frozen plan — read this *instead of* any `P*` shard) · `impl/code_state.md` · the one shard at
`HEAD.RESPONDS_TO` · your `agents/<you>.md` · the project source files you actually edit.

`HEAD.md` tells you everything procedural: whether it's your turn (`## State` — act only if
your hand is `START`; the one exception is the P1 bootstrap, which self-activates from
`ON_HOLD` — see "Starting a session" step 4), what to respond to (`RESPONDS_TO`), the id to
create (`NEXT_TURN_ID`), the phase (`PHASE`), and the gates.

## How to write a turn (order matters; `HEAD.md` is written last)

The `HANDOFF` line appended to `log.md` is the **commit point** — write `HEAD.md` last so a
crash leaves a detectable orphan, not corrupted state. In order:

1. **Create** `turns/<NEXT_TURN_ID>-<you>.md` following the `turn/v1` format (Header · Body
   FINDINGS/CHALLENGE/PROPOSAL · Evidence · Handoff · PREV/NEXT). Keep it lean. A turn that
   *resolves* a point should carry real `Evidence` (`Evidence: N/A` on a resolving turn → lint
   `L19` WARN); if it resolves a point *against* a recorded objection, add a one-line
   `- DISSENT:` (§5). For an IMPL turn (PRIMARY only) add the
   `- Impl: BRANCH=… BASE_COMMIT=… LATEST_COMMIT=…` line — top-level at column 0, never
   nested inside Body (lint `L13` matches it at line start) — a SECONDARY review turn omits it.
2. In the **predecessor** shard, if its `NEXT:` is `pending`, change only that token to a link
   to your new shard — do this *after* step 1, so a mid-turn crash leaves an orphan shard (lint
   `L14`) rather than a dangling `NEXT` pointer to a missing file.
3. **Update** `points.md` for any point you open/resolve (link `Resolved In` to your shard).
4. **Append** to `log.md`: a `TURN_COMMIT` line (+ `POINT_SET` if points changed). See
   `PROTOCOL.md §8` for the exact grammar. First ensure `log.md` ends in a newline — appending
   onto a newline-less last line merges the two events and the second is silently dropped from
   every replay (now also caught by lint `L22`).
5. **Update** your `agents/<you>.md` (`SELF_HAND`, `LAST_TURN_WRITTEN`, private notes).
6. **Update** `HEAD.md` (atomically — overwrite the whole file):
   - flip `## State`: you `WORKING→ON_HOLD`, the other actor `ON_HOLD→START`;
   - set your gate in `## Gates` if you agreed — but only once your turn body states your
     challenge(s) or why no objection remains (§4);
   - update `## Cursor` (`TURN_CURSOR`, `RESPONDS_TO`, `NEXT_TURN_ID`, `NEXT_ACTOR`, `SEQ`+1);
   - refresh `PLAN_OPEN_POINTS`; set `LAST_UPDATE`.
7. **Append** the `HANDOFF` line to `log.md` (the commit point; same newline caution as step 4).
8. **Lint**: `node "$SKILL/scripts/collab-board.mjs" lint --session <id>`. Fix any `FAIL`
   before continuing.

(On the very first turn, also flip `SESSION_STATUS: IDLE → ACTIVE`, run
`node "$SKILL/scripts/collab-board.mjs" activate --session <id>` to mark the session live in the
catalog, and append a `STATE_SET` line activating yourself — all before step 6's handoff. See
`PROTOCOL.md §3`.)

## Delegating the SECONDARY's turn

When `HEAD.md` shows the SECONDARY at `START`, you do **not** take its turn — you delegate it
through the adapter named in `SESSION.md` `SecondaryAdapter:`. Before dispatching, **read
`references/adapters.md`** (the mechanism, shared scribe/auto-resume rules, and the
scoped-prompt skeleton) **and the executor file matching the adapter** — they carry the exact
probes, command, validity rule, and failure path; don't restate them from memory:

- **`codex-cli`** (default; `codex` = legacy alias): the local Codex CLI directly, no plugin —
  `references/executors/codex-cli.md`.
- **`claude-cli`** (the inverted pairing — SECONDARY=CLAUDE): the local Claude CLI headless,
  writes path-scoped to the board — `references/executors/claude-cli.md`; host preflights in
  `references/hosts/`.
- **`subagent:<name>`** / **`manual`:** another write-capable subagent type (spawn with
  `run_in_background: false`), or a printed prompt you relay and then scribe yourself. `manual`
  also covers **peer mode** — two interactive agents self-driving on one board (`adapters.md`).

Then **verify, don't trust** — the board is the proof, not the narration. The completion
signal is the **board landing**: the turn's `HANDOFF` line is present in `log.md` (the
commit point) — with your hand now `START`, `SEQ` bumped, and the new
`turns/<id>-<secondary>` shard present — never merely "`HEAD` looks advanced". For a long
background dispatch, wait under the host's dispatch watchdog (`references/hosts/`), never on
the completion notification alone. On a timeout, kill, INVALID result, or `WRITE_BLOCKED:`
verdict, follow the executor's **Failure path** and the shared rules in `adapters.md`
(board-first landed check, PID-rooted kill-confirm — missing identity means possibly alive,
never retry over it — limit classification, scribe-relay, partial-turn recovery, one fresh
retry) — never improvise a recovery.

On success, re-read only `HEAD.md` + the new shard and run `lint`. On a `FAIL` or a
`NOT_MY_TURN`, re-delegate a correction — never silently patch authoritative state.

## Phase transition, completion, and recovery

- **PLAN → IMPL:** when every `P*` point is resolved and both `PLAN_AGREE_* = YES`, **stop
  delegating** — the PRIMARY crosses the gate on its own turn (don't hand `START` to the
  secondary again). On that turn the PRIMARY writes the frozen plan digest into
  `plan/context.md` — which must **enumerate every file the IMPL phase will touch**, including
  cross-cutting consistency files (catalog/index, logs, a schema's status section), so the
  SECONDARY's review doesn't flag legitimate consistency propagation as scope creep — then
  runs `advance --session <id>`. `advance` requires the PRIMARY to hold
  `START`, enforces the preconditions, flips to `IMPL`, and keeps `START` with the PRIMARY for
  `TURN-I1` (only the PRIMARY edits project files — Rule 7).
- **Done:** when both `IMPL_AGREE_* = YES`, run `terminal --session <id> --status COMPLETED`
  (or `ABORTED`). Both hands go `DONE`; no further turns.
- **Stall** (Rule 5), **deadlock** (Rule 6, PRIMARY decides after >3 unresolved turns on a
  point), and **user escalation** (Rule 9) are defined in `PROTOCOL.md`; `lint` flags stalls
  and undecided deadlocks.
- **Resource limits — wait them out, don't stop.** A rate/usage-limited SECONDARY is
  unavailable, not wrong to consult: never substitute your own self-review for the adversarial
  gate, never author ahead of an ungated backlog — and never end the run over it. Pause at the
  saveable point (the board is crash-safe after every `HANDOFF`), **announce, don't ask**, and
  follow the canonical wait/retry procedure in `references/adapters.md` "Usage-limit
  auto-resume" + your host's wait mechanism (`references/hosts/`). A limit wait is never a
  Rule 5 stall (`PROTOCOL.md` §4). Only a limit on the **PRIMARY's own** model ends the run;
  the user resumes later with `/collab-continue`.
- **Reset** a session (e.g. to start the same slug fresh) with `reset --session <id>`; it
  archives the old tree (never deletes) and re-scaffolds. A brand-new session is just another
  `new` — prior sessions are untouched immutable trees.

## Roles & adapters are configuration

Roles and the adapter live in `SESSION.md`; the protocol, read/write-sets, and lint are identical
no matter who the secondary is — only delegation differs. Default roles are `PRIMARY=CLAUDE,
SECONDARY=CODEX`; absent an override, adapter choice is secondary-keyed (CODEX -> `codex-cli`,
CLAUDE -> `claude-cli`, otherwise `manual`). A CLI executor must match the SECONDARY actor
(`codex-cli` ⇒ `SECONDARY=CODEX`; `claude-cli` ⇒ `SECONDARY=CLAUDE`; `codex` is a legacy alias
of `codex-cli`); both `new` and `lint` enforce this (L18). The inverted pairing —
`PRIMARY=CODEX, SECONDARY=CLAUDE, adapter=claude-cli`, orchestrated from the Codex CLI — is
supported with the mandatory preflight in `references/hosts/codex-cli.md`. Any other pairing
sets `--primary/--secondary`; accept the secondary-keyed CLI default when that actor has a
supported executor, or override with `--adapter manual` (incl. peer mode) or
`subagent:<name>`.

## References (read on demand)

- `references/protocol.md` — the full protocol (also copied to `.collab-board/PROTOCOL.md`):
  principles, rules 1–10, state machine, two-phase gates, turn format, file schemas, log
  grammar, lint invariants. **Read once per session.**
- `references/adapters.md` — the SecondaryAdapter interface, the adapter→executor map, the
  shared scribe rules, the `subagent` / `manual` (+ peer mode) adapters, and the scoped-prompt
  skeleton. **Read when delegating a secondary turn.**
- `references/executors/codex-cli.md`, `references/executors/claude-cli.md` — the exact
  per-CLI dispatch specs (probes, command, validity rule, failure path, limit signatures,
  resume). **Read the one matching the session's adapter.**
- `references/hosts/claude-code.md`, `references/hosts/codex-cli.md` — orchestrator mechanics
  per host (skill loading, command timeouts, preflights; hosts are named for the orchestrating
  product, not the executor). **Read once when running in that host.**
- `references/lint-spec.md` — each lint check (through L23; L17 retired), its severity, and the rule it enforces.
