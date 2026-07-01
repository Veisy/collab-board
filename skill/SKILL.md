---
name: collab-board
description: Orchestrate a strict, turn-based PLAN→IMPL collaboration between two AI models (a PRIMARY and a SECONDARY) over a split, interlinked .collab-board session tree, so each turn reads only the few files it needs instead of one giant board. Default pairing is PRIMARY=Claude + SECONDARY=Codex via the codex@openai-codex plugin, but roles work with any models. Use this whenever the user wants two AIs to co-design and co-implement something with skeptical peer review, point tracking, gated phases, and bounded per-turn context — e.g. "have Claude and Codex collaborate on X", "start a collab session", "run the collab board", "kick off a Codex/Claude plan-then-build", or when they reference COLLAB_BOARD / a collab board / a two-agent review loop.
---

# Collab-Board

Two AI models collaborate on a task in strict alternating turns: a **PRIMARY** (the model
running this skill — Claude by default) and a **SECONDARY** (Codex by default, via the
`codex@openai-codex` plugin). They go through a **PLAN** phase, agree, then an
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

Narrate to the user in **the language of their prompt** (a Turkish prompt → Turkish progress
notes, questions, and summaries); your chat output is never parsed by `lint` and never read by the
SECONDARY, so it is free to localize. But **never translate the machine tokens** — `HEAD.md`
keys, hand-states, `PHASE`, gate names, log event names, point `Status` values, `SCHEMA:` ids, and
actor/adapter names are fixed ASCII/English literals the parsers match by regex; a translated token
silently fails to parse and diverges under lint (`L2`). Turn-body prose may follow the working
language, but default to ASCII while the `codex` adapter is active — its write path corrupts
pre-existing non-ASCII to mojibake even in a file it merely re-touches (see lint `L21`).

## The bundled script

A dependency-free Node CLI does the deterministic, error-prone work (scaffolding + verifying).
It lives next to this file at `scripts/collab-board.mjs`. Call it from the **target project
root** (so `.collab-board/` lands there). Substitute the skill's directory for `$SKILL`
(this skill is installed at `.claude/skills/collab-board/` in the project or
`~/.claude/skills/collab-board/` globally):

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

## Slash commands & installing into a project

These ship with the skill (bundled under `commands/`) and are placed in a project's
`.claude/commands/` by the installer:

- **`/collab-new [type] [slug]`** — scaffold a new clean session, fill the contract, open PLAN.
- **`/collab-continue [id]`** — resume a session where it left off (lints first, then re-enters
  the turn loop).
- **`/collab-status [id]`** — list sessions + lint findings; see whose turn it is.
- **`/collab-install`** — copy the skill + commands into the current project's `.claude/`.

To install, run `/collab-install` from inside a project (or
`node "$HOME/.claude/skills/collab-board/scripts/install.mjs" .`); commit the resulting
`.claude/`. Session data (`.collab-board/`) is created later by `/collab-new`, separate from the
committed tooling. See the README for the full install story.

## Starting a session

1. **Read `.collab-board/PROTOCOL.md` once** at the start of your involvement, then rely on
   your memory of it. It is the full rule set + file schemas + lint invariants. (If it doesn't
   exist yet, `new` creates it.)
2. **Scaffold**: `new --type <BUG_FIX|FEATURE|REFACTOR|META|INVESTIGATION> --slug <slug>`
   (add `--topic` to derive a slug; `--primary`/`--secondary`/`--adapter` to override the
   Claude/Codex/codex default). This creates `.collab-board/sessions/<id>/` (id =
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
your hand is `START`), what to respond to (`RESPONDS_TO`), the id to create (`NEXT_TURN_ID`),
the phase (`PHASE`), and the gates.

## How to write a turn (order matters; `HEAD.md` is written last)

The `HANDOFF` line appended to `log.md` is the **commit point** — write `HEAD.md` last so a
crash leaves a detectable orphan, not corrupted state. In order:

1. **Create** `turns/<NEXT_TURN_ID>-<you>.md` following the `turn/v1` format (Header · Body
   FINDINGS/CHALLENGE/PROPOSAL · Evidence · Handoff · PREV/NEXT). Keep it lean. A turn that
   *resolves* a point should carry real `Evidence` (`Evidence: N/A` on a resolving turn → lint
   `L19` WARN); if it resolves a point *against* a recorded objection, add a one-line
   `- DISSENT:` (§5). For an IMPL turn (PRIMARY only) add the
   `- Impl: BRANCH=… BASE_COMMIT=… LATEST_COMMIT=…` line — a SECONDARY review turn omits it.
2. In the **predecessor** shard, if its `NEXT:` is `pending`, change only that token to a link
   to your new shard — do this *after* step 1, so a mid-turn crash leaves an orphan shard (lint
   `L14`) rather than a dangling `NEXT` pointer to a missing file.
3. **Update** `points.md` for any point you open/resolve (link `Resolved In` to your shard).
4. **Append** to `log.md`: a `TURN_COMMIT` line (+ `POINT_SET` if points changed). See
   `PROTOCOL.md §8` for the exact grammar. First ensure `log.md` ends in a newline — appending
   onto a newline-less last line merges the two events and the second is silently dropped from
   every replay (now also caught by lint `L22`).
