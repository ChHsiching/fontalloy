import {
  store,
  type CatalogFamilyEntry,
  type CatalogState,
  type LoadedFont,
} from "../state";
import { registerFontBytes, fontDisplayName } from "../fonts/registry";
import { getDefaultManager } from "../catalog/manager";
import { starsFor, subscribeStars } from "../catalog/stars";
import {
  TOKEN_HELP_ROWS,
  cutLabels,
  displayFamilies,
  variantCuts,
  type CatalogEntryLike,
  type DisplayFamily,
  type VariantCut,
} from "../catalog/variantAxes";
import { canPickWithDialog, pickLocalFonts } from "../platform/localfonts";
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
/** The registration callback the input's change event runs (set by the
 *  footer action; tests and warm loads reach the input directly). */
let pendingRegister: ((files: File[]) => Promise<void>) | null = null;
/** Per-picker registration flows, for direct loads (the file input set
 *  without a footer click): they land in the picker that opened last. */
const registerFlows = new Map<PickerRole, (files: File[]) => Promise<void>>();
let lastOpenedRole: PickerRole | null = null;

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
      const flow =
        pendingRegister ??
        (lastOpenedRole !== null
          ? registerFlows.get(lastOpenedRole) ?? null
          : null);
      if (flow !== null && files.length > 0) {
        void flow(files);
      }
    });
    document.body.appendChild(input);
    fileInput = input;
  }
  return fileInput;
}

/** Inline status tag for a catalog row that cannot be picked (yet). */
function catalogTag(family: CatalogFamilyEntry): string | undefined {
  // Icon-purge round: the status and its remedy are one sentence — a
  // comma joins them (the interpunct was glyph-as-chrome).
  if (family.status === "failed") return "未下载，下次启动自动重试";
  if (family.status === "downloading") return "下载中…";
  if (family.status === "pending") return "等待下载";
  return undefined;
}

