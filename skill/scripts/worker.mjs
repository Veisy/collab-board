#!/usr/bin/env node
// worker — verify what a delegated WORKER changed, without reading what it said.
//
//   node worker.mjs baseline --out <file> [--root .]
//   node worker.mjs verify   --baseline <file> --allow <path>[,<path>...] [--expect-changes] [--root .]
//
// A WORKER is not a board actor. It holds no seat, no hand, no turn, no point and no gate; it never
// appears in HEAD; it is not a SecondaryAdapter value; and it loads NO collab-board context — its
// prompt carries a task, a read manifest, a write manifest and an output contract, nothing else.
// The seats (PRIMARY, SECONDARY) think, plan and review. A worker executes one well-defined job.
//
// WHY THIS FILE EXISTS. The PRIMARY stays accountable for every byte a worker writes, and the way
// it discharges that is the DIFF, not the worker's report. "The reply is never evidence" is this
// project's oldest rule and it applies with more force here, because a worker is chosen for cost
// rather than for judgement. On a clean verify the PRIMARY never needs to read the transcript at
// all, which is the context saving the whole tier exists for.
//
// WHAT THIS OBSERVES, stated as a bounded claim rather than a containment promise. It compares the
// paths GIT REPORTS as differing from HEAD, by content, plus HEAD itself — and, separately, the
// BOARD, which is read off the filesystem and never through git.
//
// It therefore does NOT see: an ignored path, a mode change on a file whose bytes are unchanged, a
// symlink retargeted to identical content, `.git` internals, anything outside the repository, and
// anything done off disk. Each of those was found by review rather than by reasoning, which is why
// the claim is now stated as a boundary instead of a guarantee — a verifier that keeps discovering
// new escapes is describing its own coverage wrongly, not merely missing cases.
//
// `assume-unchanged`/`skip-worktree` was on that list until the FLAGS became compared state. It was
// the only entry a worker could reach without leaving the repository — setting one is a legitimate
// git operation on a permitted path, so the dispatch sandbox will not deny it — and it silenced
// every check here that reads `git status`. This list and the SCOPE notice `verify` prints are read
// as the set of things NOT checked, so an entry that becomes checked has to leave both.
//
// THE BOARD IS THE ONE EXCEPTION, and it is deliberate. A worker has no board access at all, so
// that refusal must not inherit the boundary above. Deriving it from git's change list gave it two
// escapes that a reader of `workers.md` would never expect, because the file states the refusal
// unconditionally: a board file ALREADY dirty before the dispatch keeps its status line, never
// enters the changed set, and was accepted for being inside the manifest; and a project that
// gitignores `.collab-board/` — which the install docs invite, since session data is not committed
// tooling — drops every board path out of git's view entirely, so a worker could rewrite `HEAD.md`
// while verify printed OK. Both were one root cause: asking git about a property of the board.
// The board is now digested directly, so the refusal holds whatever git thinks, and no `--allow`
// entry can grant it.
//
// Containment belongs at DISPATCH, enforced by the executor's sandbox. This is the second check,
// not the first, and it is only sound to the extent the first one held.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function git(root, args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return e.stdout != null ? String(e.stdout) : ""; }
}
function isRepo(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
}

// The observable state of the tree, in one shot. `--porcelain` covers tracked modifications and
// untracked files; HEAD and the index are recorded separately because a worker that COMMITS its own
// work would otherwise make its changes vanish from a status comparison — the advertised diff
// disappears and the tree looks untouched.
// CONTENT, not status lines. Comparing porcelain output alone was unsound and the review proved it
// with a two-line construction: a file already modified before the dispatch shows ` M path` both
// before AND after, so a worker could overwrite ANY already-dirty file, outside its manifest, and
// verify reported "every change is inside the manifest". The status line is a claim ABOUT the
// content; hashing the content is the content.
function hashFile(root, rel) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex").slice(0, 16); }
  catch { return "ABSENT"; }
}
const BOARD = ".collab-board/";

