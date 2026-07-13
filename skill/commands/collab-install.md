---
description: Install the collab-board skill + slash commands into THIS project's .claude/ so they travel with the repo (commit them for collaborators)
allowed-tools: Bash(node:*), Read
---

Install collab-board into the current project so the skill and `/collab-*` commands are
committed with the repo (and use a project-local script path).

Run the bundled installer from the global copy (or a project copy if one already exists):

```bash
node "$HOME/.claude/skills/collab-board/scripts/install.mjs" .
```

If the global copy is absent, look for the installer under any `.claude/skills/collab-board/`
you can reach and run it with `.` as the target.

This copies:
- the skill → `./.claude/skills/collab-board/`
- the commands → `./.claude/commands/collab-new.md`, `collab-continue.md`, `collab-status.md`,
  `collab-install.md`

After it runs, report exactly what was written and remind the user to **commit `.claude/`** so
the team gets it. Session data (`.collab-board/`) is created later by `/collab-new` and is
separate from the installed tooling.