/** Catalog status line for the popup footer (visible text, never hover). */
function catalogNote(catalog: CatalogState): string | null {
  if (catalog.status === "unavailable") {
    return "目录不可用（离线）—— 本地字体不受影响。";
  }
  if (catalog.status === "settled-partial") {
    const missing = catalog.families.filter((f) => f.status !== "verified").length;
    return `目录不完整：${missing} 个家族未下载，下次启动时自动重试。`;
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
 * `starsFor` (round 5): the live startup fetch, falling back to the
 * curated seed when offline.
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

/** The meta line of one family (stars resolved live-first). */
function familyMeta(family: string): FontMeta | undefined {
  const base = MANIFEST_META.get(family);
  const stars = starsFor(family);
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
 * The upstream release artifact's own name — the row a font that has
 * not been fetched falls back to (round 9, owner item 2): the stem of
 * the release document's face file, never a constructed string.
 */
function releaseArtifactName(family: string): string {
  const meta = getDefaultManager()
    ?.getRelease()
    ?.families.find((f) => f.family === family);
  const face = meta?.files[0]?.file ?? `${family}.ttf`;
  return face.replace(/\.[^.]+$/, "");
}

/**
 * The variant chips of one display row: one chip per CUT — the distinct
 * releases the manifest pins, labeled in the DATA'S OWN WORDS (round 9,
 * owner item 2: the registered cut's name-table name after the family's
 * shared base — 「Maple Mono NF CN」 after 「Maple Mono NF」 reads CN;
 * unfetched cuts fall back to the manifest's variant word or the
 * release artifact's own suffix). The default cut renders PLAIN; the
 * accent marks only the user's EXPLICIT pick. A cut whose member family
 * is not fetched renders disabled with the 未下载 tag. Every chip is a
 * real manifest entry, so impossible combinations never appear at all.
 */
function rowChips(
  cuts: readonly VariantCut[],
  selectedCutId: string | null,
  statusOf: (family: string) => CatalogFamilyEntry | undefined,
  labels: ReadonlyMap<string, string>,
): PickerChip[] {
  return cuts.map((cut) => {
    const verified = statusOf(cut.entry.family)?.status === "verified";
    return {
      id: cut.id,
      label: labels.get(cut.id) ?? cut.label,
      on: selectedCutId === cut.id,
      disabled: !verified,
      tag: verified ? undefined : "未下载",
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

  /** Register picked local fonts, selecting the first new family. */
  const registerPicked = async (
    entries: Array<{ buffer: ArrayBuffer; fileName: string; path?: string }>,
  ): Promise<void> => {
    error = null;
    for (const entry of entries) {
      try {
        const { font, isNewFamily } = await registerFontBytes(entry.buffer, {
          fileName: entry.fileName,
          origin: "local",
          path: entry.path,
        });
        if (isNewFamily && store.get().selected[options.role] === null) {
          store.set({
            selected: { ...store.get().selected, [options.role]: font.cssFamily },
          });
        }
      } catch (err) {
        error = `无法加载 ${entry.fileName}：${
          err instanceof Error ? err.message : "不是有效的字体文件"
        }`;
      }
    }
    // Prototype parity: a successful load closes the picker (the new
    // pick is what the closed card now shows); a failure keeps it open
    // so the error line above the footer stays reachable.
    if (error === null) popup.close();
    rerender();
  };

  const openLocalFlow = async (): Promise<void> => {
    // Under Tauri the native dialog: real absolute paths for recipes.
    if (canPickWithDialog()) {
      const picked = await pickLocalFonts();
      if (picked !== null && picked.length > 0) {
        await registerPicked(picked);
      }
      return;
    }
    pendingRegister = async (files: File[]): Promise<void> => {
      await registerPicked(
        await Promise.all(
          files.map(async (file) => ({
            buffer: await file.arrayBuffer(),
            fileName: file.name,
          })),
        ),
      );
    };
    ensureFileInput().click();
  };

  /**
   * Select a catalog entry for preview (round 7: an entry names the
   * exact manifest family + VARIANT a row or chip resolved to): read
   * the variant's face from local storage (sha256-verified at download
   * time), register it through the same FontFace(arrayBuffer) path as
   * local files, and load it so the anchor renders in it immediately.
   */
  const selectCatalogEntry = async (
    entry: CatalogEntryLike,
  ): Promise<void> => {
    const manager = getDefaultManager();
    const release = manager?.getRelease();
    const meta = release?.families.find((f) => f.family === entry.family);
    if (!manager || !meta) return;
    const cssKey = await manager.ensureRegistered(meta, {
      variant: entry.variant,
    });
    if (!cssKey) {
      error = `无法载入目录字体 ${entry.family}：存储的字体文件无法解析。`;
      rerender();
      return;
    }
    // Deterministic load for immediate rendering (lazy faces load on use).
    await document.fonts.load(`16px ${cssFamily(cssKey)}`);
    store.set({
      selected: { ...store.get().selected, [options.role]: cssKey },
    });
  };

  /**
   * Plain pick of a release family the manifest mirror does not carry
   * (the e2e fixtures' invented families, the dev extras): the release
   * document's own variant rides the catalog identity.
   */
  const selectReleaseFamily = async (family: string): Promise<void> => {
    const manager = getDefaultManager();
    const meta = manager?.getRelease()?.families.find(
      (f) => f.family === family,
    );
    if (!manager || !meta) return;
    const cssKey = await manager.ensureRegistered(meta);
    if (!cssKey) {
      error = `无法载入目录字体 ${family}：存储的字体文件无法解析。`;
      rerender();
      return;
    }
    await document.fonts.load(`16px ${cssFamily(cssKey)}`);
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
    const releaseExtras: DisplayFamily[] = catalog.families
      .filter(
        (f) => !covered.has(f.family) && !EXCLUDED_FAMILIES.has(f.family),
      )
      .map((f) => ({ id: f.family, families: [f.family], entries: [] }));
    const statusOf = (family: string): CatalogFamilyEntry | undefined =>
      catalog.families.find((f) => f.family === family);
    /**
     * The cssFamily a family's registered face lives under: the exact
     * variant key first, then the bare family key, then ANY variant key
     * of the family (the sweep registers the face the release document
     * carries, under ITS variant — one face per dev family, every
     * member family in production).
     */
    const registeredCss = (family: string, variant?: string): string | null => {
      if (variant !== undefined) {
        const exact = catalog.registered[`${family}::${variant}`];
        if (exact !== undefined) return exact;
      }
      const bare = catalog.registered[family];
      if (bare !== undefined) return bare;
      for (const key of Object.keys(catalog.registered)) {
        if (key.startsWith(`${family}::`)) return catalog.registered[key]!;
      }
      return null;
    };
    const displays = [...manifestDisplays, ...releaseExtras]
      .filter((display) => {
        const isCjk = display.families.some((f) => CJK_SLOT_FAMILIES.has(f));
        return options.role === "cjk" ? isCjk : !isCjk;
      })
      // A row lists only when the release document actually carries one
      // of its families (the dev catalog may serve a subset).
      .filter((display) =>
        display.families.some((f) => statusOf(f) !== undefined),
      );

    const rowsByFamily = new Map(
      displays.map((display) => {
        const primaryFamily = display.families[0]!;
        const memberStatus = display.families
          .map((f) => statusOf(f))
          .filter((s): s is CatalogFamilyEntry => s !== undefined);
        const anyVerified = memberStatus.some((s) => s.status === "verified");
        const rowNote = memberStatus.find((s) => s.status !== "verified");
        // The cuts (round 8): one chip per distinct release; the ACTIVE
        // cut is the explicit selection, else the family default. The
        // LIST row reads the family name; the row the user actually
        // PICKED (the checked one — the picker card's selected state)
        // carries the registered face's own name-table name.
        const cuts = variantCuts(display);
        const selectedCutId = variantSelections.get(display.id) ?? null;
        const activeCut =
          cuts.find((cut) => cut.id === selectedCutId) ?? cuts[0] ?? null;
        // Self-render + the checked state: the registration of the
        // CURRENTLY active cut first (a chip pick registered the
        // variant's own face), any registered member face as fallback.
        const cssKey =
          (activeCut !== null
            ? registeredCss(activeCut.entry.family, activeCut.entry.variant)
            : null) ?? registeredCss(primaryFamily) ?? null;
        // Round 9 (owner item 2): the row name is the registered
        // font's OWN name-table string; an unfetched row falls back to
        // the upstream release artifact's own name — never a curated
        // or constructed display name.
        const activeFont =
          cssKey !== null
            ? (fonts.find((f) => f.cssFamily === cssKey) ?? null)
            : null;
        const rowName = activeFont
          ? fontDisplayName(activeFont)
          : releaseArtifactName(activeCut?.entry.family ?? primaryFamily);
        // The chip labels: the registered cuts' own name-table words,
        // falling back to the data label (variant / asset words).
        const nameOf = (cut: VariantCut): string | undefined => {
          const key = registeredCss(cut.entry.family, cut.entry.variant);
          if (key === null) return undefined;
          return fonts.find((f) => f.cssFamily === key)?.names?.display;
        };
        const labels = cutLabels(cuts, display.id, nameOf);
        const chips = rowChips(cuts, selectedCutId, statusOf, labels);
        const rowId = cssKey ?? `cat:${display.id}`;
        return [
          display.id,
          {
            id: rowId,
            name: rowName,
            family: cssKey ?? undefined,
            meta: familyMeta(primaryFamily),
            disabled: !anyVerified,
            note: anyVerified ? undefined : (rowNote ? catalogTag(rowNote) : undefined),
            chips: chips.length > 1 ? chips : undefined,
            keywords: `${display.id} ${display.families.join(" ")}`,
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
      if (seen.has(font.cssFamily) || font.origin === "catalog") continue;
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

    return {
      role: options.role,
      fonts: rows,
      selectedId: selectedKey,
      emptyLabel: "尚未加载字体",
      emptyText: "尚未加载字体 —— 请从下方加载本地字体文件。",
      note: catalogNote(catalog),
      error,
      footer: { label: "加载本地字体文件", onClick: () => void openLocalFlow() },
      // The picker-level variant help (round 8 final form): ONE ? for
      // the whole popup — one sentence plus the token table (the
      // official proper nouns and their meanings).
      help: {
        title: "变体是什么",
        buttonLabel: "变体是什么",
        build: () => {
          const body = document.createElement("div");
          body.append(
            helpNote(
              "同一款字体常有多个发行版本，称为变体；点击字体行下方的标签即可切换。未选择时使用家族默认（标准）。",
            ),
          );
          body.append(workedTable(["标签", "含义"], TOKEN_HELP_ROWS));
          return body;
        },
      },
      onPick: (id) => {
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
        store.set({
          selected: { ...store.get().selected, [options.role]: id },
        });
      },
      onChip: (rowId, chipId) => {
        const displayId = displayByRowId.get(rowId);
        const display = displays.find((d) => d.id === displayId);
        if (!display) return;
        const cut = variantCuts(display).find((c) => c.id === chipId);
        if (!cut) return;
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

  registerFlows.set(options.role, async (files: File[]): Promise<void> => {
    await registerPicked(
      await Promise.all(
        files.map(async (file) => ({
          buffer: await file.arrayBuffer(),
          fileName: file.name,
        })),
      ),
    );
  });

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
  // Live star counts landing after startup re-render the rows in place.
  const unsubscribeStars = subscribeStars(rerender);
  rerender();

  return {
    open: () => {
      lastOpenedRole = options.role;
      popup.open();
    },
    close: () => popup.close(),
    destroy: unsubscribeStars,
  };
}
