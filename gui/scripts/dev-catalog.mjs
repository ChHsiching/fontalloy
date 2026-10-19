/**
 * The REAL dev catalog — the same families production serves, from the
 * repo's own single source of truth, so `npm run dev` (gui) and the
 * built WebApp under `vite preview` (web) show the picker/rail/grid the
 * validated prototype shows: every real family row with real meta and
 * real glyph rendering (repair round 2; supersedes the 5-host-font
 * fixture of round 1).
 *
 * Served by the vite dev AND preview servers (never built):
 *
 *   GET /dev-catalog/catalog-release.json   the bootstrap document
 *   GET /dev-catalog/origins/dev/<Zip>      one family zip per request
 *
 * Metadata comes from `assets/fonts.manifest.json` (ADR-0005: every
 * family with its real name, license, variant). Font BYTES come from,
 * in priority order (round 9, owner item 1 — the startup download must
 * reach EVERY family, zero 未下载 when online):
 *
 * 1. a local fonts directory — the env override, the gui prototype
 *    checkout next to this worktree (`<sibling>/fontalloy/gui/
 *    prototype/fonts`), an in-tree prototype branch checkout, or the
 *    repo's own fetch layout (`assets/fonts/`); the binaries are
 *    gitignored everywhere and are only ever READ here;
 * 2. the pinned UPSTREAM artifact, fetched ONCE over the network into
 *    a gitignored cache (`gui/.dev-catalog-cache/`), sha256-verified
 *    against the manifest's pin, and (for zip artifacts) unpacked —
 *    EVERY face the artifact carries, because the dev catalog honors
 *    the production release schema (catalog-release.yml: one zip per
 *    family, ALL faces). A one-face catalog starves the weight matrix:
 *    the family-cut pattern pools what exists, and a Regular-only
 *    layout builds a single 400 slot (the round-15/16 owner report).
 *    The cache is reused verbatim on later boots; a stale entry
 *    (manifest sha moved) is fetched again.
 *
 * Round 20 (owner item 2): resolution and fetching are PER VARIANT
 * ENTRY. Every multi-entry manifest family serves EVERY cut's faces —
 * each entry's ARTIFACT STEM resolves its own faces (the fetch layout
 * extracts `<archive stem>/` one level under the fonts dir, robust for
 * versioned and numbered archive names like HackGen_NF_v2.10.0 and
 * 14_SourceHanSansHWSC; round 17's cut-stem PREFIX matching never saw
 * those), and the family's release zip is the UNION of all entries'
 * faces with the primary face following the DEFAULT entry. The
 * upstream pass fetches PER ENTRY (the round-9 by-FAMILY fetch pulled
 * only the DEFAULT entry's artifact, so NotoSansSC's HW and Mono cuts
 * were never even unpacked locally); each fetched artifact unpacks
 * into its own cache faces dir keyed by the same artifact stem. An
 * entry whose fetch fails stays an honest miss (the cut renders 未下载
 * downstream) — never a silent collapse onto another cut.
 *
 * The per-family file mapping below is explicit (Nerd Fonts renames
 * several families in their patched binaries); the upstream path falls
 * back to a Regular-face match inside the pinned artifact when the
 * alias is absent. Families that fail BOTH paths are skipped and
 * reported on the server console — the honest miss list, never a
 * silent gap.
 *
 * Each family zip is STORED (no deflate — font binaries barely
 * compress and loopback transfer is free) with fixed timestamps like
 * the CI packaging, pinned by sha256. The origin base_url points back
 * at whatever host served the document (a loopback http origin, the
 * documented dev carve-out in catalog/release.ts). When no fonts
 * directory is found AND the upstream fetch yields nothing the
 * document 503s and the app falls back to "catalog unavailable",
 * still fully usable. The production catalog flow is untouched — this
 * plugin never participates in a build and never serves production.
 *
 * Spec #25's final batch: every family entry in the release document
 * ALSO carries its per-cut list (the `cuts` field — the
 * family_docs.variant_cuts port: entries collapsed by their non-weight
 * axis vector, Regular-canonical, default first, each cut with its own
 * resolved faces). One `variant` field per family cannot represent a
 * multi-cut family (MapleMono NF + NF-CN collapsed); the nested cuts
 * make the family's full cut structure visible to a consumer of the
 * document alone, matching what /catalog/families serves.
 *
 * Round 31 (the absolute memory rule): this middleware STREAMS. Face
 * bytes and zip bytes are never resident — the catalog build keeps one
 * streaming pass per face (sha256 + crc32 + size), the pinned zip sha
 * is hashed over the deterministic zip stream, zip requests stream the
 * same bytes from disk under a small concurrency bound, and upstream
 * artifact fetches stream to disk before verification. The round-31
 * heavy run sampled this middleware at ~13.9 GB working set over the
 * ~9.8 GB warm cache (the old buffered build retained ~2x the catalog);
 * gui/tests/dev-catalog-mem.spec.ts pins the flat-memory contract.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rm, open, copyFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, readFileSync, createReadStream } from "node:fs";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * Where the repo's font catalog manifest lives (metadata truth). The
 * env override is the specs' hermetic seam (a crafted manifest against
 * a fake upstream), never set outside tests.
 */
const MANIFEST_PATH = process.env.FONTALLOY_DEV_CATALOG_MANIFEST
  ? resolve(process.env.FONTALLOY_DEV_CATALOG_MANIFEST)
  : resolve(REPO_ROOT, "assets", "fonts.manifest.json");

/**
 * The gitignored upstream-artifact cache (round 9, owner item 1). The
 * env override keeps the specs' fetches off the repo's own cache.
 */
const UPSTREAM_CACHE = process.env.FONTALLOY_DEV_CATALOG_CACHE
  ? resolve(process.env.FONTALLOY_DEV_CATALOG_CACHE)
  : resolve(HERE, "..", ".dev-catalog-cache");

/** Per-artifact fetch timeout — release assets run to tens of MB. */
const FETCH_TIMEOUT_MS = 180_000;

/**
 * Round 27 (owner ruling): the mirror prefixes tried after GitHub
 * direct — release-asset accelerators that proxy the FULL upstream
 * URL (the ghproxy convention). Override with
 * FONTALLOY_DEV_CATALOG_MIRRORS (comma-separated prefixes). Safety is
 * unaffected by the list's contents: every fetched artifact must match
 * the manifest's pinned sha256 before it enters the cache.
 */
