/**
 * The synthesize flow (issue #16): connect to the merge service, build a
 * recipe from the current GUI state through the shared recipe modules
 * (issue #21's model/validation), submit it over the serve contract,
 * poll progress, save the artifact through the platform saver, and fetch
 * the verification report — all without ever blocking the workspace
 * (each build runs as an independent async loop; the UI observes the
 * store).
 */

import { store, type LoadedFont } from "../state";
import { defaultDraft } from "../recipe/model";
import { recipeJson } from "../recipe/json";
import { applySettingsToDraft, fileFaceSlots } from "../recipe/settings";
import { applyRulesToDraft } from "../precedence/serialize";
import { saveArtifact } from "../platform/artifacts";
import { isTauri, readConfig } from "../platform/config";
import { ServeClient } from "./client";
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
/** A build that never settles must not wedge a poll loop forever. */
const BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * Where the service answers. Priority: injected config (tests, the
 * future WebApp build), then the Tauri shell's sidecar (`serve_url`
 * waits for the startup line), else null (no probe — a refused fetch
 * would log a console error; the default browser page stays silent).
 */
async function resolveServiceUrl(): Promise<string | null> {
  const injected = readConfig().serveUrl;
  if (injected !== undefined) return injected;
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("serve_url")) as string | null;
  }
  return null;
}

/**
 * Boot the service connection. Fire-and-forget from main.ts: the
 * workspace is never delayed by it, and a failed probe leaves a fully
 * usable app (the synthesize action stays disabled with its reason as
 * page text).
 */
export async function connectService(): Promise<void> {
  const url = await resolveServiceUrl();
  if (url === null) {
    patchService({ status: "none" });
    return;
  }
  patchService({ status: "connecting", url });
  const client = new ServeClient(url);
  try {
    await client.health();
  } catch (err) {
    patchService({
      status: "unavailable",
      client: null,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  let fontsIndex = null;
  try {
    fontsIndex = await client.fonts();
  } catch {
    // /health answered but /fonts failed: builds still work for fonts
    // with known paths; path resolution will report what it misses.
  }
  patchService({ status: "connected", client, fontsIndex, error: undefined });
}

/** Basename of a path, Windows or POSIX separators. */
function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]!.toLowerCase();
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
 * /builds.
 */

function newBuildRow(family: string): BuildRow {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    family,
    status: "queued",
    stage: null,
    queuePosition: null,
    error: null,
    savedPath: null,
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

  const { fonts, selected, outputFamily } = store.get();
  const en = fonts.find((f) => f.cssFamily === selected.en);
  const cjk = fonts.find((f) => f.cssFamily === selected.cjk);
  const row = newBuildRow(outputFamily || "ChHsich");
  addBuild(row);

  const fail = (message: string): void => {
    patchBuild(row.id, { status: "error", error: message });
  };

  if (!en || !cjk) {
    fail("请先选择英文字体与中文字体，再进行合成。");
    return;
  }

  // Resolve both fonts to on-disk paths BEFORE submitting — the recipe
  // names files, and a font the service cannot see must fail here, as
  // inline text, instead of as a build that dies for a cryptic reason.
  const enPath = await resolveFontPathWithRefresh(en);
  const cjkPath = await resolveFontPathWithRefresh(cjk);
  if (enPath === null) {
    fail(`无法定位字体文件路径：${en.fileName}（服务目录中不存在）。`);
    return;
  }
  if (cjkPath === null) {
    fail(`无法定位字体文件路径：${cjk.fileName}（服务目录中不存在）。`);
    return;
  }

  const draft = defaultDraft();
  draft.base = { catalog: null, path: enPath, face: null };
  draft.donors = [{ catalog: null, path: cjkPath, face: null }];
  // The top bar's font-name field is the recipe's output family.
  draft.output.family = outputFamily || "ChHsich";
  // The SAME rule state the preview grid resolves (issue #18): the
  // build and the preview can never drift apart.
  applyRulesToDraft(draft, store.get().rules);
  // The synthesis settings (issue #19): baseline / CJK width land in
  // the normalization block, the weight merge mode in the weights
  // selection (face data from the service's own /fonts index).
  const faces = synthStore.get().service.fontsIndex?.families.flatMap(
    (family) => family.faces,
  ) ?? [];
  applySettingsToDraft(
    draft,
    store.get().settings,
    fileFaceSlots(faces, enPath),
    fileFaceSlots(faces, cjkPath),
  );

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

  // Fetch artifact + report, then hand the font to the platform saver.
  patchBuild(id, { status: "saving" });
  try {
    const [bytes, report] = await Promise.all([
      client.fontBytes(id),
      client.report(id),
    ]);
    const filename =
      synthStore.get().builds.find((candidate) => candidate.id === id)?.family ??
      "ChHsich";
    const suggested = `${filename}.ttf`;
    const result = await saveArtifact(suggested, bytes);
    patchBuild(id, {
      status: result.saved ? "saved" : "done",
      savedPath: result.path,
      report,
    });
  } catch (err) {
    patchBuild(id, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
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
