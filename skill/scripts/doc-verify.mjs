#!/usr/bin/env node
// doc-verify — machine-token preservation check over a rewritten document surface.
//
// NOT "validate-or-revert", which is what this called itself for two commits. That name promises a
// verdict on the rewrite; this compares string sets. It answers ONE question — did a token that a
// reader or a checker matches on leave the live surface — and a rewrite can pass it while meaning
// something else entirely. The narrower name is the honest one, and the difference is the whole of
// what a human reviewer is still for.
//
//   node doc-verify.mjs --before <path> --after <path>
//     [--allow-drop <token>]... [--allow-drop-file <rel>]... [--allow-growth] [--json]
//
// A path is a file or a directory; a directory is walked for `.md` and compared as ONE surface.
// That is the whole point: deduplicating a fact MOVES it from five files to one, so a per-file
// comparison would report every successful dedupe as a loss. Tokens are compared as the UNION over
// the surface, so a token may move between files and may not vanish from all of them.
//
// The rule this enforces: a rewrite may not silently drop a MACHINE TOKEN — a fenced block, an
// inline code span, a URL, a heading, an `L<n>` code, an ALL-CAPS identifier, a column-zero `Key:`
// declaration, an `<x>-cli` adapter name, a `collab-board/<name>/v<n>` schema string, or a path to
// another shipped file. Those are the strings a reader or a checker matches on.
//
// WHAT `OK` MEANS, stated narrowly because the first version of this comment did not. It means no
// machine token left the live surface. It does NOT mean meaning survived: a rule can be inverted
// with every token of it intact, and this tool cannot see that. It compares strings, not claims.
// `OK` clears a rewrite for review; it does not substitute for reading the diff.
//
// Nothing here is a list of known events, adapters or gates. Every class is a SHAPE. A registry
// copied into this file would be one more pair of things that must agree where only one gets
// edited, which is the defect class this whole refactor exists to remove.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------------------------
// Attestation. A construct this cannot parse is refused, never passed: an unclosed fence makes
// every subsequent token ambiguous — real text or quoted example — and reporting "no drops" over
// input the extractor did not understand is exactly the false assurance rtk's fail-closed rule is
// for. Refusing is the ONLY safe answer, because the alternative reads identically to success.
//
// MASK BEFORE COUNTING, which is caveman's discipline and the engine's `liveText` rule both. The
// first version of this counted `<!--` on raw bytes and refused `lint-spec.md`, whose L0 row
// explains — in an inline code span, quoting the marker — that these documents describe a Markdown
// format and quote `<!--` constantly. The detector was wrong and the document said so in the line
// that tripped it.
function maskCode(text) {
  const out = text.split("");
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  for (const m of text.matchAll(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gm)) blank(m.index, m.index + m[0].length);
  const masked = out.join("");
  const out2 = masked.split("");
  const blank2 = (a, b) => { for (let k = a; k < b; k++) if (out2[k] !== "\n") out2[k] = " "; };
  for (const m of masked.matchAll(/`[^`\n]*`/g)) blank2(m.index, m.index + m[0].length);
  return out2.join("");
}
function unattestable(text) {
  const problems = [];
  // Fences are counted on the RAW text — masking is defined in terms of them, so they cannot be
  // checked through their own output.
  const fences = (text.match(/^[ \t]*```/gm) || []).length;
  if (fences % 2 !== 0) problems.push(`unbalanced code fence (${fences} fence lines)`);
  if (fences % 2 === 0) {
    const live = maskCode(text);
    const opens = (live.match(/<!--/g) || []).length;
    const closes = (live.match(/-->/g) || []).length;
    if (opens !== closes) problems.push(`unbalanced HTML comment (${opens} open, ${closes} close)`);
  }
  return problems;
}

