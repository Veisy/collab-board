# Secondary adapters

The protocol is **adapter-blind**: read-sets, write-sets, the state machine, and lint are
byte-identical no matter who the SECONDARY is. Only *how a turn is handed to the secondary
and its output obtained* varies. That variation is isolated behind one small interface.

`SESSION.md` selects the adapter via `SecondaryAdapter:` — `codex` | `subagent:<name>` |
`manual`. Default is `codex` (the `PRIMARY=CLAUDE, SECONDARY=CODEX` case).

---

## The interface

```
prepareTurn(sessionId) -> scopedPrompt
    Adapter-INDEPENDENT. The PRIMARY assembles the minimal read-set list + ordered
    write-spec from HEAD.md (+ plan/context.md and impl/code_state.md for IMPL turns).
    This is the scoped prompt skeleton below — identical for every adapter.

dispatch(scopedPrompt, {memory: fresh|resume}) -> rawOutput
    The ONLY adapter-specific step. Hand the scoped prompt to the secondary and get its
    output back. `memory: resume` means "continue the secondary's private thread across
    its turns"; `fresh` means "start a new thread" (used only on its first turn).

confirm(sessionId) -> ok|fail
    Adapter-INDEPENDENT. The PRIMARY re-reads ONLY HEAD.md (its own hand is now START,
    SEQ bumped) + the one new turns/<id>-<secondary>.md shard, then runs lint. The PRIMARY
    never trusts the secondary's narration and never re-reads full history.
```

**Contract every adapter must honor**

- The secondary reads **only** the named minimal set (the scoped prompt enumerates it).
- The secondary writes its **own** turn shard, its **own** hand line in `HEAD.md`, and the
  `points`/`log`/`agents` updates, in the order the scoped prompt specifies.
- A SECONDARY **IMPL** turn is **review-only** — it never edits project source files and
  never authors `BRANCH`/`BASE_COMMIT`/`LATEST_COMMIT` (Rule 7).
- The PRIMARY **always** runs `confirm()` + lint afterward and never launders authorship.

---

## CODEX adapter (the default — write-capable)

**Valid only when `Roles: PRIMARY=CLAUDE, SECONDARY=CODEX`.** The `codex@openai-codex` plugin
runs *inside Claude Code*, with Claude as the orchestrator delegating each secondary turn to
Codex — so this adapter cannot be used with any other pairing (use `manual` or `subagent:<name>`
there). `new`/`lint` reject a `codex` adapter on any other roles.

`dispatch()` spawns the bundled Codex rescue subagent, which owns the Codex runtime and the
`${CLAUDE_PLUGIN_ROOT}` path. **Do not** call `codex-companion.mjs` or reference
`${CLAUDE_PLUGIN_ROOT}` yourself from this skill — that env var resolves to the *wrong*
plugin here. Go through the subagent.

Spawn it with the **Agent tool**:

- `subagent_type: "codex:codex-rescue"`
- `prompt:` the routing flags, then the scoped prompt. The subagent strips the routing flags
  (`--write`, `--resume`/`--fresh`, `--model`, `--effort`) from the task text and forwards
  to `codex-companion.mjs task ...`, then returns Codex's stdout verbatim.

Routing flags to put at the very top of the prompt:

- `--write` — **always.** Gives Codex a workspace-write sandbox rooted at the project so it
  authors its own shard and flips its own hand-state in `HEAD.md` directly.
- `--wait` — **always.** Forces the run synchronous. Do **not** rely on foreground being the
  default: a collab-board turn is multi-step, and the rescue subagent may decide on its own to
  run `--background`, which returns immediately while Codex writes asynchronously — your
  `confirm()`+lint would then hit a half-written board (spurious orphan / dual-START /
  projection FAILs, or a writer race). `--wait` is a Claude-side control the subagent strips
  before calling Codex, and it disables the auto-background heuristic. (Precisely: `codex-companion`'s
  `task` subcommand has no `--wait` flag — `task` already runs in the foreground — so it is the
  **codex-rescue agent** that reads `--wait` and forces foreground instead of auto-backgrounding.)
