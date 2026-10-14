/**
 * The synthesize flow (issue #16): connect to the merge service, build a
 * recipe from the current GUI state through the shared recipe modules
 * (issue #21's model/validation), submit it over the serve contract,
 * poll progress, save the artifact through the platform's DEFAULT-PATH
 * saver (round 12: the configured output directory, no dialog), and
 * fetch the verification report — all without ever blocking the
 * workspace (each build runs as an independent async loop; the UI
 * observes the store).
 *
 * Round 18 (owner item 4) moves round 17's same-name gate from the
 * save to the CLICK: asking after the build wastes it (a rename then
 * discards the artifact and forces a rebuild anyway). The action
 * probes the target name BEFORE submitting; a collision starts NO
 * build — the card asks, and only a choice builds.
 */

import { store, type LoadedFont } from "../state";
import { defaultDraft, type FontSlot } from "../recipe/model";
import { recipeJson } from "../recipe/json";
import {
  applySettingsToDraft,
  fileFaceSlots,
  patternFaceSlots,
  type FaceSlot,
} from "../recipe/settings";
import { applyRulesToDraft } from "../precedence/serialize";
import { localFaceSet } from "../precedence/picks";
import { probeArtifact, saveArtifact, saveArtifactAs } from "../platform/artifacts";
import { isTauri, readConfig, serveProbeAddress } from "../platform/config";
import { flashFontNameInput } from "../kit/topBar";
import { appMessages } from "../ui/charmap";
import { ServeClient, type CatalogDocument, type FaceDocument, type ReportDocument } from "./client";
import {
  addBuild,
  patchBuild,
  patchService,
  synthStore,
  type BuildRow,
} from "./state";

/** Poll cadence from the serve contract's guidance (ticket #11). */
const RUNNING_POLL_MS = 250;
const QUEUED_POLL_MS = 1_000;
/**
 * A build that never settles must not wedge a poll loop forever. Round
 * 12: a family pick builds the whole weight matrix — 16 slots × graft
 * + rewrite + the readback report run to many minutes on the flagship
 * pair (measured ~6–9 min), so the cap is 20 minutes.
 */
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** How long the web target's load-time probe may take before absence. */
export const PROBE_TIMEOUT_MS = 1_500;

/**
 * Where the service answers. Priority: injected config (tests), then
 * the Tauri shell's sidecar (`serve_url` waits for the startup line),
 * else the web target's #22 detection address (`?serve=`, default
 * http://127.0.0.1:7777) — the workspace probes it on load and a
 * refused connection is a handled state (the CLI fallback).
 */
async function resolveServiceUrl(): Promise<string | null> {
  const injected = readConfig().serveUrl;
  if (injected !== undefined) return injected;
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("serve_url")) as string | null;
  }
  return serveProbeAddress();
}

/**
 * One bounded `/health` probe (the web target's detection): never
 * throws and never logs — every failure mode (connection refused,
 * timeout, CORS block, a non-fontalloy responder) resolves to false.
 */
async function probeHealth(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (response.ok) {
      const doc = (await response.json()) as { service?: string };
      if (doc.service === "fontalloy") return true;
    }
  } catch {
    // Handled by design: absence is a state, not an error.
  } finally {
    clearTimeout(timer);
  }
  return false;
}

/**
 * Boot the service connection. Fire-and-forget from main.ts: the
 * workspace is never delayed by it, and a failed probe leaves a fully
 * usable app (the synthesize action stays disabled with its reason as
 * page text; the no-service CLI panel offers the copy-CLI alternative).
 */
export async function connectService(): Promise<void> {
  const url = await resolveServiceUrl();
  if (url === null) {
    patchService({ status: "none" });
    return;
  }
  patchService({ status: "connecting", url });
  if (!(await probeHealth(url))) {
    patchService({
      status: "unavailable",
      client: null,
      error: `未检测到本地服务（${url} 无响应：连接被拒绝、超时或被 CORS 拦截）`,
    });
    return;
  }
  const client = new ServeClient(url);
  let fontsIndex = null;
  try {
    fontsIndex = await client.fonts();
  } catch {
    // /health answered but /fonts failed: builds still work for fonts
    // with known paths; path resolution will report what it misses.
  }
  let catalogIndex = null;
  try {
    catalogIndex = await client.catalog();
  } catch {
    // Same tolerance: without the catalog index, catalog picks resolve
    // through the path flow (the basename match against /fonts).
  }
  patchService({ status: "connected", client, fontsIndex, catalogIndex, error: undefined });
}

