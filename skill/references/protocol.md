# COLLAB-BOARD PROTOCOL

Strict PRIMARY/SECONDARY collaboration in alternating PLAN→IMPL turns. Read once per
persistent thread; a fresh SECONDARY reads it every turn. New/reset sessions pin an immutable copy
at `sessions/<id>/PROTOCOL.md` and are governed by it; legacy sessions may declare the shared root
copy. Resolve `HEAD.PROTOCOL` relative to the session directory.

Contents: §0 principles · §1 bounded board · §2 files · §3 hand-state · §4 phases/gates ·
§5 turns · §6 points · §7 rules 1–11 · §8 event log · §9 schemas · §10 lint.

## 0. Collaboration principles

**The board is instrumentation for agents.** It carries the state and evidence the next turn acts
on; being tidy, ordered or well-written is not one of its properties. A shard is read whole by the
next turn and by a fresh SECONDARY with no memory of writing it, so its length is a tax every later
turn pays.

Challenge claims with evidence, ask for whatever you need to judge them, and concede when evidence
holds, never merely to agree. **Mutual agreement is not verification.** Prefer the simplest complete
solution. Never translate machine tokens.

**A turn exists to change the answer.** Progress is settlement — a resolved point, a gate, a
decision — never turns taken. Open a point only for what changes an outcome; refuse a gate only for
a defect that breaks a stated Done condition; let anything smaller ride on the next turn you were
already taking. A correction earns no turn of its own.

**Only state is authoritative** — HEAD, the log, point rows and gates. Shard prose and agent notes
serve the next reader: repair them in passing, never by spending a turn on them. The session's own
progress is recorded in the log, which cannot go stale; prose that restates it will.

## 1. Bounded board

Per-turn context stays independent of session length: read HEAD, points, the one shard named by
`HEAD.RESPONDS_TO`, your agent file, and phase-specific cold files — never the turn directory or the
log. A file another hand may have changed is HOT and is read every turn; a frozen or self-authored
one is COLD and a persistent thread reads it once, again only once its context has been renewed. A
fresh dispatch is never persistent and reads the whole set. Lint replays full history in a
subprocess, outside model context.

## 2. Session files

```text
.collab-board/
├── index.md                    # catalog
└── sessions/<id>/
    ├── PROTOCOL.md             # immutable current snapshot for new/reset sessions
    ├── HEAD.md                 # authoritative live state and protocol path
    ├── SESSION.md              # frozen contract
    ├── points.md               # point rendering
    ├── points-archive.md       # rows `archive` moved out once settled; outside the turn read-set
    ├── log.md                  # append-only state derivation
    ├── plan/context.md         # frozen gate plan
    ├── impl/code_state.md      # branch/base/latest
    ├── agents/<actor>.md       # private mirror/recovery state
    ├── captures/<ID>-<who>.relay # sole-writer audit payloads
    └── turns/<ID>-<actor>.md   # immutable turn shards
```

A root `PROTOCOL.md` may exist for legacy sessions; new scaffolds neither create nor overwrite it.

## 3. Hand-state machine

Hands: `START`, `WORKING`, `ON_HOLD`, `DONE`. HEAD `## State` is authoritative; agent/v2 SELF_HAND
mirrors it. Act only at START, the mutex: enter START→WORKING, finish WORKING→ON_HOLD and other
ON_HOLD→START, exactly one active hand. A dispatched actor without START writes nothing and returns
`NOT_MY_TURN`.

Fresh boards are IDLE with both ON_HOLD. PRIMARY bootstraps P1: set ACTIVE, run `activate`, append
`STATE_SET <PRIMARY>=WORKING <SECONDARY>=ON_HOLD cursor=- next=P1/<PRIMARY> seq=0`, then take P1.

Write HEAD after content but before the final log event. `HANDOFF` commits a non-terminal turn;
`TERMINAL` commits a final PRIMARY turn.

## 4. Phases and gates

PLAN→IMPL. Each actor sets only its own PLAN/IMPL gate and logs GATE_SET. A gate turn states its
challenge, or what it checked and why no defensible objection remains. §8 admits no `=NO` form and
the log is append-only, so a gate cannot be withdrawn: gate only once nothing you attest can still
change, which puts the actor that may still have to amend the artifact — normally PRIMARY — last.