- `--fresh` on Codex's **first** turn of the session (`agents/codex.md` `LAST_TURN_WRITTEN: -`);
  `--resume` on **every subsequent** Codex turn. `--resume` continues the latest Codex thread
  in *this repo + this Claude session* so Codex keeps its working memory across turns — but the
  scope is repo+Claude-session, **not** the collab-board session id. Two collab-board sessions
  in one repo+Claude-session, or a changed Claude session, can make `--resume` attach to the
  wrong thread or find none. That is harmless to the board (the scoped read-set + `confirm()`
  + lint bound everything; Codex's private memory is never authoritative) — on a miss, just
  fall back to `--fresh`.
- `--model` / `--effort` — only if `SESSION.md` requests them; otherwise omit.

So the flags line is e.g. `--write --wait --resume` (or `--write --wait --fresh` on the first
turn). With `--wait` present the run is synchronous — the PRIMARY blocks until Codex finishes,
so there is never a concurrent writer.

`via=codex` is recorded in the `log.md` `TURN_COMMIT` line.

**Handling a failed delegation.** The subagent returns Codex's stdout verbatim, but on several
non-exceptional paths it returns **nothing** (empty output) with the board unchanged: Codex
missing/unauthenticated, `--resume` finding no thread, or a task still running. So in
`confirm()`, before anything else: if the output is empty **or** `HEAD.md` is unchanged (your
hand is still not `START`, no new `turns/<NEXT_TURN_ID>` shard, `SEQ` not bumped), treat the
delegation as **failed** — do **not** take the turn yourself. Retry once with `--fresh` (in
case `--resume` found no thread); if it still fails, tell the user to run `/codex:setup` or
escalate. This is distinct from `NOT_MY_TURN` (Codex *did* run but read `HEAD` wrong).

---

## subagent:&lt;name&gt; adapter (other write-capable runtimes)

`dispatch()` spawns the Agent tool with `subagent_type: "<name>"` and the same scoped prompt.
The subagent must have project write access (it authors its own files). Log `via=subagent:<name>`.

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

---

## Scoped prompt skeleton (built by `prepareTurn`, used by every adapter)

Fill `<...>` from `HEAD.md`. This is what the secondary receives. For the CODEX adapter,
prefix the routing flags line.

```
--write --wait --resume   ← CODEX adapter only; use --write --wait --fresh on the secondary's first turn

You are SECONDARY=<SECONDARY> in collab-board session <id>. Project root is the cwd.
Follow .collab-board/PROTOCOL.md strictly. Be skeptical but open; favor the simplest
solution that fully works; challenge with evidence; ask what you need to understand. Find
faults before you agree; hold your position unless given a substantive technical reason; do
NOT concede merely to agree. Before you set an agreement gate, state either the substantive
challenge(s) you raised or, explicitly, what you checked and why no defensible objection
remains — mutual agreement is not verification.

READ EXACTLY THESE, NOTHING ELSE (do NOT read other turns/* or log.md):
  - .collab-board/PROTOCOL.md                         (skip if already in this thread)
  - .collab-board/sessions/<id>/HEAD.md               (confirm <SECONDARY>: START — else output NOT_MY_TURN and stop)
  - .collab-board/sessions/<id>/points.md
  - .collab-board/sessions/<id>/<RESPONDS_TO>         (the one shard you respond to; skip if NEW)
  - .collab-board/sessions/<id>/agents/<secondary_lc>.md   (your private notes)
  [IMPL only] - .collab-board/sessions/<id>/plan/context.md
  [IMPL only] - .collab-board/sessions/<id>/impl/code_state.md

Take ONE <PHASE> turn (id <NEXT_TURN_ID>) responding to <RESPONDS_TO> for points <ids>.
You are SECONDARY: do NOT edit project source files (Rule 7). An IMPL turn is review-only —
omit the "- Impl:" line and author no branch/commit; cite the reviewed commit in Evidence.

WRITE, IN THIS ORDER (HEAD.md last; the log HANDOFF line is the commit point):
  1. In <RESPONDS_TO>, change ONLY the literal "NEXT: pending" to
     "NEXT: [<NEXT_TURN_ID>](<NEXT_TURN_ID>-<secondary_lc>.md)". Touch nothing else there.
  2. CREATE turns/<NEXT_TURN_ID>-<secondary_lc>.md (turn/v1: Header, Body, Evidence,
     Handoff; then on their own lines `PREV: [<resp-id>](<resp-id>-<resp-actor-lc>.md)` — or
     `PREV: NEW` — and `NEXT: pending`). Keep it lean — signal, not transcript.
  3. UPDATE points.md for any point you resolve (Resolved In = link to your shard).
  4. APPEND log.md:
     "<ts> TURN_COMMIT <NEXT_TURN_ID> actor=<SECONDARY> responds_to=<resp-id> points=<ids> via=codex"
     (+ a POINT_SET line if you changed any point).
  5. UPDATE agents/<secondary_lc>.md: SELF_HAND=ON_HOLD, LAST_TURN_WRITTEN=<NEXT_TURN_ID>,
     and your private notes.
  6. UPDATE HEAD.md (write atomically, last): ## State <SECONDARY> WORKING->ON_HOLD and
     <PRIMARY> ON_HOLD->START; set your gate(s) in ## Gates if you agreed; ## Cursor
     TURN_CURSOR=<NEXT_TURN_ID>, RESPONDS_TO=turns/<NEXT_TURN_ID>-<secondary_lc>.md,
     NEXT_TURN_ID=<next>, NEXT_ACTOR=<PRIMARY>, SEQ+1; LAST_UPDATE=now.
  7. APPEND log.md:
     "<ts> HANDOFF <SECONDARY>:WORKING->ON_HOLD <PRIMARY>:ON_HOLD->START next=<next>/<PRIMARY> seq=<SEQ>".

Output a 3-line summary; the files are the real deliverable.
```

After the secondary returns, the PRIMARY runs `confirm()`: first the failed-delegation check
above (empty output or unchanged `HEAD.md` → retry `--fresh` once, then escalate); then re-read
`HEAD.md` + the new shard and run `node scripts/collab-board.mjs lint --session <id>`. If lint
FAILs or the secondary returned `NOT_MY_TURN`, do **not** silently repair authoritative state —
re-delegate a correction turn or escalate per the stall rules.