/** Basename of a path, Windows or POSIX separators. */
function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]!.toLowerCase();
}

/**
 * Strip a collection face suffix (round 19): a face extracted from a
 * picked .ttc carries the per-face name `file.ttc#N`, but the file on
 * disk (and in the service's listing) is the one collection — the
 * `#N` is this app's own bookkeeping, never part of any path.
 */
function stripFaceSuffix(fileName: string): string {
  return fileName.replace(/#\d+$/, "");
}

/**
 * The subfamily words a release face's last name segment can carry
 * (OS/2 weight names + the italic composites). Order matters: the
 * composites must precede their prefixes in the alternation.
 */
const SUBFAMILY_WORD =
  /^(?:regular|italic|bolditalic|bold ?italic|bold|semibold|demibold|medium|extralight|extra ?light|extrabold|extra ?bold|light|thin|hairline|black|heavy|book)$/i;

/**
 * The FAMILY CUT pattern of a catalog pick (round 12, owner item 8):
 * a bare-filename glob covering every face of the picked variant's
 * cut, derived from the representative face's own file name —
 * `JetBrainsMonoNerdFont-Regular.ttf` yields
 * `JetBrainsMonoNerdFont-*.ttf`, so the service's resolved reference
 * carries the family's whole weight matrix (the release zip mixes
 * other cuts — Mono/Propo/NL — into the same artifact; the cut keeps
 * the pick to ONE family). A file whose last segment is not a
 * subfamily word cannot be narrowed mechanically and keeps its exact
 * name (single-face semantics — today's behavior).
 */
export function familyCutPattern(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const split = /^(.*)([-_])([^-_]+)$/.exec(stem);
  if (split !== null && SUBFAMILY_WORD.test(split[3]!)) {
    return `${split[1]!}${split[2]!}*${ext}`;
  }
  return fileName;
}

/**
 * The SAME-DIR family pattern of a LOCAL base pick (round 13, owner
 * item 7): the cut-prefix glob over the representative's own basename,
 * extension-LESS — `AlloyFamily-Regular.ttf` yields `AlloyFamily-*`,
 * so the service's directory scan pulls in every sibling face of the
 * family whatever container it ships in (ttf, otf, ttc, woff2; the
 * core filters the matches to font files). The dash keeps the glob to
 * ONE cut exactly like the catalog pattern: `AlloyFamily-*` never
 * matches `AlloyFamilyMono-Regular.ttf`. A file whose last segment is
 * not a subfamily word cannot be narrowed mechanically and keeps its
 * exact name (the reference then stays single-file).
 */
export function localFamilyPattern(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const split = /^(.*)([-_])([^-_]+)$/.exec(stem);
  if (split !== null && SUBFAMILY_WORD.test(split[3]!)) {
    return `${split[1]!}${split[2]!}*`;
  }
  return fileName;
}

/**
 * The on-disk path of a loaded font, for the recipe: the platform's own
 * path when it has one (catalog storage, the Tauri file dialog), else a
 * match by file name against the service's /fonts listing (the browser
 * dev path: the test/dev environment points serve's --font-dir at the
 * same files the page loaded).
 */
export function resolveFontPath(font: LoadedFont): string | null {
  if (font.path !== undefined) return font.path;
  const index = synthStore.get().service.fontsIndex;
  if (index === null) return null;
  // A collection face's `#N` suffix is dropped first (see
  // stripFaceSuffix): the match is against the file the service lists.
  const wanted = basename(stripFaceSuffix(font.fileName));
  for (const family of index.families) {
    for (const face of family.faces) {
      if (basename(face.path) === wanted) return face.path;
    }
  }
  return null;
}

/** Refresh the /fonts index once (a downloader may have added fonts). */
async function refreshFontsIndex(): Promise<void> {
  const { client } = synthStore.get().service;
  if (client === null) return;
  try {
    patchService({ fontsIndex: await client.fonts() });
  } catch {
    // Stale index stands; a missed lookup reports its own error.
  }
}

/** The /catalog document, fetching it once when the connect-time probe
 *  did not land (round 6: catalog-family reference resolution). */
async function ensureCatalogIndex(): Promise<CatalogDocument | null> {
  const { client, catalogIndex } = synthStore.get().service;
  if (catalogIndex !== null || client === null) return catalogIndex;
  try {
    const doc = await client.catalog();
    patchService({ catalogIndex: doc });
    return doc;
  } catch {
    return null;
  }
}

async function resolveFontPathWithRefresh(
  font: LoadedFont,
): Promise<string | null> {
  let path = resolveFontPath(font);
  if (path === null) {
    await refreshFontsIndex();
    path = resolveFontPath(font);
  }
  return path;
}

/**
 * The recipe draft for the current selection: the EN pick is the base
 * (the output inherits its metrics and identity), the CJK pick the one
 * donor filling the empty slots. The output name is the top bar's
 * font-name field (default the fixed brand default, never derived from
 * the source fonts — spec naming rule). Built through the shared recipe
 * modules (issue #21's model), then serialized by recipeJson for POST
 * /builds — and by recipeYaml for the no-service CLI panel, always from
 * the SAME state (the build and the panel can never drift apart).
 */

/** The currently picked pair, as loaded fonts (undefined when unset). */
export function selectedPicks(): {
  en: LoadedFont | undefined;
  cjk: LoadedFont | undefined;
} {
  const { fonts, selected } = store.get();
  return {
    en: fonts.find((f) => f.cssFamily === selected.en),
    cjk: fonts.find((f) => f.cssFamily === selected.cjk),
  };
}

/**
 * The recipe draft for the given font slots. `faces` is the
 * service's /fonts index when one is connected (weight-slot selection);
 * empty degrades the weight selection to the default — normalization
 * needs no face data.
 *
 * Round 12 (owner item 8): a catalog base pick builds the family's
 * whole weight matrix — the cut pattern resolves to every face of the
 * variant, and a multi-face output can only be packaged as a
 * collection. Round 13 (owner item 7): a LOCAL base pick with
 * same-dir siblings carries the same shape of pattern and follows the
 * SAME auto tier — no forked format logic, the pattern is the input.
 * Single-file references (local or catalog) keep the plain ttf.
 *
 * Round 14: a pattern slot's weight selection enumerates the index by
 * the pattern (patternFaceSlots) instead of degrading to the default —
 * the 字重合并方式 modes stay live for family picks.
 */
export function buildWorkspaceDraft(
  slots: { en: FontSlot; cjk: FontSlot },
  faces: readonly FaceDocument[] = [],
): ReturnType<typeof defaultDraft> {
  const { rules, settings, outputFamily } = store.get();
  const draft = defaultDraft();
  draft.base = slots.en;
  draft.donors = [slots.cjk];
  // The top bar's font-name field is the recipe's output family.
  draft.output.family = outputFamily || "ChHsich";
  // A slot's face data from the service's /fonts index: a pattern
  // reference enumerates by its pattern (round 14 — the same faces the
  // service's own resolution pulls in), a single-file reference by its
  // exact path.
  const slotFaces = (slot: FontSlot): FaceSlot[] =>
    slot.pattern !== undefined
      ? patternFaceSlots(faces, slot.pattern, slot.path !== "" ? slot.path : null)
      : fileFaceSlots(faces, slot.path);
  // The AUTO tier: a multi-face family pick packages the weight
  // matrix as a collection; anything else is a plain ttf. The face
  // COUNT comes from the index when it can see the pattern's faces
  // (round 14): a pick whose family resolves to ONE file builds that
  // file as a plain ttf, exactly like a single-file reference; an
  // index that cannot see the faces keeps the round-12 assumption —
  // a patterned family pick packages as ttc. An explicit 输出格式
  // setting wins — applySettingsToDraft runs AFTER this and
  // overwrites the format when the user chose one ("auto" leaves it,
  // so this resolution is the value that ships).
  const baseFaces = slotFaces(slots.en);
  if (draft.output.format === "auto") {
    draft.output.format =
      slots.en.pattern !== undefined && baseFaces.length !== 1 ? "ttc" : "ttf";
  }
  // The SAME rule state the preview grid resolves (issue #18): the
  // build and the preview can never drift apart.
  applyRulesToDraft(draft, rules);
  // The synthesis settings (issue #19): baseline / CJK width land in
  // the normalization block, the weight merge mode in the weights
  // selection, over the same face data the format tier counted.
  applySettingsToDraft(draft, settings, baseFaces, slotFaces(slots.cjk));
  return draft;
}

/**
 * The pattern a pick's PATH-form slot carries (round 14): a LOCAL pick
 * keeps the round-13 same-dir cut glob (extension-less, only when the
 * load path actually discovered sibling faces — single-file semantics
 * otherwise); a CATALOG pick carries the FAMILY CUT pattern of its
 * representative face whatever the resolution form — the pick is the
 * family, and a reference that drops the pattern narrows the build to
 * the representative alone (round 14's owner report: one weight slot
 * where the family ships sixteen). The donor's pattern pools the
 * variant's faces into nearest-weight matching — the same pooling the
 * catalog form's whole-variant reference does. Undefined when the
 * representative's name cannot be narrowed (no `*` in the pattern).
 */
function pickPathPattern(
  font: LoadedFont,
  role: "base" | "donor",
): string | undefined {
  if (font.origin === "local") {
    // Round 13: only a base whose load discovered same-dir siblings.
    if (role !== "base" || localFaceSet(store.get().fonts, font).length <= 1) {
      return undefined;
    }
    const pattern = localFamilyPattern(font.fileName);
    return pattern.includes("*") ? pattern : undefined;
  }
  if (font.origin === "catalog") {
    const pattern = familyCutPattern(font.fileName);
    return pattern.includes("*") ? pattern : undefined;
  }
  return undefined;
}

/**
 * The recipe slot for one picked font (round 6; round 12 for the base
 * pattern; round 13 for the LOCAL base pattern; round 14 for the
 * pattern on EVERY catalog pick's path form). Order matters:
 *
 * 1. The PATH form whenever the service's own /fonts listing can see
 *    the file — the serve vouches for that path, and a bare path is
 *    always buildable. (A serve started from a repository checkout
 *    answers /catalog with the repo manifest whose artifacts are NOT
 *    fetched; preferring the catalog form there would submit a
 *    reference that dies with "not fetched" while a working path
 *    exists.) The slot carries the pick's family pattern
 *    (`pickPathPattern`): a LOCAL base whose load discovered
 *    same-directory sibling faces (round 13, owner item 7) carries the
 *    extension-less SAME-DIR glob over the representative's basename;
 *    a CATALOG pick (round 14) carries the FAMILY CUT pattern of its
 *    representative face in BOTH roles — the pick is the family, and
 *    without the pattern the path form would narrow the build to the
 *    representative alone (the round-14 owner report: a 16-face
 *    JetBrainsMono pick building ONE weight slot). A one-file family
 *    (no siblings, or a name the rule cannot narrow) keeps the bare
 *    path: single-face semantics.
 * 2. The CATALOG-FAMILY reference — `{family, variant}` naming what
 *    the manifest pins — for catalog picks the listing CANNOT see (a
 *    serve whose /fonts scan does not reach the catalog layout's
 *    nested faces). The BASE carries the FAMILY CUT pattern (round
 *    12): a glob over the representative face's own file name that
 *    resolves to every face of the picked variant's cut, so the base's
 *    faces — and only those — become the output weight matrix (a Nerd
 *    Fonts zip mixes other cuts into the same artifact; the manifest
 *    entry's variant already narrowed the variant, the cut keeps the
 *    pick to ONE family). The DONOR references the whole variant
 *    pattern-free, as before: its faces pool into nearest-weight
 *    matching, and its stored file naming need not match the service's
 *    artifact faces.
 *
 * Null when neither form resolves (the caller's inline failure).
 */
async function resolvePickSlot(
  font: LoadedFont,
  role: "base" | "donor",
): Promise<FontSlot | null> {
  const path = await resolveFontPathWithRefresh(font);
  if (path !== null) {
    const slot: FontSlot = { catalog: null, path, face: null };
    const pattern = pickPathPattern(font, role);
    if (pattern !== undefined) slot.pattern = pattern;
    return slot;
  }
  if (font.origin === "catalog" && font.catalog) {
    const doc = await ensureCatalogIndex();
    const family = doc?.families.find((f) => f.family === font.catalog!.family);
    if (family && family.variants.length > 0) {
      const variants = family.variants.map((v) => v.variant);
      const variant =
        font.catalog.variant !== null && variants.includes(font.catalog.variant)
          ? font.catalog.variant
          : variants.length === 1
            ? variants[0]!
            : null;
      if (variant !== null) {
        const slot: FontSlot = {
          catalog: { family: font.catalog.family, variant },
          path: "",
          face: null,
        };
        if (role === "base") slot.pattern = familyCutPattern(font.fileName);
        return slot;
      }
    }
  }
  return null;
}

function newBuildRow(family: string): BuildRow {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    family,
    status: "queued",
    stage: null,
    queuePosition: null,
    error: null,
    savedPath: null,
    savedNotice: null,
    report: null,
    submittedAt: new Date().toISOString(),
  };
}

