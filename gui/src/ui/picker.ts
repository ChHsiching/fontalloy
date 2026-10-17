import {
  store,
  type CatalogFamilyDoc,
  type CatalogState,
  type LoadedFont,
} from "../state";
import {
  registerLocalFontFiles,
  fontDisplayName,
  evictCssFamily,
  type LocalFontFile,
} from "../fonts/registry";
import { sweepLocalFamily } from "../fonts/localFamily";
import {
  ensureCatalogRegistered,
  previewCssFamily,
  starsFor,
  subscribeStars,
} from "../catalog/serve";
import { appMessages } from "./charmap";
import {
  TOKEN_HELP_ROWS,
  displayFamilies,
  variantCuts,
  type CatalogEntryLike,
  type DisplayFamily,
  type VariantCut,
} from "../catalog/variantAxes";
import {
  canPickWithDialog,
  pickLocalFonts,
  readFontPathInput,
} from "../platform/localfonts";
import { readConfig } from "../platform/config";
import {
  registerSystemFamily,
  systemFamilies,
  systemFontsPending,
} from "../service/systemfonts";
import { synthStore } from "../service/state";
import {
  cssFamily,
  mountPickerPopup,
  type PickerChip,
  type PickerFont,
  type PickerPopup,
  type PickerPopupProps,
} from "../kit/pickerPopup";
import { helpNote, workedTable } from "../kit/helpPopover";
import type { FontMeta } from "../kit/metaLine";
import catalogManifest from "../data/catalog.json";
import curatedMeta from "../data/curated-meta.json";

export type PickerRole = "en" | "cjk";

/**
 * Whether the typed-path fallback exists (round 20, owner item 3): the
 * Tauri shell's `read_font_path` command, or an injected seam on the
 * same config bootstrap the save flows use. The native dialog stays
 * PRIMARY either way — the path input is the fallback that never
 * depends on a file manager.
 */
function pathInputAvailable(): boolean {
  return canPickWithDialog() || readConfig().readFontPath !== undefined;
}

export interface PickerOptions {
  role: PickerRole;
}

export interface FontPicker {
  open(): void;
  close(): void;
  /** Detach the picker's store/star subscriptions (region teardown). */
  destroy?(): void;
}

/** The shared hidden file input (one local-load flow at a time). */
let fileInput: HTMLInputElement | null = null;
/** The bytes-level flow the input's change event runs (set by the
 *  footer action; tests and warm loads reach the input directly and
 *  land in the picker that opened last). */
let pendingRegister: ((files: LocalFontFile[]) => Promise<void>) | null = null;
/** Per-picker local-load flows (round 20: bytes-level — every entry
 * point funnels here): the hidden input, the native dialog, and the
 * typed path all land in the picker that opened last. */
const localFlows = new Map<
  PickerRole,
  (files: LocalFontFile[]) => Promise<void>
>();
let lastOpenedRole: PickerRole | null = null;

/** The local-load flow of the slot a load should land in. */
function localFlowFor(
  role: PickerRole | null,
): ((files: LocalFontFile[]) => Promise<void>) | null {
  const target = role ?? lastOpenedRole ?? "en";
  return localFlows.get(target) ?? null;
}

/** Browser File objects → the bytes-level flow payload. */
async function filesToLocalFontFiles(files: File[]): Promise<LocalFontFile[]> {
  return Promise.all(
    files.map(async (file) => ({
      buffer: await file.arrayBuffer(),
      fileName: file.name,
    })),
  );
}

function ensureFileInput(): HTMLInputElement {
  if (fileInput === null) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ttf,.otf,.woff,.woff2,.ttc";
    input.multiple = true;
    input.hidden = true;
    input.dataset.role = "font-file";
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      if (files.length === 0) return;
      const flow = pendingRegister ?? localFlowFor(lastOpenedRole);
      if (pendingRegister !== null) pendingRegister = null; // one-shot
      if (flow !== null) void filesToLocalFontFiles(files).then(flow);
    });
    document.body.appendChild(input);
    fileInput = input;
  }
  return fileInput;
}

/**
 * Drag-and-drop loading (round 20) was REMOVED in round 23 (owner item
 * 3): the two font pickers are the app's only load entry points — the
 * footer button, the native dialog, and the typed path — so dropping
 * files on the window is a silent no-op now (the webview still
 * intercepts drops; nobody listens).
 */

/**
 * A family's readiness (the serve document's own state) as an inline
 * row/chip tag. `done` families carry no tag; everything else states
 * itself — never a silent dead row.
 */
