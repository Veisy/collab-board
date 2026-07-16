# Secondary adapters

The protocol is **adapter-blind**: read-sets, write-sets, the state machine, and lint are
byte-identical no matter who the SECONDARY is. Only *how a turn is handed to the secondary
and its output obtained* varies. That variation is isolated behind one small interface, and
the per-CLI mechanics live in one **executor file** per assistant.

`SESSION.md` selects the adapter via `SecondaryAdapter:`:

| Adapter | Spec | Pairing rule (lint `L18`) |
|---|---|---|
| `codex-cli` (default for the CLAUDE/CODEX pairing) | `executors/codex-cli.md` | `SECONDARY=CODEX` |
| `claude-cli` (the inverted pairing) | `executors/claude-cli.md` | `SECONDARY=CLAUDE` |
| `codex` | legacy alias of `codex-cli` (existing boards; no migration needed) | `SECONDARY=CODEX` |
| `subagent:<name>` | below | any pairing |
| `manual` (incl. peer mode) | below | any pairing |

A CLI executor always drives the **secondary**, so it must name a model different from the
PRIMARY (actor distinctness is enforced at scaffold). The **host** the orchestrator runs in
is not board state and not linted — see `hosts/` for per-host mechanics (command timeouts,
skill loading, preflights).

**Naming convention:** executors are named for the CLI they dispatch (`codex-cli`,
`claude-cli` — the `codex`/`claude` binaries); hosts are named for the **product** the
orchestrator runs in (`claude-code` = Claude Code, `codex-cli` = the Codex CLI). The string
`codex-cli` therefore names both a host and an executor — distinct things: one is where the
PRIMARY runs, the other is what dispatches the SECONDARY. The Claude pair splits into
`claude-code` (host) and `claude-cli` (executor) only because Anthropic's product and its
binary have different names.

---

## The interface

```
prepareTurn(sessionId) -> scopedPrompt
    Adapter-INDEPENDENT. The PRIMARY assembles the minimal read-set list + ordered
    write-spec from HEAD.md (+ plan/context.md and impl/code_state.md for IMPL turns),
    and supplies DISPATCH_UTC = max(host UTC now, HEAD.LAST_UPDATE + 1 ms). This is the
    scoped prompt skeleton below — identical for every adapter.

dispatch(scopedPrompt, {memory: fresh|resume}) -> rawOutput
    The ONLY adapter-specific step. Hand the scoped prompt to the secondary and get its
    output back. `memory: resume` means "continue the secondary's private thread across
    its turns"; `fresh` means "start a new thread" (used on its first turn, and the
    default for every turn after). For a CLI executor this is one process run — the
    executor file specifies the exact command, validity rule, and failure path.

confirm(sessionId) -> ok|fail
    Adapter-INDEPENDENT. The PRIMARY re-reads ONLY HEAD.md (its own hand is now START,
    SEQ bumped) + the one new turns/<id>-<secondary>.md shard, then runs lint. The PRIMARY
    never trusts the secondary's narration and never re-reads full history.
```

**Contract every adapter must honor**

- The secondary reads **only** the named minimal set (the scoped prompt enumerates it).
- Keep that read-set **tight** (≈5 files: the board files + at most one or two artifacts). A
  file-heavy turn is the dominant stall cause; for a broad consistency review prefer a single
  `rg`/command check over reading each file, search a small **family** of equivalent terms (not
  one literal string), and on Windows use `rg` (Git-for-Windows `grep` can throw a
  `CreateFileMapping` error).
- The secondary writes its **own** turn shard, its **own** hand line in `HEAD.md`, and the
  `points`/`log`/`agents` updates, in the order the scoped prompt specifies.
- A SECONDARY **IMPL** turn is **review-only** — it never edits project source files and
  never authors `BRANCH`/`BASE_COMMIT`/`LATEST_COMMIT` (Rule 7).
- The PRIMARY **always** runs `confirm()` + lint afterward and never launders authorship.

**Executor section contract** — every `executors/*.md` file specifies, in order: Probes ·
Dispatch (command + per-session/turn/attempt unique files + stdout/stderr redirection) ·
Validity rule · Execution mode · Failure path (board-first, confirmed process death,
limit classification, one fresh retry) · WRITE_BLOCKED detection · Usage-limit signatures
(feeding the shared auto-resume below) · Resume (stored-id only, fresh default) ·
Model/effort keys (`SecondaryModel:`/`SecondaryEffort:`, absent = inherit). Adding a future
assistant = adding one executor file + one `L18` mapping row; nothing else changes.

---

## Scribe rules (shared — any write-capable secondary whose write was blocked)

