/**
 * The synthesize flow (issue #16): connect to the merge service, build a
 * recipe from the current GUI state through the shared recipe modules
 * (issue #21's model/validation), submit it over the serve contract,
 * poll progress, save the artifact through the platform's DEFAULT-PATH
 * saver (round 12: the configured output directory, no dialog), and
 * fetch the verification report — all without ever blocking the
 * workspace (each build runs as an independent async loop; the UI
 * observes the store).
 */

import { store, type LoadedFont } from "../state";
import { defaultDraft, type FontSlot } from "../recipe/model";
import { recipeJson } from "../recipe/json";
import { applySettingsToDraft, fileFaceSlots } from "../recipe/settings";
import { applyRulesToDraft } from "../precedence/serialize";
import { saveArtifact, saveArtifactAs } from "../platform/artifacts";
import { isTauri, readConfig, serveProbeAddress } from "../platform/config";
import { ServeClient, type CatalogDocument, type FaceDocument } from "./client";
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
  const wanted = basename(font.fileName);
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
 * collection. Local single-file picks (and a catalog reference pinned
 * to exactly one file) keep the plain ttf.
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
  // The AUTO tier: a multi-face family pick packages the weight
  // matrix as a collection; anything else is a plain ttf. An explicit
  // 输出格式 setting wins — applySettingsToDraft runs AFTER this and
  // overwrites the format when the user chose one ("auto" leaves it,
  // so this resolution is the value that ships).
  if (draft.output.format === "auto") {
    draft.output.format =
      slots.en.catalog !== null && (slots.en.pattern ?? "").includes("*")
        ? "ttc"
        : "ttf";
  }
  // The SAME rule state the preview grid resolves (issue #18): the
  // build and the preview can never drift apart.
  applyRulesToDraft(draft, rules);
  // The synthesis settings (issue #19): baseline / CJK width land in
  // the normalization block, the weight merge mode in the weights
  // selection (face data from the service's own /fonts index; a
  // catalog-family reference has no listing entry, so the selection
  // degrades to the default — nearest matching).
  applySettingsToDraft(
    draft,
    settings,
    fileFaceSlots(faces, slots.en.catalog ? "" : slots.en.path),
    fileFaceSlots(faces, slots.cjk.catalog ? "" : slots.cjk.path),
  );
  return draft;
}

/**
 * The recipe slot for one picked font (round 6; round 12 for the base
 * pattern). Order matters:
 *
 * 1. The PATH form whenever the service's own /fonts listing can see
 *    the file — the serve vouches for that path, and a bare path is
 *    always buildable. (A serve started from a repository checkout
 *    answers /catalog with the repo manifest whose artifacts are NOT
 *    fetched; preferring the catalog form there would submit a
 *    reference that dies with "not fetched" while a working path
 *    exists.)
 * 2. The CATALOG-FAMILY reference — `{family, variant}` naming what
 *    the manifest pins — for catalog picks the listing CANNOT see (the
 *    owner's serve over the fetched layout: assets/fonts/<Family>/
 *    extracted faces, which the top-level /fonts scan skips). The BASE
 *    carries the FAMILY CUT pattern (round 12): a glob over the
 *    representative face's own file name that resolves to every face
 *    of the picked variant's cut, so the base's faces — and only those
 *    — become the output weight matrix (a Nerd Fonts zip mixes other
 *    cuts into the same artifact; the manifest entry's variant already
 *    narrowed the variant, the cut keeps the pick to ONE family). The
 *    DONOR references the whole variant pattern-free, as before: its
 *    faces pool into nearest-weight matching, and its stored file
 *    naming need not match the service's artifact faces.
 *
 * Null when neither form resolves (the caller's inline failure).
 */
async function resolvePickSlot(
  font: LoadedFont,
  role: "base" | "donor",
): Promise<FontSlot | null> {
  const path = await resolveFontPathWithRefresh(font);
  if (path !== null) return { catalog: null, path, face: null };
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
 * Run one synthesis end to end. Never throws: every failure lands in
 * the build row as inline text (the app stays usable, no modals).
 */
export async function synthesize(): Promise<void> {
  const { service } = synthStore.get();
  if (service.status !== "connected" || service.client === null) return;

  const { outputFamily } = store.get();
  const { en, cjk } = selectedPicks();
  const row = newBuildRow(outputFamily || "ChHsich");
  addBuild(row);

  const fail = (message: string): void => {
    patchBuild(row.id, { status: "error", error: message });
  };

  if (!en || !cjk) {
    fail("请先选择英文字体与中文字体，再进行合成。");
    return;
  }

  // Resolve both picks to recipe slots BEFORE submitting — catalog
  // picks become catalog-family references the service resolves against
  // its own manifest; everything else names an on-disk path, and a font
  // the service cannot see must fail here, as inline text, instead of
  // as a build that dies for a cryptic reason.
  const enSlot = await resolvePickSlot(en, "base");
  const cjkSlot = await resolvePickSlot(cjk, "donor");
  if (enSlot === null) {
    fail(`无法定位字体文件路径：${en.fileName}（服务目录中不存在）。`);
    return;
  }
  if (cjkSlot === null) {
    fail(`无法定位字体文件路径：${cjk.fileName}（服务目录中不存在）。`);
    return;
  }

  // The SAME draft the no-service CLI panel builds (issue #22's
  // absorption): the two font slots, the rail's rule state, the
  // settings — one recipe model for the service and the YAML alike.
  const faces = synthStore.get().service.fontsIndex?.families.flatMap(
    (family) => family.faces,
  ) ?? [];
  const draft = buildWorkspaceDraft({ en: enSlot, cjk: cjkSlot }, faces);

  const client = service.client;
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
  // dependency of saving).
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
    const suggested = `${filename}.${format === "ttc" || format === "woff2" ? format : "ttf"}`;
    const result = await saveArtifact(suggested, bytes);
    patchBuild(id, {
      status: result.saved ? "saved" : "done",
      savedPath: result.path,
      savedNotice: result.notice ?? null,
      report,
    });
  } catch (err) {
    patchBuild(id, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
