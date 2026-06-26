# COLLAB-BOARD PROTOCOL

Strict, turn-based collaboration protocol between a **PRIMARY** and a **SECONDARY** AI
(default: `PRIMARY=CLAUDE`, `SECONDARY=CODEX`). This is the single document every
participant reads **once per session, then caches**. Everything an agent needs to take a
turn lives in a handful of tiny per-session files (below) — never read the whole history.

This file is the schema root. It is copied verbatim to `.collab-board/PROTOCOL.md` when a
session tree is scaffolded. Do not edit it inside a project; edit the skill's
`references/protocol.md` instead.

---

## 0. Collaboration principles (the spirit behind the rules)

These guide every turn; the mechanics in §1–§10 exist to serve them, not the other way
around.

- **Adversarial but open.** Each agent reviews the other skeptically — treat a claim as
  unproven until its evidence holds — yet stays genuinely open to a better idea and concedes
  plainly when the other is right. The goal is the best answer, not winning the turn. *Find
  faults before you agree; hold your position unless given a substantive technical reason;
  never concede merely to agree.* Mutual agreement is **not** verification — two models can
  share a blind spot and converge on the same wrong answer — so back a resolution with evidence
  (and, in IMPL, an executable check where one exists), not with assent.
- **Occam's razor.** Prefer the simplest solution that fully solves the problem: as simple
  as possible, as complex as necessary. When two solutions are of similar quality, the
  simpler one wins — the burden of proof is on the added complexity.
- **Challenge and ask.** Raise disagreements as `CHALLENGE`s backed by evidence, and ask the
  other agent the questions you actually need answered to understand the problem before you
  propose.
- **Escalate when jointly unsure.** If, after exchanging evidence, *both* agents are still
  unsure, escalate to the user (Rule 9, `USER_QUESTION:`) instead of guessing. Persistent,
  *evidence-backed* disagreement that neither side can resolve is itself grounds to escalate —
  don't let a confident assertion settle it, since self-reported certainty tracks neither
  correctness nor independence (it tends to *rise* under disagreement). This stays a judgment
  call, never automatic: at a hard per-point deadlock the PRIMARY still decides (Rule 6).
- **Stay lean — this is a board, not a history book.** Record only what a future turn or the
  audit genuinely needs. Turn bodies carry signal, not transcripts; the log carries events,
  not prose; points capture decisions, not chatter. Brevity is what keeps every agent's
  read-set small.

---

## 1. Why the board is split

The old monolithic board put the session contract, both agents' hand-state, every turn, the
point tracker, and the phase gates into one growing file. Every turn forced every agent to
re-read all of it → context pollution that scales with session length.

This protocol splits each session into small, single-purpose, interlinked Markdown files so
the **per-turn read-set is bounded and independent of how long the session has run.** The
board is many small cross-linked files: a catalog (`index.md`), an append-only ledger
(`log.md`), and a schema doc (this file) read once.

---

## 2. Session file tree

```
.collab-board/
├── PROTOCOL.md          # this file (read once per agent per session, then cached)
├── index.md             # cross-session catalog (read only when choosing a session)
└── sessions/<id>/       # <id> = <YYYY-MM-DD>-<slug>
    ├── HEAD.md          # HOT  — the live state singleton (see schema below)
    ├── SESSION.md       # COLD — frozen contract, write-once at open
    ├── points.md        # HOT  — the point tracker table
    ├── log.md           # APPEND-ONLY — event ledger / derivation of HEAD
    ├── plan/context.md  # frozen plan digest, written once at the PLAN→IMPL gate
    ├── impl/code_state.md   # BRANCH / BASE_COMMIT / LATEST_COMMIT singleton
    ├── agents/<actor>.md    # each actor's private scratch + non-authoritative hand mirror
    └── turns/<ID>-<actor>.md  # immutable turn shards, one per turn
```

**HOT** files are read and/or written most turns. **COLD** files are read rarely (open,
phase change, terminal). The only file an agent reads to learn *what happened last* is the
**one** turn shard named by `HEAD.RESPONDS_TO` — never the whole `turns/` directory.

---

## 3. Hand-state machine

Valid hand-states: `START` · `WORKING` · `ON_HOLD` · `DONE`.

- The authoritative hand-state for both actors lives **only** in `HEAD.md` under `## State`.
  (Rule 1 — single State section.) `agents/<actor>.md` keeps a *mirror* for the actor's own
  convenience; it is explicitly non-authoritative.