A write-capable secondary's environment can deny a board write even when its verdict is
sound. When the returned message shows a **complete, concrete** verdict (turn dispositions +
evidence) but `HEAD`/log/shards are unchanged, do **not** just retry — that discards sound
review work. The PRIMARY creates `turns/<id>-<secondary>.md` from the returned verdict
**verbatim** (never inventing content), performs the `points`/`log`/`HEAD` writes on the
secondary's behalf, and logs `via=<adapter> relayed_by=<PRIMARY>` so the relay is auditable
(§8; `relayed_by=` is exempt from the L20 gate-authorship check). Ask for this in the scoped
prompt (the skeleton's WRITE_BLOCKED instruction). Only scribe a verdict concrete enough to
transcribe faithfully — if it is vague, re-delegate.

- **Timestamps are the scribe's** — stamp the real relay-time UTC on every line you append,
  never the timestamps the secondary proposed in its payload (its clock ran earlier; log
  timestamps must stay monotonic with the actual writes).
- **Mutations, not just prose** — the verdict must carry the exact points/HEAD/log
  mutations alongside the turn content, so the relay is transcription, not reconstruction.
- **Scribe-first posture (optional, per session):** after the first `WRITE_BLOCKED` of a
  session, later scoped prompts may instruct the secondary to skip the board-write attempts
  and output the scribe-ready verdict directly — on a machine where the sandbox denies
  every board write, having it attempt seven doomed writes per turn is pure waste. Write
  authority, `confirm()`, and lint are unchanged (the PRIMARY still performs and verifies
  every write). Return to write-attempts on the next session — the denial is environmental,
  not permanent.

---

## Usage-limit auto-resume (shared — any CLI executor)

This section is the **canonical** wake/retry/backoff procedure (`PROTOCOL.md` §4 carries the
principle: never degrade, never stop, a limit wait is not a stall). A **limit-shaped** INVALID
result (each executor lists its signatures) is a scheduling problem, not a retriable failure
and not a stall: do **not** burn the failure path's single fresh retry into a hard limit, and
never `STALL_HANDOFF` over a known wait. Classify FIRST, then: pause at the saveable point,
note the wait in the PRIMARY's `agents/` file (signature, expected reset, attempt count),
announce to the user (never block on them), schedule a wake at the
stated reset time + ~2 min (no stated reset → 15 min backoff, doubling per attempt, 60-min
cap) through the host's wait mechanism (`hosts/`), then re-dispatch **once** — the dispatch
itself is the probe; never burn extra calls polling a limit. A match carrying **no reset language** is ambiguous — give it the
failure path's single fresh retry first and classify it as a limit only when the same
signature repeats. Three consecutive capped-backoff wakes returning the same no-reset
signature are a **hard block** (an exhausted quota never self-resets): stop scheduling and
escalate to the user. A failing *probe* (`codex login status`, `claude auth status`,
missing binary) stays a hard pause instead: an auth or install failure needs the user; a
limit does not.

---

## subagent:&lt;name&gt; adapter (other write-capable runtimes)

Available only in hosts that have the Agent tool (see `hosts/`). `dispatch()` spawns the
Agent tool with `subagent_type: "<name>"` and the same scoped prompt (use
`run_in_background: false` — block on the turn; strict alternation means the PRIMARY has
no legal board work while the SECONDARY holds `START`). The subagent must have project write
access (it authors its own files). Log `via=subagent:<name>`.

---

## MANUAL adapter (non-write-capable secondary, or human relay)

The fallback for any secondary that cannot write to disk (e.g. a model in a separate chat, or
a human standing in). `dispatch()` = the PRIMARY prints the scoped prompt block and asks the
user to relay it to the secondary and paste the secondary's turn back.

Because an arbitrary secondary may lack disk access, MANUAL permits **write-back / scribe**
mode: the secondary returns only the turn **text**, and the PRIMARY performs the
create/update/append side-effects on its behalf — still honoring impl-authority (a MANUAL
secondary IMPL turn is review-only). Stamp the shard header
`ACTOR=<secondary> (relayed by <PRIMARY>)` and log `via=manual relayed_by=<PRIMARY>` so the
relay is auditable. "Resume" is emulated by the user keeping the same external chat thread.

### Peer mode (two terminals, one board)

MANUAL also covers the fully **self-driving** secondary: the user opens the second model in
its own terminal/program, points it at the same `.collab-board/` session, and each agent
runs the protocol natively — reading `PROTOCOL.md` once, acting **only** when `HEAD.md`
shows its own hand at `START`, and writing its own turns. No dispatch, no relay, no prompt
printing: the `START` token is the mutex and the stall timers (Rule 5) are the pacing. A
self-authored turn omits `via=` entirely (it is optional in the log grammar) — authorship
is already carried by the shard name, `TURN_COMMIT actor=`, and the hand chain. This is the
recommended way to pair two interactive assistants without any automation.

---

## Scoped prompt skeleton (built by `prepareTurn`, used by every adapter)

Fill `<...>` from `HEAD.md`; `<adapter>` is the session's `SecondaryAdapter` value. This is
what the secondary receives — the pure scoped prompt; for a CLI executor it goes into the
prompt file verbatim (no flags line of any kind).

```
You are SECONDARY=<SECONDARY> in collab-board session <id>. Project root is the cwd.
Follow .collab-board/PROTOCOL.md strictly. Be skeptical but open; favor the simplest
solution that fully works; challenge with evidence; ask what you need to understand. Find
faults before you agree; hold your position unless given a substantive technical reason; do
NOT concede merely to agree. Before you set an agreement gate, state either the substantive
challenge(s) you raised or, explicitly, what you checked and why no defensible objection
remains - mutual agreement is not verification.

DISPATCH_UTC=<ISO timestamp supplied by PRIMARY>. Use this base plus ordered 1 ms
increments for every log event and HEAD.LAST_UPDATE you write in this turn. Never estimate
wall-clock time. Lint L23 rejects decreasing or far-future event time.

READ EXACTLY THESE, NOTHING ELSE (do NOT read other turns/* or log.md):
  - .collab-board/PROTOCOL.md                         (skip if already in this thread)
  - .collab-board/sessions/<id>/HEAD.md               (confirm <SECONDARY>: START — else output NOT_MY_TURN and stop)
  - .collab-board/sessions/<id>/points.md
  - .collab-board/sessions/<id>/<RESPONDS_TO>         (the one shard you respond to; skip if NEW)
  - .collab-board/sessions/<id>/agents/<secondary_lc>.md   (your private notes)
  [first secondary turn] - .collab-board/sessions/<id>/SESSION.md   (the contract — read it to ACK, see below)
  [IMPL only] - .collab-board/sessions/<id>/plan/context.md
  [IMPL only] - .collab-board/sessions/<id>/impl/code_state.md

Take ONE <PHASE> turn (id <NEXT_TURN_ID>) responding to <RESPONDS_TO> for points <ids>.
You are SECONDARY: do NOT edit project source files (Rule 7). An IMPL turn is review-only —
omit the "- Impl:" line and author no branch/commit; cite the reviewed commit in Evidence.
If this is your FIRST turn of the session, ACK the contract (Topic/Goal/Done from SESSION.md) in
your turn body (Rule 2).
Do NOT run `lint` yourself — the PRIMARY verifies after your turn (the script path differs from the
project cwd anyway). For a broad consistency check, prefer one `rg`/command over reading many files,
and on Windows use `rg` (Git-for-Windows `grep` can error).
If your sandbox denies a board file write, do NOT fail silently: output "WRITE_BLOCKED:" plus a
complete scribe-ready verdict — your full turn content AND the exact points/HEAD/log mutations,
concrete enough to transcribe verbatim — the PRIMARY will relay it (§8).

WRITE, IN THIS ORDER (HEAD.md written before the log HANDOFF line, which is the commit point):
  1. CREATE turns/<NEXT_TURN_ID>-<secondary_lc>.md (turn/v1: Header, Body, Evidence,
     Handoff; then on their own lines `PREV: [<resp-id>](<resp-id>-<resp-actor-lc>.md)` — or
     `PREV: NEW` — and `NEXT: pending`). Keep it lean — signal, not transcript.
  2. In <RESPONDS_TO>, change ONLY the literal "NEXT: pending" to
     "NEXT: [<NEXT_TURN_ID>](<NEXT_TURN_ID>-<secondary_lc>.md)" — after step 1, so a crash leaves an
     orphan shard (lint L14) not a dangling NEXT to a missing file. Touch nothing else there.
  3. UPDATE points.md for any point you resolve (Resolved In = link to your shard).
  4. APPEND log.md (first ensure the file ends in a newline — else your line merges onto the last
     one and is silently dropped from every replay; lint L22):
     "<DISPATCH_UTC + next ms> TURN_COMMIT <NEXT_TURN_ID> actor=<SECONDARY> responds_to=<resp-id> points=<ids> via=<adapter>"
     (+ a POINT_SET line if you changed any point).
  5. UPDATE agents/<secondary_lc>.md: SELF_HAND=ON_HOLD, LAST_TURN_WRITTEN=<NEXT_TURN_ID>,
     and your private notes.
  6. UPDATE HEAD.md (write atomically): ## State <SECONDARY> WORKING->ON_HOLD and
     <PRIMARY> ON_HOLD->START; set your gate(s) in ## Gates if you agreed; ## Cursor
     TURN_CURSOR=<NEXT_TURN_ID>, RESPONDS_TO=turns/<NEXT_TURN_ID>-<secondary_lc>.md,
     NEXT_TURN_ID=<next>, NEXT_ACTOR=<PRIMARY>, SEQ+1; LAST_UPDATE=the next ordered timestamp.
  7. APPEND log.md (same newline caution as step 4):
     "<DISPATCH_UTC + next ms> HANDOFF <SECONDARY>:WORKING->ON_HOLD <PRIMARY>:ON_HOLD->START next=<next>/<PRIMARY> seq=<SEQ>".

Output a 3-line summary; the files are the real deliverable.
```

After the secondary returns, the PRIMARY runs `confirm()`: first the executor's failure
checks (INVALID result or unchanged `HEAD.md` → board-first check, confirmed process
death, limit classification, retry once, then escalate); then re-read `HEAD.md` + the new
shard and run
`node "$SKILL/scripts/collab-board.mjs" lint --session <id>`. If lint FAILs or the secondary
returned `NOT_MY_TURN`, do **not** silently repair authoritative state — re-delegate a
correction turn or escalate per the stall rules.