- Applicable executable verification requires command and outcome; an unrun/failing check is
  disclosure, not support. `verified=self|reported` (§8) records who ran it.

Advance only with zero OPEN P points, both PLAN gates YES, and non-empty `plan/context.md`. PRIMARY
writes the complete file-scope digest and runs `advance`; this shard-less transition keeps START
with PRIMARY for I1. If PRIMARY casts the deciding PLAN gate, its attestation belongs on the
preceding agreement turn, never folded into `advance`. IMPL ends only with both IMPL gates YES and
terminal COMPLETED.

A known SECONDARY usage limit is not a stall and never lowers the bar: pause at a confirmed HANDOFF,
persist recovery state, announce the resume, and follow `recovery.md` plus the host wait mechanism.
A PRIMARY limit leaves the board safe for later resume.

## 5. Turn format (`collab-board/turn/v1`)

```text
### TURN-<ID> (<ACTOR>)
SCHEMA: collab-board/turn/v1
- Header: PART=<PLAN|IMPL> · RESPONDS_TO=<turn-id|NEW> · POINTS=<ids|N/A>
- Body:
  - FINDINGS: <bullets or N/A>
  - CHALLENGE: <bullets or N/A>
  - PROPOSAL: <bullets or N/A>
- Evidence: <file:line, command outcome, doc, reasoning, or N/A>
- Handoff: <ACTOR> WORKING->ON_HOLD, <OTHER> ON_HOLD->START
PREV: [<prev-id>](<prev-id>-<actor>.md) | NEW
NEXT: pending
```

Create a shard before changing its predecessor's NEXT; thereafter only that NEXT token may change.
Resolving turns cite evidence (L19 warns on N/A) and may preserve an overruled view in one DISSENT
line. PRIMARY IMPL adds top-level `- Impl: BRANCH=<b> BASE_COMMIT=<c> LATEST_COMMIT=<c>`; SECONDARY
IMPL is review-only and omits it.

SECONDARY first turn ACKs SESSION and works independent-first: form a candidate from Topic/Goal/Done
plus scoped task sources before points/predecessor, then record `- INDEPENDENT:`. **Diagnostic, not
proof**: convergence can still reflect a shared blind spot.

A SECONDARY requests a step-back with `- REFRAME_REQUEST:`. A PRIMARY step-back shard uses
`- REFRAME: <outcome> — <one-line result of the barren window>`, compares at least two approaches,
and logs REFRAME. PRIMARY may instead answer the request with one line explaining why the loop is
converging. The response independently challenges what would converge.

## 6. Point tracker (`collab-board/points/v1`)

```text
| ID | Part | Title | Status | Resolved In |
|----|------|-------|--------|-------------|
```

IDs use P/PLAN or I/IMPL. Status is `OPEN`, `AGREED`, `REJECTED`, or `OUT_OF_SCOPE`. There is no
DEFERRED: work resolves here, is deemed unnecessary, or is opened on a successor board. Resolved In
links its turn as a markdown link whose destination is that turn's own shard — `[P2](turns/P2-codex.md)`,
the form L2 parses — and is `-` while OPEN. HEAD.PLAN_OPEN_POINTS equals OPEN P rows. `archive`
moves settled rows to `points-archive.md`; an id has a row in exactly one of the two files, an OPEN
row never leaves `points.md`, and a decision weighs the two together (L4).

## 7. Rules

1. **Single State.** Hand rows exist only in HEAD `## State` (§3); agent/v2 mirrors them in
   SELF_HAND, agent/v3 has no mirror.
2. **Session contract.** PRIMARY fills Topic/Goal/Done before P1; SECONDARY ACKs and never edits it.
3. **Two phases.** §4.
4. **State machine.** §3.
5. **Stall recovery.** After SESSION CHECK silence log STALL_CHECK; after the HANDOFF window force
   the stalled actor ON_HOLD, self START, and log STALL_HANDOFF. Never for a known limit.
6. **Deadlock.** More than three unresolved turns on one point forces PRIMARY `DECISION <id> ->
   ACCEPT|REJECT`; no defer verb exists.