// THE LIVE VIEW. A token inside an HTML comment is not on the page: no reader sees it and no
// checker matches it. Deleting a live `L29` and leaving `<!-- L29 -->` behind therefore removed it
// while this reported OK — the SECONDARY demonstrated exactly that at I4. Comments are located on
// the code-masked view so a marker quoted in a fence or a code span is text, not syntax, which is
// the same rule the attestation pass above already needed.
function liveText(text) {
  const masked = maskCode(text);
  const out = text.split("");
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  for (let i = 0; ;) {
    const a = masked.indexOf("<!--", i);
    if (a < 0) break;
    const c = masked.indexOf("-->", a + 4);
    const b = c < 0 ? text.length : c + 3;
    blank(a, b);
    i = b;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// Token classes, each a shape rather than a list.
const CLASSES = {
  // Fenced blocks are compared by their CONTENT, byte for byte apart from line endings. An earlier
  // version stripped trailing whitespace per line as "formatting", which silently accepted a fenced
  // block whose bytes had changed — in a document whose fences are commands and file layouts, a
  // trailing byte is content.
  FENCE: (t) => [...t.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)]
    .map((m) => m[1].replace(/\r\n/g, "\n"))
    .filter((s) => s.trim() !== ""),
  // PHANTOM SPANS. Pairing backticks left to right on a line whose count is ODD makes the PROSE
  // between two real spans look like a span of its own, and then a rewrite that merely rewraps the
  // line "drops" a token that was never a token. That happened on a real file here. A line with an
  // unbalanced count is therefore not attested for this class: its spans are skipped rather than
  // guessed at, which is the same fail-closed choice the fence check makes.
  CODE: (t) => t.split(/\r?\n/).flatMap((line) => {
    if (((line.match(/`/g) || []).length % 2) !== 0) return [];
    return [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  }).filter(Boolean),
  URL: (t) => [...t.matchAll(/https?:\/\/[^\s)\]<>"']+/g)].map((m) => m[0].replace(/[.,;]$/, "")),
  // LEVEL IS PART OF THE HEADING. Storing only the text made `## State` and `### State` the same
  // token, so re-nesting a section — a structural rewrite of the document — passed as unchanged.
  HEADING: (t) => [...t.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)].map((m) => `${m[1]} ${m[2].trim()}`),
  LCODE: (t) => [...t.matchAll(/\bL\d+\b/g)].map((m) => m[0]),
  // Machine identifiers: hands, phases, statuses, event names, gate names, sentinel values. Four
  // characters and up, so ordinary capitalised prose and initialisms are not swept in.
  CAPS: (t) => [...t.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z]{4,}\b/g)].map((m) => m[0]),
  CLI: (t) => [...t.matchAll(/\b[a-z][a-z0-9]*-cli\b/g)].map((m) => m[0]),
  SCHEMA: (t) => [...t.matchAll(/\bcollab-board\/[A-Za-z_]+\/v\d+/g)].map((m) => m[0]),
  // Cross-references between shipped files. A rewrite that moves a fact must repoint the pointers.
  PATH: (t) => [...t.matchAll(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:md|mjs|json)\b/g)].map((m) => m[0]),
  // Column-zero `Key:` declarations — the shape of every board-file key. `CAPS` could not see the
  // mixed-case ones, so `Catalog`, `Type`, `Reset`, `Converge` and `Roles` were unprotected: the
  // SECONDARY dropped all five from the shipped surface at I4 and this reported OK. A shape, not a
  // list, so it covers a key added to a template tomorrow without anything being kept in sync.
  //
  // A DECLARATION IS NOT AN EXAMPLE. This one class is read with fenced blocks masked out, because
  // a `Roles:` line inside a ```text``` sample is an illustration of the syntax rather than a use
  // of it — deleting the real declaration while the sample survived satisfied the union. The FENCE
  // class still protects the sample's own bytes, so nothing is left unguarded by the exclusion.
  COLKEY: (t) => [...maskCode(t).matchAll(/^([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]),
};

// Negations are counted, not matched. Dropping one inverts a rule, and caveman's own compressor
// carries a hard never-drop-negations rule for that reason — but a rewrite legitimately turns
// "does not permit" into "forbids", so a fall is a question to answer rather than a failure.
const NEGATION = /\b(not|never|no|none|cannot|can't|don't|do not|must not|neither|nor|without|unless|except)\b/gi;

function tokensOf(text) {
  const out = {};
  for (const [name, fn] of Object.entries(CLASSES)) out[name] = new Set(fn(text));
  return out;
}

function walk(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const found = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) rec(q);
      else if (e.name.endsWith(".md")) found.push(q);
    }
  })(p);
  return found.sort();
}

function surface(p) {
  const root = fs.statSync(p).isDirectory() ? p : path.dirname(p);
  const files = walk(p);
  const texts = files.map((f) => fs.readFileSync(f, "utf8"));
  const union = {}, buried = {};
  for (const name of Object.keys(CLASSES)) { union[name] = new Set(); buried[name] = new Set(); }
  let bytes = 0, negations = 0;
  const refused = [];
  for (let i = 0; i < files.length; i++) {
    const t = texts[i];
    bytes += Buffer.byteLength(t, "utf8");
    const bad = unattestable(t);
    if (bad.length) refused.push(`${files[i]}: ${bad.join("; ")}`);
    // Tokens are taken from the LIVE view. What only a comment carries is tracked separately so a
    // token moving out of the document into a comment reads as the removal it is.
    const live = liveText(t);
    negations += (live.match(NEGATION) || []).length;
    const lt = tokensOf(live), all = tokensOf(t);
    for (const name of Object.keys(CLASSES)) {
      for (const v of lt[name]) union[name].add(v);
      for (const v of all[name]) if (!lt[name].has(v)) buried[name].add(v);
    }
  }
  const manifest = new Set(files.map((f) => path.relative(root, f).split(path.sep).join("/")));
  return { files, manifest, union, buried, bytes, negations, refused };
}

// ---------------------------------------------------------------------------------------------
function main(argv) {
  const opts = { allowDrop: new Set(), allowDropFile: new Set(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--before") opts.before = argv[++i];
    else if (a === "--after") opts.after = argv[++i];
    else if (a === "--allow-drop") opts.allowDrop.add(argv[++i]);
    else if (a === "--allow-drop-file") opts.allowDropFile.add(argv[++i]);
    else if (a === "--allow-growth") opts.allowGrowth = true;
    else if (a === "--json") opts.json = true;
    else { console.error(`doc-verify: unknown argument ${JSON.stringify(a)}`); return 2; }
  }
  if (!opts.before || !opts.after) {
    console.error("usage: doc-verify.mjs --before <path> --after <path> [--allow-drop <token>]... [--allow-drop-file <rel>]... [--allow-growth] [--json]");
    return 2;
  }

  const B = surface(opts.before), A = surface(opts.after);
  const findings = [];

  // Refusal comes first and is terminal for the run. A surface the extractor could not parse
  // cannot be reported clean, and cannot be reported dirty either.
  for (const r of [...B.refused.map((s) => `before ${s}`), ...A.refused.map((s) => `after ${s}`)])
    findings.push({ level: "REFUSE", cls: "ATTEST", msg: r });

  if (!findings.length) {
    for (const name of Object.keys(CLASSES)) {
      for (const tok of B.union[name]) {
        if (A.union[name].has(tok)) continue;
        if (opts.allowDrop.has(tok)) {
          findings.push({ level: "NOTE", cls: name, msg: `declared drop: ${JSON.stringify(tok)}` });
          continue;
        }
        const where = A.buried[name].has(tok) ? " (survives only inside a comment, which is not the page)" : "";
        findings.push({ level: "FAIL", cls: name, msg: `dropped: ${JSON.stringify(tok)}${where}` });
      }
    }
    // FILE MANIFEST. The union answers "does this token still exist somewhere", which a rewrite can
    // satisfy by parking the last copy in a file it intends to delete next. Deleting a file is
    // therefore its own declaration, so the parking move has to be undone or admitted rather than
    // completed quietly in a later commit.
    for (const f of B.manifest) {
      if (A.manifest.has(f)) continue;
      if (opts.allowDropFile.has(f)) findings.push({ level: "NOTE", cls: "FILE", msg: `declared file removal: ${f}` });
      else findings.push({ level: "FAIL", cls: "FILE", msg: `file removed without --allow-drop-file: ${f}` });
    }
    // ADDED paths are reported too. Only reporting removals made a RENAME read as a bare removal,
    // so the file that replaced it went unmentioned; seeing both halves is what makes a rename
    // legible as one move rather than two unrelated events. Informational, because adding a file is
    // not a loss — the point is that the reader is told.
    for (const f of A.manifest) if (!B.manifest.has(f)) findings.push({ level: "NOTE", cls: "FILE", msg: `added: ${f}` });
    // never_worse: a compression pass that grew the surface did not compress it. Measured over the
    // surface, so one file may legitimately grow while the whole shrinks.
    // Growth is a FAILURE for a compression pass and the NORMAL outcome for a change that adds
    // documentation, so it is declared rather than inferred. Without the declaration the rule would
    // either block every feature commit or mean nothing during the passes it exists for.
    if (A.bytes > B.bytes)
      findings.push(opts.allowGrowth
        ? { level: "NOTE", cls: "SIZE", msg: `declared growth ${B.bytes} -> ${A.bytes} B (+${A.bytes - B.bytes})` }
        : { level: "FAIL", cls: "SIZE", msg: `surface grew ${B.bytes} -> ${A.bytes} B (+${A.bytes - B.bytes})` });
    if (A.negations < B.negations)
      findings.push({ level: "WARN", cls: "NEGATION", msg: `negations ${B.negations} -> ${A.negations} — confirm no rule was inverted` });
  }

  const fails = findings.filter((f) => f.level === "FAIL" || f.level === "REFUSE").length;
  if (opts.json) {
    console.log(JSON.stringify({
      before: { files: B.files.length, bytes: B.bytes }, after: { files: A.files.length, bytes: A.bytes },
      findings, ok: fails === 0,
    }, null, 2));
  } else {
    console.log(`── doc-verify ${opts.before} -> ${opts.after} ──`);
    console.log(`  ${B.files.length} file(s) ${B.bytes} B  ->  ${A.files.length} file(s) ${A.bytes} B`
      + (A.bytes <= B.bytes ? `  (-${B.bytes - A.bytes} B)` : ""));
    for (const f of findings) console.log(`  ${f.level.padEnd(6)} ${f.cls.padEnd(8)} ${f.msg}`);
    console.log(fails ? `REVERT: ${fails} blocking finding(s)` : "OK: no machine token was dropped");
  }
  return fails ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