const DEFAULT_MIRRORS = [
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://ghproxy.net/",
];

/** The origin list for one pinned artifact: direct, then mirrors. */
function upstreamOrigins(upstreamUrl) {
  const overrides = (process.env.FONTALLOY_DEV_CATALOG_MIRRORS ?? "")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
  const mirrors = overrides.length > 0 ? overrides : DEFAULT_MIRRORS;
  return [upstreamUrl, ...mirrors.map((prefix) => `${prefix}${upstreamUrl}`)];
}

/** A short label for logs: the direct URL, or the mirror's host. */
function originLabel(url, directUrl) {
  if (url === directUrl) return "github-direct";
  try {
    return `mirror ${new URL(url).host}`;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Round 27 (owner ruling: one unpacker, the Python one): extract a
 * sha-verified archive artifact's FONT faces through the core
 * pipeline's own extractor (fontalloy_core.assets.extract_font_faces
 * — zip and 7z alike, sanitized member paths, the exact `assets
 * fetch` code path). No JS archive code remains in this middleware.
 * FONTALLOY_DEV_PYTHON overrides the interpreter outright; the repo's
 * venv (the one the serve itself runs from) is the default.
 */
async function extractArchiveViaPython(artifactPath, faceDir) {
  const code = [
    "import sys",
    "from pathlib import Path",
    "from fontalloy_core.assets import extract_font_faces",
    "faces = extract_font_faces(Path(sys.argv[1]), Path(sys.argv[2]))",
    "print(faces)",
  ].join("\n");
  const candidates = process.env.FONTALLOY_DEV_PYTHON
    ? [process.env.FONTALLOY_DEV_PYTHON]
    : [
        process.platform === "win32"
          ? resolve(REPO_ROOT, ".venv/Scripts/python.exe")
          : resolve(REPO_ROOT, ".venv/bin/python"),
        "python",
      ];
  const run = promisify(execFile);
  let lastError = null;
  for (const python of candidates) {
    try {
      await run(python, ["-c", code, artifactPath, faceDir], {
        cwd: REPO_ROOT,
        timeout: FETCH_TIMEOUT_MS,
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`archive extraction failed (${lastError})`);
}

/** Upstream fetches run with bounded concurrency (be a good citizen). */
const FETCH_CONCURRENCY = 4;

/**
 * Local font-byte candidates, in priority order: the env override, the
 * prototype checkout that lives in the sibling main worktree, then an
 * in-tree prototype branch checkout. The directories are only ever
 * read. Since round 7 the repo's own fetch layout (`assets/fonts/`,
 * filled by `fontalloy assets fetch [--family …]`) is ALSO scanned —
 * flat files plus one level of extracted `<archive stem>/` face
 * directories — so the 22 expansion families (yuru7 merges, the LXGW
 * series, 寒蝉, Glow Sans, 汇文明朝体 …) serve in dev after a plain
 * fetch, without touching the prototype checkout.
 */
function fontDirCandidates() {
  const list = [];
  if (process.env.FONTALLOY_DEV_FONT_DIR) list.push(process.env.FONTALLOY_DEV_FONT_DIR);
  list.push(
    // Round 27 (owner ruling): the prototype layouts are REMOVED as
    // byte sources — the design-draft bundle shipped ONE face per
    // family, and "local first" let that single-Regular file shadow
    // the multi-weight upstream artifact for every family it carried.
    // The remaining local layouts are complete-by-construction: the
    // repo's own fetch layout, and the upstream cache the fetch pass
    // populates per pinned entry.
    resolve(REPO_ROOT, "assets", "fonts"),
    resolve(UPSTREAM_CACHE, "faces"),
  );
  return list;
}

/**
 * Manifest family -> the dev-served font binary. Most Nerd Font
 * families map mechanically (`<Family>NerdFont-Regular.ttf`); the
 * renamed ones and every CJK family are pinned explicitly so a wrong
 * guess can never ship silently. The round-7 expansion families name
 * the Regular face their pinned artifacts extract (`assets/fonts/
 * <archive stem>/…` after `fontalloy assets fetch`).
 */
const FILE_ALIASES = {
  AnonymousPro: "AnonymiceProNerdFont-Regular.ttf",
  AnnotationMono: "AnnotationMNerdFont-Regular.ttf",
  AtkinsonHyperlegibleMono: "AtkynsonMonoNerdFont-Regular.otf",
  AurulentSansMono: "AurulentSansMNerdFont-Regular.otf",
  BigBlueTerminal: "BigBlueTerm437NerdFont-Regular.ttf",
  BitstreamVeraSansMono: "BitstromWeraNerdFont-Regular.ttf",
  CascadiaCode: "CaskaydiaCoveNerdFont-Regular.ttf",
  CascadiaMono: "CaskaydiaMonoNerdFont-Regular.ttf",
  D2Coding: "D2KodingLigatureNerdFont-Regular.ttf",
  DejaVuSansMono: "DejaVuSansMNerdFont-Regular.ttf",
  DroidSansMono: "DroidSansMNerdFont-Regular.otf",
  FantasqueSansMono: "FantasqueSansMNerdFont-Regular.ttf",
  Gohu: "GohuFont11NerdFont-Regular.ttf",
  Hasklig: "HasklugNerdFont-Regular.otf",
  Hermit: "HurmitNerdFont-Regular.otf",
  IBMPlexMono: "BlexMonoNerdFont-Regular.ttf",
  IntelOneMono: "IntoneMonoNerdFont-Regular.ttf",
  LiberationMono: "LiterationMonoNerdFont-Regular.ttf",
  MPlus: "M+1NerdFont-Regular.ttf",
  Meslo: "MesloLGLDZNerdFont-Regular.ttf",
  Monaspace: "MonaspiceArNerdFont-Regular.otf",
  Noto: "NotoMonoNerdFont-Regular.ttf",
  ProFont: "ProFontIIxNerdFont-Regular.ttf",
  Recursive: "RecMonoCasualNerdFont-Regular.ttf",
  ShareTechMono: "ShureTechMonoNerdFont-Regular.ttf",
  SourceCodePro: "SauceCodeProNerdFont-Regular.ttf",
  Terminus: "TerminessNerdFont-Regular.ttf",
  "iA-Writer": "iMWritingDuoNerdFont-Regular.ttf",
  // CJK families (the prototype ships one face per family; the Maple
  // and Source-Han entries are the same typefaces our manifest lists
  // under its MapleMono NF-CN / NotoSerifSC ids).
  MapleMono: "MapleMonoCN-Regular.ttf",
  LXGWWenKai: "LXGWWenKai-Regular.ttf",
  LXGWWenKaiScreen: "LXGWWenKaiScreen-Regular.ttf",
  NotoSansSC: "NotoSansSC-VF.ttf",
  NotoSerifSC: "SourceHanSerifSC-Regular.otf",
  // Round-7 expansion families (served from the assets/fonts fetch
  // layout; Regular faces of the pinned artifacts).
  UDEVGothic: "UDEVGothic-Regular.ttf",
  HackGen: "HackGen-Regular.ttf",
  PlemolJP: "PlemolJP35ConsoleNF-Regular.ttf",
  BizinGothic: "BizinGothic-Regular.ttf",
  GuguruSansCode: "GuguruSansCodeConsole35NF-Regular.ttf",
  SourceHanCodeJP: "SourceHanCodeJP.ttc",
  LxgwNeoXiHei: "LXGWNeoXiHei.ttf",
  LxgwNeoXiHeiCode: "NeoXiHeiCode-Regular.ttf",
  LxgwNeoZhiSong: "LXGWNeoZhiSong.ttf",
  Xiaolai: "Xiaolai-Regular.ttf",
  XiaolaiMono: "XiaolaiMono-Regular.ttf",
  LxgwWenKaiTC: "LXGWWenKaiTC-Regular.ttf",
  LxgwWenKaiMonoTC: "LXGWWenKaiMonoTC-Regular.ttf",
  LxgwZhenKai: "LXGWZhenKaiGB-Regular.ttf",
  Yozai: "Yozai-Regular.ttf",
  LxgwMarkerGothic: "LXGWMarkerGothic-Regular.ttf",
  Chillkai: "ChillKai.ttf",
  ChillRoundGothic: "ChillRoundGothic_Regular.otf",
  ChillRound: "ChillRoundM.otf",
  GlowSans: "GlowSansSC-Normal-Regular.otf",
  HuiwenMincho: "Huiwenmincho-improved.otf",
};

/**
 * Families the committed manifest does NOT pin (upstream pinning is a
 * documented follow-up) but the validated prototype ships and the dev
 * catalog serves locally from the same fonts directory: the five CJK
 * families the parity matrix flagged as honest misses (得意黑 / 更纱黑体 /
 * 方舟像素 / 缝合像素 / 朱雀仿宋). Skipped with a console note when the
 * local binary is absent — never a silent gap, and never served by a
 * production catalog.
 */
const EXTRA_DEV_FAMILIES = [
  { family: "SmileySans", file: "SmileySans-Oblique.otf" },
  { family: "SarasaGothic", file: "SarasaMonoSC-Regular.ttf" },
  { family: "ZhuqueFangsong", file: "ZhuqueFangsong-Regular.ttf" },
  { family: "ArkPixel", file: "ark-pixel-12px-monospaced-zh_hans.ttf" },
  { family: "FusionPixel", file: "fusion-pixel-12px-monospaced-zh_hans.otf" },
];

/* ---------- the pinned-upstream fetch pass (round 9, owner item 1) ---------- */

const FONT_EXT_RE = /\.(ttf|otf|ttc|woff2?)$/i;

/**
 * The manifest entry a fetched family serves: the same canonical-cut
 * preference `chooseVariant` applies to local files (Regular > Variable
 * > Standard > catalog order), so the served face and its declared
 * variant always agree.
 */
const CANONICAL_ENTRIES = ["Regular", "Variable", "Standard", "Light", "Medium"];

function defaultEntryFor(entries) {
  for (const variant of CANONICAL_ENTRIES) {
    const hit = entries.find((e) => e.variant === variant);
    if (hit) return hit;
  }
  return entries[0];
}

/** Read a zip's entries: basename -> bytes (stored + deflate). */

/**
 * The cache identity of one manifest ENTRY: its artifact stem (the
 * artifact's own name minus its extension — zip, 7z, or a bare font
 * file alike) — the same name the fetch layout extracts
 * (`assets/fonts/<stem>/`) and the upstream cache unpacks into
 * (`faces/<stem>/`). Unique per entry (each entry pins its own
 * upstream artifact) and a legal directory name on every host; keeping
 * the extension OUT matters: a `faces/X.ttf/` directory would shadow
 * the font file `X.ttf` in the flat-name scan.
 */
function entryKey(entry) {
  return basename(entry.file).replace(/\.[^.]+$/, "");
}

/**
 * The face names one manifest entry contributes from the scanned local
 * layouts (round 20, owner item 2):
 *
 * - a FONT-file entry (a bare ttf/otf/ttc) is its own face, wherever a
 *   layout carries it;
 * - an ARCHIVE entry resolves its extraction directory `<stem>/` —
 *   `14_SourceHanSansHWSC`, `HackGen_NF_v2.10.0`, the upstream cache's
 *   per-entry dirs — plus round 17's flat dash/exact stem files for
 *   prototype-style layouts.
 *
 * An entry with zero faces is absent locally: the upstream pass fetches
 * it (per entry — a family whose DEFAULT entry is present still fetches
 * its siblings' artifacts).
 */
function entryFaceNames(entry, available, bySubdir) {
  const file = basename(entry.file);
  if (FONT_EXT_RE.test(file)) {
    return available.has(file) ? [file] : [];
  }
  const stem = entryKey(entry);
  const out = new Set();
  const sub = bySubdir.get(stem);
  if (sub) for (const name of sub.keys()) out.add(name);
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dash = new RegExp(`^${esc}-[^-]+\\.(ttf|otf|ttc|woff2?)$`, "i");
  const exact = new RegExp(`^${esc}\\.(ttf|otf|ttc|woff2?)$`, "i");
  for (const name of available.keys()) {
    if (dash.test(name) || exact.test(name)) out.add(name);
  }
  return [...out].sort();
}

/**
 * The face-stem prefix a font file belongs to: everything before the
 * last dash segment (NF and CJK naming alike, `<Family>-<Style>.ttf`;
 * a dashless name is its own prefix). Sibling faces share the prefix,
 * look-alike families do not (JetBrainsMonoNerdFont vs
 * JetBrainsMonoNLNerdFont).
 */
function faceStemPrefix(file) {
  const stem = file.replace(/\.[^.]+$/, "");
  const idx = stem.lastIndexOf("-");
  return idx === -1 ? stem : stem.slice(0, idx);
}

/**
 * Every face of the family the resolved file belongs to, across the
 * scanned layouts: all available files sharing its face-stem prefix,
 * the resolved face always among them. Sorted for byte-reproducible
 * zips.
 */
function familyFaces(resolvedFile, available) {
  const prefix = faceStemPrefix(resolvedFile);
  return [...available.keys()]
    .filter((name) => FONT_EXT_RE.test(name) && faceStemPrefix(name) === prefix)
    .sort();
}

/**
 * Fetch ONE manifest ENTRY's pinned upstream artifact (cached,
 * sha256-verified) and unpack EVERY face it carries into the cache's
 * per-entry faces layout (`faces/<artifact stem>/`). Returns the
 * unpacked face names, or null when the network pass is disabled.
 * `force` refetches an artifact whose cached bytes no longer match the
 * manifest pin. An error THROWS to the caller — the entry stays an
 * honest miss with its reason.
 */
async function fetchEntryUpstream(entry, force = false) {
  const file = basename(entry.file);
  const isFontFile = FONT_EXT_RE.test(file);
  const isZip = /\.zip$/i.test(file);
  const is7z = /\.7z$/i.test(file);
  // Round 27 (owner: 7z 解起来又不困难): 7z artifacts unpack through
  // the repo's own Python (py7zr — the core pipeline's unpacker, the
  // same one `fontalloy assets fetch` uses) instead of being honest
  // misses. Tar-family archives remain honest misses; nothing else
  // ships in the manifest.
  if (!isFontFile && !isZip && !is7z) {
    throw new Error(`${file}: unsupported archive in the JS dev pass — fetch via fontalloy assets fetch`);
  }
  const key = entryKey(entry);
  const artifactDir = resolve(UPSTREAM_CACHE, "artifacts", key);
  const faceDir = resolve(UPSTREAM_CACHE, "faces", key);
  const artifactPath = resolve(artifactDir, file);
  const markerPath = resolve(faceDir, ".source-sha256");

  // The marker carries an extraction VERSION: v2 extracts every face
  // (round 17) — a v1 cache (the one-Regular-face era) fails the check
  // once and re-extracts the full family. A warm entry (marker ok,
  // faces present) never touches the network or the artifact again.
  const markerOk = () => {
    if (force || !existsSync(markerPath)) return false;
    try {
      return readFileSync(markerPath, "utf8").trim() === `v2 ${entry.sha256}`;
    } catch {
      return false;
    }
  };
  if (markerOk() && existsSync(faceDir)) {
    const warm = (await readdir(faceDir)).filter((n) => FONT_EXT_RE.test(n));
    if (warm.length > 0) return warm.sort();
  }

  // The artifact lives ON DISK only (round-31 memory rule): a cached
  // artifact is hash-verified by streaming over the file, a fetch
  // streams to a .part file that is renamed into place only after the
  // sha matches — tens-of-MB artifacts are never resident in this
  // process, even with four concurrent fetches.
  let artifactOnDisk = false;
  if (existsSync(artifactPath)) {
    if ((await shaFile(artifactPath)) === entry.sha256) artifactOnDisk = true;
  }
  if (!artifactOnDisk) {
    // Offline/hermetic runs opt out of the network pass entirely.
    if (process.env.FONTALLOY_DEV_CATALOG_FETCH === "0") {
      console.info(
        `[dev-catalog] upstream fetch disabled (FONTALLOY_DEV_CATALOG_FETCH=0): ${entry.family}::${entry.variant}`,
      );
      return null;
    }
    // Round 27 (owner ruling: 抓不到是不允许的): the pinned artifact is
    // fetched through an ORIGIN LIST — GitHub direct first, then the
    // mirror prefixes — until one answers. Every origin is equally
    // safe: the bytes must match the manifest's pinned sha256 or the
    // artifact is rejected, so a proxy can never poison the catalog.
    const reasons = [];
    await mkdir(artifactDir, { recursive: true });
    const tmpPath = `${artifactPath}.part`;
    for (const url of upstreamOrigins(entry.upstream_url)) {
      console.info(`[dev-catalog] fetching upstream ${entry.file} (${entry.family}::${entry.variant}) via ${originLabel(url, entry.upstream_url)}`);
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          reasons.push(`${originLabel(url, entry.upstream_url)}: HTTP ${res.status}`);
          continue;
        }
        if (!res.body) {
          reasons.push(`${originLabel(url, entry.upstream_url)}: empty body`);
          continue;
        }
        await rm(tmpPath, { force: true }).catch(() => {});
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));
        const actual = await shaFile(tmpPath);
        if (actual !== entry.sha256) {
          reasons.push(
            `${originLabel(url, entry.upstream_url)}: sha256 mismatch (want ${entry.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
          );
          await rm(tmpPath, { force: true }).catch(() => {});
          continue;
        }
        await rename(tmpPath, artifactPath);
        artifactOnDisk = true;
        break;
      } catch (err) {
        reasons.push(`${originLabel(url, entry.upstream_url)}: ${err instanceof Error ? err.message : String(err)}`);
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    }
    if (!artifactOnDisk) {
      throw new Error(reasons.join("; "));
    }
  }

  // Unpack EVERY face the artifact carries (the dev catalog serves
  // full families — a Regular-only cache starves the weight matrix).
  await mkdir(faceDir, { recursive: true });
  if (isFontFile) {
    // A bare font-file entry: the artifact IS the face (copied on
    // disk; the bytes never pass through this process).
    await copyFile(artifactPath, resolve(faceDir, file));
  } else {
    // Round 27 (owner ruling: one unpacker, the Python one): zip AND
    // 7z artifacts extract through the core pipeline's own extractor
    // (fontalloy_core.assets.extract_font_faces — magic-byte format
    // detection, sanitized member paths, the exact `assets fetch`
    // code path). The bytes are already sha-verified on disk; the raw
    // artifact is pruned below once its faces + marker exist.
    await extractArchiveViaPython(artifactPath, faceDir);
    const faces = (await readdir(faceDir)).filter((n) => FONT_EXT_RE.test(n));
    if (faces.length === 0) throw new Error(`${entry.file} carries no font file`);
  }
  await writeFile(markerPath, `v2 ${entry.sha256}\n`);
  // Round 27: the RAW artifact is pruned once its faces + marker are
  // on disk — the upstream zips run to tens of MB each (they carry
  // every cut and platform) and would balloon the cache by GBs. A
  // warm entry never reads the zip again; a cold re-extraction
  // refetches through the origin list.
  await rm(artifactPath, { force: true }).catch(() => {});
  return (await readdir(faceDir)).filter((n) => FONT_EXT_RE.test(n)).sort();
}

/**
 * Fill the cache's per-entry faces layout for every manifest entry the
 * local layouts lack (round 20: PER ENTRY — the round-9 pass fetched
 * only each family's DEFAULT entry, so a family whose default cut was
 * present never got its siblings). A single-entry family already
 * served through the prototype-alias fallback counts as present: the
 * alias IS that family's local serving.
 */
async function fillUpstreamCache(manifest, available, bySubdir, manifestFiles) {
  const byFamily = new Map();
  for (const entry of manifest.families) {
    if (!byFamily.has(entry.family)) byFamily.set(entry.family, []);
    byFamily.get(entry.family).push(entry);
  }
  const wanted = [];
  for (const [family, entries] of byFamily) {
    const aliasPresent =
      entries.length === 1 &&
      resolveFamilyFile(family, available, manifestFiles.get(family) ?? []) !== null;
    for (const entry of entries) {
      if (aliasPresent) continue;
      if (entryFaceNames(entry, available, bySubdir).length > 0) continue;
      wanted.push(entry);
    }
  }
  if (wanted.length === 0) return { fetched: 0, errors: [] };
  const errors = [];
  let fetched = 0;
  let done = 0;
  const queue = [...wanted];
  const worker = async () => {
    for (;;) {
      const entry = queue.shift();
      if (entry === undefined) return;
      try {
        const faces = await fetchEntryUpstream(entry);
        if (faces !== null) fetched++;
      } catch (err) {
        errors.push(
          `${entry.family}::${entry.variant}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      done++;
      if (done % 10 === 0 || done === wanted.length) {
        console.info(`[dev-catalog] upstream pass ${done}/${wanted.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return { fetched, errors };
}

/* ---------- stored-zip streaming (bounded memory — the round-31 absolute rule) ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC32 (init 0xffffffff, finalize ^ 0xffffffff). */
function crc32Update(crc, buf) {
  let c = crc;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** Fixed 2026-01-01 local-header date, like the CI packaging. */
const DOS_TIME = 0x0000;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

/** The IO chunk every streamed read/hash/serve path uses (1 MiB). */
const CHUNK_BYTES = 1024 * 1024;

/** A file's digest facts in ONE bounded-memory streaming pass. */
async function scanFace(path) {
  const fh = await open(path, "r");
  try {
    const hash = createHash("sha256");
    let crc = 0xffffffff;
    let size = 0;
    const buf = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const view = bytesRead === CHUNK_BYTES ? buf : buf.subarray(0, bytesRead);
      hash.update(view);
      crc = crc32Update(crc, view);
      size += bytesRead;
    }
    return { sha256: hash.digest("hex"), crc32: (crc ^ 0xffffffff) >>> 0, size };
  } finally {
    await fh.close();
  }
}

/** The sha256 of a file on disk, streamed (never resident whole). */
async function shaFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * The family release zip as a CHUNK of Buffers — the EXACT stored-zip
 * layout the buffered writer emitted (local headers, raw face bytes
 * streamed from disk, then central directory + EOCD), so the pinned
 * zipSha256 and the served bytes stay byte-identical to the old build
 * while nothing larger than a chunk is ever resident. Face payloads
 * ride a ReadableStream (each chunk a distinct Buffer — safe for
 * consumers like res.write that may retain).
 * @param {Array<{file: string, path: string, crc32: number, size: number}>} faces
 */
async function* zipStream(faces) {
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const face of faces) {
    const nameBuf = Buffer.from(face.file, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(face.crc32, 14);
    local.writeUInt32LE(face.size, 18);
    local.writeUInt32LE(face.size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    yield local;
    yield nameBuf;
    for await (const chunk of createReadStream(face.path, { highWaterMark: CHUNK_BYTES })) {
      yield /** @type {Buffer} */ (chunk);
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(face.crc32, 16);
    cd.writeUInt32LE(face.size, 20);
    cd.writeUInt32LE(face.size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + face.size;
  }
  yield* central;
  const centralLen = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(faces.length, 8);
  eocd.writeUInt16LE(faces.length, 10);
  eocd.writeUInt32LE(centralLen, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  yield eocd;
}

/** The deterministic zip's sha256 — hashed over the stream, never resident. */
async function zipSha256Of(faces) {
  const hash = createHash("sha256");
  for await (const chunk of zipStream(faces)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Zip REQUESTS are bounded too (the absolute rule): at most this many
 * generations stream concurrently, so a first-run full-catalog
 * download cannot fan disk reads unboundedly.
 */
const ZIP_SERVE_CONCURRENCY = 3;
let zipActive = 0;
/** @type {Array<() => void>} */
const zipWaiters = [];

/** Stream one family zip to the response, honoring backpressure. */
async function serveFamilyZip(family, res, cors) {
  res.writeHead(200, { ...cors, "content-type": "application/zip" });
  if (zipActive >= ZIP_SERVE_CONCURRENCY) {
    await new Promise((release) => zipWaiters.push(release));
  }
  zipActive++;
  try {
    for await (const chunk of zipStream(family.faces)) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await once(res, "drain");
    }
    res.end();
  } catch (err) {
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    zipActive--;
    zipWaiters.shift()?.();
  }
}

/* ---------- the catalog, built once on first request ---------- */

/**
 * The served font file for a family on the FALLBACK path only (round
 * 20: no entry of the family resolved its own faces): the explicit
 * alias, the manifest's own pinned font-file names, then the
 * mechanical Nerd Fonts renaming.
 */
function resolveFamilyFile(family, available, manifestFiles = []) {
  const alias = FILE_ALIASES[family];
  if (alias && available.has(alias)) return alias;
  for (const pinned of manifestFiles) {
    if (available.has(pinned)) return pinned;
  }
  const compact = family.replace(/-/g, "");
  for (const candidate of [
    `${compact}NerdFont-Regular.ttf`,
    `${compact}NerdFont-Regular.otf`,
  ]) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}/**
 * @typedef {{variant: string, def: boolean, label: string, file: string,
 *            version?: string, sha256: string, axes?: Record<string, string>,
 *            files: Array<{file: string, sha256: string}>}} CatalogCut
 */
/**
 * The served catalog family — METADATA ONLY (round-31 absolute memory
 * rule): digest facts and the on-disk path per face, the zip's pinned
 * sha256 (hashed over the deterministic stream at build). No font
 * byte and no zip byte is ever resident in this process; zips stream
 * from disk at serve time (see zipStream / serveFamilyZip).
 * @typedef {{family: string, variant: string | undefined, cuts: CatalogCut[] | null, zip: string, zipSha256: string,
 *            file: string, fileSha256: string,
 *            faces: Array<{file: string, sha256: string, crc32: number, size: number, path: string}>}} CatalogFamily
 */

/** @type {Promise<{families: CatalogFamily[], misses: string[]}> | null} */
let catalogPromise = null;

/**
 * The manifest VARIANT a served file belongs to (round 6): one-entry
 * families answer directly; multi-variant families (MapleMono NF vs
 * NF-CN) disambiguate by matching the variant zip's distinguishing
 * tokens against the served file name — MapleMonoCN-Regular.ttf
 * carries the CN token, so it is the NF-CN variant.
 */
/**
 * Tie-break preference for otherwise-equal variant matches: the plain
 * cut a dev layout serves by default (round 7: catalog.json sorts
 * variants alphabetically, so a bare tie would pick e.g. HW over the
 * Variable face the prototype actually ships).
 */
const CANONICAL_VARIANTS = ["Regular", "Variable", "Standard", "Light", "Medium"];

/* ---------- the cut model (the family_docs.variant_cuts port) ---------- */

/**
 * The typed-axes cut structure (the spec #25 final-batch fix): a
 * family's manifest entries collapse by their non-weight axis vector
 * into CUTS — exactly what the serve's /catalog/families documents and
 * variant_cuts() computes core-side. The release document carries the
 * same list per family (one nested entry per cut), so a multi-cut
 * family (MapleMono NF + NF-CN) is REPRESENTABLE in the document
 * alone — the old single `variant` field collapsed it and a
 * manifest-less consumer could not tell the cuts apart.
 */
const CUT_AXES = ["icons", "ligature", "cjk_width", "region", "charset", "rendering"];

/** The implicit per-axis defaults a family's cuts disagree against. */
const CUT_IMPLICIT_DEFAULTS = {
  icons: "plain",
  ligature: "liga",
  cjk_width: "prop",
  charset: "full",
  rendering: "print",
};

/** Variant strings that are weight names (anything else collapses to Regular). */
const CUT_WEIGHT_NAMES = new Set([
  "Thin",
  "ExtraLight",
  "Light",
  "Regular",
  "Medium",
  "SemiBold",
  "Bold",
  "ExtraBold",
  "Black",
]);

/** The weight an entry effectively carries (axes first, else its variant word). */
function cutEntryWeight(entry) {
  const recorded = entry.axes?.weight;
  if (recorded !== undefined) return recorded;
  return CUT_WEIGHT_NAMES.has(entry.variant) ? entry.variant : "Regular";
}

/** One axis's effective value (weight special-cased; region carries no default). */
function cutAxis(entry, axis) {
  if (axis === "weight") return cutEntryWeight(entry);
  const value = entry.axes?.[axis];
  if (value !== undefined) return value;
  return CUT_IMPLICIT_DEFAULTS[axis] ?? null;
}

/**
 * The cut's DATA label: the artifact's OWN stem minus the catalog's
 * leading index numbering and a trailing version (the data_cut_label
 * port — `14_SourceHanSansHWSC.zip` → `SourceHanSansHWSC`).
 */
function dataCutLabel(file, variant) {
  let stem = file.replace(/\.[^.]+$/, "").replace(/^\d+_/, "");
  stem = stem.replace(/[-_]v?\d+(\.\d+)+([-_].*)?$/, "");
  return stem || variant;
}

/**
 * The cuts of one family (the variant_cuts port): entries bucketed by
 * their non-weight axis vector, the canonical member of each bucket
 * preferring the Regular weight, the default cut first. Returns
 * `{ entry, members, def }[]`.
 */
function variantCuts(entries) {
  if (entries.length === 0) return [];
  const buckets = [];
  const byKey = new Map();
  for (const entry of entries) {
    const key = CUT_AXES.map((axis) => cutAxis(entry, axis) ?? "").join("|");
    if (!byKey.has(key)) {
      byKey.set(key, []);
      buckets.push(byKey.get(key));
    }
    byKey.get(key).push(entry);
  }
  const canonical = buckets.map((members) => ({
    members,
    entry: members.find((m) => cutEntryWeight(m) === "Regular") ?? members[0],
  }));
  const values = (axis) => {
    const seen = [];
    for (const { entry } of canonical) {
      const value = cutAxis(entry, axis);
      if (value !== null && !seen.includes(value)) seen.push(value);
    }
    return seen;
  };
  const contrasting = CUT_AXES.filter((axis) => values(axis).length > 1);
  const defaultVector = {};
  for (const axis of contrasting) {
    const vals = values(axis);
    const implicit = CUT_IMPLICIT_DEFAULTS[axis];
    defaultVector[axis] = implicit !== undefined && vals.includes(implicit)
      ? implicit
      : vals[0];
  }
  const defaultEntry = canonical.find(({ entry }) =>
    contrasting.every((axis) => cutAxis(entry, axis) === defaultVector[axis]),
  )?.entry ?? canonical[0].entry;
  const cuts = canonical.map(({ entry, members }) => ({
    entry,
    members,
    def: entry === defaultEntry,
  }));
  cuts.sort((a, b) => Number(b.def) - Number(a.def)); // stable: default first
  return cuts;
}

function chooseVariant(family, file, manifest) {
  const variants = manifest.families.filter((e) => e.family === family);
  if (variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0].variant;
  const lower = file.toLowerCase();
  const stemOf = (name) => name.replace(/\.[^.]+$/, "").toLowerCase();
  // 1. The variant whose pinned FILE is exactly the served one.
  const exact = variants.find((e) => stemOf(e.file) === stemOf(file));
  if (exact) return exact.variant;
  // 2. Token overlap of the variant's file stem with the served name.
  let best = null;
  let bestScore = -1;
  for (const entry of variants) {
    const tokens = stemOf(entry.file)
      .split(/[-_\s]+/)
      .filter((t) => t && t !== family.toLowerCase());
    const score = tokens.filter((t) => lower.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (bestScore > 0 && best) return best.variant;
  // 3. Canonical plain-cut preference, else catalog order.
  for (const name of CANONICAL_VARIANTS) {
    const hit = variants.find((e) => e.variant === name);
    if (hit) return hit.variant;
  }
  return variants[0].variant;
}

function buildCatalog() {
  catalogPromise ??= (async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

    // Every candidate directory that exists contributes its font files:
    // the flat entries plus one level of subdirectories (the fetch
    // layout extracts archive faces into `<archive stem>/`). A basename
    // seen in an earlier directory wins (the priority order above).
    // `bySubdir` indexes the one-level-down faces by their directory
    // name, so per-ENTRY stem resolution can find an extraction dir
    // even when its basenames collide with another layout's.
    const scanDirs = async () => {
      /** @type {Map<string, string>} basename -> absolute path */
      const available = new Map();
      /** @type {Map<string, Map<string, string>>} subdir -> (face -> path) */
      const bySubdir = new Map();
      const foundDirs = [];
      for (const candidate of fontDirCandidates()) {
        if (!existsSync(candidate)) continue;
        foundDirs.push(candidate);
        const names = (await readdir(candidate)).filter((name) => !name.startsWith("."));
        for (const name of names) {
          const abs = resolve(candidate, name);
          // A directory is a directory whatever its name (a cache entry
          // dir must never shadow a same-named font FILE in the scan).
          let isDir = false;
          try {
            isDir = statSync(abs).isDirectory();
          } catch {
            continue;
          }
          if (isDir) {
            const faces = bySubdir.get(name) ?? new Map();
            bySubdir.set(name, faces);
            for (const inner of await readdir(abs)) {
              if (!FONT_EXT_RE.test(inner)) continue;
              if (!faces.has(inner)) faces.set(inner, resolve(abs, inner));
              if (!available.has(inner)) available.set(inner, resolve(abs, inner));
            }
            continue;
          }
          if (FONT_EXT_RE.test(name) && !available.has(name)) available.set(name, abs);
        }
      }
      return { available, bySubdir, foundDirs };
    };

    let { available, bySubdir, foundDirs } = await scanDirs();

    // The manifest's own pinned file names per family (the DEFAULT
    // entry's first — the alias-fallback path consults them).
    const byFamily = new Map();
    for (const entry of manifest.families) {
      if (!byFamily.has(entry.family)) byFamily.set(entry.family, []);
      byFamily.get(entry.family).push(entry);
    }
    const manifestFiles = new Map(
      [...byFamily].map(([family, entries]) => [
        family,
        [defaultEntryFor(entries), ...entries].map((e) => basename(e.file)),
      ]),
    );

    // Round 9 (owner item 1) / round 20 (per entry): entries no local
    // layout carries come from the manifest's pinned upstream
    // artifacts — fetched ONCE into the gitignored cache,
    // sha256-verified, each unpacked into its OWN faces dir — then the
    // scan runs again so the fetched faces ride the exact same serving
    // path as locals.
    const upstream = await fillUpstreamCache(manifest, available, bySubdir, manifestFiles);
    if (upstream.fetched > 0 || upstream.errors.length > 0) {
      const rescan = await scanDirs();
      available = rescan.available;
      bySubdir = rescan.bySubdir;
      foundDirs = rescan.foundDirs;
      if (upstream.errors.length > 0) {
        console.warn(
          `[dev-catalog] upstream fetch failed for: ${upstream.errors.join("; ")}`,
        );
      }
    }
    if (foundDirs.length === 0) {
      console.warn(
        `[dev-catalog] no local fonts directory found (tried ${fontDirCandidates()
          .map((p) => `"${p}"`)
          .join(", ")}); set FONTALLOY_DEV_FONT_DIR — serving 503`,
      );
      return { families: [], misses: [] };
    }

    /** @type {CatalogFamily[]} */
    const families = [];
    /** @type {string[]} */
    const misses = [];
    const seen = new Set();
    for (const entry of manifest.families) {
      // One release family per manifest family id (the release schema is
      // unique by family).
      if (seen.has(entry.family)) continue;
      seen.add(entry.family);
      const entries = byFamily.get(entry.family) ?? [entry];

      // Round 20 (owner item 2): PER VARIANT ENTRY. Each entry's
      // artifact stem resolves its OWN cut's faces (its extraction
      // dir, the upstream cache's per-entry dir, or round 17's flat
      // dash/exact stem files); the family's release zip is the UNION
      // of all entries' faces, so every chip serves its own cut. The
      // primary face follows the DEFAULT entry (its Regular, else its
      // plainest face) — chooseVariant reads it unchanged.
      /** @type {Map<object, string[]>} entry -> its resolved face names */
      const entryFaces = new Map();
      /** @type {Map<string, string>} face -> path */
      const union = new Map();
      let defaultFaces = [];
      const defaultEntry = defaultEntryFor(entries);
      for (const e of entries) {
        const names = entryFaceNames(e, available, bySubdir);
        entryFaces.set(e, names);
        if (e === defaultEntry) defaultFaces = names;
        for (const name of names) {
          if (!union.has(name)) union.set(name, available.get(name));
        }
      }

      let file;
      let faceNames;
      if (union.size > 0) {
        faceNames = [...union.keys()].sort();
        file =
          defaultFaces.find((n) => /regular/i.test(n)) ??
          defaultFaces[0] ??
          faceNames.find((n) => /regular/i.test(n)) ??
          faceNames[0];
      } else {
        // No entry of the family resolved locally: the prototype-alias
        // fallback (one face pinned by FILE_ALIASES or the manifest's
        // own file names), else an honest miss.
        file = resolveFamilyFile(entry.family, available, manifestFiles.get(entry.family) ?? []);
        if (file === null) {
          misses.push(entry.family);
          continue;
        }
        faceNames = familyFaces(file, available);
      }

      // EVERY sibling face rides the release (production schema: one
      // zip per family, all faces) — the GUI's weight matrix pools
      // them through the family-cut pattern. Faces are SCANNED, not
      // loaded: the catalog keeps digest facts + the on-disk path per
      // face (round-31 memory rule — the bytes stream from disk at
      // serve time), and the zip sha is hashed over the deterministic
      // stream.
      /** @type {Array<{file: string, sha256: string, crc32: number, size: number, path: string}>} */
      const faces = [];
      for (const name of faceNames) {
        const path = available.get(name);
        const meta = await scanFace(path);
        faces.push({ file: name, sha256: meta.sha256, crc32: meta.crc32, size: meta.size, path });
      }
      // The per-cut entries (the variant_cuts port): EVERY cut of the
      // family rides the document when the entry path resolved — each
      // cut's own identity (canonical entry, axes, artifact stem) plus
      // the faces ITS entries resolved (an honest empty list for a cut
      // whose fetch failed — the 未下载 shape, never a silent collapse
      // onto a sibling cut). The alias-fallback path (no entry resolved
      // anything) keeps the legacy single-variant shape.
      let cuts = null;
      if (union.size > 0) {
        const shaByName = new Map(faces.map((f) => [f.file, f.sha256]));
        cuts = variantCuts(entries).map(({ entry, members, def }) => ({
          variant: entry.variant,
          def,
          label: dataCutLabel(basename(entry.file), entry.variant),
          file: basename(entry.file),
          ...(entry.version === undefined ? {} : { version: entry.version }),
          sha256: entry.sha256,
          ...(entry.axes === undefined ? {} : { axes: entry.axes }),
          files: [...new Set(members.flatMap((m) => entryFaces.get(m) ?? []))]
            .sort()
            .map((name) => ({ file: name, sha256: shaByName.get(name) ?? "" })),
        }));
      }
      families.push({
        family: entry.family,
        variant: chooseVariant(entry.family, file, manifest),
        ...(cuts === null ? {} : { cuts }),
        zip: `${entry.family.replace(/\s+/g, "")}.zip`,
        zipSha256: await zipSha256Of(faces),
        file,
        fileSha256: faces.find((f) => f.file === file)?.sha256 ?? "",
        faces,
      });
    }
    // The prototype-only CJK families (dev-only; see EXTRA_DEV_FAMILIES).
    for (const entry of EXTRA_DEV_FAMILIES) {
      if (!available.has(entry.file)) {
        misses.push(`${entry.family} (dev-only extra)`);
        continue;
      }
      /** @type {Array<{file: string, sha256: string, crc32: number, size: number, path: string}>} */
      const faces = [];
      for (const name of familyFaces(entry.file, available)) {
        const path = available.get(name);
        const meta = await scanFace(path);
        faces.push({ file: name, sha256: meta.sha256, crc32: meta.crc32, size: meta.size, path });
      }
      families.push({
        family: entry.family,
        zip: `${entry.family}.zip`,
        zipSha256: await zipSha256Of(faces),
        file: entry.file,
        fileSha256: faces.find((f) => f.file === entry.file)?.sha256 ?? "",
        faces,
      });
    }
    console.info(
      `[dev-catalog] serving ${families.length} families (${seen.size} manifest + dev extras) from ${foundDirs
        .map((p) => `"${p}"`)
        .join(" + ")}` +
        (upstream.fetched > 0
          ? `; ${upstream.fetched} upstream artifacts fetched into the cache`
          : "") +
        (upstream.errors.length > 0
          ? `; ${upstream.errors.length} upstream fetch(es) failed (honest misses)`
          : "") +
        (misses.length > 0 ? `; no binary for: ${misses.join(", ")}` : ""),
    );
    return { families, misses };
  })();
  return catalogPromise;
}

function releaseDocument(families, baseUrl) {
  return JSON.stringify(
    {
      schema: "fontalloy/catalog-release@v1",
      tag: "font-catalog-dev-local",
      origins: [{ id: "dev", base_url: baseUrl }],
      families: families.map((f) => ({
        family: f.family,
        ...(f.variant === undefined ? {} : { variant: f.variant }),
        // The per-cut entries (additive, like `variant`): every cut of
        // a multi-entry family, variant_cuts semantics, so a consumer
        // of the document alone can represent the family's cuts.
        ...(f.cuts === undefined || f.cuts === null
          ? {}
          : {
              cuts: f.cuts.map((cut) => ({
                variant: cut.variant,
                def: cut.def,
                label: cut.label,
                ...(cut.version === undefined ? {} : { version: cut.version }),
                file: cut.file,
                sha256: cut.sha256,
                ...(cut.axes === undefined ? {} : { axes: cut.axes }),
                files: cut.files,
              })),
            }),
        zip: f.zip,
        sha256: f.zipSha256,
        files: f.faces.map(({ file, sha256 }) => ({ file, sha256 })),
      })),
    },
    null,
    1,
  );
}

/** The shared request handler (dev serve and preview alike). */
async function handle(req, res, next) {
  const url = req.url ?? "";
  if (!url.startsWith("/dev-catalog/")) {
    next();
    return;
  }
  const { families } = await buildCatalog();
  const cors = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  };
  if (url.split("?")[0] === "/dev-catalog/catalog-release.json") {
    if (families.length === 0) {
      res.writeHead(503, cors);
      res.end("no local font binaries available for the dev catalog");
      return;
    }
    // Same-origin by construction: base_url points at the host the
    // browser actually reached us on.
    const host = req.headers.host ?? "127.0.0.1:5173";
    const body = releaseDocument(families, `http://${host}/dev-catalog/origins/dev`);
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(body);
    return;
  }
  const match = url.match(/^\/dev-catalog\/origins\/[^/]+\/([^/?]+)$/);
  const family = match
    ? families.find((f) => f.zip === decodeURIComponent(match[1]))
    : undefined;
  if (family) {
    await serveFamilyZip(family, res, cors);
    return;
  }
  res.writeHead(404, cors);
  res.end("not found");
}

/**
 * The vite plugin: `configureServer` covers `vite dev`, and
 * `configurePreviewServer` covers `vite preview` (the built WebApp's
 * e2e suite and any local preview of the static target boot the same
 * real catalog). It never participates in a build.
 */
export function devCatalogPlugin() {
  return {
    name: "fontalloy-dev-catalog",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => handle(req, res, next));
    },
  };
}
