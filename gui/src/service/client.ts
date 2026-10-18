/**
 * The serve HTTP client (issue #16): typed fetches over the localhost
 * contract `fontalloy serve` exposes (issue #11). This module knows the
 * wire and nothing else — no UI, no store — so the same client serves
 * the GUI synthesize flow and any future consumer unchanged.
 *
 * Conventions: every non-2xx response is turned into an `Error` carrying
 * the service's own `{"error": …}` message (the inline-failure surfaces
 * show exactly what the service said); network failures are caught and
 * rethrown with a Chinese, console-clean message (the app never logs
 * them — state only, per the seam-3 zero-JS-errors policy).
 */

import type { SystemFaceDoc, SystemFontFamilyDoc } from "./systemfonts";

/** `GET /health` — the connection probe. */
export interface HealthDocument {
  service: string;
  version: string;
  address: string;
  port: number;
}

/** One face of a local font directory entry (`GET /fonts`). */
export interface FaceDocument {
  path: string;
  face_index: number;
  family: string;
  subfamily: string;
  weight: number;
  italic: boolean;
  variable: boolean;
}

/** `GET /fonts` — the directories the service scans, as families. */
export interface FontsDocument {
  directories: string[];
  /**
   * False until the serve's background directory scan lands (spec #25
   * review P1-1 — the handler serves a cached snapshot, never parses);
   * the families list is empty while false.
   */
  ready: boolean;
  families: Array<{ name: string; faces: FaceDocument[] }>;
  skipped: string[];
}

/** One variant of a manifest family (`GET /catalog`). */
export interface CatalogVariantDocument {
  variant: string;
  version?: string;
  file: string;
}

/** `GET /catalog` — the manifest the service resolves catalog refs against. */
export interface CatalogDocument {
  manifest?: string;
  families: Array<{ family: string; variants: CatalogVariantDocument[] }>;
}

/* ---------- the local-font scan (ticket #31/#34: paths in, docs out) ---------- */

/** One face of a scanned local family document (the catalog doc shape). */
export interface LocalFaceDoc {
  file: string;
  /** The absolute on-disk path (recipes name it verbatim). */
  path: string;
  face_index: number;
  sha256: string | null;
  /** The serve-relative byte URL (`GET /local-fonts/face?path=&index=`). */
  href: string;
  family: string;
  subfamily: string;
  weight: number;
  italic: boolean;
  variable: boolean;
  coverage: {
    codepoints: number;
    placeholders: number;
    latin: boolean;
    cjk: boolean;
    /** Ticket #36: run-length intervals of the honest coverage. */
    intervals: number[][];
    /** The suspected-placeholder codepoints, same run shape. */
    placeholder_intervals: number[][];
  };
  placeholder: boolean;
  /** The face's own glyph count (maxp numGlyphs) — the 字形 stat. */
  glyphs: number;
}

/** `POST /local-fonts` — family documents in the catalog shape. */
export interface LocalFontsDocument {
  families: Array<{
    family: string;
    display_name: string | null;
    cuts: Array<{
      variant: string;
      def: boolean;
      display_name: string | null;
      representative: string | null;
      faces: LocalFaceDoc[];
    }>;
  }>;
  skipped: Array<{ path: string; error: string }>;
}

/** `GET /builds/{id}` — the job document, the progress endpoint. */
export interface BuildDocument {
  id: string;
  /**
   * Round 19 adds `cancelled`: the consumer stopped the build through
   * `POST /builds/{id}/cancel` — a distinct outcome, never a failure
   * (no error text, no artifact).
   */
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  stage: string | null;
  /**
   * Round 13 (owner item 5): the CURRENT stage's live facts — the
   * quantitative readout the pipeline already knows (file count and
   * sizes at loading, slot count at planning, rule/codepoint counts,
   * format and an estimated size at saving, the check count at
   * reporting). Null while queued or when the stage carries none;
   * consumers degrade to stage names alone.
   */
  facts: Record<string, string | number> | null;
  format: string;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  queue_position: number | null;
  error: string | null;
  font: { filename: string; size: number; sha256: string } | null;
  report: { filename: string } | null;
  href: string;
}

/** `POST /builds` response. */
export interface SubmitResult {
  id: string;
  status: string;
  href: string;
}

/**
 * One compressed run of `POST /precedence-resolve` (ticket #28/#35): a
 * maximal stretch of consecutive codepoints sharing the full answer
 * tuple. `declared` is the covering rule's first font + granularity
 * (exposed even when that rule cannot supply); `adjusted` is the 已调整
 * discipline — a non-set rule effectively moved the winner off the
 * no-rule default.
 */
export interface PrecedenceRun {
  start: number;
  end: number;
  /** Font ref: `base` or `donor-<index>`. */
  winner: string;
  /** `default`, or the winning rule's id (`rule-<declaration index>`). */
  via: string;
  kind: "base" | "fill" | "override";
  declared: { font: string; granularity: string } | null;
  adjusted: boolean;
}

