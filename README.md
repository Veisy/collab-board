# collab-board

Two AI models, one task, strict alternating turns. **collab-board** has a **PRIMARY** model and a
**SECONDARY** model plan a task together, agree, then build it together — each skeptically reviewing
the other — so you get a result neither reaches alone. The default pair is **Claude + Codex** (Codex
runs from inside Claude via the `codex@openai-codex` plugin), but the same board coordinates any two
models. It's plain Node + Markdown and installs into a project with one command.

The task can be anything with reviewable decisions or output — a feature, a bug fix, a refactor, an
investigation, a design — not just coding.

The board is **not one growing file.** Each session is a small tree of interlinked Markdown files, so
a model taking a turn reads only the few it needs and its context stays small no matter how long the
collaboration runs.

```text
/collab-new REFACTOR readme   # scaffold a session, fill the contract, open the PLAN phase
/collab-status                # list sessions, whose turn it is, and check results
/collab-continue [id]         # resume a session exactly where it left off
/collab-install               # copy the tooling into the current project's .claude/
```

## Why two models

A single model has blind spots and can state a wrong answer with total confidence. collab-board turns
that into a safeguard, two ways:

- **Two *different* models cross-check each other.** Each has to back its claims with evidence and
  survive the other's skeptical review, so blind spots and confidently-wrong answers get caught far
  more often than either model manages alone.
- **Every decision is approved before the next one builds on it.** Work moves in strict turns through
  gated **PLAN** and **IMPLEMENTATION** phases, and a phase can't advance until *both* models have
  signed off and every open question is resolved. That keeps a wrong call from quietly becoming the
  foundation later work piles onto — small mistakes get caught while they're still small, instead of
  compounding and spiraling as the task grows.

This *reduces* error; it doesn't eliminate it — two models can still share a blind spot. So
collab-board anchors agreement on evidence, and in the build phase on an executable check where one
exists, rather than on the two models simply agreeing.

## How it runs

Both models need a way to pass turns. There are two modes — **same board, same protocol, same checks;
only the hand-off differs:**

- **Connected (default, fully automated).** With **Claude + Codex**, Claude is the orchestrator and
  drives Codex through the `codex@openai-codex` plugin, all inside Claude Code. You give one prompt to
  start; Claude takes its own turns and delegates Codex's automatically, pausing only at a phase gate
  or a question — no copy-pasting. One-time setup: add the `codex@openai-codex` plugin and run
  `/codex:setup` to authenticate the Codex CLI (Claude can walk you through it).

- **Human-relayed — the shared board *is* the connection.** Any other pair (Claude + Gemini, two
  ChatGPT windows, a local model…) needs no plugin, because the board is just files under
  `.collab-board/` and every turn is gated and checked, so an offline or async collaboration stays
  consistent.
    - **Shared workspace (recommended):** point both models at the same folder or a shared **git**
      repo. Each runs `/collab-continue` and acts only when the live-state file shows its hand at
      `START` — reading its small read-set, taking its turn, and handing off. You just nudge whoever
      holds the turn ("your turn"); each model edits the board itself.
    - **Pure relay:** if the second model can't reach the filesystem (a browser-only chat), the
      orchestrator prints a self-contained prompt each turn; you paste it across and paste the reply
      back, and the orchestrator records the writes. (A write-capable subagent can stay fully
      automated instead.)

## Install

The only dependency is **Node.js 18+**, on Windows, macOS, or Linux.

```bash
git clone https://github.com/Veisy/collab-board

node collab-board/install.mjs /path/to/your-project   # install into one project (then commit its .claude/)
node collab-board/install.mjs --global                # …or globally, for every project
```

`install.mjs` copies the skill and the `/collab-*` commands into the target's `.claude/` (the Claude
Code layout) — no build step, no dependencies. From inside a project that already has it,
**`/collab-install`** re-installs or updates the copy.

For the default **Claude + Codex** pair, also add the `codex@openai-codex` plugin and run
`/codex:setup` once to authenticate Codex. Any other pair needs no plugin.

## Use it

```text
/collab-new <TYPE> <slug>   # scaffold a clean session and open PLAN
                            #   TYPE = FEATURE | BUG_FIX | REFACTOR | INVESTIGATION | META
/collab-status              # list sessions + check results; see whose turn it is
/collab-continue [id]       # resume a session exactly where it left off
/collab-install             # copy the tooling into the current project's .claude/
```

`/collab-new` creates the board on first use. In connected mode you then let Claude drive the turn
loop until a phase gate or a question needs you.

## Layout

This repo is the **source**; the skill under `skill/` is what gets installed:

```
install.mjs            # one-command installer (forwards to skill/scripts/install.mjs)
skill/                 # the installable skill
├── SKILL.md  references/  templates/  commands/collab-*.md
└── scripts/           # collab-board.mjs (the engine, plain Node) + install.mjs + test.mjs
```

Two directories are **generated** and git-ignored in this source repo:

- **`.claude/`** — the installed tooling, produced from `skill/` by the installer. Commit it in a
  *target* project so collaborators get the commands.
- **`.collab-board/`** — runtime session data, created by `/collab-new`: a live-state file
  (`HEAD.md`), an append-only event log (`log.md`), the point tracker (`points.md`), the frozen plan,
  and the immutable per-turn notes.

## For AI agents (orchestrator quickstart)

Read `.claude/skills/collab-board/SKILL.md`, then `.collab-board/PROTOCOL.md` **once**. Each turn,
read only the live-state file `HEAD.md` + `points.md` + the one prior turn it points to (plus the
frozen `plan/context.md` during IMPL). Write `HEAD.md` **last** — the `HANDOFF` line appended to the
log is the commit point. After every turn, run the checker and fix any failure:

```bash
node .claude/skills/collab-board/scripts/collab-board.mjs lint --session <id>
```

It replays the append-only log to verify the live state. (Working in this source repo directly? The
engine is `skill/scripts/collab-board.mjs`.)