// The board, read off the filesystem. `git status` is not consulted at any point here: tracking,
// ignore rules and the write manifest are all properties of git's view, and the board refusal is a
// property of the PATH. Symlinks are recorded by target rather than followed, so retargeting one is
// a change even when the bytes it points at are identical.
function hashTree(root, rel) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return { present: false, files: {} }; }
  if (!st.isDirectory()) return { present: true, files: { [rel]: hashFile(root, rel) } };
  const files = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = `${dir}/${e.name}`;
      if (e.isSymbolicLink()) { try { files[r] = "link:" + fs.readlinkSync(path.join(root, r)); } catch { files[r] = "link:?"; } }
      else if (e.isDirectory()) walk(r);
      else files[r] = hashFile(root, r);
    }
  };
  try { walk(rel.replace(/\/+$/, "")); } catch { /* unreadable subtree is reported by the diff below */ }
  return { present: true, files };
}

function snapshot(root) {
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]).split(/\r?\n/).filter(Boolean).sort();
  // Every path git can see as differing from HEAD, hashed. A path that leaves this set between the
  // two snapshots is caught by the status comparison; a path that STAYS in it with different bytes
  // is caught only here.
  const digests = {};
  for (const line of status) {
    const rel = line.slice(3).split(" -> ").pop().replace(/^"(.*)"$/, "$1");
    digests[rel] = hashFile(root, rel);
  }
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim() || "NONE",
    // The real index, not the HEAD tree it was mistakenly recorded as — and it is now compared.
    index: git(root, ["write-tree"]).trim() || "NONE",
    status,
    digests,
    board: hashTree(root, BOARD.replace(/\/$/, "")),
    // The one evasion reachable WITHOUT leaving the repository, and the one a sandbox is least
    // likely to stop, because setting it is a legitimate git operation on a permitted path.
    // `ls-files -v` prefixes each tracked path with its flag: `H` is normal, lowercase `h` is
    // assume-unchanged and `S` is skip-worktree. Either makes git report the path as clean
    // forever after, so every check below that reads `git status` inherits whatever the flag hid.
    // Captured in `snapshot`, which feeds BOTH the baseline and the live comparison, so the field
    // exists on both sides for free.
    skipflags: git(root, ["ls-files", "-v"]).split(/\r?\n/).filter(Boolean).sort(),
  };
}