/** `POST /precedence-resolve` — the effective table as compressed runs. */
export interface PrecedenceDocument {
  /** The merge's font ids in default order (`base`, `donor-0`, …). */
  fonts: string[];
  /** The declaration count (complete rules that serialize). */
  rules: number;
  /** |universe ∩ coverage union|. */
  codepoints: number;
  /** Sorted, disjoint, maximal same-answer stretches. */
  runs: PrecedenceRun[];
  counts: Record<string, number>;
  conflicts: unknown[];
  universe: string[] | null;
}

/** The machine form of the verification report (schema v2 fields used). */
export interface ReportDocument {
  schema?: string;
  output?: { path?: string; sha256?: string; format?: string };
  sources?: Array<{
    id?: string;
    role?: string;
    path?: string;
    sha256?: string;
    codepoints?: number;
    /** Round 18: codepoints the placeholder heuristic suspected in
     * this source (already excluded from `codepoints`). */
    placeholder_codepoints?: number;
  }>;
  precedence?: {
    counts?: Record<string, number>;
    same_layer_conflicts?: unknown[];
  };
  weights?: Array<{
    index?: number;
    weight?: number;
    style?: string;
    base_face?: number;
    borrows?: Array<{
      donor?: string;
      family?: string;
      weight?: number;
      style?: string;
      via?: string;
      style_fallback?: boolean;
    }>;
  }>;
  /** v2: the effective-table scope versus the built font's cmap. */
  coverage?: {
    overall?: {
      requested?: number;
      covered?: number;
      missing_total?: number;
      missing_truncated?: boolean;
    };
    rules?: unknown[];
  };
  /** v2: before/after metrics per output face. */
  metrics?: {
    faces?: Array<{
      weight?: number;
      style?: string;
      upem?: { base?: number; output?: number };
      latin_advance?: { base?: number; output?: number };
      cjk_advance?: { base?: number; output?: number };
      grid_ratio?: number;
      line_height_untouched?: { hhea?: boolean; typo?: boolean };
    }>;
  };
  summary?: {
    codepoints_total?: number;
    from_base?: number;
    from_donors?: number;
    output_codepoints?: number;
  };
  [key: string]: unknown;
}

/**
 * Prefix the scan documents' serve-relative face ``href`` fields with
 * the bound origin — the FontFace url() sources the page registers
 * (one place, so both the path scan and the upload scan serve the same
 * absolute URLs).
 */
function withAbsoluteHrefs(
  baseUrl: string,
): (document: LocalFontsDocument) => LocalFontsDocument {
  return (document) => ({
    ...document,
    families: document.families.map((family) => ({
      ...family,
      cuts: family.cuts.map((cut) => ({
        ...cut,
        faces: cut.faces.map((face) => ({
          ...face,
          href: `${baseUrl}${face.href}`,
        })),
      })),
    })),
  });
}

export class ServeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Round 30 (owner report: a second build stuck 排队中 forever and
 * uncancelable): the serve PROCESS can stay alive with its HTTP thread
 * dead — the kernel still accepts TCP connections into the backlog, so
 * fetch() never refuses AND never settles. Every request carries an
 * abort timeout: a service that cannot answer within it reads as
 * unreachable, the build row flips to its error card, and a cancel
 * that gets no answer fails visibly instead of hanging the panel.
 */
const CONTROL_TIMEOUT_MS = 15_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const REPORT_TIMEOUT_MS = 60_000;
/**
 * A precedence resolve loads the picks server-side (the same loading a
 * build performs) — the endpoint is synchronous by measurement, but a
 * big real family pair needs the same headroom a report readback has.
 */
const RESOLVE_TIMEOUT_MS = 60_000;
/** Byte transfers: artifacts reach hundreds of MB over the loopback. */
const BYTES_TIMEOUT_MS = 10 * 60_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined;
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

function timeoutMessage(ms: number): string {
  return `本地合成服务无响应（${Math.round(ms / 1000)} 秒超时）。`;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Not JSON — fall through to the status line.
  }
  return `服务返回 HTTP ${res.status}`;
}

export class ServeClient {
  constructor(readonly baseUrl: string) {}

