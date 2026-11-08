import catalogManifest from "../data/catalog.json";
import { store, type CatalogFamilyProgress } from "../state";
import { skipCatalogScreen } from "./serve";
import { openFontPicker } from "../ui/picker";
import { appMessages } from "../ui/charmap";
import { brandMark } from "../kit/topBar";
import { sep } from "../kit/icons";

/**
 * The first-run progress screen (issue #17, ADR-0005; ticket #30):
 * a dismissable overlay showing the SERVE's per-family sync progress
 * while the full catalog arrives. It never blocks the workspace — the
 * workspace is mounted and functional underneath, the 跳过 button
 * dismisses at any time, and the screen closes itself once the serve's
 * state machine settles (failures never block; missing families are
 * repaired by later sync runs).
 *
 * The node is created once and appended to <body>. Rows are CACHED per
 * family and patched in place (the picker-popup discipline, ADR-0004):
 * a render touches only the changed status cells, appends families the
 * document gained, drops the ones it lost, and rebuilds the list
 * exactly once — at the discrete seed → authoritative row-set switch.
 *
 * Seed rows (the release-document window): while the serve's `document`
 * phase is not `loaded` the manifest is NOT KNOWN — an empty status
 * families list means "cannot say yet", never "known and empty" — so
 * the screen lays the repo's own catalog seed (data/catalog.json) as
 * 未下载 rows. Once loaded, the status document is authoritative and
 * the row set is reconciled to it exactly (families the seed carries
 * that the release does not are dropped; the dev catalog is generated
 * dynamically, so the sets always drift a little).
 *
 * The connecting variant (the desktop sidecar's cold start): while the
 * service connection is still being resolved the panel states
 * 正在启动字体服务 with an indeterminate bar — a copy of its own, never
 * the download screen's label (the download copy appears only when the
 * serve actually syncs).
 */

const STATUS_TEXT: Record<CatalogFamilyProgress["state"], string> = {
  pending: "等待下载",
  downloading: "下载中",
  extracting: "解压中",
  verifying: "校验中",
  done: "已完成",
  failed: "下载失败",
};

/** The seed rows' display text — a pseudo state, never a serve state. */
const SEED_STATUS = "seed";
const SEED_TEXT = "未下载";

/** The repo's own catalog seed: family names only, display-layer use.
 *  Deduplicated — the manifest carries multi-VARIANT entries under one
 *  family name (114 entries, 102 families), while the release schema
 *  the rows later align to is unique by family name. */
const SEED_FAMILIES: readonly string[] = [
  ...new Set(
    (catalogManifest.families as Array<{ family: string }>).map(
      (entry) => entry.family,
    ),
  ),
];

/** One cached row: the node plus the spans a render patches. */
interface RowParts {
  row: HTMLElement;
  status: HTMLElement;
  error: HTMLElement | null;
}