/** Sleep without blocking anything (the poll loop's pacemaker). */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * Stop a build on the service (round 19) — the real abort behind the
 * build panel's confirms. Never throws: an unreachable service or an
 * id that aged out of the retention window (404) leaves the row to
 * settle on its own terms, and a build that finished in the race is a
 * no-op on the service side.
 */
export async function cancelBuild(id: string): Promise<void> {
  const { client } = synthStore.get().service;
  if (client === null) return;
  try {
    await client.cancelBuild(id);
  } catch {
    // The poll loop owns the row's outcome either way.
  }
}

/**
 * The artifact's file extension for an output format — the same
 * mapping the report readback uses at save time (anything the schema
 * did not name falls back to ttf).
 */
function artifactExt(format: string): string {
  return format === "ttc" || format === "woff2" ? format : "ttf";
}

/**
 * Land a failure that predates any build as its own error row (the
 * flow's inline-text contract — the app stays usable, no modals).
 */
function failBeforeBuild(message: string): void {
  const row = newBuildRow(store.get().outputFamily || "ChHsich");
  addBuild(row);
  patchBuild(row.id, { status: "error", error: message });
}

/**
 * Run one synthesis end to end. Never throws: every failure lands in
 * the build row as inline text (the app stays usable, no modals).
 *
 * Round 18 (owner item 4): the same-name gate runs HERE, at the click
 * — before anything is submitted. The target name is probed; a
 * collision starts NO build and hands the decision to the card
 * (`askRenameOrBuild`). 「直接覆盖」 re-enters with the exact draft
 * that was probed and the overwrite pre-approved (its save writes
 * exactly like the old explicit overwrite); 「改个名字」 re-runs the
 * whole action on the committed name, gate first (another collision
 * asks again).
 */
