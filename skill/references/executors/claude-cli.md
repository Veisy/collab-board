# Executor: claude-cli — dispatching the local Claude CLI as SECONDARY

Implements the executor section contract (see `../adapters.md`): Probes · Dispatch ·
Validity · Execution mode · Failure path · WRITE_BLOCKED · Usage-limit signatures ·
Resume · Model/effort keys.
Flag surface verified on claude 2.1.207; on a different major, spot-check `claude --help`.

**Pairing**: requires `SECONDARY=CLAUDE` (and therefore a PRIMARY that is not CLAUDE).
This is the executor for the **inverted pairing** — e.g. Codex orchestrating with Claude
reviewing. `new`/`lint` enforce the pairing (lint `L18`).

Prerequisites: the Claude Code CLI (`npm install -g @anthropic-ai/claude-code` or the
native installer) and a login (`claude auth login` or `ANTHROPIC_API_KEY`).

## Probes (once per session, before the first dispatch)

- `claude --version` — binary present.
- `claude auth status` — returns JSON; require `"loggedIn": true`. **Auth-only — not a
  network proof**: it reads local credentials and can succeed where an actual API call is
  blocked (this divergence occurs in sandboxed hosts).
- When the host is the Codex CLI (mandatory there — see `../hosts/codex-cli.md`), and
  recommended once per new host otherwise: one short **child probe through the host's own
  shell** — `claude -p "Reply with exactly: OK" --output-format json`; VALID iff exit 0
  and `"is_error": false`. This is what proves the dispatch path end-to-end.

Any probe failing → tell the user and pause at a saveable point — an auth/install failure
needs the user: it is a hard pause, not the §4 usage-limit wait, and never grounds to
degrade to self-review.

## The dispatch

1. Immediately before writing the scoped prompt, compute `DISPATCH_UTC` as the later of
   host UTC now and `HEAD.LAST_UPDATE + 1 ms`. Inject it using the adapter skeleton. This
   gives the shell-free secondary a deterministic timestamp base; it uses ordered 1 ms
   increments, never an estimated clock. Lint L23 enforces non-decreasing, non-future log time.
2. Write the scoped prompt to a **UTF-8 (no BOM), LF-only** file in a PRIMARY-side scratch
   directory outside the session tree, unique per **session, turn, and attempt** (same
   naming rule and rationale as the codex-cli executor).
3. Run from the **project root** (the CLI has no `-C`; cwd is the workspace), foreground,
   timeout ≥ 600000 ms. This block is POSIX-shell reference syntax; non-POSIX hosts use
   their host document's equivalent redirected-process form:

   ```bash
   claude -p --safe-mode --output-format json \
     --tools "Read,Grep,Glob,Edit,Write" \
     --allowedTools "Read" "Grep" "Glob" "Edit(.collab-board/**)" "Write(.collab-board/**)" \
     < "<scratch>/prompt-<slug>-<TURN_ID>-a<attempt>.txt" \
     > "<scratch>/out-<slug>-<TURN_ID>-a<attempt>.json" \
     2> "<scratch>/err-<slug>-<TURN_ID>-a<attempt>.txt"
   ```

   - `--tools` is the available built-in surface; omitting it leaves ambient tools such as
     Bash available even when `--allowedTools` is present. `--allowedTools` controls which
     listed tools are pre-authorized and path-scopes Edit/Write. Together they make the
     whole write surface board files only. **No `Bash(...)` rule,
     ever** — a prefix rule like `Bash(rg *)` admits `rg --pre <cmd>`, which executes an
     arbitrary program that can mutate source outside Edit/Write mediation. `Grep`/`Glob`
     are ripgrep-backed built-ins and cover the search need. This gives **mechanical
     Rule 7 enforcement for tool-mediated writes**: Bash reports unavailable while board
     edits land.
   - **No bare `--permission-mode acceptEdits` fallback** — it removes the path barrier.
     A blocked legitimate board write goes through the WRITE_BLOCKED scribe path, never
     through widening write permissions.
   - `--safe-mode` — deterministic dispatch: skills/CLAUDE.md/hooks/plugins off; auth,
     built-in tools, and permission rules work normally under `-p`.
   - `--model <m>` / `--effort <low|medium|high|xhigh|max>` — **only** when `SESSION.md`
     carries `SecondaryModel:` / `SecondaryEffort:`; absent = inherit the user's config.
     Same effort guidance as the codex-cli executor (never low effort for a gate turn).
   - **Forbidden flags**: `--bare` (locks auth to `ANTHROPIC_API_KEY`; kills OAuth/
     subscription auth), `--no-session-persistence` (kills resume),
     `--dangerously-skip-permissions` (never needed under the scoped allow-list).

## Result validity

VALID only if: exit code 0 **and** the stdout capture parses as the single JSON result
object **and** `"is_error": false` **and** `"result"` is non-empty — read only after the
process exits. Anything else is INVALID → failure path. `permission_denials[]` in the
result **diagnoses, never confirms**: a denial on a `.collab-board/` path is the
mechanical WRITE_BLOCKED signal (below); unrelated denials never substitute for the
board-advance check.

## Execution mode

Same as codex-cli: foreground ≥ 600000 ms default; the host's background mechanism for
longer turns; the **board advancing is the only completion authority**.

## Failure path

Byte-identical to the codex-cli executor: board-first check → confirm the child process
is dead (no surviving `claude` child of this dispatch — double-writer guard) → classify a
limit (signatures below; retry-vs-schedule for a matched signature is decided **only** by
the shared auto-resume rules in `../adapters.md`, including ambiguous no-reset handling) →
one fresh retry with new `-a<attempt>` names → escalate
per Rule 5 / §4 (pause, don't degrade). `NOT_MY_TURN` prevention likewise: check `HEAD.md`
before dispatching.

## WRITE_BLOCKED

Two detectors, either sufficient: the returned `result` leads with `WRITE_BLOCKED:`, or
`permission_denials[]` contains an `Edit`/`Write` entry whose `file_path` is under
`.collab-board/` while the board is unchanged. Then apply the shared scribe rules in
`../adapters.md` (verbatim transcription, scribe's own timestamps,
`via=claude-cli relayed_by=<PRIMARY>`, optional scribe-first posture thereafter).

## Usage-limit signatures

Match a small **family** on the result JSON (`result` text / error message) and the stderr
file, case-insensitive — never one literal (wording shifts across CLI versions):
`usage limit` · `rate limit` / `rate_limit` · `429` · `quota` ·
`resets at` · `try again (at|in)` (subscription-limit messages embed a reset time, e.g.
"Claude AI usage limit reached|<reset>"). On a match, extract the
embedded reset timestamp/epoch when present and hand the match plus any extracted reset to
the shared auto-resume (`../adapters.md`), whose canonical rules decide retry vs schedule
(including a match with no reset language). An auth failure
(`401`, `"loggedIn": false`, invalid API key) is **not** a limit — that path pauses for
the user.

## Resume (deliberate multi-turn memory only)

Every valid result carries a `session_id` — persist it into `agents/claude.md` after each
dispatch. Resume ONLY via a stored id:

```bash
claude -p --resume <stored-session-id> --safe-mode --output-format json ... < promptfile
```

`--continue` (latest-conversation guessing) is forbidden — it is directory-scoped, not
collab-session-scoped. No stored id → fresh. Fresh is the default posture; the board
read-set is authoritative, never the executor's private memory.

`via=claude-cli` is recorded in the `log.md` `TURN_COMMIT` line.