export function mountCatalogScreen(): void {
  const screen = document.createElement("div");
  screen.className = "catalog-screen";
  screen.setAttribute("role", "dialog");
  screen.setAttribute("aria-modal", "false");
  screen.setAttribute("aria-label", "首次运行：下载字体目录");
  screen.innerHTML = `
    <div class="catalog-panel">
      <div class="catalog-head">
        <h2 class="catalog-title"><span data-role="title-a">首次运行</span><span data-role="title-sep">${sep().outerHTML}</span><span data-role="title-b">正在下载字体目录</span></h2>
        <div class="catalog-sub" data-role="catalog-sub" hidden>首次启动需解压字体服务，约需几十秒</div>
        <div class="catalog-progress">已完成 <b data-stat="catalog-done">0</b> / <span data-stat="catalog-total">0</span> 个字体家族<span data-stat="catalog-checking" hidden>（清单核对中…）</span></div>
        <span class="catalog-ready" data-stat="catalog-ready">目录就绪</span>
      </div>
      <div class="catalog-bar" data-role="catalog-bar"><i></i></div>
      <div class="catalog-list"></div>
      <div class="catalog-actions">
        <button class="catalog-start" type="button" hidden>开始使用</button>
        <button class="catalog-skip" type="button">跳过，稍后再说</button>
      </div>
    </div>
  `;
  screen.hidden = true;
  document.body.appendChild(screen);

  // Round 7: the panel head carries the brand mark (logo adoption).
  screen.querySelector(".catalog-title")!.prepend(brandMark(22));

  const list = screen.querySelector<HTMLElement>(".catalog-list")!;
  const done = screen.querySelector<HTMLElement>("[data-stat='catalog-done']")!;
  const total = screen.querySelector<HTMLElement>("[data-stat='catalog-total']")!;
  const checking = screen.querySelector<HTMLElement>(
    "[data-stat='catalog-checking']",
  )!;
  const readyTag = screen.querySelector<HTMLElement>(
    "[data-stat='catalog-ready']",
  )!;
  /** The exit-fade timer (see the hide path in render). */
  let outTimer: ReturnType<typeof setTimeout> | undefined;
  const titleA = screen.querySelector<HTMLElement>("[data-role='title-a']")!;
  const titleB = screen.querySelector<HTMLElement>("[data-role='title-b']")!;
  const titleSep = screen.querySelector<HTMLElement>(
    "[data-role='title-sep']",
  )!;
  const sub = screen.querySelector<HTMLElement>("[data-role='catalog-sub']")!;
  const bar = screen.querySelector<HTMLElement>("[data-role='catalog-bar']")!;
  const barFill = bar.querySelector<HTMLElement>("i")!;
  const skip = screen.querySelector<HTMLButtonElement>(".catalog-skip")!;
  const start = screen.querySelector<HTMLButtonElement>(".catalog-start")!;

  /** Whether a USER click closed the screen (the serve's settle did not). */
  let userDismissed = false;
  skip.addEventListener("click", () => {
    userDismissed = true;
    skipCatalogScreen();
  });
  // The completion CTA rides the exact close path of the dismiss copy,
  // then hands the fresh catalog over: opening the EN picker makes the
  // synced families immediately visible against the rail's unpicked
  // 尚未加载字体 cards (issue #17 review: the first run ended with no
  // visible result). Only this click branch — the auto-close path
  // (materializer → settled) announces itself with the handoff toast
  // in render instead.
  start.addEventListener("click", () => {
    userDismissed = true;
    skipCatalogScreen();
    openFontPicker("en");
  });

  /** seed (manifest unknown) or serve (status authoritative). */
  let mode: "seed" | "serve" | null = null;
  const rows = new Map<string, RowParts>();
  let materializerRow: HTMLElement | null = null;

  const makeRow = (family: string): RowParts => {
    const row = document.createElement("div");
    row.className = "catalog-family";
    row.dataset.family = family;
    const name = document.createElement("span");
    name.className = "catalog-family-name";
    name.textContent = family;
    const status = document.createElement("span");
    status.className = "catalog-family-status";
    row.append(name, status);
    return { row, status, error: null };
  };

  const render = (): void => {
    const { catalog } = store.get();
    // True only on the render that STARTS the exit fade without a user
    // click behind it — the serve's own settle (see the handoff toast).
    let autoClosed = false;
    // The exit fade (the reviews' "hard cut"): hide after the
    // animation, cancel if the screen comes back within the window.
    if (catalog.screen) {
      clearTimeout(outTimer);
      screen.classList.remove("out");
      screen.hidden = false;
    } else if (!screen.hidden && !screen.classList.contains("out")) {
      screen.classList.add("out");
      outTimer = setTimeout(() => {
        screen.classList.remove("out");
        screen.hidden = true;
      }, 180);
      autoClosed = !userDismissed;
    }

    // The connecting variant: the sidecar window owns the panel before
    // any status sample exists. Its label is its own — the download
    // copy must appear only around a real sync.
    const connecting = catalog.screen && catalog.status === "connecting";
    if (connecting) {
      screen.setAttribute("aria-label", "正在启动字体服务");
      titleA.textContent = "正在启动字体服务";
      titleSep.hidden = true;
      titleB.hidden = true;
      sub.textContent = "首次启动需解压字体服务，约需几十秒";
      sub.hidden = false;
    } else {
      screen.setAttribute("aria-label", "首次运行：下载字体目录");
      titleA.textContent = "首次运行";
      titleSep.hidden = false;
      titleB.hidden = false;
      sub.hidden = true;
    }

    // Is the status families list authoritative? The `document` key
    // decides; against a serve predating it (undefined) the fallback
    // treats a non-empty list or a terminal state as authoritative and
    // everything else as "manifest not known yet" (seed rows).
    const loaded =
      catalog.document !== undefined
        ? catalog.document === "loaded"
        : catalog.progress.length > 0 ||
          catalog.status === "ready" ||
          catalog.status === "unavailable";

    // The discrete row-set switch rebuilds the list exactly once.
    const nextMode: "seed" | "serve" = loaded ? "serve" : "seed";
    if (nextMode !== mode) {
      mode = nextMode;
      rows.clear();
      materializerRow?.remove();
      materializerRow = null;
      list.replaceChildren();
    }

    const entries: Array<{
      family: string;
      state: CatalogFamilyProgress["state"] | typeof SEED_STATUS;
      error: string | null;
    }> = loaded
      ? catalog.progress.map((family) => ({
          family: family.family,
          state: family.state,
          error: family.error ?? null,
        }))
      : SEED_FAMILIES.map((family) => ({
          family,
          state: SEED_STATUS,
          error: null,
        }));

    const present = new Set<string>();
    for (const entry of entries) {
      present.add(entry.family);
      let parts = rows.get(entry.family);
      if (parts === undefined) {
        parts = makeRow(entry.family);
        rows.set(entry.family, parts);
        list.appendChild(parts.row);
      }
      parts.row.dataset.status = entry.state;
      parts.status.textContent =
        entry.state === SEED_STATUS ? SEED_TEXT : STATUS_TEXT[entry.state];
      // Failures state the serve's own reason inline — nothing lives in
      // hover-only tooltips (ADR-0004).
      if (entry.state === "failed" && entry.error) {
        if (parts.error === null) {
          parts.error = document.createElement("span");
          parts.error.className = "catalog-family-error";
          parts.row.appendChild(parts.error);
        }
        parts.error.textContent = entry.error;
      } else if (parts.error !== null) {
        parts.error.remove();
        parts.error = null;
      }
    }
    for (const [family, parts] of rows) {
      if (!present.has(family)) {
        parts.row.remove();
        rows.delete(family);
      }
    }

    // The materializer tail: only while the screen is still up (a cold
    // download run) and every family is done — the entries sweep the
    // fetched layout needs keeps the panel honestly busy. Warm boots
    // suppress this screen entirely; their materializer progress is
    // implied by the picker working.
    const allDone =
      loaded &&
      catalog.progress.length > 0 &&
      catalog.progress.every((family) => family.state === "done");
    const mat = catalog.materializer;
    const matActive =
      mat !== undefined && mat.phase !== "done" && mat.phase !== "failed";
    if (allDone && matActive) {
      if (materializerRow === null) {
        materializerRow = document.createElement("div");
        materializerRow.className = "catalog-family catalog-materializer";
        materializerRow.dataset.family = "materializer";
        list.appendChild(materializerRow);
      }
      materializerRow.textContent =
        mat!.phase === "entries" && mat!.total
          ? `字体文件准备中 ${mat!.done ?? 0}/${mat!.total}`
          : "字体文件准备中…";
      // One story across the two progress layers (issue #17 reviews:
      // "4/4 done" next to "still downloading" read as a contradiction):
      // the sub line bridges the head's download title and the tail
      // row's file count — the families are all in, what is still
      // arriving is the font files themselves. The connecting window
      // owns the sub line elsewhere.
      if (!connecting) {
        sub.textContent = "字体家族已全部下载，正在准备字体文件…";
        sub.hidden = false;
      }
    } else if (materializerRow !== null) {
      materializerRow.remove();
      materializerRow = null;
    }

    // The counters and the bar read the display rows (seed count until
    // the document lands, then the authoritative N).
    const doneCount = loaded
      ? catalog.progress.filter((family) => family.state === "done").length
      : 0;
    done.textContent = String(doneCount);
    total.textContent = String(entries.length);
    checking.hidden = loaded;
    const complete = allDone && !matActive;
    // The auto-close handoff (issue #17 review trail, the residual
    // "closed itself, then nothing" path): when the serve's settle —
    // never a user click — closes a COMPLETED screen, the workspace
    // underneath is the rail's unpicked 尚未加载字体 cards with no
    // guide at all. One short toast points at the rail. The CTA click
    // opens the EN picker itself (no double guidance) and the skip is
    // a deliberate "later" — neither toasts. The status gate keeps the
    // failure closes honest: the unavailable fetch-break carries the
    // previous poll's all-done rows, but never the settled "ready".
    if (autoClosed && complete && catalog.status === "ready") {
      appMessages().push({
        icon: "check",
        title: "字体目录已就绪——点击侧栏选择字体",
        autoDismiss: 4000,
      });
    }
    // Visibility, not display: the tag's float space is reserved from
    // the first frame, so its appearance cannot reflow the head (the
    // dual-axis reviews caught a 9px jump here).
    readyTag.classList.toggle("on", complete);
    // The terminal title: the client's materializer window keeps the
    // panel up for a while at 4/4 — the head must not keep saying
    // "downloading" next to the ready tag.
    titleB.textContent = complete ? "字体目录已就绪" : "正在下载字体目录";
    // The terminal actions: "skip, later" is the wrong sole control at
    // 4/4 — completion swaps in the start CTA (same close path) and
    // hides the dismiss copy; mid-run the dismiss copy is unchanged.
    start.hidden = !complete;
    skip.hidden = complete;
    bar.classList.toggle("complete", complete);
    // Indeterminate while nothing is countable yet — the sidecar window
    // or the ultra-early document fetch of a true first start.
    const indeterminate = connecting || entries.length === 0;
    bar.classList.toggle("indeterminate", indeterminate);
    // Liveness between family completions — the window the sweep never
    // covered: once rows exist and the count is moving (0 < done <
    // total) the fill breathes, so a multi-second wait inside one
    // family's download never reads as a frozen panel. The materializer
    // window needs the same breath: at done == total the count stops
    // moving while matActive still keeps the panel honestly busy
    // (complete is allDone && !matActive), so the FULL fill pulses until
    // the sweep truly settles — and the pulse falls back the very render
    // matActive does, before `complete` can style the bar. The discrete
    // scaleX steps and their transition stay exactly as they were.
    const busy = !indeterminate && doneCount > 0 && doneCount < entries.length;
    const matBusy = allDone && matActive;
    bar.classList.toggle("busy", busy || matBusy);
    barFill.style.transform =
      entries.length === 0 || indeterminate
        ? "scaleX(0)"
        : `scaleX(${doneCount / entries.length})`;
  };
  store.subscribe(render);
  render();
}
