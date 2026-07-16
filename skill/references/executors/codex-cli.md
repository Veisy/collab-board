# Executor: codex-cli — dispatching the local Codex CLI as SECONDARY

Implements the executor section contract (see `../adapters.md`): Probes · Dispatch ·
Validity · Execution mode · Failure path · WRITE_BLOCKED · Usage-limit signatures ·
Resume · Model/effort keys.

**Pairing**: requires `SECONDARY=CODEX` (and therefore a PRIMARY that is not CODEX — actor
distinctness is enforced at scaffold). The orchestrator — whatever host it runs in —
dispatches each secondary turn to the **local Codex CLI** directly. `new`/`lint` enforce
the pairing (lint `L18`). `SecondaryAdapter: codex` is the accepted **legacy alias** for
`codex-cli` on existing boards.

There is **no plugin dependency**: `dispatch()` is one `codex exec` process, run by the
PRIMARY from its shell. Prerequisites are only the Codex CLI itself
(`npm install -g @openai/codex`) and a login (`codex login`).

## Probes (once per session, before the first dispatch)

- `codex --version` — binary present; note the version (flag surface below is verified on
  codex-cli 0.144.1; on a different major, spot-check `codex exec --help` for the used flags).
- `codex login status` — authenticated.

Either failing → tell the user (`npm install -g @openai/codex` / `codex login`) and pause at
a saveable point — an auth/install failure needs the user: it is a hard pause, not the §4
usage-limit wait, and never grounds to degrade to self-review.

## The dispatch

1. Write the scoped prompt to a **UTF-8 (no BOM), LF-only** file in a PRIMARY-side scratch
   directory **outside** the session tree, unique per **session, turn, and attempt**:
   `<scratch>/prompt-<slug>-<TURN_ID>-a<attempt>.txt` — a scratch directory outlives
   sessions and turn ids repeat across them, so a name without the session slug collides
   with an earlier session's file. Feeding the prompt as a file via stdin (not
   a heredoc, not an argv string) avoids Windows CRLF/encoding and shell-quoting hazards.
2. Run (foreground, timeout ≥ 600000 ms — see Execution below and the host file):

   ```bash
   codex exec -C "<abs-project-root>" -s workspace-write \
     -o "<scratch>/last-<slug>-<TURN_ID>-a<attempt>.txt" \
     - < "<scratch>/prompt-<slug>-<TURN_ID>-a<attempt>.txt" \
     > "<scratch>/stdout-<slug>-<TURN_ID>-a<attempt>.txt" \
     2> "<scratch>/stderr-<slug>-<TURN_ID>-a<attempt>.txt" &
   echo $! > "<scratch>/pid-<slug>-<TURN_ID>-a<attempt>.txt"
   wait $!
   ```

   The `& … wait $!` pair keeps foreground semantics while capturing the **spawn PID** to a
   per-attempt pidfile — the identity the failure path's kill-confirm is rooted at. A host
   whose shell exposes the child PID another way (e.g. PowerShell `Start-Process -PassThru`,
   see `../hosts/codex-cli.md`) persists that identity instead; a dispatch with no captured
   identity leaves kill-confirm UNKNOWN (below).

   - `--skip-git-repo-check` — add **only** when the target project is not a git repository.
   - `--json` — add when you intend to allow a later `resume` of this thread: capture the
     `thread_id` from the first `{"type":"thread.started",...}` JSONL event and store it in
     `agents/codex.md`. Without `--json`, the turn is fresh-only (which is the default
     posture anyway).
   - `-m <model>` / `-c model_reasoning_effort=<effort>` — **only** when `SESSION.md` carries
     the optional keys `SecondaryModel:` / `SecondaryEffort:`; absent keys mean *inherit the
     user's Codex config* (deliberate — never silently change a user's effort default;
     benchmark first). Effort guidance when a session does pin it: `xhigh` for first-pass /
     complex adversarial reviews, `high` for substantive judgments and gate rechecks,
     `medium` only for deterministic schema/link/format checks, never `low` for any turn
     that feeds an agreement gate.
   - The prompt file contains the **pure scoped prompt** (skeleton in `../adapters.md`).
     There is no routing-flags line — write access is `-s workspace-write`, fresh is the
     default, and resume is a different command form.

## Result validity

The dispatch result is VALID only if the exit code is 0 **and** the
`-o` last-message file exists and is non-empty — read it only after the process exits.
Anything else (nonzero exit, missing/empty file, timeout, kill) is INVALID: discard any
partial text and enter the failure path. The rendered transcript on stdout is for humans —
redirect stdout/stderr to per-attempt files as shown above, because a transcript of tens
of kilobytes is normal and must not flood the orchestrator's context; the machine result
is (exit code, `-o` file).

## Execution mode