export async function synthesize(): Promise<void> {
  const { service } = synthStore.get();
  if (service.status !== "connected" || service.client === null) return;

  const { en, cjk } = selectedPicks();
  if (!en || !cjk) {
    failBeforeBuild("请先选择英文字体与中文字体，再进行合成。");
    return;
  }

  // Resolve both picks to recipe slots BEFORE anything builds — catalog
  // picks become catalog-family references the service resolves against
  // its own manifest; everything else names an on-disk path, and a font
  // the service cannot see must fail here, as inline text, instead of
  // as a build that dies for a cryptic reason. The gate also needs the
  // slots: the draft's resolved format decides the target's extension
  // (a family pick packages the weight matrix as ttc).
  const enSlot = await resolvePickSlot(en, "base");
  const cjkSlot = await resolvePickSlot(cjk, "donor");
  if (enSlot === null) {
    failBeforeBuild(`无法定位字体文件路径：${en.fileName}（服务目录中不存在）。`);
    return;
  }
  if (cjkSlot === null) {
    failBeforeBuild(`无法定位字体文件路径：${cjk.fileName}（服务目录中不存在）。`);
    return;
  }

  // The SAME draft the no-service CLI panel builds (issue #22's
  // absorption): the two font slots, the rail's rule state, the
  // settings — one recipe model for the service and the YAML alike.
  const faces = synthStore.get().service.fontsIndex?.families.flatMap(
    (family) => family.faces,
  ) ?? [];
  const draft = buildWorkspaceDraft({ en: enSlot, cjk: cjkSlot }, faces);

  // The GATE: does a file already sit at the target this name resolves
  // to? No collision → build as today. A collision → NO build starts;
  // the card asks, and only a choice builds (round 17's rule — never a
  // silent overwrite, never a silent suffix — now answered before the
  // minutes-long build, not after it).
  const suggested = `${draft.output.family}.${artifactExt(draft.output.format)}`;
  const probe = await probeArtifact(suggested);
  if (probe.exists) {
    askRenameOrBuild(draft, probe.path);
    return;
  }
  await runBuild(draft, false);
}

