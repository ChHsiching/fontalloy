import { store, type LoadedFont } from "../state";
import { readConfig } from "../platform/config";
import { cssFamily } from "../kit/pickerPopup";

/**
 * The user-facing name of a registered font (round 9, owner item 2):
 * the name-table strings the SERVE's scan read, verbatim — never a
 * curated or constructed display name. The record's own `names.display`
 * (built from the document's identity fields) is what every surface
 * reads, falling back to the metadata family.
 */
export function fontDisplayName(font: LoadedFont): string {
  return font.names?.display ?? font.family;
}

/** One catalog/local/system face to register by URL: href + its slot. */
export interface CatalogFaceUrl {
  /** The serve's absolute face URL (streamed bytes, cache headers). */
  url: string;
  /** The face's OS/2 weight, as the family document reports it. */
  weight: number;
  style: "normal" | "italic";
}

/**
 * Register a family's faces as URL FontFaces (ticket #32, the MEMORY
 * RED LINE): one FontFace per (weight, style) slot winner, each
 * carrying its descriptor and a `url(...)` source — the page holds NO
 * bytes; the browser fetches a face only when something actually
 * renders in that weight/style (lazy per used descriptor). Nothing is
 * awaited: load errors surface at use time, exactly like the preview
 * subsets' own lazy faces. This is the ONLY FontFace construction left
 * in the frontend (ticket #36: the byte fallback died with the upload
 * endpoint; the conformance guard pins a zero non-URL budget).
 *
 * The eviction counterpart is {@link evictCssFamily}.
 */
export function registerCatalogUrlFaces(
  cssFamily: string,
  faces: readonly CatalogFaceUrl[],
): void {
  for (const face of faces) {
    document.fonts.add(
      new FontFace(cssFamily, `url(${JSON.stringify(face.url)})`, {
        weight: String(face.weight),
        style: face.style,
      }),
    );
  }
}

/**
 * The css family name as the FontFace API reports it. A URL-source
 * FontFace's ``family`` is re-serialized through the CSS grammar — a
 * spaced family like ``Alloy Wide`` reads back as ``"Alloy Wide"``
 * WITH quotes, so every family-keyed comparison normalizes the quotes
 * away first.
 */
function reportedFamily(face: FontFace): string {
  const name = face.family;
  return name.length > 1 && name.startsWith('"') && name.endsWith('"')
    ? name.slice(1, -1)
    : name;
}

/**
 * Evict one css family's registration (ticket #32): every face of the
 * family comes off document.fonts — the browser releases the native
 * font data behind them — and the store's records for the family drop,
 * so a re-pick re-registers from scratch. Repeat-click unload keeps
 * working across the whole cycle.
 *
 * Scoped to one css family key; a catalog family's key is its manifest
 * id, so a same-named LOCAL load colliding with it (a family whose
 * manifest id equals its name-table family) is evicted with it — the
 * acceptable edge, re-loadable from either side.
 */
export function evictCssFamily(cssFamily: string): void {
  for (const face of [...document.fonts]) {
    if (reportedFamily(face) === cssFamily) document.fonts.delete(face);
  }
  const before = store.get().fonts;
  const after = before.filter((font) => font.cssFamily !== cssFamily);
  if (after.length !== before.length) store.set({ fonts: after });
}

/**
 * The abort budget for a pick's default-slot font load (the round-30
 * hung-fetch lesson, applied to the one await the serve client cannot
 * reach): a URL-source FontFace's byte fetch rides the BROWSER's font
 * loader, not {@link ServeClient} — an endpoint that accepts the
 * connection and never answers leaves the face in ``loading`` forever,
 * parking `document.fonts.load` AND `document.fonts.ready` with it at
 * zero CPU (the J11.3 wedge, ticket #37 / spec #25). Every pick's
 * default-slot load runs under this budget: a service that cannot
 * deliver the face within it reads as a failed load, the family's
 * registration is evicted (a stuck-loading face must come OFF
 * document.fonts, or the set's ready promise stays parked for the rest
 * of the page's life), and the caller surfaces the error loudly.
 */
export const FONT_LOAD_BUDGET_MS = 30_000;

/**
 * The default-slot load's budget expired: the face's byte fetch never
 * settled within {@link FONT_LOAD_BUDGET_MS} and the family's
 * registration was evicted with it. Consumers treat it as a failed
 * load (their existing error surfaces state it); the local-load flow
 * additionally drops its representative pick, since the family it
 * would select no longer exists.
 */
export class FontLoadBudgetError extends Error {}

/**
 * Browser-native load-failure messages. A URL FontFace's byte fetch
 * rejects with the BROWSER's own English wording — Firefox's
 * NetworkError ``A network error occurred.``, its fetch twin
 * ``NetworkError when attempting to fetch resource.``, Chrome's
 * ``Failed to fetch``, WebKit's ``Load failed`` — and every consumer
 * of the default-slot load used to splice ``err.message`` into its
 * error surface verbatim, so a failed system-font pick showed the
 * untranslated runtime string (the fonts-errors round-2 finding).
 * These phrasings — and any DOMException named ``NetworkError`` —
 * map to one localized copy; everything else passes through.
 */
const NETWORK_LOAD_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  "A network error occurred.",
  "NetworkError when attempting to fetch resource.",
  "Failed to fetch",
  "Load failed",
]);

/** The localized line the browser-native network failures render as. */
const NETWORK_LOAD_FAILURE_COPY = "网络错误：无法从服务获取字体数据。";

/**
 * Localize a font-load rejection's browser-native message: the
 * rejection of a URL FontFace's byte fetch is constructed by the
 * browser (``document.fonts.load``), so its message is runtime
 * English original no locale can translate after the fact. Known
 * network phrasings (and NetworkError DOMExceptions) come back as a
 * new Error carrying the localized copy with the original attached
 * as ``cause``; every other rejection is returned untouched, message
 * and identity both — the budget error above all.
 */