7. **Impl authority.** Only PRIMARY edits project files, and records branch/base/latest each PRIMARY
   IMPL turn, literal NONE where git state does not exist. A SECONDARY never edits project files.
   PRIMARY may delegate execution to ONE sequential worker inside its own IMPL turn, attesting the
   diff before HANDOFF; the worker holds no seat and `workers.md` owns the procedure. This clause
   binds only boards whose pinned snapshot carries it; an older board is governed by the snapshot it
   pinned, in which the worker tier does not exist.
8. **Terminal.** COMPLETED/ABORTED sets both DONE, with no later activity; COMPLETED requires IMPL,
   both IMPL gates, and no OPEN points. SECONDARY never terminalizes; it requests terminal status
   in its turn body and PRIMARY decides.
9. **User escalation.** Use `USER_QUESTION:` plus event only after both agents exchange evidence and
   remain unsure, or cannot resolve persistent evidence-backed disagreement. Rule 6 still forces
   PRIMARY at a hard per-point deadlock.
10. **Gates.** §4.
11. **Convergence.** `Converge: BARREN=<n>, CHURN=<n>` defaults to 8/2. If a phase produces no
    settlement for BARREN turns, or one point is resolved/reopened CHURN times, PRIMARY must step
    back: re-read SESSION, compare at least two approaches including "cannot reach Goal", choose
    CONTINUE, REFRAME, NARROW, ESCALATE or ABORT, and log REFRAME with trigger
    BARREN/CHURN/REPEAT/MANUAL. A second barren step-back must ESCALATE or ABORT. Either agent/user
    may trigger MANUAL early; SECONDARY uses REFRAME_REQUEST. CONTINUE names the specific loop-
    breaking next step and why; REFRAME carries abandoned evidence forward as points; NARROW marks
    a genuine cut OUT_OF_SCOPE or opens it on a successor board. L26 blocks transitions until handled.

## 8. Append-only event log (`collab-board/log/v1`)

Closed grammar, one real RFC3339 timestamped event per line. Payload fields are grammar, not
decoration: a malformed line is refused, never partially applied. Malformed, unknown-type and
commented-out events FAIL L22 — a well-formed event inside a comment is still not an event.

```text
<ts> OPEN session=<TYPE> by=<ACTOR> [agent_schema=<v1|v2|v3>] [ruleset=<id>]
<ts> STATE_SET <A>=<hand> <B>=<hand> cursor=<id|-> next=<id>/<ACTOR> seq=<n>
<ts> TURN_COMMIT <ID> actor=<ACTOR> responds_to=<id|NEW> points=<ids|-> [via=<adapter>] [relayed_by=<ACTOR> attempt=<n> fused=yes contributors=<n> adjudicated=<id>:<who> renumbered=<id>:<who>-><newid> merged=<id>:<who> gate_partial=<GATE>:<k>/<n> gate_set=<GATE>:<k>/<n> gate_family=<GATE>:<k>/<n> absent=<who> capture_sha=<hex> ...] [branch=<b> base=<c> latest=<c>]
<ts> POINT_SET <ID>=<STATUS> [<ID>=<STATUS> ...] in=<turn-id>
<ts> GATE_SET <PLAN_AGREE_PRIMARY|PLAN_AGREE_SECONDARY|IMPL_AGREE_PRIMARY|IMPL_AGREE_SECONDARY>=YES by=<ACTOR> [justified_by=<turn-id>] [verified=self|reported]
<ts> PHASE_SET PLAN->IMPL plan_open_points=0
<ts> HANDOFF <A>:<from>-><to> <B>:<from>-><to> next=<id>/<ACTOR> seq=<n>
<ts> STALL_CHECK actor=<ACTOR>
<ts> STALL_HANDOFF stalled=<ACTOR> next=<id>/<ACTOR> seq=<n>
<ts> DECISION <point-id> -> ACCEPT|REJECT by=<ACTOR>
<ts> USER_QUESTION by=<ACTOR> in=<turn-id>
<ts> REFRAME by=<PRIMARY> in=<turn-id> trigger=<BARREN|CHURN|REPEAT|MANUAL> outcome=<CONTINUE|REFRAME|NARROW|ESCALATE|ABORT>
<ts> SCHEMA_SET agent/<from>->agent/<to> by=<PRIMARY>   # declared edges only: v1->v2, v2->v3
<ts> TERMINAL <COMPLETED|ABORTED> by=<ACTOR> seq=<n>
```