// A path is allowed when it is inside one of the declared write roots. Comparison is on normalised
// relative paths, and anything that escapes the root is refused before it is compared — a manifest
// entry cannot grant `..`.
function within(rel, allowRoots) {
  const p = rel.split("\\").join("/");
  if (p.startsWith("../") || p === "..") return false;
  return allowRoots.some((a) => p === a || p.startsWith(a.replace(/\/*$/, "") + "/"));
}

function cmdBaseline(opts) {
  if (!isRepo(opts.root)) die("worker: not a git repository — the diff is the deliverable, so there must be one");
  // The baseline must live OUTSIDE the tree it describes, or it becomes a change in its own
  // snapshot and every verify reports the record-keeping as a violation. Refusing here teaches the
  // rule once instead of letting each caller rediscover it as a spurious finding.
  if (opts.out) {
    const rel = path.relative(path.resolve(opts.root), path.resolve(opts.out));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      die(`worker: --out ${opts.out} is inside the repository, so the baseline would record itself as a change; write it to scratch outside the project`);
  }
  const snap = snapshot(opts.root);
  const out = JSON.stringify({ version: 3, root: path.resolve(opts.root), taken: snap }, null, 2);
  if (opts.out) { fs.writeFileSync(opts.out, out); console.log(`baseline written to ${opts.out} (HEAD ${snap.head.slice(0, 7)}, ${snap.status.length} pre-existing change(s))`); }
  else console.log(out);
}

function cmdVerify(opts) {
  if (!opts.baseline) die("worker: verify needs --baseline <file> from a `worker baseline` run before the dispatch");
  if (!fs.existsSync(opts.baseline)) die(`worker: baseline ${opts.baseline} not found`);
  const base = JSON.parse(fs.readFileSync(opts.baseline, "utf8"));
  // Fail closed on a baseline this build cannot classify. A pre-v2 baseline carries no board
  // digest, so the board refusal below would silently have nothing to compare against — and a
  // refusal that quietly stops running is a pass. Re-take the baseline instead.
  // Exact, not ">= 2". A baseline that predates a captured field cannot answer the question the
  // check asks, and skipping a check it cannot run is a PASS wearing the check's name — the same
  // fail-closed rule the board refusal follows. A baseline is taken seconds before the dispatch,
  // so demanding a current one costs nothing and buys the guarantee that every block below ran.
  if (base.version !== 3)
    die(`worker: baseline ${opts.baseline} is version ${base.version ?? "unknown"}, not 3 — it predates a field the checks read, so they cannot all run; re-take it with \`worker baseline\``);
  const now = snapshot(opts.root);
  const allow = (opts.allow || "").split(",").map((s) => s.trim().split("\\").join("/")).filter(Boolean);
  if (!allow.length) die("worker: verify needs --allow <path>[,<path>...] — an unbounded write manifest is not a manifest");
  // A manifest cannot grant what no worker has. Refusing the entry is better than accepting it and
  // reporting the writes it invites, because the caller's mistake is the manifest, not the diff.
  for (const a of allow)
    if (a === BOARD.replace(/\/$/, "") || a.startsWith(BOARD) || BOARD.startsWith(a.replace(/\/*$/, "") + "/"))
      die(`worker: --allow ${a} names the board — a worker holds no seat and has no board access at all, so the board is never grantable`);

  const findings = [];
  const say = (level, msg) => findings.push({ level, msg });

  // 1. The worker must not have moved the repository under the PRIMARY. A commit, a reset or a
  //    checkout makes the tracked diff disappear, which reads as "changed nothing".
  if (now.head !== base.taken.head)
    say("FAIL", `HEAD moved ${base.taken.head.slice(0, 7)} -> ${now.head.slice(0, 7)} — a worker does not commit; its work must remain an inspectable diff`);

  // 1b. Ordered BEFORE every status-derived block, because those read through `git status` and
  //     would inherit whatever a flag hid. The flag itself is the finding: no legitimate worker
  //     marks a path unchanged, so the change is reported without asking which path it covered or
  //     whether that path was in the manifest — a manifest cannot grant the right to disable the
  //     check that reads it.
  if ((base.taken.skipflags || []).join("\n") !== (now.skipflags || []).join("\n"))
    say("FAIL", "git assume-unchanged/skip-worktree flags changed during the dispatch — a worker "
      + "does not mark paths unchanged, and every content check here reads through `git status`, "
      + "which such a flag silences");

  // 2. Every change must be inside the declared manifest. Block 2b owns the board, on every path
  //    and whatever git thinks of it, so board paths are skipped here rather than reported twice.
  const before = new Set(base.taken.status);
  const changed = now.status.filter((l) => !before.has(l));
  const paths = changed.map((l) => l.slice(3).split(" -> ").pop().replace(/^"(.*)"$/, "$1"));
  for (const p of paths) {
    if (p.startsWith(BOARD)) continue;
    if (!within(p, allow)) say("FAIL", `wrote outside the manifest: ${p} (allowed: ${allow.join(", ")})`);
  }

  // 2b. THE BOARD, compared digest-to-digest off the filesystem and never through git. This block
  //     consults neither `status` nor `allow`: a worker has no board access at all, so the refusal
  //     is a property of the path and must survive a board that is untracked, ignored, or already
  //     dirty when the dispatch began — each of which had silently disabled it.
  const bBase = base.taken.board || { present: false, files: {} };
  const bNow = now.board;
  if (bBase.present !== bNow.present)
    say("FAIL", bNow.present
      ? `created the board: ${BOARD} did not exist before the dispatch — a worker has no board access at all`
      : `deleted the board: ${BOARD} existed before the dispatch and is gone`);
  for (const rel of new Set([...Object.keys(bBase.files), ...Object.keys(bNow.files)])) {
    const a = bBase.files[rel], b = bNow.files[rel];
    if (a === b) continue;
    say("FAIL", a === undefined ? `wrote inside the board: ${rel} — a worker has no board access at all`
      : b === undefined ? `deleted inside the board: ${rel} — a worker has no board access at all`
      : `rewrote inside the board: ${rel} — a worker has no board access at all`);
  }

  // 3. Pre-existing changes must survive, in BOTH senses: the change must still be there, and it
  //    must still be the same bytes. Only the first was checked, which left the hole above.
  const gone = base.taken.status.filter((l) => !now.status.includes(l));
  for (const l of gone) say("FAIL", `a change present before the dispatch is gone: ${l.trim()} — the worker reverted work it did not own`);
  for (const [rel, digest] of Object.entries(base.taken.digests || {})) {
    const nowDigest = (now.digests || {})[rel];
    if (nowDigest === undefined || nowDigest === digest) continue;
    if (rel.startsWith(BOARD)) continue;  // 2b owns the board, and reports it once
    if (!within(rel, allow))
      say("FAIL", `silently rewrote a file that was ALREADY modified before the dispatch: ${rel} — its status line never changed, so only its content shows this`);
    else if (!paths.includes(rel)) paths.push(rel);
  }
  // 4. The index must not have moved. A worker that stages its work changes what a later commit
  //    would capture without changing the worktree the PRIMARY is reading.
  if (now.index !== base.taken.index && base.taken.index !== "NONE")
    say("FAIL", "the git index moved — a worker does not stage; leave the work in the worktree for the PRIMARY to read");

  // 5. Damage git itself can see: conflict markers, whitespace errors.
  const check = git(opts.root, ["diff", "--check"]);
  if (check.trim()) say("FAIL", `git diff --check reports damage:\n    ${check.trim().split(/\r?\n/).slice(0, 5).join("\n    ")}`);

  // 6. A WRITE job that changed nothing did not do its job. Silence and success look identical
  //    otherwise, which is the failure mode this whole file exists to prevent.
  // Asks the SAME question the rest of this function now asks: did any CONTENT change. Reading
  // `changed` here kept the old status-line semantics, so a worker that continued an already-dirty
  // file inside its manifest was reported as having done nothing.
  if (opts.expectChanges && !paths.length)
    say("FAIL", "the write job produced no change at all — an empty diff is not a completed task");

  const fails = findings.filter((f) => f.level === "FAIL").length;
  console.log(`── worker verify (${paths.length} change(s), manifest: ${allow.join(", ")}) ──`);
  for (const p of paths) console.log(`  changed  ${p}`);
  for (const f of findings) console.log(`  ${f.level.padEnd(6)} ${f.msg}`);
  // The limit is printed on every run, not buried in a comment: a reader who sees only "OK" must
  // still be told what OK does not cover.
  console.log(fails
    ? `REJECT: ${fails} finding(s) — discard the worker's output and do not read its transcript for reassurance`
    : "OK: of the paths git reports as changed, every one is inside the manifest and no pre-existing content was lost");
  console.log("  SCOPE: this compares the paths git reports against HEAD, by content, plus HEAD itself.");
  console.log("  It does NOT see ignored paths, mode-only changes, a symlink retargeted to identical");
  console.log("  bytes, .git internals, anything outside the repository, or anything done off disk.");
  console.log("  Containment is the dispatch sandbox's job. A path hidden with assume-unchanged or");
  console.log("  skip-worktree is not in that list: the flag change is compared and refused.");
  console.log(`  The one exception is ${BOARD}: it is digested off the filesystem, so that refusal`);
  console.log("  holds whether the board is tracked, untracked, ignored or already dirty, and no");
  console.log("  --allow entry can grant it.");
  return fails ? 1 : 0;
}

function die(msg) { console.error(msg); process.exit(2); }

function main(argv) {
  const opts = { root: "." };
  const cmd = argv[0];
  // ONE table for the whole argv grammar, and a Map rather than an object literal: `a in FLAGS`
  // would have accepted every inherited property name, so `verify toString` parses as a flag —
  // the escape arriving from outside the grammar the check reasons in.
  //
  // A REPEATED flag is REFUSED, not resolved. `--allow a --allow b` used to keep only `b`, and the
  // direction is fail-safe only in the narrow sense that it can just under-grant: the visible
  // result is a FAIL on a write the caller believed it had permitted, with nothing naming the
  // dropped entry. A guard must reject what it cannot classify, and two values for one flag is
  // exactly that.
  const FLAGS = new Map([["--root", "root"], ["--out", "out"], ["--baseline", "baseline"],
    ["--allow", "allow"], ["--expect-changes", null]]);
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!FLAGS.has(a)) die(`worker: unknown argument ${JSON.stringify(a)}`);
    if (seen.has(a))
      die(`worker: ${a} given more than once — one flag carries one value and a repeat silently `
        + "dropped the earlier one; pass a single comma-separated value instead");
    seen.add(a);
    const key = FLAGS.get(a);
    if (key === null) { opts.expectChanges = true; continue; }
    if (i + 1 >= argv.length) die(`worker: ${a} needs a value`);
    opts[key] = argv[++i];
  }
  if (cmd === "baseline") { cmdBaseline(opts); return 0; }
  if (cmd === "verify") return cmdVerify(opts);
  die("usage: worker.mjs baseline --out <file> | worker.mjs verify --baseline <file> --allow <paths> [--expect-changes]");
}

process.exit(main(process.argv.slice(2)));