  private async requestJson<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = CONTROL_TIMEOUT_MS,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
        ...(timeoutSignal(timeoutMs) !== undefined
          ? { signal: timeoutSignal(timeoutMs) }
          : {}),
      });
    } catch (err) {
      if (isTimeout(err)) throw new ServeError(timeoutMessage(timeoutMs), 0);
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return (await res.json()) as T;
  }

  private async getJson<T>(
    path: string,
    timeoutMs: number = CONTROL_TIMEOUT_MS,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...(timeoutSignal(timeoutMs) !== undefined
          ? { signal: timeoutSignal(timeoutMs) }
          : {}),
      });
    } catch (err) {
      if (isTimeout(err)) throw new ServeError(timeoutMessage(timeoutMs), 0);
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return (await res.json()) as T;
  }

  health(): Promise<HealthDocument> {
    return this.getJson<HealthDocument>("/health");
  }

  fonts(): Promise<FontsDocument> {
    return this.getJson<FontsDocument>("/fonts");
  }

  /** The manifest's families (`/catalog`); an empty list without one. */
  catalog(): Promise<CatalogDocument> {
    return this.getJson<CatalogDocument>("/catalog");
  }

  /** The installed system fonts (`/system-fonts`, grouped: #34). */
  systemFonts(): Promise<{
    dirs: string[];
    ready: boolean;
    faces: SystemFaceDoc[];
    families: SystemFontFamilyDoc[];
  }> {
    return this.getJson("/system-fonts");
  }

  /**
   * The local-font scan (ticket #31, consumed by #34): absolute paths
   * in — files, or anything the shell resolved a typed path to — and
   * family documents out, TTCs expanded server-side. A rejected path
   * (relative, missing, not a font) is a 400 naming every offender.
   */
  localFonts(paths: readonly string[]): Promise<LocalFontsDocument> {
    return this.requestJson<LocalFontsDocument>(
      "/local-fonts",
      { method: "POST", body: JSON.stringify({ paths }) },
      RESOLVE_TIMEOUT_MS,
    ).then(withAbsoluteHrefs(this.baseUrl));
  }

  /**
   * The browser fallback's font load (ticket #36): the File object
   * itself is the fetch body — the browser STREAMS it, the page never
   * constructs an ArrayBuffer — and the serve's upload endpoint scans
   * it into the same family-document shape (faces serving by URL from
   * the serve's scratch copy). A rejected upload is a 400 carrying
   * the service's own message.
   */
  async localFontsUpload(file: File): Promise<LocalFontsDocument> {
    let res: Response;
    const path =
      "/local-fonts/upload?filename=" + encodeURIComponent(file.name);
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        body: file,
        ...(timeoutSignal(BYTES_TIMEOUT_MS) !== undefined
          ? { signal: timeoutSignal(BYTES_TIMEOUT_MS) }
          : {}),
      });
    } catch (err) {
      if (isTimeout(err)) throw new ServeError(timeoutMessage(BYTES_TIMEOUT_MS), 0);
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return withAbsoluteHrefs(this.baseUrl)(
      (await res.json()) as LocalFontsDocument,
    );
  }

  build(id: string): Promise<BuildDocument> {
    return this.getJson<BuildDocument>(`/builds/${id}`);
  }

  /**
   * Stop a build (round 19): `POST /builds/{id}/cancel`. Idempotent —
   * a settled build answers 200 as a no-op; an unknown id is a 404
   * (the id may have aged out of the retention window). The response
   * is the job document; its `status` says where the cancellation
   * stands (`cancelled` once it landed).
   */
  cancelBuild(id: string): Promise<BuildDocument> {
    return this.requestJson<BuildDocument>(`/builds/${id}/cancel`, {
      method: "POST",
    });
  }

  report(id: string): Promise<ReportDocument> {
    return this.getJson<ReportDocument>(`/builds/${id}/report`, REPORT_TIMEOUT_MS);
  }

  /**
   * The effective precedence table for picks+rules (ticket #35): one
   * request per picks/rules change, the answer's compressed runs
   * serving every local lookup. The body is
   * `{picks, rules, sets}` in the recipe schema (codepoint targets as
   * integers); a 400 carries the service's own message.
   */
  resolvePrecedence(body: unknown): Promise<PrecedenceDocument> {
    return this.requestJson<PrecedenceDocument>("/precedence-resolve", {
      method: "POST",
      body: JSON.stringify(body),
    }, RESOLVE_TIMEOUT_MS);
  }

  /** Submit a recipe-shaped JSON body; a 400 carries the service message. */
  async submit(recipe: unknown): Promise<SubmitResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/builds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recipe),
        ...(timeoutSignal(SUBMIT_TIMEOUT_MS) !== undefined
          ? { signal: timeoutSignal(SUBMIT_TIMEOUT_MS) }
          : {}),
      });
    } catch (err) {
      if (isTimeout(err)) throw new ServeError(timeoutMessage(SUBMIT_TIMEOUT_MS), 0);
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return (await res.json()) as SubmitResult;
  }

  /** The built font bytes (`font/ttf` / `font/collection` / `font/woff2`). */
  async fontBytes(id: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/builds/${id}/font`, {
        ...(timeoutSignal(BYTES_TIMEOUT_MS) !== undefined
          ? { signal: timeoutSignal(BYTES_TIMEOUT_MS) }
          : {}),
      });
    } catch (err) {
      if (isTimeout(err)) throw new ServeError(timeoutMessage(BYTES_TIMEOUT_MS), 0);
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}
