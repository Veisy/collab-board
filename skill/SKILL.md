---
name: collab-board
description: Orchestrate strict, turn-based PLAN→IMPL collaboration between a PRIMARY and one or more SECONDARY AI reviewers over a bounded .collab-board session tree. Use for multi-agent co-design/implementation, skeptical peer review, point tracking, phase gates, or whenever the user references COLLAB_BOARD, a collab board, or a two-agent review loop. Default roles are Claude PRIMARY and Codex SECONDARY, and registered CLI harnesses and models are configurable.
---

# Collab-board

Act as PRIMARY/orchestrator. Alternate one PRIMARY and one SECONDARY seat through PLAN, then IMPL.
Track disagreements as points; require both gates.

Core posture: protocol §0 and Rules 9/11 govern. Narrate in the user's language.

## CLI

Run from the target project root. `$SKILL` is this skill directory.

```text
node "$SKILL/scripts/collab-board.mjs" new --type FEATURE --slug jwt-auth
node "$SKILL/scripts/collab-board.mjs" lint --session <id>
node "$SKILL/scripts/collab-board.mjs" explain L26
node "$SKILL/scripts/collab-board.mjs" status --all
node "$SKILL/scripts/collab-board.mjs" activate --session <id>
node "$SKILL/scripts/collab-board.mjs" advance --session <id>
node "$SKILL/scripts/collab-board.mjs" terminal --session <id> --status COMPLETED
node "$SKILL/scripts/collab-board.mjs" points --session <id>
node "$SKILL/scripts/collab-board.mjs" doctor
node "$SKILL/scripts/collab-board.mjs" --help   # the situational commands are documented here
node "$SKILL/scripts/test.mjs"
```

`new` bootstraps the root catalog and writes an immutable `PROTOCOL.md` inside the new session.
Legacy sessions may still declare `../../PROTOCOL.md`; follow the path in HEAD, never a hardcoded
location. The script preserves an existing compatibility root but creates none for new boards.
Reset archives the old tree, never deletes it.

Claude slash commands ship under `commands/`. Install project-local tooling with `/collab-install`
or `scripts/install.mjs .`; globally for Codex with `scripts/install.mjs --codex-global`.

## Start or resume

1. For a new board run `new --type <BUG_FIX|FEATURE|REFACTOR|META|INVESTIGATION> --slug <slug>`. Override `--primary`, `--secondary`, or `--adapter` only when needed.
2. Read `SESSION.md` before other state on the first turn; fill Topic/Goal/Done; it is write-once.
3. Read HEAD; resolve `HEAD.PROTOCOL` relative to the session directory and read it once per persistent thread. A fresh-dispatched SECONDARY pays this cost each turn.
4. A new session is IDLE with both hands ON_HOLD. PRIMARY alone bootstraps P1: set ACTIVE, run `activate`, append STATE_SET, then take and hand off the turn.
5. On resume, lint first. Act only when HEAD gives your actor START (except P1 bootstrap).

## Bounded turn read-set

Never bulk-read `turns/` or `log.md`. Lint may read them in a subprocess; its contents do not enter the model context.

PLAN: HEAD; the protocol; SESSION on first turn; points; the single `RESPONDS_TO` shard; your agent file.

IMPL: HEAD; the protocol; points; frozen `plan/context.md`; `impl/code_state.md`; the single predecessor shard — at I1 `plan/context.md` stands in its place, because the phase boundary is where the frozen plan replaces the PLAN chain and the last PLAN shard is a gate attestation IMPL does not act on; your agent file; only project sources required for the assigned work.

Cadence (§1). HOT — HEAD, points, the predecessor shard: another hand may have changed them, so read them every turn. COLD — the protocol, SESSION, `plan/context.md`, `impl/code_state.md`, your agent file: frozen, or written by you, so a persistent thread reads each once and again only once its context has been renewed. A fresh dispatch holds no context and reads the whole set every turn.

HEAD is procedural truth: hands, phase, cursor, next actor/id, gates, open-plan count, protocol path. The log is authoritative derivation but is not a turn read.

## Author a direct-write turn

For a non-terminal turn, `HANDOFF` is the commit point. Write HEAD before HANDOFF so a crash leaves a recoverable prefix. In order:

1. Create `turns/<NEXT_TURN_ID>-<actor>.md` in turn/v1 format: Header; FINDINGS/CHALLENGE/PROPOSAL; Evidence; Handoff; PREV; `NEXT: pending`. Keep it lean (§0). Cite real evidence when resolving a point; preserve overridden dissent in one `- DISSENT:` line. PRIMARY IMPL adds top-level `- Impl: BRANCH=… BASE_COMMIT=… LATEST_COMMIT=…`; SECONDARY never does.
2. After the shard exists, replace only the predecessor's `NEXT: pending` with the new link.
3. Update points rows and Resolved In links; a point is for what changes an outcome (§0).
4. Ensure log ends in newline; append TURN_COMMIT, then POINT_SET/GATE_SET events as needed.
5. Update your agent mirror and recovery/thread keys.
6. Atomically rewrite HEAD: hands, gates, cursor, SEQ, open count, LAST_UPDATE.
7. Append HANDOFF. A final PRIMARY turn uses TERMINAL as its commit point instead.
8. Run lint and fix every FAIL before proceeding.

Produce in one turn whatever one review can cover. Splitting a deliverable across turns buys an extra review round at the price of a full read-set for both seats and a fresh dispatch for the SECONDARY; §0 counts settlement, not turns. This bounds the work a turn takes on, never the length of its shard, which §0 taxes separately.

A gate turn states the challenge raised or what was checked and why no objection remains. IMPL agreement cites an applicable command plus outcome, or states none applies. A gate cannot be withdrawn, so PRIMARY gates last (§4).

## Delegate SECONDARY

When SECONDARY has START, do not take its turn. Which files a dispatch reads, and how often, is the References map below. The adapter registry — ids, actor families, aliases, model/effort defaults — is owned by PROTOCOL §9 and `references/adapters.md`'s table.

Confirm after every dispatch: shard exists, log contains TURN_COMMIT and later HANDOFF, HEAD gives PRIMARY START with bumped SEQ, then lint. Never trust process narration. If lint FAILs, `recovery.md`'s "Lint correction" routes it by what it names; only an all-L10 FAIL remains landed for PRIMARY's forced decision.
`NOT_MY_TURN` also re-delegates after re-reading HEAD; never alter state to fit the dispatch.

## Phase and terminal transitions

PLAN→IMPL requires no OPEN P point, both PLAN gates YES, and a frozen `plan/context.md` that lists every implementation file. PRIMARY keeps START, writes the digest, and runs `advance`; do not delegate an extra turn after both gates agree. Only PRIMARY edits project files.

When both IMPL gates are YES, run `terminal --status COMPLETED` (or ABORTED). Both hands become DONE.

For L26/non-convergence, stop incremental turns and run Rule 11's step-back.

A known SECONDARY limit is scheduling, not a lower review bar; protocol §4 governs the pause and resume.

## References

Each file, and when to read it:

- `references/protocol.md`: session protocol source; rules, schemas, log grammar, state machine — cadence in Start or resume step 3.
- `references/adapters.md`: common dispatch interface and direct-write prompt — needed at every delegated turn, but cold like the protocol: a skill file cannot change mid-session, so read it once per orchestrator thread and again once your context has been renewed. Compose each dispatch from the file, never from memory of it.
- `references/executors/<adapter-id>.md`: probes/argv/result/vendor facts for a CLI adapter id — the one file that id names, once per orchestrator thread and again on resume or an adapter change. A `subagent:`/`manual` id has none; it reads `references/non-cli-adapters.md`.
- `references/hosts/claude-code.md`, `references/hosts/codex-cli.md`: PRIMARY runtime mechanics — the current host, once per orchestrator thread.
- `references/non-cli-adapters.md`: `subagent:<name>`, `manual`, peer mode — a CLI thread never reads it.
- `references/relay.md`: scribe, sole-writer relay, fusion, panels, cross-product — only for PRIMARY_ONLY, a panel, or scribe fallback.
- `references/recovery.md`: failure classification, partial recovery, resume, limits — only after an invalid, timed-out, killed, limited, lint-failed, partial, or deliberately resumed dispatch.
- `references/manager.md`: optional PRIMARY fan-out and durable panel preference — only when fanning out or persisting a panel choice.
- `references/workers.md`: delegating one well-defined job outside the board, verified by diff — only for a Rule 7 worker dispatch.
- `references/lint-spec.md`: lint checks through L30 (L17 retired); resolve a finding via `explain <code>`.
