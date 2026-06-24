# collab-board

A portable, **agent-neutral toolkit** that makes two AI models collaborate on a coding task in
strict, alternating turns — a **PRIMARY** and a **SECONDARY** (default: **Claude + Codex**, with
Codex driven from *inside* Claude via the `codex@openai-codex` plugin — no second terminal or app).
The engine is plain Node + Markdown and drops into any project with one command.

Each session runs a **PLAN** phase (converge, then agree) and an **IMPLEMENTATION** phase, tracking
decisions as points and gating each phase. The board is **not one growing file** — it's a small tree
of interlinked Markdown files, so every turn reads only the few it needs and context stays bounded no
matter how long the collaboration runs.

## Why two models

A single model has blind spots and can state a wrong answer with complete confidence. Pairing two
*different* models turns that into a safeguard: each has to back its claims with evidence and survive
the other's skeptical review, so hallucinations get caught and gaps get filled before any decision
sticks — a more reliable result than either model reaches alone.

## What it's good for

- Two AIs **co-designing then co-implementing** a feature/fix/refactor with skeptical peer review.
- Keeping a long collaboration's **per-turn context small** — no re-reading the whole history.
- A clean, lintable **audit trail** of who decided what, and why.
- Built-in principles: adversarial-but-open review · Occam's razor · challenge & ask · escalate to
  the user only when *both* are unsure · keep the board lean.

## How it runs: connected, or human-relayed

Both agents need a channel to pass turns. Two modes — **same board, same protocol, same lint; only
the hand-off differs**:

- **Connected (default, fully automated).** Claude (PRIMARY) drives Codex (SECONDARY) through the
  `codex@openai-codex` plugin, entirely inside Claude Code or Claude Desktop. You give one prompt to
  start; Claude takes its own turns and delegates Codex's automatically, pausing only at a phase gate
  or a question — no copy-pasting. **Claude sets this up and guides you:** it adds the plugin from the
  Claude Code marketplace, runs `/codex:setup`, and walks you through authenticating the Codex CLI.

- **Disconnected — the shared board *is* the connection.** Any other pairing (Claude + Gemini, two
  ChatGPT windows, a local model…) needs no plugin: the board is just files under `.collab-board/`,
  and every turn is gated + lint-checked, so an offline/async collaboration stays consistent.
    - **Shared workspace (recommended):** point both agents at the same folder or a shared **git**
      repo. Each runs `/collab-continue` and acts only when `HEAD.md` shows its hand at `START` —
      reading its tiny read-set, taking its turn, and handing off. You just nudge whoever holds
      `START` ("your turn"); each agent edits the board itself.
    - **Pure relay (`manual` adapter):** if the secondary can't touch the filesystem (a browser-only
      chat), the orchestrator prints a self-contained *scoped prompt* each turn; you paste it over and
      paste the reply back, and it scribes the writes. (A write-capable Claude Code subagent can use
      `subagent:<name>` and stay automated.)

## Install

**Node 18+** is the only hard dependency, and it's cross-platform (Windows, macOS, Linux).

### As an AI agent (minimal overhead)

Give the agent this repo's URL and ask it to set up collab-board — it clones and runs the one-line
installer itself:

```bash
git clone https://github.com/Veisy/collab-board && node collab-board/install.mjs --global
```

For the default **Claude + Codex** pairing, Claude also finishes the setup — it adds the
`codex@openai-codex` plugin and runs `/codex:setup` (see
[How it runs](#how-it-runs-connected-or-human-relayed)). Any other pairing needs no plugin.

### As a human

Clone the repo and run the installer; it copies the skill + `/collab-*` commands into the target's
`.claude/` (the Claude Code layout) — no build, no dependencies:

```bash
git clone https://github.com/Veisy/collab-board

node collab-board/install.mjs /path/to/your-project   # into one project (then commit its .claude/)
node collab-board/install.mjs --global                # …or globally, for every project
```

From inside a project that already has it, **`/collab-install`** re-installs or updates the copy.

## Use it

```text
/collab-new FEATURE jwt-auth   # scaffold a clean session, fill the contract, open PLAN
/collab-status                 # list sessions + lint findings; see whose turn it is
/collab-continue [id]          # resume a session exactly where it left off
/collab-install                # copy the tooling into the current project's .claude/
```

`/collab-new` creates the board on first use; in connected mode you then just let Claude drive the
turn loop until a phase gate or a question needs you.

## Layout

The repo is the agent-neutral **source**:

```
install.mjs            # one-command installer
skill/                 # the portable toolkit
├── SKILL.md  references/  templates/  commands/collab-*.md
└── scripts/           # collab-board.mjs (the engine, plain Node) + install.mjs + test.mjs
```

The installer **generates** (both git-ignored in this source repo): `.claude/` — the Claude Code
integration, which you commit in a *target* project so the team gets the tooling; and, at runtime via
`/collab-new`, `.collab-board/` — session data (`HEAD.md` live state · `log.md` ledger · `points.md` ·
`plan/` · `impl/` · `agents/` · `turns/<id>-<actor>.md`).

## For AI agents (orchestrator quickstart)

Read `.claude/skills/collab-board/SKILL.md`, then `.collab-board/PROTOCOL.md` **once**. Per turn read
only `HEAD.md` + `points.md` + the one shard at `HEAD.RESPONDS_TO` (+ `plan/context.md` in IMPL).
Write `HEAD.md` **last**; the `HANDOFF` log line is the commit point. After every turn run
`node .claude/skills/collab-board/scripts/collab-board.mjs lint --session <id>` and fix any `FAIL` —
the lint replays the append-only log to verify live state. (Working in this source repo directly? The
engine is `skill/scripts/collab-board.mjs`.)