function readinessTag(doc: CatalogFamilyDoc | undefined): string | undefined {
  if (doc === undefined) return "未收录";
  switch (doc.readiness) {
    case "done":
      return undefined;
    case "pending":
      return "等待同步";
    case "downloading":
      return "下载中…";
    case "extracting":
      return "解压中…";
    case "verifying":
      return "校验中…";
    case "failed":
      return "同步失败，稍后启动自动重试";
    case "unsynced":
      return "未同步";
    case "absent":
      return "未收录";
    default:
      return undefined;
  }
}

/** Catalog status line for the popup footer (visible text, never hover). */
function catalogNote(catalog: CatalogState): string | null {
  if (catalog.status === "unavailable") {
    // The serve's own error string, VERBATIM (ticket #30 / spec #25
    // story 3): the owner reads what the sync actually said.
    return catalog.error && catalog.error.length > 0
      ? catalog.error
      : "目录不可用（离线）—— 本地字体不受影响。";
  }
  if (catalog.status === "bootstrapping") {
    const done = catalog.progress.filter((f) => f.state === "done").length;
    return catalog.progress.length > 0
      ? `内置目录同步中：${done}/${catalog.progress.length} 个家族已完成。`
      : "内置目录同步中…";
  }
  return null;
}

/**
 * Display metadata for a catalog family: license + variant from the
 * repo's catalog manifest (the honest in-repo source), overlaid with
 * the curated display DATA the validated prototype carries — GitHub
 * stars and the Chinese trait tags (连字 / 楷体 / 圆角等宽 …) — from
 * data/curated-meta.json. Display NAMES are not curated (round 9,
 * owner item 2): every name surface reads the registered font's own
 * name table (see variantDisplayName); unfetched rows fall back to the
 * upstream release artifact's own name. Star counts come through
 * `starsFor` (round 5; ticket #33): the SERVE's launch-cached sweep,
 * falling back to this curated seed when it landed nothing.
 */
const CURATED_META = curatedMeta.families as Record<
  string,
  { stars?: number; trait?: string }
>;

/** The curated front per picker role: featured families pinned first
 *  (the prototype's LB/LD rows), in the prototype's order. */
const CURATED_FRONT = (curatedMeta as {
  front: { en: string[]; cjk: string[] };
}).front;

/**
 * The per-slot catalogs (round 5, owner item 2 — the prototype's BA/DA
 * wiring): the EN slot lists the Nerd Fonts coding families, the CJK
 * slot the CJK families. `slots.cjk` in curated-meta names the CJK
 * families; every other family is an EN-slot family.
 * NerdFontsSymbolsOnly never lists in either.
 */
const CJK_SLOT_FAMILIES = new Set(
  (curatedMeta as { slots?: { cjk?: string[] } }).slots?.cjk ?? [],
);

/**
 * The display-family groups (round 7): WenKai's six manifest families
 * (kai × mono × screen × GB — separate upstream repos) collapse onto
 * one row whose chips resolve to the exact member family + variant.
 */
const FAMILY_GROUPS: Record<string, string[]> = (
  curatedMeta as { groups?: Record<string, string[]> }
).groups ?? {};

/** The manifest's display families (static data; computed once). */
const ALL_DISPLAYS: readonly DisplayFamily[] = displayFamilies(FAMILY_GROUPS);

/** The one family the prototype never lists (icon-only symbols build). */
const EXCLUDED_FAMILIES = new Set(["NerdFontsSymbolsOnly"]);

const MANIFEST_META = new Map<string, FontMeta>(
  catalogManifest.families.map((family) => {
    const curated = CURATED_META[family.family];
    return [
      family.family,
      {
        license: family.license_spdx
          .replace(/-1\.1$/, "")
          .replace(/-(no-)?RFN$/, ""),
        trait: curated?.trait ?? family.variant,
      },
    ];
  }),
);

/**
 * The meta line of one family (stars resolved live-first): the SERVE's
 * launch-cached count (ticket #33 — the page no longer fetches GitHub
 * itself), falling back to the curated seed when the sweep has not
 * landed a count.
 */
function familyMeta(family: string): FontMeta | undefined {
  const base = MANIFEST_META.get(family);
  const stars = starsFor(family) ?? CURATED_META[family]?.stars;
  if (base === undefined && stars === undefined) return undefined;
  return { license: base?.license, stars, trait: base?.trait };
}

/**
 * The user-facing name of a loaded font (round 9, owner item 2): the
 * font file's OWN name-table strings, verbatim — nameID 16/1 + 17/2 as
 * the author wrote them ("LXGW WenKai Screen" stays "LXGW WenKai
 * Screen", never 屏幕版/Screen-翻译/mixed hand-built forms). Local
 * files keep their parsed name (it IS the name table). The top bar's
 * pair tags, the rail cards, the char popup's 来自 line, and the
 * report/message source names are the consumers.
 */
export function variantDisplayName(font: LoadedFont): string {
  return fontDisplayName(font);
}

