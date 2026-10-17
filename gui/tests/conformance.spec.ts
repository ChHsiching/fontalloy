// Seam 3 — the architecture-conformance guard (ticket #33, spec #25).
//
// A static scan over the frontend source (gui/src + the web app's own
// source, never the test trees) that turns the suite RED the moment a
// frontend business pattern reappears — the class of code this
// migration deleted (the page-side catalog downloader, the zip reader,
// the IndexedDB/FS storage layer, the byte-hashing verify loop) or that
// may only exist inside the modules a later ticket is scheduled to
// delete. The guard is deliberately dumb: pattern + file, no semantic
// reasoning. Every exemption below is explicit, named, and carries the
// reason it exists — an exemption is a reviewed decision, never an
// accident.
//
// Banned patterns (v1):
//   indexeddb   IndexedDB usage (indexedDB / openDb)
//   zip         zip/decompression handling (DecompressionStream,
//               inflateRaw, unzip)
//   fontface    new FontFace(...) whose source is not a url(...) string
//   hashing     hashing of bytes (crypto.subtle.digest)
//   sfnt-magic  binary font-table parsing (sfnt flavor/table tags read
//               as string literals: ttcf/OTTO/glyf/cmap/…)
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..");

/** Repo-relative in the portable forward-slash form (the exemption
 *  tables below are compared against this — never the host's sep). */
function repoRelative(abs: string): string {
  return relative(REPO_ROOT, abs).split(sep).join("/");
}

/** The scanned roots: the frontend source only, never test trees. */
const SCAN_ROOTS = ["gui/src", "web"] as const;

/** Directories never scanned (build output, dependencies, fixtures). */
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "fixtures"]);

/** Source extensions the scanner reads. */
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".html"]);

/**
 * Files whose banned-pattern content is SCHEDULED for deletion by a
 * later ticket of this migration. The exemption is pattern-scoped and
 * temporary by construction: when the ticket lands and deletes the
 * file, the stale entry here must go with it (a missing file makes the
 * exemption inert, and the guard's file-existence check below keeps
 * the table honest).
 */
const SCHEDULED_DELETIONS: ReadonlyArray<{
  file: string;
  patterns: readonly string[];
  reason: string;
}> = [
  {
    file: "gui/src/fonts/sfnt.ts",
    patterns: ["sfnt-magic"],
    reason: "the frontend sfnt reader — T9 of spec #25 deletes it",
  },
  {
    file: "gui/src/fonts/ttc.ts",
    patterns: ["sfnt-magic"],
    reason: "the frontend TTC surgery — T9 of spec #25 deletes it",
  },
];

/**
 * REVIEWED non-URL FontFace sites, as a per-file BUDGET (an upper
 * bound, not a pin): the local/system pick byte path in the registry
 * is the one flow the MEMORY RED LINE (ticket #32) still allows to
 * hold font bytes in the page — a user-loaded file and an installed
 * system family register through FontFace(ArrayBuffer) until the
 * local/system byte path itself moves serve-side. Anything beyond the
 * budget is UNREVIEWED and fails the guard; dropping below it stays
 * green (progress never trips the alarm).
 */
const NON_URL_FONTFACE_BUDGET: ReadonlyArray<{
  file: string;
  budget: number;
  reason: string;
}> = [
  {
    file: "gui/src/fonts/registry.ts",
    budget: 2,
    reason:
      "registerFontBytes + the sibling-face add: the local/system pick " +
      "byte path (ticket #32's carve-out; retired when that path moves " +
      "serve-side)",
  },
];

interface Violation {
  pattern: string;
  file: string;
  line: number;
  excerpt: string;
}

/* ---------- the scanner ---------- */

/**
 * Blank out // and /* … *​/ comments while leaving string literals
 * intact (a "//" inside "https://…" is not a comment). Template
 * literals are kept whole — their ${…} guts may contain anything, and
 * none of the banned patterns are expected to hide there; a violation
 * visible in a template's literal part is still matched.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        out.push("  ");
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block";
        out.push("  ");
        i += 2;
        continue;
      }
      if (ch === "'") mode = "single";
      else if (ch === '"') mode = "double";
      else if (ch === "`") mode = "template";
      out.push(ch);
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n" || ch === "\r") {
        mode = "code";
        out.push(ch);
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        out.push("  ");
        i += 2;
        continue;
      }
      out.push(ch === "\n" || ch === "\r" ? ch : " ");
      i += 1;
      continue;
    }
    // string modes: copy verbatim until the matching quote (handling
    // backslash escapes); a template literal also ends on its backtick.
    out.push(ch);
    if (ch === "\\") {
      if (next !== undefined) {
        out.push(next);
        i += 2;
        continue;
      }
    } else if (
      (mode === "single" && ch === "'") ||
      (mode === "double" && ch === '"') ||
      (mode === "template" && ch === "`")
    ) {
      mode = "code";
    }
    i += 1;
  }
  return out.join("");
}

/** 1-based line of a character index. */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * The source-argument text of the Nth `new FontFace(family, source,
 * descriptors?)` call: from the call's open paren, capture up to the
 * SECOND top-level comma with string/paren/brace awareness. Returns
 * null for anything the mini-parser cannot confidently read — the
 * caller then flags the site for human review rather than guessing.
 */
