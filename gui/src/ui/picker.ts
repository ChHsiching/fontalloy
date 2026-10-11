import {
  store,
  type CatalogFamilyEntry,
  type CatalogState,
} from "../state";
import { registerFontBytes } from "../fonts/registry";
import { getDefaultManager } from "../catalog/manager";
import { canPickWithDialog, pickLocalFonts } from "../platform/localfonts";
import {
  cssFamily,
  mountPickerPopup,
  type PickerFont,
  type PickerPopup,
  type PickerPopupProps,
} from "../kit/pickerPopup";
import type { FontMeta } from "../kit/metaLine";
import catalogManifest from "../data/catalog.json";
import devCatalogManifest from "../data/dev-catalog.json";

export type PickerRole = "en" | "cjk";

export interface PickerOptions {
  role: PickerRole;
}

export interface FontPicker {
  open(): void;
  close(): void;
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
  if (family.status === "failed") return "未下载 · 下次启动自动重试";
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
 * repo's catalog manifest (the honest in-repo source; stars have no
 * source of truth here and stay omitted rather than invented). The
 * committed dev-fixture overlay (data/dev-catalog.json) merges on top —
 * the vite dev server serves those families from host font files.
 */
const MANIFEST_META = new Map<string, FontMeta>(
  [
    ...catalogManifest.families,
    ...devCatalogManifest.families,
  ].map((family) => [
    family.family,
    {
      license: family.license_spdx
        .replace(/-1\.1$/, "")
        .replace(/-(no-)?RFN$/, ""),
      trait: family.variant,
    },
  ]),
);

/**
 * A font picker (ADR-0004), assembled from the kit's PickerPopup: the
 * card renders the current font in its own typeface plus its MetaLine;
 * opening attaches the popup listbox (search header, inner scroll,
 * footer OUTSIDE the scroll) with node persistence and frame clamping.
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
   * Select a catalog family for preview: read the primary face from local
   * storage (it was sha256-verified at download time), register it through
   * the same FontFace(arrayBuffer) path as local files, and load it so the
   * anchor renders in it immediately.
   */
  const selectCatalogFamily = async (
    family: CatalogFamilyEntry,
  ): Promise<void> => {
    const manager = getDefaultManager();
    const release = manager?.getRelease();
    const meta = release?.families.find((f) => f.family === family.family);
    if (!manager || !meta) return;
    const cssKey = await manager.ensureRegistered(meta);
    if (!cssKey) {
      error = `无法载入目录字体 ${family.family}：存储的字体文件无法解析。`;
      rerender();
      return;
    }
    // Deterministic load for immediate rendering (lazy faces load on use).
    await document.fonts.load(`16px ${cssFamily(cssKey)}`);
    store.set({
      selected: { ...store.get().selected, [options.role]: cssKey },
    });
  };

  const buildProps = (): PickerPopupProps => {
    const { fonts, selected, catalog } = store.get();
    const selectedKey = selected[options.role];

    // Catalog families first (metadata-driven rows); the name text is the
    // metadata family and the row renders in its own font once the face
    // is registered (ADR-0004).
    const rows: PickerFont[] = catalog.families.map((family) => {
      const cssKey = catalog.registered[family.family] ?? null;
      const available = family.status === "verified";
      return {
        id: cssKey ?? `cat:${family.family}`,
        name: family.family,
        family: cssKey ?? undefined,
        meta: MANIFEST_META.get(family.family),
        disabled: !available,
        note: catalogTag(family),
      };
    });

    // Locally loaded fonts, deduped against registered catalog faces
    // (their catalog row already lists them). Every local row carries
    // the 本地字体文件 trait — the row AND the compact header card then
    // read "Consolas / 本地字体文件" like the prototype's local picks.
    const registered = new Set(Object.values(catalog.registered));
    const seen = new Set<string>();
    for (const font of fonts) {
      if (seen.has(font.cssFamily) || registered.has(font.cssFamily)) continue;
      seen.add(font.cssFamily);
      rows.push({
        id: font.cssFamily,
        name: font.family,
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
      onPick: (id) => {
        if (id.startsWith("cat:")) {
          const family = catalog.families.find(
            (f) => `cat:${f.family}` === id,
          );
          if (family) void selectCatalogFamily(family);
          return;
        }
        store.set({
          selected: { ...store.get().selected, [options.role]: id },
        });
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
  rerender();

  return {
    open: () => {
      lastOpenedRole = options.role;
      popup.open();
    },
    close: () => popup.close(),
  };
}