- A receiver acts **only** when `HEAD` shows its own hand at `START`.
- On entering a turn: self `START→WORKING`. On finishing: self `WORKING→ON_HOLD`,
  other `ON_HOLD→START`. Exactly one actor is at `START`/`WORKING` while the session is
  `ACTIVE`. **No parallel turns.** The `START` token is the mutex.
- **Bootstrap (the first turn only).** A freshly scaffolded session is `IDLE` with *both*
  hands `ON_HOLD` and `NEXT_ACTOR` = the PRIMARY. To open `TURN-P1` the PRIMARY self-activates:
  set `SESSION_STATUS: ACTIVE`, run `collab-board.mjs activate --session <id>` (reconciles the
  catalog row to ACTIVE so it doesn't read IDLE through the whole PLAN phase), append
  `<ts> STATE_SET <PRIMARY>=WORKING <SECONDARY>=ON_HOLD cursor=- next=P1/<PRIMARY> seq=0` to
  `log.md`, take the turn, then hand off normally. This is the one turn that enters from
  `ON_HOLD` rather than `START`.
- `HEAD.md` is always written **last** in a turn, and the `HANDOFF` line appended to
  `log.md` is the **commit point**. A turn that crashes before that is detectable as an
  orphan (lint L14) rather than silently corrupting state.

---

## 4. Two phases and their gates

`PLAN → IMPL`. Tracked by `HEAD.PHASE`.

- During `PLAN`, agents converge a plan. Each agent records its own agreement in
  `HEAD ## Gates`: `PLAN_AGREE_PRIMARY` / `PLAN_AGREE_SECONDARY` (`NO`→`YES`), logged with a
  `GATE_SET` line.
- **Agreeing is an attestation, not a reflex.** Before an agent sets *its own* gate to `YES`
  (`PLAN_AGREE_*` or `IMPL_AGREE_*`), its turn must state EITHER the substantive challenge(s) it
  raised this session OR, explicitly, what it checked and why no defensible objection remains. A
  gate flipped with no recorded scrutiny is the rubber-stamp failure this protocol exists to
  prevent. (A turn-body norm, not a lint check.)
- **Anchor IMPL agreement on external verification where one exists.** Mutual `AGREE` is not
  proof of correctness. When the project code has an executable verifier (tests, build,
  type-check, lint), an `IMPL_AGREE_*` turn should cite that result in its `Evidence`, not rest
  on both agents agreeing.
- The phase advances to `IMPL` **only** when: every `P*` point is non-`OPEN`
  (`PLAN_OPEN_POINTS: 0`), **and** both `PLAN_AGREE_* = YES`, **and** `plan/context.md`
  holds a real digest (not the `STATUS: EMPTY` placeholder). The transition is the **PRIMARY's**
  job: once both gates are `YES`, the PRIMARY does **not** delegate another turn — on its own
  turn it writes `context.md` and runs `advance` (which requires the PRIMARY to hold `START`,
  logs `PHASE_SET PLAN->IMPL`, sets `HEAD.PHASE: IMPL`, and hands `START` to the PRIMARY for
  `TURN-I1`, since only the PRIMARY implements — Rule 7). The bundled `advance` command enforces
  these preconditions.
- **The `advance` crossing is a shard-less engine transition.** It writes no `turn/v1` shard and so
  has no `Handoff` line (§5's `Handoff` requirement applies to turn shards only); the PRIMARY keeps
  `START` across it rather than handing off. The deciding `PLAN_AGREE` is normally the SECONDARY's; if
  the PRIMARY casts it, that attestation (above) belongs on the PRIMARY's own preceding agreement turn
  — it is **not** folded into `advance`.
- `IMPL` ends when both `IMPL_AGREE_* = YES` and the session is set `COMPLETED`.

---

## 5. Turn format (`collab-board/turn/v1`)

Each turn is one immutable file `turns/<ID>-<actor>.md` where `<ID>` is `P{n}` (plan) or
`I{n}` (impl) and `<actor>` is the lowercase actor name.

```
### TURN-<ID> (<ACTOR>)
SCHEMA: collab-board/turn/v1
- Header: PART=<PLAN|IMPL> · RESPONDS_TO=<turn-id|NEW> · POINTS=<ids|N/A>
- Body:
  - FINDINGS: <bullets or N/A>
  - CHALLENGE: <bullets or N/A>
  - PROPOSAL: <bullets or N/A>
- Evidence: <≥1 of file:line, test output, doc ref, or step-by-step reasoning — or N/A>
- Handoff: <ACTOR> WORKING->ON_HOLD, <OTHER> ON_HOLD->START
PREV: [<prev-id>](<prev-id>-<actor>.md) | NEW
NEXT: pending
```

Rules for shards:
- **Immutable once written**, with exactly **one** allowed later edit: the next author flips
  this shard's `NEXT: pending` to `NEXT: [<next-id>](<next-id>-<actor>.md)` to keep the
  chain doubly-linked.
- **Disputed claims need evidence** (≥1 of: `file:line`, test output, doc ref, or explicit
  step-by-step reasoning). A turn that **resolves** a point (sets it to a non-`OPEN` status)
  should carry resolvable evidence for that resolution; `Evidence: N/A` on a resolving turn
  draws lint **L19** (a WARN, not a block). Whether a claim is "disputed" is a judgment for the
  author, not the linter.
- **Preserve dissent.** When a turn resolves a point by overriding or conceding a recorded
  objection, add a one-line `- DISSENT: <the minority view + why it was overruled>` to the Body
  (optional — omit when there was no objection). Recording the losing position guards against
  silent/sycophantic consensus collapse. Keep it to one line; it lives in the resolving turn,
  never in `points.md` or the log.
- A **PRIMARY** IMPL turn adds a line `- Impl: BRANCH=<b> BASE_COMMIT=<c> LATEST_COMMIT=<c>`
  echoing `impl/code_state.md`. A **SECONDARY** IMPL turn is **review-only**: it omits the
  `- Impl:` line entirely and authors no branch/commit (Rule 7) — cite the reviewed commit in
  `Evidence` if needed.
- A SECONDARY's **first** turn must `ACK` the session contract in its `FINDINGS`.

---

## 6. Point tracker (`points.md`, `collab-board/points/v1`)

```
| ID | Part | Title | Status | Resolved In |
|----|------|-------|--------|-------------|
```

- `ID` prefixes: `P*` (plan), `I*` (impl). `Part`: `PLAN` | `IMPL`.
- `Status`: `OPEN` · `AGREED` · `REJECTED` · `DEFERRED` · `OUT_OF_SCOPE`.
- `Resolved In` links the turn shard that resolved it, e.g. `[P2](turns/P2-codex.md)`.
- `HEAD.PLAN_OPEN_POINTS` mirrors the count of `OPEN` `P*` rows (lint-reconciled).

---

## 7. The rules (faithful to the original board)

1. **Single State section.** Hand-state tokens (`- <ACTOR>: <HAND>`) appear only in
   `HEAD.md ## State`. Mirrors elsewhere use the `SELF_HAND:` key and are non-authoritative.
2. **Session contract.** PRIMARY fills `SESSION.md` (Topic/Goal/Done) before opening `P1`.
   SECONDARY `ACK`s it in its first turn body — it does **not** edit `SESSION.md`.
3. **Two phases.** `PLAN → IMPL`; IMPL starts only when no `OPEN` `P*` points and both
   `PLAN_AGREE_* = YES` (see §4).
4. **State machine.** Receiver acts only on `START`; enter self→`WORKING`; exit self→
   `ON_HOLD`, other→`START`. No parallel turns (§3).
5. **Stall recovery.** No update for `CHECK` → log `STALL_CHECK`. Still silent after
   `HANDOFF` window → force the stalled actor `ON_HOLD`, self→`START`, log `STALL_HANDOFF`.
   Timers come from `SESSION.Stall` (default `CHECK=15m, HANDOFF=10m`).
6. **Deadlock.** A point with more than 3 unresolved turns referencing it → PRIMARY decides:
   append `DECISION <id> -> ACCEPT|REJECT|DEFER` (turn body + `log.md`).
7. **Impl authority.** Only the **PRIMARY** edits project files (everything except the
   board). SECONDARY reviews. Each PRIMARY impl turn records `BRANCH`, `BASE_COMMIT`,
   `LATEST_COMMIT` in `impl/code_state.md` and echoes them in its shard. Use the literal `NONE`
   for any that has no git value (a non-git repo, or before the first commit); the `—`/`-`
   placeholder is what lint rejects.
8. **Terminal.** `COMPLETED`/`ABORTED` sets both hands `DONE`; no new turns after.
9. **User escalation.** Either actor may ask the user (project owner) when an answer cannot
   be found in the codebase, docs, or web search **and, after exchanging evidence, both agents
   remain unsure** (don't escalate unilaterally — challenge and ask each other first), **or**
   when a substantive *evidence-backed* disagreement persists that neither side can resolve. Do
   not let self-reported confidence settle such a dispute — stated certainty tracks neither
   correctness nor independence. This stays a judgment call, never automatic: at a hard
   per-point deadlock the PRIMARY still decides (Rule 6). Tag `USER_QUESTION:` in the turn body
   and log a `USER_QUESTION` line.
10. **Gates.** `PLAN_AGREE_*` / `IMPL_AGREE_*` live in `HEAD ## Gates`, each set by its own
    actor during its own turn and logged `GATE_SET`.

---

## 8. Append-only event log (`log.md`, `collab-board/log/v1`)

The log is the immutable **derivation** of live state. Lint replays it to recompute and
verify `HEAD`. Closed event vocabulary (one event per line, `<ISO_TS>` first):

```
<ts> OPEN session=<TYPE> by=<ACTOR>
<ts> STATE_SET <A>=<hand> <B>=<hand> cursor=<id|-> next=<id>/<ACTOR> seq=<n>
<ts> TURN_COMMIT <ID> actor=<ACTOR> responds_to=<id|NEW> points=<ids|-> [via=<adapter>] [branch=<b> base=<c> latest=<c>]
<ts> POINT_SET <ID>=<STATUS> [<ID>=<STATUS> ...] in=<turn-id>
<ts> GATE_SET <PLAN_AGREE_PRIMARY|PLAN_AGREE_SECONDARY|IMPL_AGREE_PRIMARY|IMPL_AGREE_SECONDARY>=YES by=<ACTOR> [justified_by=<turn>]
<ts> PHASE_SET PLAN->IMPL plan_open_points=<n>
<ts> HANDOFF <A>:<from>-><to> <B>:<from>-><to> next=<id>/<ACTOR> seq=<n>
<ts> STALL_CHECK actor=<ACTOR>
<ts> STALL_HANDOFF stalled=<ACTOR> next=<id>/<ACTOR> seq=<n>
<ts> DECISION <point-id> -> ACCEPT|REJECT|DEFER by=<ACTOR>
<ts> USER_QUESTION by=<ACTOR> in=<turn>
<ts> TERMINAL <COMPLETED|ABORTED> by=<ACTOR> seq=<n>
```

The `HANDOFF` line is the commit point of a turn. `via=<adapter>` records how a SECONDARY
turn was produced (`codex`, `subagent:<name>`, `manual`); `relayed_by=<actor>` is added when
the PRIMARY scribed a non-write-capable secondary's turn.

---

## 9. File schemas (v1)

Every schema except `turn/v1` ships a bundled template; `turn/v1` shards are authored by hand
per §5 and are never scaffolded. The authoritative field set:

- **HEAD/v1** — `SESSION_STATUS` (IDLE|ACTIVE|COMPLETED|ABORTED), `PHASE` (PLAN|IMPL),
  `## State` (`- <ACTOR>: <HAND> - <ROLE>` ×2), `## Cursor` (`TURN_CURSOR`, `RESPONDS_TO` =
  the session-relative path to the one prior shard, e.g. `turns/P2-codex.md`, or `-`;
  `NEXT_TURN_ID`, `NEXT_ACTOR`, `SEQ`), `## Gates`
  (`PLAN_AGREE_PRIMARY/SECONDARY`, `IMPL_AGREE_PRIMARY/SECONDARY`, `PLAN_OPEN_POINTS`),
  `## Stall` (`LAST_UPDATE`, `STALL_STATE`). Actor names must be a single `[A-Za-z0-9_]` token.
- **SESSION/v1** — `Type`, `Reset`, `Topic`, `Goal`, `Done`, `Stall`, `Roles`,
  `SecondaryAdapter`. Default `Roles: PRIMARY=CLAUDE, SECONDARY=CODEX` with
  `SecondaryAdapter: codex`; the `codex` adapter is valid only for that pairing (it runs the
  plugin inside Claude Code), so other pairings use `manual` or `subagent:<name>`.
- **points/v1**, **log/v1**, **context/v1**, **code_state/v1**, **agent/v1** ship templates;
  **turn/v1** is defined inline in §5. All as shown above.

---

## 10. Lint invariants

`node scripts/collab-board.mjs lint --session <id>` (read-only) recomputes every
denormalized field from its authoritative source and reports `PASS`/`WARN`/`FAIL`, exiting
non-zero on any `FAIL`. Run it after **every** turn and before any phase/terminal transition.
The check list and its mapping to these rules lives in `references/lint-spec.md`.