5. **Update** your `agents/<you>.md` (`SELF_HAND`, `LAST_TURN_WRITTEN`, private notes).
6. **Update** `HEAD.md` (atomically — overwrite the whole file): flip `## State` (you
   `WORKING→ON_HOLD`, other `ON_HOLD→START`); set your gate in `## Gates` if you agreed —
   but only once your turn body states your challenge(s) or why no objection remains (§4);
   update `## Cursor` (`TURN_CURSOR`, `RESPONDS_TO`, `NEXT_TURN_ID`, `NEXT_ACTOR`, `SEQ`+1);
   refresh `PLAN_OPEN_POINTS`; set `LAST_UPDATE`.
7. **Append** the `HANDOFF` line to `log.md` (the commit point; same newline caution as step 4).
8. **Lint**: `node "$SKILL/scripts/collab-board.mjs" lint --session <id>`. Fix any `FAIL`
   before continuing.

(On the very first turn, also flip `SESSION_STATUS: IDLE → ACTIVE`, run
`node "$SKILL/scripts/collab-board.mjs" activate --session <id>` to mark the session live in the
catalog, and append a `STATE_SET` line activating yourself — all before step 6's handoff. See
`PROTOCOL.md §3`.)

## Delegating the SECONDARY's turn

When `HEAD.md` shows the SECONDARY at `START`, you do **not** take its turn — you delegate it
through the adapter named in `SESSION.md` `SecondaryAdapter:`. **Read `references/adapters.md`**
for the full mechanism, the routing-flag rationale, and the scoped-prompt skeleton; the essentials:

- **`codex` (default):** spawn the **Agent tool** with `subagent_type: "codex:codex-rescue"`. Lead
  the prompt with the routing flags — `--write --wait`, plus `--fresh` (the default for a bounded
  turn) — then the scoped prompt that names the exact minimal read-set and ordered writes. Use
  `--resume` only when you deliberately want Codex to carry its private thread across turns; that
  thread is repo+Claude-session-scoped (not per-collab-session), so it can bind to a stale one —
  the board read-set is authoritative, so `--fresh` is the safe default. Never call
  `codex-companion.mjs` or reference `${CLAUDE_PLUGIN_ROOT}` yourself; the subagent owns that.
- **`subagent:<name>`** / **`manual`:** another write-capable subagent type, or a printed prompt
  you relay and then scribe yourself (stamp `relayed by` for audit).

Then **verify, don't trust** — the board is the proof, not the narration. `--wait` *requests* a
synchronous run but is not a hard guarantee (the subagent can still background), so the completion
signal is the **board advancing**: your hand is now `START`, `SEQ` is bumped, and the new
`turns/<id>-<secondary>` shard exists. If the subagent returned nothing **or** `HEAD.md` is
unchanged, poll the board briefly; if it stays unchanged, the delegation failed — retry once with
`--fresh`, then escalate (`/codex:setup` for an auth failure). Otherwise re-read only `HEAD.md` +
the new shard and run `lint`; on a `FAIL` or a `NOT_MY_TURN`, re-delegate a correction — never
silently patch authoritative state. (The `--wait`/board-polling rationale, the `--resume` scoping
caveat, scribe-relay, and the failed-delegation paths are detailed in `adapters.md`.)

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
- **Resource limits.** If the SECONDARY becomes unavailable mid-session (a rate/usage limit — its
  delegation fails in a limit-shaped way), do **not** lower the bar to cope: never substitute your
  own self-review for the adversarial gate, never author ahead of an ungated backlog. Pause at a
  **saveable point** — the board is crash-safe after every `HANDOFF`, so between two confirmed
  turns nothing is lost — tell the user, and resume later with `/collab-continue`. collab-board
  cannot read a model's usage %; it reacts to observable signals only (see `PROTOCOL.md` §4).
- **Reset** a session (e.g. to start the same slug fresh) with `reset --session <id>`; it
  archives the old tree (never deletes) and re-scaffolds. A brand-new session is just another
  `new` — prior sessions are untouched immutable trees.

## Roles & adapters are configuration

Roles and the adapter live in `SESSION.md`; the protocol, read/write-sets, and lint are identical
no matter who the secondary is — only delegation differs. The **default is `PRIMARY=CLAUDE,
SECONDARY=CODEX, adapter=codex`**, and that `codex` adapter is valid **only** for that pairing (the
plugin runs inside Claude Code). Any other pairing sets `--primary/--secondary` and uses `--adapter
manual` or `subagent:<name>`; both `new` and `lint` enforce this.

## References (read on demand)

- `references/protocol.md` — the full protocol (also copied to `.collab-board/PROTOCOL.md`):
  principles, rules 1–10, state machine, two-phase gates, turn format, file schemas, log
  grammar, lint invariants. **Read once per session.**
- `references/adapters.md` — the SecondaryAdapter interface and the `codex` / `subagent` /
  `manual` implementations, with the exact `codex:codex-rescue` spawn recipe and scoped-prompt
  skeleton. **Read when delegating a secondary turn.**
- `references/lint-spec.md` — each lint check (L1–L22; L17 retired), its severity, and the rule it enforces.