/**
 * The unscanned row's fallback name (round 9, owner item 2): the
 * family document's own data label — the release artifact's stem, from
 * the SERVE's cut structure — never a constructed string. Scanned
 * families read `display_name` (the real name-table name).
 */
function documentRowName(doc: CatalogFamilyDoc | undefined, family: string): string {
  if (doc === undefined) return family;
  if (doc.display_name !== null) return doc.display_name;
  const cut = doc.cuts.find((c) => c.def) ?? doc.cuts[0];
  return cut !== undefined ? (cut.display_name ?? cut.label) : family;
}

/**
 * The variant chips of one display row: one chip per CUT — the distinct
 * releases the curated manifest mirror pins, labeled with each cut's
 * OWN name (the serve document's scanned name-table display, verbatim;
 * an unscanned cut keeps the release artifact's own stem). The default
 * cut renders PLAIN; the accent marks only the user's EXPLICIT pick. A
 * cut whose member family is not synced renders disabled with its
 * readiness tag. Every chip is a real manifest entry, so impossible
 * combinations never appear at all.
 */
function rowChips(
  cuts: readonly VariantCut[],
  selectedCutId: string | null,
  docOf: (family: string) => CatalogFamilyDoc | undefined,
): PickerChip[] {
  return cuts.map((cut) => {
    const doc = docOf(cut.entry.family);
    const synced = doc !== undefined && doc.readiness === "done";
    const label =
      doc?.cuts.find((docCut) => docCut.variant === cut.entry.variant)
        ?.display_name ?? cut.label;
    return {
      id: cut.id,
      label,
      on: selectedCutId === cut.id,
      disabled: !synced,
      tag: synced ? undefined : (readinessTag(doc) ?? "未收录"),
    };
  });
}

/**
 * A font picker (ADR-0004), assembled from the kit's PickerPopup: the
 * card renders the current font in its own typeface plus its MetaLine;
 * opening reveals the anchor-fused list card (search header, inner
 * scroll, footer OUTSIDE the scroll) — a persistent child of the card
 * with the AppSelect open/close discipline.
 *
 * Rows list catalog families (metadata-driven, self-rendered once their
 * face is registered, carrying their download state when not yet
 * verified) plus locally loaded fonts; the footer action runs the
 * local-file flow (the native dialog under Tauri, the shared hidden
 * input in the browser).
 */
