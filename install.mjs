#!/usr/bin/env node
// Convenience entry point. Forwards to the installer bundled with the skill.
// Usage:  node install.mjs [target-dir | --global]   (default: current directory)
//   e.g.  node install.mjs ../my-project     install into a project's .claude/
//         node install.mjs --global          install globally (~/.claude), any OS
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(here, "skill", "scripts", "install.mjs");
const r = spawnSync(process.execPath, [installer, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