export function localizedFontLoadError(err: unknown): unknown {
  if (
    err instanceof Error &&
    (err.name === "NetworkError" ||
      NETWORK_LOAD_FAILURE_MESSAGES.has(err.message))
  ) {
    return new Error(NETWORK_LOAD_FAILURE_COPY, { cause: err });
  }
  return err;
}

/**
 * One font FILE's load failure as a structured card. The serve's scan
 * verdict for a rejected file is a wrapped, path-bearing string — the
 * scan pipeline formats ``file is not a valid font: <path> (<cause>)``
 * and wraps that template once more around the fontTools cause, so
 * the raw verdict names the file's scratch/temp path twice and nests
 * its parentheticals three deep; splicing it verbatim onto an error
 * line rendered a wall of raw red text. This object carries what a
 * failure surface actually renders: the file's bare display name, a
 * cleaned one-line reason (paths stripped, the duplicated wrapper
 * collapsed), and the ready summary line.
 */
export interface FontFileFailure {
  /** The file's display name — its basename, never a directory. */
  file: string;
  /** The cleaned reason: no paths, no duplicated wrapper nesting. */
  reason: string;
  /** The ready card line: 无法加载 file：reason */
  summary: string;
}

/** The scan verdict's leading phrase for a file that is not a font. */
const NOT_A_VALID_FONT = "file is not a valid font";

/** Basename of a path, Windows or POSIX separators. */
function failureBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] !== "" ? parts[parts.length - 1]! : path;
}

/**
 * Strip every path copy out of a scan verdict: the file's own
 * absolute path first (the verdict embeds it, twice over when the
 * template is self-wrapped), then any other absolute-path token — a
 * Windows drive path or a rooted POSIX path standing after a
 * boundary character. Mid-word slashes never match, so a phrase like
 * ``TrueType/OpenType`` survives intact.
 */
function stripVerdictPaths(text: string, path: string): string {
  let out = path.length > 0 ? text.split(path).join(" ") : text;
  out = out
    .replace(/([(\s:：]|^)[A-Za-z]:[\\/][^\s()]*/g, "$1")
    .replace(/([(\s:：]|^)\/[^\s()]*/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Collapse the verdict's self-wrapping to one ``file is not a valid
 * font: <cause>`` line. The wrapper's opening paren is the text's
 * first and its close the text's last, so the peel stays balanced by
 * construction: while the text is ``M: … (M: … (…))`` the OUTER
 * marker-plus-path prefix is the duplicate and drops; the final
 * wrapper around the true cause keeps its marker and sheds the
 * decorative parens. A text that does not follow the template is
 * returned as-is.
 */
function unwrapVerdict(text: string): string {
  let reason = text;
  for (;;) {
    if (!reason.startsWith(NOT_A_VALID_FONT)) return reason;
    const open = reason.indexOf("(");
    if (open === -1) return reason;
    const close = reason.lastIndexOf(")");
    if (close <= open) return reason;
    const inner = reason.slice(open + 1, close);
    if (!inner.startsWith(NOT_A_VALID_FONT)) {
      return `${NOT_A_VALID_FONT}: ${inner}`;
    }
    reason = inner;
  }
}

/**
 * The failure card of one font file the scan rejected: the file's
 * basename plus the verdict cleaned to a single honest line — both
 * path copies gone, the self-wrapped ``file is not a valid font``
 * template collapsed to one prefix with its innermost cause intact
 * (``file is not a valid font: Not a TrueType or OpenType font (bad
 * sfntVersion)``). A verdict that follows no template is only
 * path-stripped, never dumped raw. The local-load failure surfaces
 * (the picker's error row, the outcome card's lines) render the
 * card instead of splicing the verdict verbatim.
 */
export function describeFontFileFailure(
  path: string,
  raw: string,
): FontFileFailure {
  const reason = unwrapVerdict(stripVerdictPaths(raw, path));
  const file = failureBasename(path);
  return { file, reason, summary: `无法加载 ${file}：${reason}` };
}

/**
 * Load one registered css family's default slot within
 * {@link FONT_LOAD_BUDGET_MS} (the spec the pick paths use:
 * ``16px <family>``). Resolves when the face renders; on budget expiry
 * the family's faces are evicted and the rejection carries the
 * timeout, so the caller's existing error handling (the picker's error
 * line, the outcome card) states it — the flow fails loudly instead of
 * hanging. A genuine load REJECTION (corrupt bytes, a 404) passes
 * through — only the never-settling fetch warrants eviction — with
 * one repair: a rejection whose message is the BROWSER's own runtime
 * English network wording rides {@link localizedFontLoadError}, so
 * the failure surfaces never show the untranslated original. The
 * config seam `testFontLoadBudgetMs` overrides the budget for the
 * e2e regression specs only.
 */
export async function loadDefaultSlotWithBudget(cssKey: string): Promise<void> {
  const budgetMs = readConfig().testFontLoadBudgetMs ?? FONT_LOAD_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      document.fonts.load(`16px ${cssFamily(cssKey)}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new FontLoadBudgetError(
                `字体载入超时（${Math.round(budgetMs / 1000)} 秒内服务未返回字体数据）。`,
              ),
            ),
          budgetMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof FontLoadBudgetError) {
      // The stuck face must leave the set: a loading FontFace parked
      // on document.fonts keeps the set's ready promise pending
      // forever — the very wedge this budget exists to end.
      evictCssFamily(cssKey);
      throw err;
    }
    // A genuine rejection keeps its identity — but a message the
    // browser itself worded (a NetworkError's runtime English) must
    // not reach an error surface untranslated.
    throw localizedFontLoadError(err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
