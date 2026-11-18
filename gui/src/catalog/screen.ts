import catalogManifest from "../data/catalog.json";
import { store, type CatalogFamilyProgress } from "../state";
import { setCatalogScope, skipCatalogScreen } from "./serve";
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

/** One family's row text — the state word, or the byte progress while
 *  the archive streams: `下载中 43%` (origin sent Content-Length) or
 *  `下载中 12.3 MiB` (it didn't). Never a motionless verb over running
 *  bytes. */
function statusText(entry: {
  state: CatalogFamilyProgress["state"] | typeof SEED_STATUS;
  downloaded?: number;
  total?: number;
}): string {
  if (entry.state === SEED_STATUS) return SEED_TEXT;
  if (entry.state !== "downloading") return STATUS_TEXT[entry.state];
  if (entry.downloaded === undefined) return STATUS_TEXT.downloading;
  if (entry.total !== undefined && entry.total > 0) {
    return `下载中 ${Math.min(100, Math.floor((entry.downloaded / entry.total) * 100))}%`;
  }
  return `下载中 ${(entry.downloaded / 1024 / 1024).toFixed(1)} MiB`;
}

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
      <div class="catalog-choice" data-role="catalog-choice" hidden>
        <div class="catalog-choice-cards">
          <button class="catalog-choice-card" type="button" data-choice="full">
            <span class="catalog-choice-name">下载全部字体</span>
            <span class="catalog-choice-note">下载后完全离线可用</span>
          </button>
          <button class="catalog-choice-card" type="button" data-choice="on-demand">
            <span class="catalog-choice-name">按需使用</span>
            <span class="catalog-choice-note">暂不下载，使用时再下载所选字体</span>
          </button>
        </div>
        <div class="catalog-choice-error" data-role="catalog-choice-error" hidden></div>
        <div class="catalog-choice-foot">随时可在设置中更改</div>
      </div>
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
  const choice = screen.querySelector<HTMLElement>(
    "[data-role='catalog-choice']",
  )!;
  const choiceError = screen.querySelector<HTMLElement>(
    "[data-role='catalog-choice-error']",
  )!;
  const choiceButtons = [
    ...screen.querySelectorAll<HTMLButtonElement>(".catalog-choice-card"),
  ];
  const counter = screen.querySelector<HTMLElement>(".catalog-progress")!;
  const skip = screen.querySelector<HTMLButtonElement>(".catalog-skip")!;
  const start = screen.querySelector<HTMLButtonElement>(".catalog-start")!;

  // ADR-0010: the two-entry choice. An undecided scope owns the panel
  // until the user picks — "full" hands it to the progress story on the
  // next poll; "on-demand" settles ready on its own, so the screen
  // closes immediately (the listing is already live). The skip stays
  // available either way (decide later — the next launch asks again).
  for (const button of choiceButtons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.choice as "full" | "on-demand";
      for (const other of choiceButtons) other.disabled = true;
      choiceError.hidden = true;
      void setCatalogScope(mode)
        .then(() => {
          if (mode === "on-demand") skipCatalogScreen();
        })
        .catch(() => {
          choiceError.textContent = "未能记录选择，请检查网络连接后重试。";
          choiceError.hidden = false;
          for (const other of choiceButtons) other.disabled = false;
        });
    });
  }

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
    // ADR-0010: an undecided scope owns the panel — the two-entry
    // choice replaces the progress story (counter, bar, list) until
    // the user picks. Explicit null only: serves predating the scope
    // key report undefined and never see the choice.
    const choosing =
      catalog.screen &&
      catalog.status === "bootstrapping" &&
      catalog.scope === null;
    if (connecting) {
      screen.setAttribute("aria-label", "正在启动字体服务");
      titleA.textContent = "正在启动字体服务";
      titleSep.hidden = true;
      titleB.hidden = true;
      sub.textContent = "首次启动需解压字体服务，约需几十秒";
      sub.hidden = false;
    } else if (choosing) {
      screen.setAttribute("aria-label", "首次使用：选择字体目录的下载方式");
      titleA.textContent = "首次使用";
      titleSep.hidden = false;
      titleB.hidden = false;
      sub.hidden = true;
    } else {
      screen.setAttribute("aria-label", "首次运行：下载字体目录");
      titleA.textContent = "首次运行";
      titleSep.hidden = false;
      titleB.hidden = false;
      sub.hidden = true;
    }
    choice.hidden = !choosing;
    // The sheet gives .catalog-list `display:flex` (and the bar/counter
    // sit under flexed parents) — the [hidden] ATTRIBUTE loses to a
    // sheet display rule, so the choice screen must hide them with an
    // EXPLICIT inline style (the round-11 discipline), not the attr.
    for (const el of [bar, counter, list]) {
      el.style.display = choosing ? "none" : "";
    }
    if (choosing) readyTag.hidden = true;

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
      list.replaceChildren();
    }

    const entries: Array<{
      family: string;
      state: CatalogFamilyProgress["state"] | typeof SEED_STATUS;
      error: string | null;
      downloaded?: number;
      total?: number;
    }> = loaded
      ? catalog.progress.map((family) => ({
          family: family.family,
          state: family.state,
          error: family.error ?? null,
          // The byte fields MUST ride along — the row text's 下载中 n%
          // reads them (round 5: stripping them here left the dialog's
          // rows bare while the picker showed live percents).
          ...(family.downloaded !== undefined
            ? { downloaded: family.downloaded }
            : {}),
          ...(family.total !== undefined ? { total: family.total } : {}),
        }))
      : SEED_FAMILIES.map((family) => ({
          family,
          state: SEED_STATUS,
          error: null,
        }));

    // The doc side of the story (ADR-0010's honest readiness): a
    // done-sync family whose document is still being indexed renders
    // 索引中 — the row owns the state word the user is actually
    // waiting on, never a premature 已完成.
    const docReadiness = new Map(
      catalog.documents.map((doc) => [doc.family, doc.readiness] as const),
    );
    const docIndexing = (family: string): boolean =>
      docReadiness.get(family) === "indexing";

    const present = new Set<string>();
    for (const entry of entries) {
      present.add(entry.family);
      let parts = rows.get(entry.family);
      if (parts === undefined) {
        parts = makeRow(entry.family);
        rows.set(entry.family, parts);
        list.appendChild(parts.row);
      }
      const display =
        entry.state === "done" && docIndexing(entry.family)
          ? "indexing"
          : entry.state;
      parts.row.dataset.status = display;
      parts.status.textContent =
        display === "indexing"
          ? "索引中"
          : entry.state === SEED_STATUS
            ? SEED_TEXT
            : statusText(entry);
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

    // The materializer is INVISIBLE plumbing (r31v4 owner ruling): its
    // sweep gates `complete` below but renders nothing — no row, no sub
    // line. The panel's story is the families' own six steps.
    const allDone =
      loaded &&
      catalog.progress.length > 0 &&
      catalog.progress.every((family) => family.state === "done");
    const mat = catalog.materializer;
    const matActive =
      mat !== undefined && mat.phase !== "done" && mat.phase !== "failed";

    // The indexing tail (r31v4): the bar keeps advancing through it
    // (each family's 索引 step is its fifth advance), the rows carry
    // 索引中 with their spinners. `complete` (the CTA, the ready tag,
    // the close) waits for it.
    const docsKnown = catalog.documents.length > 0;
    const indexingCount = entries.filter(
      (entry) => entry.state === "done" && docIndexing(entry.family),
    ).length;

    // The counters and the bar read the display rows (seed count until
    // the document lands, then the authoritative N).
    const doneCount = loaded
      ? catalog.progress.filter((family) => family.state === "done").length
      : 0;
    done.textContent = String(doneCount);
    total.textContent = String(entries.length);
    checking.hidden = loaded;
    // Completion is USABLE, not synced: every family done, the
    // materializer settled, AND the documents' indexing tail drained
    // (docs known — an unfetched document set never counts as done).
    const complete =
      allDone && !matActive && docsKnown && indexingCount === 0;
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
    // The terminal title: the head names the STAGE the panel is in —
    // never a "downloading" claim over an indexing or materializer
    // tail. While the choice owns the panel its own title stands.
    titleB.textContent = choosing
      ? "选择字体目录的下载方式"
      : complete
        ? "字体目录已就绪"
        : allDone && indexingCount > 0
          ? "正在构建字体索引"
          : "正在下载字体目录";
    // The terminal actions: completion swaps in the start CTA (same
    // close path) and hides the dismiss copy. The dismiss copy itself
    // names what it does ON EACH STAGE (r31v4: "跳过，稍后再说" read
    // as ambiguity, not choice) — on the choice it defers the
    // decision (the next launch asks again); on the download it hides
    // the panel while the sync keeps running in the serve.
    start.hidden = !complete;
    skip.hidden = complete;
    skip.textContent = choosing ? "稍后再选" : "后台继续下载";
    bar.classList.toggle("complete", complete);
    // Indeterminate while nothing is countable yet — the sidecar window
    // or the ultra-early document fetch of a true first start.
    const indeterminate = connecting || entries.length === 0;
    bar.classList.toggle("indeterminate", indeterminate);
    // The staged fill (r31v4): ONE monotone bar; each family advances
    // it FIVE times through its six steps — 等待(0) → 下载(0→0.2, by
    // bytes, smooth) → 解压(0.4) → 校验(0.6) → 索引(0.8) → 完成(1.0).
    // No extra stage text anywhere: the rows carry the step words, the
    // head names the stage, the bar carries the motion. The fill is
    // WIDTH-driven, so the highlight sweep lives inside the fill's own
    // box and cannot out-travel it.
    const STAGE_DOWNLOAD = 0.2;
    const STAGE_EXTRACT = 0.4;
    const STAGE_VERIFY = 0.6;
    const STAGE_INDEXING = 0.8;
    const fractionOf = (entry: (typeof entries)[number]): number => {
      switch (entry.state) {
        case SEED_STATUS:
        case "pending":
          return 0;
        case "downloading": {
          const { downloaded, total: bytes } = entry;
          const ratio =
            downloaded !== undefined &&
            bytes !== undefined &&
            bytes > 0
              ? downloaded / bytes
              : 0;
          return STAGE_DOWNLOAD * ratio;
        }
        case "extracting":
          return STAGE_EXTRACT;
        case "verifying":
          return STAGE_VERIFY;
        case "failed":
          return 1;
        case "done":
          return docIndexing(entry.family) || !docsKnown
            ? STAGE_INDEXING
            : 1;
        default:
          return 0;
      }
    };
    const fill = indeterminate
      ? 0
      : loaded
        ? entries.reduce((sum, entry) => sum + fractionOf(entry), 0) /
          entries.length
        : doneCount / entries.length;
    barFill.style.width = `${fill * 100}%`;
  };
  store.subscribe(render);
  render();
}
