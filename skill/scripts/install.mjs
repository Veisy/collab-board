#!/usr/bin/env node
// install.mjs — copy the collab-board skill + /collab-* commands into a target's .claude/.
// Usage:  node install.mjs [target-dir | --global]   (default: current dir; --global -> ~/.claude)
// Cross-platform (Windows / macOS / Linux), no dependencies. Safe to re-run (overwrites the copy).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");            // skill source (.../skill, or an installed .../skills/collab-board)
const argv = process.argv.slice(2);
const useGlobal = argv.includes("--global") || argv.includes("-g");
const positional = argv.find((a) => !a.startsWith("-"));
const target = useGlobal ? os.homedir() : path.resolve(positional || ".");
const skillDest = path.join(target, ".claude", "skills", "collab-board");
const cmdSrc = path.join(SKILL_DIR, "commands");
const cmdDest = path.join(target, ".claude", "commands");

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
  console.log("Skill already at the destination; installing commands only.");
} else {
  copyDir(SKILL_DIR, skillDest);
}
copyDir(cmdSrc, cmdDest);

const cmds = fs.readdirSync(cmdSrc).filter((f) => f.endsWith(".md")).map((f) => "/" + f.replace(/\.md$/, ""));
console.log(`Installed collab-board into ${target}`);
if (!sameSkill) console.log(`  skill    → ${path.relative(target, skillDest) || skillDest}`);
console.log(`  commands → ${path.relative(target, cmdDest) || cmdDest}  (${cmds.join(", ")})`);
console.log("Commit .claude/ to share the tooling with the project. Run /collab-new to begin.");