function fontFaceSourceArgument(
  stripped: string,
  callStart: number,
): string | null {
  const open = stripped.indexOf("(", callStart);
  if (open === -1) return null;
  let depth = 0;
  let mode: "code" | "single" | "double" | "template" = "code";
  let commas = 0;
  let arg = "";
  for (let i = open; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (mode === "code") {
      if (ch === "(") {
        depth++;
        if (depth > 1) arg += ch;
        continue;
      }
      if (ch === ")" ) {
        depth--;
        if (depth === 0) return commas >= 1 ? arg : null;
        arg += ch;
        continue;
      }
      if (ch === ",") {
        if (depth === 1) {
          commas++;
          if (commas >= 2) return arg;
          arg = "";
          continue;
        }
        arg += ch;
        continue;
      }
      if (ch === "'") mode = "single";
      else if (ch === '"') mode = "double";
      else if (ch === "`") mode = "template";
      arg += ch;
      continue;
    }
    arg += ch;
    if (ch === "\\") {
      const next = stripped[i + 1];
      if (next !== undefined) {
        arg += next;
        i += 1;
      }
    } else if (
      (mode === "single" && ch === "'") ||
      (mode === "double" && ch === '"') ||
      (mode === "template" && ch === "`")
    ) {
      mode = "code";
    }
  }
  return null;
}

/** A `new FontFace` source argument is conformant iff it is a quoted
 *  url(...) literal (template `url(${…})` included). */
const URL_SOURCE = /^\s*(['"`])\s*url\(/;

/** sfnt flavor tags and table tags, read as string literals. */
const SFNT_TAG =
  /(["'])(ttcf|OTTO|wOFF|wOF2|glyf|cmap|loca|hmtx|maxp|GSUB|GPOS|fvar|CFF |VORG|CBDT|sbix|COLR|CPAL)\1/g;

/** The banned-pattern regexes over comment-stripped code. */
const TEXT_PATTERNS: ReadonlyArray<{ id: string; re: RegExp; label: string }> = [
  { id: "indexeddb", re: /\bindexedDB\b|\bopenDb\s*\(/g, label: "IndexedDB usage" },
  {
    id: "zip",
    re: /\bDecompressionStream\b|\binflateRaw\b|\bunzip\b/g,
    label: "zip/decompression handling",
  },
  {
    id: "hashing",
    re: /\bcrypto\s*\.\s*subtle\s*\.\s*digest\s*\(/g,
    label: "byte hashing (crypto.subtle.digest)",
  },
];

function isExempt(file: string, pattern: string): boolean {
  return SCHEDULED_DELETIONS.some(
    (entry) => entry.file === file && entry.patterns.includes(pattern),
  );
}

function fontfaceBudget(file: string): number {
  for (const entry of NON_URL_FONTFACE_BUDGET) {
    if (entry.file === file) return entry.budget;
  }
  return 0;
}

function* matchAll(source: string, re: RegExp): Generator<number> {
  const regex = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    yield match.index;
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(join(dir, entry.name));
        continue;
      }
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!SOURCE_EXT.has(ext)) continue;
      out.push(join(dir, entry.name));
    }
  };
  await visit(root);
  return out;
}

async function scanFile(abs: string, rel: string): Promise<Violation[]> {
  const raw = await readFile(abs, "utf8");
  const stripped = stripComments(raw);
  const violations: Violation[] = [];
  const push = (pattern: string, index: number, excerpt: string): void => {
    if (isExempt(rel, pattern)) return;
    violations.push({
      pattern,
      file: rel,
      line: lineOf(raw, index),
      excerpt: excerpt.trim().slice(0, 120),
    });
  };

  for (const { id, re, label } of TEXT_PATTERNS) {
    for (const index of matchAll(stripped, re)) {
      push(id, index, stripped.slice(index, index + 60) || label);
    }
  }

  // sfnt table/flavor tags read as literals.
  const tags = new RegExp(SFNT_TAG.source, SFNT_TAG.flags);
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tags.exec(stripped)) !== null) {
    push("sfnt-magic", tagMatch.index, stripped.slice(tagMatch.index, tagMatch.index + 30));
  }

  // Non-URL FontFace construction.
  let nonUrl = 0;
  for (const index of matchAll(stripped, /new\s+FontFace\s*\(/g)) {
    const source = fontFaceSourceArgument(stripped, index);
    if (source !== null && URL_SOURCE.test(source)) continue;
    nonUrl++;
    if (nonUrl > fontfaceBudget(rel)) {
      push(
        "fontface",
        index,
        `new FontFace(…, ${source === null ? "<unparseable source>" : source.slice(0, 60)})`,
      );
    }
  }
  return violations;
}

test("frontend source carries no banned business patterns (guard v1)", async () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!(await stat(abs).then(() => true).catch(() => false))) continue;
    files.push(...(await collectSourceFiles(abs)));
  }
  // The guard must actually see the tree it guards.
  expect(files.filter((f) => f.includes(join("gui", "src"))).length).toBeGreaterThan(50);

  const violations: Violation[] = [];
  for (const abs of files) {
    violations.push(...(await scanFile(abs, repoRelative(abs))));
  }
  // Every exemption must name a file that exists (a stale entry after
  // its ticket lands is itself a failure — the table stays honest).
  for (const entry of [...SCHEDULED_DELETIONS, ...NON_URL_FONTFACE_BUDGET]) {
    const abs = join(REPO_ROOT, entry.file);
    expect(
      await stat(abs).then(
        () => true,
        () => false,
      ),
      `exemption names a missing file: ${entry.file}`,
    ).toBe(true);
  }

  expect(
    violations.map((v) => `${v.pattern} ${v.file}:${v.line} ${v.excerpt}`),
    "banned frontend business patterns found (spec #25 seam 3):\n" +
      violations.map((v) => `  ${v.pattern}  ${v.file}:${v.line}  ${v.excerpt}`).join("\n") +
      "\n",
  ).toEqual([]);
});