export function mountPicker(
  root: HTMLElement,
  options: PickerOptions,
): FontPicker {
  root.dataset.role = `picker-${options.role}`;
  // The shared local-file input exists from the start (tests and the
  // footer action reach for it without an open/click warm-up).
  ensureFileInput();
  let error: string | null = null;
  /**
   * The in-flight local load's progress (round 21, owner item 2; round
   * 23 phases): the footer's inline spinner + count mirrors it while a
   * load runs — 「正在读取 n/N」 while a collection's faces extract,
   * 「正在加载 n/N」 while they register.
   */
  let loading:
    | { loaded: number; total: number; phase?: "reading" | "registering" }
    | null = null;

  /**
   * The picker's local-load flow — every entry point funnels here (the
   * hidden input, the native dialog, the typed path).
   * Round 20 (owner items 2+3): the load registers the files' families
   * (a collection registers EVERY face — one css family per name-table
   * family, weight-descriptor faces behind a Regular-preferred
   * representative) and THIS slot takes the loaded family as its pick,
   * REPLACING whatever it held — 从本地加载了肯定就直接选中了. A
   * failure keeps the picker open with the error line above the footer;
   * a partial failure still selects what loaded.
   *
   * Round 21 (owner item 2): the registration runs ASYNC with yields
   * between faces — the footer's load action carries the inline
   * 「正在加载 3/16」 indicator while it runs (never a blocking
   * overlay; the workspace stays interactive), and completion posts
   * ONE outcome card with the run's stats (家族 N · 字形 M).
   */
  const registerPicked = async (files: LocalFontFile[]): Promise<void> => {
    error = null;
    loading = { loaded: 0, total: files.length };
    rerender();
    const outcome = await registerLocalFontFiles(files, {
      onProgress: (loaded, total, phase) => {
        loading = { loaded, total, phase };
        rerender();
      },
    });
    loading = null;
    if (outcome.representative !== null) {
      store.set({
        selected: {
          ...store.get().selected,
          [options.role]: outcome.representative.cssFamily,
        },
      });
      // Round 13 (owner item 7): the pick is the FAMILY — discover and
      // register the same-directory sibling faces in the background,
      // the same face-set discipline a catalog pick follows. Never
      // blocks the pick; a one-file family registers nothing.
      void sweepLocalFamily(outcome.representative);
      // The outcome card (round 21): ONE structured card with the
      // run's stats — the message system's stat-pair idiom, never a
      // prose line. A partial failure warns; the failures themselves
      // stay on the picker's error line below.
      appMessages().push({
        icon: outcome.failures.length > 0 ? "warn" : "check",
        title: "已加载本地字体",
        stats: [
          { value: String(outcome.families), label: "家族" },
          {
            value: outcome.glyphs.toLocaleString("en-US"),
            label: "字形",
          },
        ],
      });
    }
    error = outcome.failures.length > 0 ? outcome.failures.join("；") : null;
    // Prototype parity: a successful load closes the picker (the new
    // pick is what the closed card now shows); a failure keeps it open
    // so the error line above the footer stays reachable.
    if (error === null) popup.close();
    rerender();
  };
  localFlows.set(options.role, registerPicked);

  /**
   * The typed-path fallback (round 20, owner item 3): resolve the
   * pasted absolute path — file or directory — and run the same
   * register+select flow. Failures render on the picker's error line.
   */
  const commitPathInput = async (path: string): Promise<void> => {
    error = null;
    rerender();
    try {
      const read = await readFontPathInput(path);
      if (read.files.length === 0) {
        error = `路径下没有字体文件：${path}`;
      } else {
        await registerPicked(read.files);
        return; // registerPicked owns error/close/rerender.
      }
    } catch (err) {
      error = `无法读取 ${path}：${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    rerender();
  };

  const openLocalFlow = async (): Promise<void> => {
    // Under Tauri the native dialog: real absolute paths for recipes.
    // A dialog that errors (no DBus file manager) falls back to the
    // picker's own error line — the typed path stays the fallback.
    if (canPickWithDialog()) {
      try {
        const picked = await pickLocalFonts();
        if (picked !== null && picked.length > 0) {
          await registerPicked(picked);
        }
        return;
      } catch (err) {
        error = `无法打开文件对话框：${
          err instanceof Error ? err.message : String(err)
        }`;
        rerender();
        return;
      }
    }
    pendingRegister = registerPicked;
    ensureFileInput().click();
  };

  /**
   * Round 18 + ticket #32: unload THIS slot's pick — the selection
   * returns to the never-picked null AND a catalog pick's URL faces
   * evict from document.fonts with their registry record (the MEMORY
   * RED LINE's other half: unloading actually frees the font memory).
   * Local and system picks keep their registrations (a user-loaded
   * file stays loaded — the original round-18 behavior); the other
   * slot holding the same family holds it too.
   */
  const unloadSlotPick = (): void => {
    const prior = store.get().selected[options.role];
    if (prior !== null) {
      const record = store.get().fonts.find((f) => f.cssFamily === prior);
      const other = options.role === "en" ? "cjk" : "en";
      if (
        record !== undefined &&
        record.origin === "catalog" &&
        store.get().selected[other] !== prior
      ) {
        evictCssFamily(prior);
      }
    }
    store.set({
      selected: { ...store.get().selected, [options.role]: null },
    });
  };

  /**
   * Select a catalog entry for preview (round 7: an entry names the
   * exact manifest family + VARIANT a row or chip resolved to; ticket
   * #30/#32): the cut's slot winners register as lazy URL FontFaces
   * with their descriptors, and the family's default slot is loaded
   * so the anchor renders in it immediately.
   */
  const selectCatalogEntry = async (
    entry: CatalogEntryLike,
  ): Promise<void> => {
    error = null;
    let cssKey: string | null;
    try {
      cssKey = await ensureCatalogRegistered(entry.family, entry.variant);
    } catch (err) {
      cssKey = null;
      error = err instanceof Error ? err.message : String(err);
    }
    if (!cssKey) {
      if (error === null) {
        error = `无法载入目录字体 ${entry.family}：目录中尚无该字体的可用字面。`;
      }
      rerender();
      return;
    }
    // Deterministic load of the default slot for immediate rendering;
    // the other slots stay lazy (a load failure is the picker's error
    // line, never an unhandled rejection).
    try {
      await document.fonts.load(`16px ${cssFamily(cssKey)}`);
    } catch (err) {
      error = `无法载入目录字体 ${entry.family}：${
        err instanceof Error ? err.message : String(err)
      }`;
      rerender();
      return;
    }
    store.set({
      selected: { ...store.get().selected, [options.role]: cssKey },
    });
  };

  /**
   * Round 24 (owner item 3): pick an installed system family. The
   * service serves the scanned file's bytes; registration follows the
   * local-load path (a collection contributes every extracted face,
   * representative first). A failure keeps the picker open with the
   * error line.
   */
  const selectSystemFamily = async (familyName: string): Promise<void> => {
    const client = synthStore.get().service.client;
    const family = systemFamilies().find((f) => f.family === familyName);
    if (!client || !family) return;
    const cssKey = await registerSystemFamily(client, family);
    if (!cssKey) {
      // Round 25 (owner item 2): a failed LOAD is an outcome, not a
      // form validation error — it rides the message system like the
      // local-load outcome card, never the picker's inline line.
      appMessages().push({
        icon: "warn",
        title: "无法载入系统字体",
        lines: [`${familyName}：文件无法读取。`],
      });
      return;
    }
    await document.fonts.load(`16px ${cssFamily(cssKey)}`);
    store.set({
      selected: { ...store.get().selected, [options.role]: cssKey },
    });
  };

  /**
   * Plain pick of a release family the manifest mirror does not carry
   * (the e2e fixtures' invented families, the dev extras): the serve
   * document's own default cut rides the catalog identity (ticket #32:
   * the same URL FontFace registration as any catalog pick).
   */
  const selectReleaseFamily = async (family: string): Promise<void> => {
    error = null;
    let cssKey: string | null;
    try {
      cssKey = await ensureCatalogRegistered(family, null);
    } catch (err) {
      cssKey = null;
      error = err instanceof Error ? err.message : String(err);
    }
    if (!cssKey) {
      if (error === null) {
        error = `无法载入目录字体 ${family}：目录中尚无该字体的可用字面。`;
      }
      rerender();
      return;
    }
    try {
      await document.fonts.load(`16px ${cssFamily(cssKey)}`);
    } catch (err) {
      error = `无法载入目录字体 ${family}：${
        err instanceof Error ? err.message : String(err)
      }`;
      rerender();
      return;
    }
    store.set({
      selected: { ...store.get().selected, [options.role]: cssKey },
    });
  };

  /**
   * The live variant selection per display family (round 8: the
   * explicitly picked CUT id — null/absent = the family's default cut).
   */
  const variantSelections = new Map<string, string>();

  const buildProps = (): PickerPopupProps => {
    const { fonts, selected, catalog } = store.get();
    const selectedKey = selected[options.role];

    // The role's OWN catalog (round 5, owner item 2): the EN slot lists
    // the Nerd Fonts coding families, the CJK slot the CJK families —
    // separate catalogs, exactly the prototype's BA/DA wiring (round 7:
    // one DISPLAY family per typeface — WenKai's six manifest families
    // collapse onto one chip row through the curated groups table).
    // Release families the manifest mirror does not carry (the e2e
    // fixtures' invented families, the dev catalog's prototype extras)
    // keep their own plain rows — no manifest entries, no chips. The
    // curated front pins first (keyed on the DISPLAY id — a registered
    // family's row swaps its `cat:` id for the css key, so ids are not
    // stable keys); NerdFontsSymbolsOnly never lists.
    const manifestDisplays = ALL_DISPLAYS.filter(
      (display) => !display.families.some((f) => EXCLUDED_FAMILIES.has(f)),
    );
    const covered = new Set(manifestDisplays.flatMap((d) => d.families));
    /**
     * The families the serve's catalog actually CARRIES: the families
     * the status document's per-family progress names (populated the
     * moment the release document loaded) plus every family whose
     * readiness already says done. Manifest-only families (readiness
     * `absent`) never list, and a catalog whose release document never
     * loaded (progress empty, everything pending) carries nothing —
     * the footer's verbatim error is the whole story then, exactly
     * like the empty catalog of before.
     */
    const progressed = new Set(catalog.progress.map((entry) => entry.family));
    const carried = new Set(
      catalog.documents
        .filter(
          (doc) =>
            progressed.has(doc.family) ||
            doc.readiness === "done" ||
            doc.readiness === "failed",
        )
        .map((doc) => doc.family),
    );
    const releaseExtras: DisplayFamily[] = catalog.documents
      .filter(
        (doc) =>
          carried.has(doc.family) &&
          !covered.has(doc.family) &&
          !EXCLUDED_FAMILIES.has(doc.family),
      )
      .map((doc) => ({ id: doc.family, families: [doc.family], entries: [] }));
    /** The serve's family document of one manifest family. */
    const docOf = (family: string): CatalogFamilyDoc | undefined =>
      catalog.documents.find((doc) => doc.family === family);
    /**
     * The cssFamily a family's registered face lives under: the exact
     * catalog identity first (family + the pick's variant), then any
     * registration of the family.
     */
    const registeredCss = (family: string, variant?: string): string | null => {
      if (variant !== undefined) {
        const exact = fonts.find(
          (f) =>
            f.catalog?.family === family && f.catalog?.variant === variant,
        );
        if (exact !== undefined) return exact.cssFamily;
      }
      const bare = fonts.find((f) => f.catalog?.family === family);
      return bare !== undefined ? bare.cssFamily : null;
    };
    const displays = [...manifestDisplays, ...releaseExtras]
      .filter((display) => {
        const isCjk = display.families.some((f) => CJK_SLOT_FAMILIES.has(f));
        return options.role === "cjk" ? isCjk : !isCjk;
      })
      // A row lists only when the serve's catalog actually carries one
      // of its families (a serve may serve a subset of the manifest).
      .filter((display) => display.families.some((f) => carried.has(f)));

    const rowsByFamily = new Map(
      displays.map((display) => {
        const primaryFamily = display.families[0]!;
        const primaryDoc = docOf(primaryFamily);
        const memberDocs = display.families
          .map((f) => docOf(f))
          .filter((doc): doc is CatalogFamilyDoc => doc !== undefined);
        const anyDone = memberDocs.some((doc) => doc.readiness === "done");
        const rowNoteDoc = memberDocs.find((doc) => doc.readiness !== "done");
        // The cuts (round 8): one chip per distinct release; the ACTIVE
        // cut is the explicit selection, else the family default.
        const cuts = variantCuts(display);
        const selectedCutId = variantSelections.get(display.id) ?? null;
        const activeCut =
          cuts.find((cut) => cut.id === selectedCutId) ?? cuts[0] ?? null;
        // The checked state: the registration of the CURRENTLY active
        // cut first (a chip pick registered the variant's own face),
        // any registered member face as fallback.
        const cssKey =
          (activeCut !== null
            ? registeredCss(activeCut.entry.family, activeCut.entry.variant)
            : null) ?? registeredCss(primaryFamily) ?? null;
        // Round 9 (owner item 2): the row name is the family's OWN
        // name-table string from the serve document; a picked row reads
        // the registered face's own display; an unscanned row falls
        // back to the document's data label — never a curated or
        // constructed display name.
        const activeFont =
          cssKey !== null
            ? (fonts.find((f) => f.cssFamily === cssKey) ?? null)
            : null;
        const activeDoc = docOf(activeCut?.entry.family ?? primaryFamily);
        const rowName = activeFont
          ? fontDisplayName(activeFont)
          : documentRowName(activeDoc ?? primaryDoc, activeCut?.entry.family ?? primaryFamily);
        const chips = rowChips(cuts, selectedCutId, docOf);
        /**
         * Round 21/22: the row's search index covers EVERY cut's own
         * name — the serve document's scanned name-table display, else
         * the cut's release artifact stem — beside the family id and
         * the manifest family ids, so "source" surfaces the NotoSansSC
         * row through its "Source Han Sans HW SC" HW cut even though
         * the row itself reads "Noto Sans SC", findable BEFORE the
         * scan lands (variant word + artifact stem words, version
         * noise stripped, camel humps split).
         */
        const cutName = (cut: VariantCut): string => {
          const doc = docOf(cut.entry.family);
          return (
            doc?.cuts.find((docCut) => docCut.variant === cut.entry.variant)
              ?.display_name ??
            doc?.display_name ??
            cut.entry.file.replace(/\.[^.]+$/, "")
          );
        };
        const cutTokens = (cut: VariantCut): string[] => {
          const stem = cut.entry.file.replace(/\.[^.]+$/, "");
          const words = stem
            .split(/[_\-\s]+/)
            .flatMap((word) => word.split(/(?<=[a-z])(?=[A-Z])/))
            .flatMap((word) => word.split(/(?<=[A-Z])(?=[A-Z][a-z])/))
            .filter((word) => !/^(v?\d+(\.\d+)*)$/i.test(word));
          return [cut.entry.variant ?? "", ...words].filter(Boolean);
        };
        const rowId = cssKey ?? `cat:${display.id}`;
        // Self-rendering (ticket #30): the row renders in its OWN
        // preview-subset family (the active cut's, else the primary
        // member's) — a lazy URL FontFace, never a registered binary:
        // listing the catalog holds no font bytes in the page.
        const renderDoc = activeDoc ?? primaryDoc;
        return [
          display.id,
          {
            id: rowId,
            name: rowName,
            family:
              renderDoc !== undefined && renderDoc.preview !== null
                ? previewCssFamily(renderDoc.family)
                : undefined,
            meta: familyMeta(primaryFamily),
            disabled: !anyDone,
            note: anyDone
              ? undefined
              : rowNoteDoc === undefined
                ? undefined
                : readinessTag(rowNoteDoc),
            chips: chips.length > 1 ? chips : undefined,
            keywords: [
              display.id,
              ...display.families,
              ...cuts.flatMap(cutTokens),
              ...cuts.map(cutName),
              ...memberDocs.flatMap((doc) =>
                doc.display_names.length > 0 ? doc.display_names : [],
              ),
            ].join(" "),
          } satisfies PickerFont,
        ];
      }),
    );
    const frontIds = CURATED_FRONT[options.role] ?? [];
    const frontSet = new Set(frontIds);
    const rows: PickerFont[] = [
      ...frontIds.flatMap((id) => {
        const row = rowsByFamily.get(id);
        return row === undefined ? [] : [row];
      }),
      ...displays
        .filter((display) => !frontSet.has(display.id))
        .map((display) => rowsByFamily.get(display.id)!),
    ];
    // Round 30 (owner report: the picker sat empty with no hint while
    // the catalog was fetched — the loading window owns no rows of its
    // own): a disabled loading row heads the list until the serve's
    // first status answer lands and the family documents arrive. The
    // first-run DOWNLOAD progress screen stays what it is — it shows
    // only when the serve actually syncs.
    if (
      catalog.status === "connecting" ||
      (catalog.status === "bootstrapping" && catalog.documents.length === 0)
    ) {
      rows.unshift({
        id: "catalog-loading",
        name: "内置目录准备中…",
        disabled: true,
      });
    }
    // The live row id (a css key once registered) back to its display
    // family — the chip handler resolves rows by id, never by name.
    const displayByRowId = new Map(
      displays.map((display) => [rowsByFamily.get(display.id)!.id, display.id]),
    );

    // Locally loaded fonts. Faces that entered the registry through the
    // catalog (download or lazy registration) are NEVER listed here —
    // their catalog row already carries them, and `origin` says so
    // directly (keying on the registered map instead would show ghost
    // duplicate rows while the registration sweep is mid-flight).
    // Every local row carries the 本地字体文件 trait — the row AND the
    // compact header card then read "Consolas / 本地字体文件" like the
    // prototype's local picks.
    const seen = new Set<string>();
    for (const font of fonts) {
      if (
        seen.has(font.cssFamily) ||
        font.origin === "catalog" ||
        font.origin === "system"
      ) {
        continue;
      }
      seen.add(font.cssFamily);
      rows.push({
        id: font.cssFamily,
        // The local row's name: the file's own name table (round 9).
        name: fontDisplayName(font),
        // Every row renders its family name in its own font (ADR-0004).
        family: font.cssFamily,
        meta: { trait: "本地字体文件" },
      });
    }

    // Round 24 (owner item 3): the installed system fonts, listed
    // under their OWN coverage — a Latin-covering family in the EN
    // slot, a CJK-covering family in the CJK slot, BOTH when a family
    // covers both (微软雅黑's Chinese is a legitimate standalone
    // pick). A family another source already registered under the
    // same name-table family keeps that row — never a duplicate.
    const takenByOtherSources = new Set(
      fonts
        .filter((f) => f.origin !== "system")
        .map((f) => f.cssFamily),
    );
    for (const family of systemFamilies()) {
      if (options.role === "cjk" ? !family.cjk : !family.latin) continue;
      const registered = fonts.find((f) => f.cssFamily === family.family);
      if (registered !== undefined && takenByOtherSources.has(family.family)) {
        continue;
      }
      rows.push({
        id: family.family,
        name: registered ? fontDisplayName(registered) : family.family,
        // Self-render once a pick has loaded the face (ADR-0004).
        family: registered ? registered.cssFamily : undefined,
        meta: { trait: "系统字体" },
        keywords: [
          family.family,
          ...family.faces.map((face) => face.subfamily),
        ].join(" "),
      });
    }
    // Round 30 (owner report: no hint while the serve's system-font
    // scan warms): the scan's own loading row, appended exactly where
    // the system rows will land — never once they exist.
    if (systemFontsPending() && systemFamilies().length === 0) {
      rows.push({
        id: "system-loading",
        name: "系统字体扫描中…",
        disabled: true,
      });
    }

    return {
      role: options.role,
      fonts: rows,
      selectedId: selectedKey,
      emptyLabel: "尚未加载字体",
      emptyText: "尚未加载字体 —— 请从下方加载本地字体文件。",
      note: catalogNote(catalog),
      error,
      footer: {
        label: "加载本地字体文件",
        onClick: () => void openLocalFlow(),
        // The inline spinner + count while a load runs (round 21).
        ...(loading !== null ? { loading } : {}),
      },
      // The typed-path fallback (round 20): only where a resolver
      // exists — the Tauri shell, or an injected test seam. Round 21:
      // the placeholder is SHORT and fully visible at rest (the field
      // is content-sized and expands on focus; the full value rides
      // the field's title tooltip).
      ...(pathInputAvailable()
        ? {
            pathInput: {
              placeholder: "或输入路径",
              onCommit: (path: string) => void commitPathInput(path),
            },
          }
        : {}),
      // The picker-level variant help (round 8 final form): ONE ? for
      // the whole popup — one sentence plus the token table (the words
      // that appear inside the cuts' own release names).
      help: {
        title: "变体是什么",
        buttonLabel: "变体是什么",
        build: () => {
          const body = document.createElement("div");
          body.append(
            helpNote(
              "同一款字体常有多个发行版本，称为变体；标签就是各发行版自己的名字。点击字体行下方的标签即可切换，未选择时使用家族默认版本。",
            ),
          );
          body.append(workedTable(["名字里的词", "含义"], TOKEN_HELP_ROWS));
          return body;
        },
      },
      onPick: (id) => {
        // Round 18 (owner item 3): clicking the row this role already
        // picked UNLOADS the pick — selection returns to the never-picked
        // null, the same toggle the row's active chip gets below. The
        // pick is always a css key and an unregistered row id starts
        // with `cat:`, so a plain identity check decides it. The row's
        // explicit-cut memory goes with the pick (a fresh pick starts
        // from the family default again). Ticket #32: a catalog pick's
        // URL faces evict with the selection.
        if (id === store.get().selected[options.role]) {
          const pickedDisplay = displayByRowId.get(id);
          if (pickedDisplay !== undefined) {
            variantSelections.delete(pickedDisplay);
          }
          unloadSlotPick();
          return;
        }
        if (id.startsWith("cat:")) {
          const display = displays.find((d) => `cat:${d.id}` === id);
          if (!display) return;
          // A release-only family (no manifest entries): plain pick.
          if (display.entries.length === 0) {
            void selectReleaseFamily(display.id);
            return;
          }
          // The row's ACTIVE cut (explicit selection, else default).
          const cuts = variantCuts(display);
          const cut =
            cuts.find((c) => c.id === variantSelections.get(display.id)) ??
            cuts[0];
          if (cut) void selectCatalogEntry(cut.entry);
          return;
        }
        // Round 24: an installed system family that nobody picked
        // yet has no registry record — load it (the service serves the
        // scanned file's bytes) and select what registers.
        if (
          !fonts.some((f) => f.cssFamily === id) &&
          systemFamilies().some((f) => f.family === id)
        ) {
          void selectSystemFamily(id);
          return;
        }
        store.set({
          selected: { ...store.get().selected, [options.role]: id },
        });
      },
      onChip: (rowId, chipId) => {
        const displayId = displayByRowId.get(rowId);
        const display = displays.find((d) => d.id === displayId);
        if (!display) return;
        const cuts = variantCuts(display);
        const cut = cuts.find((c) => c.id === chipId);
        if (!cut) return;
        // Round 18 (owner item 3): clicking the ACTIVE chip of the row
        // this role already picked clears the whole family pick — the
        // chip IS the cut, and clearing means no family. The active cut
        // is the explicit selection, else the family default, so the
        // default chip unloads exactly like an accented one. A
        // DIFFERENT chip still switches cuts below. Ticket #32: the
        // cleared pick's URL faces evict with the selection.
        const activeCutId =
          variantSelections.get(display.id) ?? cuts[0]?.id ?? null;
        if (
          rowId === store.get().selected[options.role] &&
          chipId === activeCutId
        ) {
          variantSelections.delete(display.id);
          unloadSlotPick();
          return;
        }
        // Clicking the selected cut reverts the family to its default.
        if (variantSelections.get(display.id) === chipId) {
          variantSelections.delete(display.id);
        } else {
          variantSelections.set(display.id, chipId);
        }
        // Load whatever is now active — the picked cut, or the family
        // default the revert returns to.
        const active =
          variantCuts(display).find(
            (c) => c.id === variantSelections.get(display.id),
          ) ?? variantCuts(display)[0];
        if (active) void selectCatalogEntry(active.entry);
      },
    };
  };

  const popup: PickerPopup = mountPickerPopup(root, buildProps());
  // Capture-phase: a real click on the card makes THIS picker the
  // direct-load target before the kit's own header handler runs.
  popup.el.addEventListener(
    "click",
    () => {
      lastOpenedRole = options.role;
    },
    true,
  );

  function rerender(): void {
    popup.render(buildProps());
  }
  store.subscribe(rerender);
  // Round 24: the system-font enumeration lands on the SERVICE state —
  // the rows join when it does.
  synthStore.subscribe(rerender);
  // Live star counts landing after startup re-render the rows in place.
  const unsubscribeStars = subscribeStars(rerender);
  const unsubscribeSynth = synthStore.subscribe(rerender);
  rerender();

  return {
    open: () => {
      lastOpenedRole = options.role;
      popup.open();
    },
    close: () => popup.close(),
    destroy: () => {
      localFlows.delete(options.role);
      unsubscribeStars();
      unsubscribeSynth();
    },
  };
}
