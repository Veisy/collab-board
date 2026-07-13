#!/usr/bin/env node
// install.mjs — install for Claude Code, or install the skill user-wide for Codex.
// Usage:  node install.mjs [target-dir | --global | --codex-global]
//   default: current project .claude/; --global: ~/.claude/; --codex-global: $CODEX_HOME/skills/
// Cross-platform (Windows / macOS / Linux), no dependencies. Safe to re-run (overwrites the copy).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");            // skill source (.../skill, or an installed .../skills/collab-board)
const argv = process.argv.slice(2);
const useGlobal = argv.includes("--global") || argv.includes("-g");
const useCodexGlobal = argv.includes("--codex-global");
if (useGlobal && useCodexGlobal) {
  console.error("install: choose either --global (Claude Code) or --codex-global (Codex), not both.");
  process.exit(1);
}
const positional = argv.find((a) => !a.startsWith("-"));
if (useCodexGlobal && positional) {
  console.error("install: --codex-global uses CODEX_HOME (or ~/.codex) and takes no target directory.");
  process.exit(1);
}
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const target = useCodexGlobal ? codexHome : useGlobal ? os.homedir() : path.resolve(positional || ".");
const skillDest = useCodexGlobal
  ? path.join(target, "skills", "collab-board")
  : path.join(target, ".claude", "skills", "collab-board");
const cmdSrc = path.join(SKILL_DIR, "commands");
const cmdDest = useCodexGlobal ? null : path.join(target, ".claude", "commands");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const sameSkill = path.resolve(SKILL_DIR) === path.resolve(skillDest);
if (skillDest.startsWith(SKILL_DIR + path.sep)) {
  console.error("install: target would nest the skill inside itself — choose a different target.");
  process.exit(1);
}

if (sameSkill) {
  console.log(useCodexGlobal ? "Skill already at the Codex destination." : "Skill already at the destination; installing commands only.");
} else {
  copyDir(SKILL_DIR, skillDest);
}
if (cmdDest) copyDir(cmdSrc, cmdDest);

const cmds = fs.readdirSync(cmdSrc).filter((f) => f.endsWith(".md")).map((f) => "/" + f.replace(/\.md$/, ""));
console.log(`Installed collab-board for ${useCodexGlobal ? "Codex" : "Claude Code"} into ${target}`);
if (!sameSkill) console.log(`  skill    → ${path.relative(target, skillDest) || skillDest}`);
if (cmdDest) {
  console.log(`  commands → ${path.relative(target, cmdDest) || cmdDest}  (${cmds.join(", ")})`);
  console.log("Commit .claude/ to share the tooling with the project. Run /collab-new to begin.");
} else {
  console.log("The skill is available to Codex on the next turn.");
}