Foreground with a ≥ 600000 ms timeout is the **default** — typical turns run 3–6 minutes and
a synchronous run means `confirm()` never races a half-written board. For a turn you expect
to exceed the host's foreground window, use the host's background mechanism (see
`../hosts/`) and wait for completion **under the host's dispatch watchdog** — never on the
completion notification alone. Either way the **authoritative completion signal is the
board landing** (the turn's `HANDOFF` line present in `log.md` — with your hand `START`,
`SEQ` bumped, the new shard present), never process narration.

## Failure path (timeout, kill, or INVALID result)

1. **Check the board first.** The landed criterion is the turn's `HANDOFF` line present in
   `log.md` (the commit point) — never merely "`HEAD.md` looks advanced". Landed → proceed
   to `confirm()` + lint regardless of how the process ended.
2. Otherwise **confirm process death** before anything else: a process-**tree** check rooted
   at the captured spawn PID (the per-attempt pidfile) — the root has exited **and** no
   descendant survives (parent-PID walk: `pgrep -P` / `Get-CimInstance Win32_Process`; a
   survivor could still write the board while a retry runs — the double-writer race).
   **Never** match globally by process name (another `codex` — the user's own TUI, another
   session — false-positives both ways). **Missing identity = UNKNOWN, not dead**: treat the
   dispatch as possibly alive — keep waiting under the watchdog or escalate; never retry
   over an UNKNOWN.
3. **Classify a limit before retrying** (signatures below). Retry-vs-schedule for a matched
   signature is decided **only** by the shared usage-limit auto-resume rules in
   `../adapters.md` (including ambiguous no-reset handling) — never retry straight into a
   classified hard limit.
4. **Reconcile partial writes** per the shared partial-turn recovery (`../adapters.md`):
   rollback below the attempt's `TURN_COMMIT`, roll-forward above it. Only then retry
   **once**, fresh, with new `-a<attempt>` file names. If that also fails, escalate
   per the stall rules (`PROTOCOL.md` Rule 5 / §4 resource-exhaustion: pause, don't degrade).
5. `NOT_MY_TURN` is not a failure of this path: the PRIMARY prevents it by checking `HEAD.md`
   *before* dispatching (never burn a dispatch to learn whose turn it is), and if the
   secondary still reports it, re-read `HEAD.md` and re-delegate a correction.

## WRITE_BLOCKED (sandbox denied the board write, but the verdict is sound)

Codex's sandbox can deny a board write non-deterministically even in a session where prior
turns wrote fine (on some Windows machines it denies **every** turn). Detection: the
returned `-o` message leads with `WRITE_BLOCKED:` while `HEAD`/log/shards are unchanged.
When the payload shows a **complete, concrete** verdict, do **not** just retry — that
discards sound review work. Apply the shared scribe rules in `../adapters.md`
(verbatim transcription, scribe's own timestamps, `via=codex-cli relayed_by=<PRIMARY>`, and
the optional scribe-first posture for later turns of the same session).

## Usage-limit signatures

Match a small **family** on the stderr file and the `-o` message, case-insensitive — never
one literal (wording shifts across CLI versions): `usage limit` · `rate limit` /
`rate_limit` · `429` · `quota` · `too many requests` · `try again (at|in)` (e.g. "You've
hit your usage limit. Try again at <time>."). On a match, extract the reset time when the
message names one — an explicit timestamp, or a relative "try again in Xh Ym" added to the
host's UTC now — and hand the match plus any extracted reset to the shared auto-resume
(`../adapters.md`), whose canonical rules decide retry vs schedule (including a match with
no reset language). An auth failure (`codex login status` failing, `401`,
"not logged in") is **not** a limit — that path pauses for the user.

## Resume (deliberate multi-turn memory only)

Fresh is the default for every bounded collab-board turn — the scoped read-set + `confirm()`
+ lint make the board fully self-describing, so Codex's private thread memory is never
authoritative. Reach for resume only for a deliberately multi-turn exchange, and only when
the ancestor run used `--json` and its `thread_id` is stored in `agents/codex.md`:

```bash
codex exec resume <thread-id> -c 'sandbox_mode="workspace-write"' \
  -o "<scratch>/last-<slug>-<TURN_ID>-a<attempt>.txt" - < "<scratch>/prompt-...txt"
```

`resume` has **no `-C`/`-s` flags** — invoke it from the project root and pin the sandbox
via the `-c sandbox_mode=...` config override; if the installed version rejects that
override, downgrade to fresh. No stored thread id → fresh. Never resume by guesswork
(`--last` is repo-scoped, not collab-session-scoped, and can bind to a stale thread).

`via=codex-cli` is recorded in the `log.md` `TURN_COMMIT` line (stored legacy `via=codex`
lines on existing boards remain valid — the log grammar treats the adapter token as free
text).