POINT_SET ids are distinct and a non-OPEN status needs `in=` naming an existing turn. REFRAME and
SCHEMA_SET are PRIMARY-authored; ESCALATE requires USER_QUESTION. OPEN provenance selects the agent
schema; absent provenance is legacy v1.

`verified=` is optional: `self` means the gating actor ran the check it cites, `reported` that it
relied on another actor's result, absent that no executable check applied — never "unverified". It
requires `justified_by` and real Evidence in that shard (L20).

`OPEN ruleset=<id>` records the rules in force at creation. A check a board can clear by a
protocol-legal append gates every board; a DEAD-END check, one whose finding names immutable
history, gates only boards declaring the ruleset that introduced it and merely reports on a board
declaring none. Malformed or twice-declared provenance FAILs and is never read as absence. There is
no migration edge.

`via=` records the executor/manual/subagent/relay path and may be omitted in peer mode; a direct
executor commit uses that executor's adapter id and a relayed one uses `via=relay`. `relayed_by=`
records PRIMARY transcription, and PRIMARY_ONLY turns add attempt, capture and panel tokens — see
`relay.md`.

Timestamps are real and non-decreasing. A shell-free SECONDARY uses PRIMARY-supplied
`DISPATCH_UTC=max(host UTC, HEAD.LAST_UPDATE+1ms)` plus ordered milliseconds. L23 rejects invalid,
decreasing, or >60-second future time; equality remains valid for legacy second precision.

## 9. File schemas

Every field a check parses by SHAPE states that shape here. A format that lives only in a dispatch
prompt or a template is a format the author is sent nowhere to find.

- **HEAD/v1:** `PROTOCOL`; SESSION_STATUS; PHASE; two State rows; Cursor TURN_CURSOR/RESPONDS_TO/
  NEXT_TURN_ID/NEXT_ACTOR/SEQ; four agreement gates; PLAN_OPEN_POINTS; Stall LAST_UPDATE/STALL_STATE.
  `RESPONDS_TO` is the session-relative path to the one prior shard — `turns/P2-codex.md` — or `-`
  when there is none; L14 enforces that path form, and the scaffolded `-` is not a model for it.
  Actor names match `[A-Za-z0-9_]+`. PROTOCOL resolves relative to the session and stays inside
  `.collab-board` (L28).
- **SESSION/v1:** Catalog, Protocol, Type, Reset, Topic, Goal, Done, Stall, optional Converge,
  Roles, SecondaryAdapter. Protocol equals HEAD.PROTOCOL. Adapter values are `codex-cli`,
  `claude-cli`, `copilot-cli`, `agy-cli`, `omp-cli`, `reasonix-cli`, `subagent:<name>`, `manual`, or
  legacy `codex`. Defaults: CLAUDE/CODEX/codex-cli. Secondary-keyed families are CODEX, CLAUDE,
  COPILOT, ANTIGRAVITY, OMP, REASONIX exact or `_` suffix (L18). Actors differ; models may match.
  SecondaryModel/SecondaryEffort pin the secondary's model and effort; each adapter maps them and
  states what absence inherits, which is not always a CLI. Optional
  `BoardWriteMode: PRIMARY_ONLY`; optional two-or-more distinct `SecondaryPanel` requires it.
- **points/v1**, **log/v1**, **context/v1**, **code_state/v1**, and **agent/v3** ship templates;
  turn/v1 is §5.
- **agent/v3** has exactly ACTIVE_RECOVERY, EXECUTOR_THREAD, UNRESOLVED_CONCERNS before
  PRIVATE_NOTES; every key has NONE. Recovery/thread carry structured state; concerns are
  `<point>@<pointer>` only. Discretionary notes have L24 byte limits. **agent/v2** additionally
  carries SELF_HAND and LAST_TURN_WRITTEN, which v3 drops. Applicability comes from
  OPEN/SCHEMA_SET provenance ONLY — never from a file's shape or the tool version. `migrate --to agent/v2` and `migrate --to agent/v3` are explicit and atomic, and only a declared edge
  migrates. Legacy v1 remains readable.
- Machine keys/enums are fixed ASCII. Human prose may localize; adapters that re-encode text use
  ASCII prose (L21 detects BOM/mojibake symptoms).

## 10. Lint invariants

In `references/lint-spec.md`, which owns them.