/**
 * Submit one resolved draft, poll it to completion, and save the
 * artifact. `overwriteApproved` marks a build that already answered
 * the same-name gate with 直接覆盖 (its save writes exactly like the
 * old explicit overwrite); every other build re-probes at the save —
 * a name that came free at the click but was taken by the time the
 * artifact landed (another build's save, an external write) settles
 * the row as built-but-unsaved rather than silently overwriting. In
 * the normal flow the click-time gate means that re-probe never fires.
 */
async function runBuild(
  draft: ReturnType<typeof defaultDraft>,
  overwriteApproved: boolean,
): Promise<void> {
  const client = synthStore.get().service.client;
  if (client === null) return;
  const row = newBuildRow(draft.output.family);
  addBuild(row);

  const fail = (message: string): void => {
    patchBuild(row.id, { status: "error", error: message });
  };

  let submitted;
  try {
    submitted = await client.submit(recipeJson(draft));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  // The service id supersedes the local placeholder id.
  const deadId = row.id;
  const live: BuildRow = { ...row, id: submitted.id };
  synthStore.set({
    builds: synthStore
      .get()
      .builds.map((candidate) => (candidate.id === deadId ? live : candidate)),
  });
  const id = submitted.id;

  // Poll until settled: 250ms while running, 1Hz while queued.
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  for (;;) {
    let doc;
    try {
      doc = await client.build(id);
    } catch (err) {
      patchBuild(id, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    patchBuild(id, {
      status: doc.status,
      stage: doc.stage,
      queuePosition: doc.queue_position,
      error: doc.error,
    });
    if (doc.status === "failed") return;
    // Round 19: a cancelled build is settled — the row renders 已取消,
    // nothing is saved, and this poll loop stands down.
    if (doc.status === "cancelled") return;
    if (doc.status === "done") break;
    if (Date.now() > deadline) {
      patchBuild(id, { status: "error", error: "构建超时。" });
      return;
    }
    await sleep(doc.status === "queued" ? QUEUED_POLL_MS : RUNNING_POLL_MS);
  }

  // Fetch artifact + report, then hand the font to the platform's
  // DEFAULT-PATH saver (round 12: the configured output directory, no
  // dialog anywhere in the saving path — a dialog is never a
  // dependency of saving). Round 18: the same-name DECISION was made
  // at the click — a 直接覆盖 build writes through (the overwrite
  // happens here, at the save, exactly like the old explicit
  // overwrite); anything else re-probes defensively and, on a name
  // that was taken in the meantime, writes NOTHING (the row settles
  // as built-but-unsaved, the artifact stays in the service's
  // scratch, retrievable from the row's 另存为).
  patchBuild(id, { status: "saving" });
  try {
    const [bytes, report] = await Promise.all([
      client.fontBytes(id),
      client.report(id),
    ]);
    const filename =
      synthStore.get().builds.find((candidate) => candidate.id === id)?.family ??
      "ChHsich";
    // Round 12: the saved line shows the artifact's ACTUAL format —
    // what the report read back (family picks package the whole weight
    // matrix as ttc); anything the schema did not name falls back to ttf.
    const format = report.output?.format ?? "ttf";
    const suggested = `${filename}.${artifactExt(format)}`;
    if (!overwriteApproved) {
      const probe = await probeArtifact(suggested);
      if (probe.exists) {
        patchBuild(id, { status: "done", savedPath: null, report });
        return;
      }
    }
    await settleSaved(id, suggested, bytes, report);
  } catch (err) {
    patchBuild(id, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Save through the default path and settle the row with the outcome. */
async function settleSaved(
  id: string,
  suggested: string,
  bytes: Uint8Array,
  report: ReportDocument,
): Promise<void> {
  const result = await saveArtifact(suggested, bytes);
  patchBuild(id, {
    status: result.saved ? "saved" : "done",
    savedPath: result.path,
    savedNotice: result.notice ?? null,
    report,
  });
}

/**
 * Ask about a same-name target AT THE CLICK (round 18, owner item 4;
 * the round-17 card moved before the build; round 19 joins the
 * standard countdown). One message card names the exact colliding
 * path and offers BOTH paths — 改个名字 (the font-name input takes
 * the focus and flashes; the build starts itself once the new name is
 * committed, re-probed first) and 直接覆盖 (the build proceeds on the
 * exact draft that was probed; its save overwrites the colliding
 * file — the round-19 label says 覆盖, matching what the save does,
 * danger-toned for the same reason). The card rides the message
 * system's standard ~6s countdown with hover-pause (round 19, item
 * 2): a timeout counts as dismissal — no build starts, exactly like
 * the ×. Neither action is the default.
 */
function askRenameOrBuild(
  draft: ReturnType<typeof defaultDraft>,
  target: string,
): void {
  appMessages().push({
    icon: "warn",
    title: "已有同名文件",
    reason: target,
    actions: [
      {
        label: "改个名字",
        onClick: () => armRenameBuild(),
      },
      {
        label: "直接覆盖",
        tone: "danger",
        onClick: () => {
          void runBuild(draft, true);
        },
      },
    ],
  });
}

/**
 * The 改个名字 path: the field takes the focus and flashes, and the
 * build starts itself once the user COMMITS a new name — the input's
 * `change` event (Enter / blur, and only when the value actually
 * changed), so nothing builds while the user is still typing. The
 * re-run is the whole synthesize action on the fresh name: the gate
 * probes again, and another collision asks again rather than building
 * onto a taken name.
 */
function armRenameBuild(): void {
  const input = flashFontNameInput();
  if (input === null) return;
  input.addEventListener(
    "change",
    () => {
      void synthesize();
    },
    { once: true },
  );
}

/**
 * The 另存为 affordance (round 12): re-fetch the built font from the
 * service and hand it to the DIALOG flow. A canceled dialog changes
 * nothing; a dialog that cannot open or errors (headless Linux, a
 * broken dialog backend) falls back to the DEFAULT path with a plain
 * notice — the artifact stays on disk either way. The row rides the
 * same "saving" handoff state the initial save used, so the stepper
 * keeps its lit segments and 保存输出 pulses (item 2's model applies
 * verbatim). Never throws: outcomes land in the row as inline text.
 */
export async function saveBuildAs(id: string): Promise<void> {
  const { service, builds } = synthStore.get();
  const row = builds.find((candidate) => candidate.id === id);
  if (row === undefined || service.client === null) return;
  if (row.status !== "saved" && row.status !== "done") return;
  const suggested = `${row.family || "ChHsich"}.ttf`;
  const restore = row.savedPath === null ? ("done" as const) : ("saved" as const);
  patchBuild(id, { status: "saving", error: null });
  const failInline = (message: string): void => {
    if (row.savedPath === null) {
      patchBuild(id, { status: "error", error: message });
    } else {
      // The artifact is already on disk from the initial save; the
      // row stays settled and the notice carries what went wrong.
      patchBuild(id, { status: "saved", savedNotice: `无法另存：${message}` });
    }
  };
  try {
    // The service owns the artifact bytes (its build scratch keeps the
    // newest finished builds); the row never carries multi-MB blobs.
    const bytes = await service.client.fontBytes(id);
    try {
      const result = await saveArtifactAs(suggested, bytes);
      if (!result.saved) {
        // A canceled dialog leaves the row exactly as it was.
        patchBuild(id, { status: restore });
        return;
      }
      patchBuild(id, {
        status: "saved",
        savedPath: result.path,
        savedNotice: result.notice ?? null,
      });
    } catch {
      const fallback = await saveArtifact(suggested, bytes);
      patchBuild(id, {
        status: fallback.saved ? "saved" : "done",
        savedPath: fallback.path ?? row.savedPath,
        savedNotice: fallback.saved
          ? "保存对话框不可用，已保存到默认位置。"
          : null,
      });
    }
  } catch (err) {
    failInline(err instanceof Error ? err.message : String(err));
  }
}

/** True when the synthesize action should be enabled. */
export function synthesizeReady(): boolean {
  const service = synthStore.get().service;
  const { selected } = store.get();
  return (
    service.status === "connected" &&
    selected.en !== null &&
    selected.cjk !== null
  );
}
