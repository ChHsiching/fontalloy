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

import type { SystemFaceDoc } from "./systemfonts";

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

export class ServeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
    } catch {
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return (await res.json()) as T;
  }

  private async getJson<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`);
    } catch {
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

  /** The installed system fonts (`/system-fonts`, round 24+25). */
  systemFonts(): Promise<{
    dirs: string[];
    ready: boolean;
    faces: SystemFaceDoc[];
  }> {
    return this.getJson("/system-fonts");
  }

  /** One scanned system font file's bytes (round 24). */
  async systemFontBytes(path: string): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/system-fonts/file?path=${encodeURIComponent(path)}`,
      );
    } catch {
      throw new ServeError("无法读取系统字体文件。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return res.arrayBuffer();
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
    return this.getJson<ReportDocument>(`/builds/${id}/report`);
  }

  /** Submit a recipe-shaped JSON body; a 400 carries the service message. */
  async submit(recipe: unknown): Promise<SubmitResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/builds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recipe),
      });
    } catch {
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return (await res.json()) as SubmitResult;
  }

  /** The built font bytes (`font/ttf` / `font/collection` / `font/woff2`). */
  async fontBytes(id: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/builds/${id}/font`);
    } catch {
      throw new ServeError("无法连接本地合成服务。", 0);
    }
    if (!res.ok) throw new ServeError(await parseError(res), res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}
