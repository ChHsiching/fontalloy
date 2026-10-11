/**
 * catalog-release metadata for the app-side downloader (issue #17).
 *
 * This is the TypeScript consumer of the contract #14 established in
 * `core/fontalloy_core/catalog_release.py`: `catalog-release.json`, schema
 * `fontalloy/catalog-release@v1`, fetched from the release tag on every
 * launch. The document is delivery truth only (ordered origins + per-family
 * zip/face checksums); provenance and licensing stay in the committed
 * manifest and never arrive here.
 *
 * Loading is strict like the Python loader: a wrong schema string, missing
 * fields, malformed sha256s, duplicate families or zips — each is a
 * `CatalogError` naming the offender, because the downloader must never act
 * on metadata it half-understands.
 */

export const CATALOG_RELEASE_SCHEMA = "fontalloy/catalog-release@v1";

const SHA256_RE = /^[0-9a-f]{64}$/;

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

export interface ReleaseOrigin {
  id: string;
  baseUrl: string;
}

export interface ReleaseFile {
  file: string;
  sha256: string;
}

export interface ReleaseFamily {
  family: string;
  zip: string;
  sha256: string;
  files: ReleaseFile[];
}

export interface CatalogRelease {
  tag: string;
  origins: ReleaseOrigin[];
  families: ReleaseFamily[];
}

export function parseCatalogRelease(raw: unknown): CatalogRelease {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      throw new CatalogError(
        `catalog-release metadata is not valid JSON: ${String(err)}`,
      );
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CatalogError("catalog-release metadata must be a JSON object");
  }
  const data = raw as Record<string, unknown>;
  if (data.schema !== CATALOG_RELEASE_SCHEMA) {
    throw new CatalogError(
      `catalog-release schema ${JSON.stringify(data.schema)} is not supported ` +
        `(expected ${JSON.stringify(CATALOG_RELEASE_SCHEMA)})`,
    );
  }

  const tag = string(data.tag, "metadata field 'tag'");
  const origins = loadOrigins(data.origins);
  const families = loadFamilies(data.families);
  return { tag, origins, families };
}

/**
 * Loopback http origins — the documented dev carve-out: the vite dev
 * server serves a fixture catalog from 127.0.0.1/localhost (see
 * gui/scripts/dev-catalog.mjs). Production metadata keeps using
 * https:// (GitHub release assets) or file:// (on-disk layouts).
 */
const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//;

function loadOrigins(raw: unknown): ReleaseOrigin[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CatalogError(
      "metadata field 'origins' must be a non-empty ordered list " +
        "(the downloader tries origins in list order)",
    );
  }
  const origins: ReleaseOrigin[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `origin ${index}`;
    if (typeof item !== "object" || item === null) {
      throw new CatalogError(`${where} must be a JSON object`);
    }
    const entry = item as Record<string, unknown>;
    const id = string(entry.id, `${where} field 'id'`);
    const baseUrl = string(entry.base_url, `${where} (${id}) field 'base_url'`);
    const remote =
      baseUrl.startsWith("https://") ||
      baseUrl.startsWith("file://") ||
      LOOPBACK_ORIGIN_RE.test(baseUrl);
    if (!remote) {
      throw new CatalogError(
        `${where} (${id}): base_url must be an https://, file://, or loopback http:// URL, got ${JSON.stringify(baseUrl)}`,
      );
    }
    if (seen.has(id)) throw new CatalogError(`${where}: duplicate origin id ${JSON.stringify(id)}`);
    seen.add(id);
    origins.push({ id, baseUrl });
  });
  return origins;
}

function loadFamilies(raw: unknown): ReleaseFamily[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CatalogError("metadata field 'families' must be a non-empty list");
  }
  const families: ReleaseFamily[] = [];
  const seenFamilies = new Set<string>();
  const seenZips = new Set<string>();
  raw.forEach((item, index) => {
    const where = `family ${index}`;
    if (typeof item !== "object" || item === null) {
      throw new CatalogError(`${where} must be a JSON object`);
    }
    const entry = item as Record<string, unknown>;
    const family = string(entry.family, `${where} field 'family'`);
    const here = `family ${JSON.stringify(family)}`;
    const zip = filename(entry.zip, `${here} field 'zip'`);
    const zipSha = sha256(entry.sha256, `${here} field 'sha256'`);
    if (seenFamilies.has(family)) {
      throw new CatalogError(`${here} duplicates an earlier family`);
    }
    if (seenZips.has(zip)) {
      throw new CatalogError(`${here} reuses zip ${JSON.stringify(zip)} of another family`);
    }
    seenFamilies.add(family);
    seenZips.add(zip);
    families.push({ family, zip, sha256: zipSha, files: loadFiles(entry.files, here) });
  });
  return families;
}

function loadFiles(raw: unknown, where: string): ReleaseFile[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CatalogError(`${where}: field 'files' must be a non-empty list`);
  }
  const files: ReleaseFile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new CatalogError(`${where}: each file entry must be a JSON object`);
    }
    const entry = item as Record<string, unknown>;
    const file = filename(entry.file, `${where} file entry field 'file'`);
    const fileSha = sha256(entry.sha256, `${where} file ${JSON.stringify(file)} field 'sha256'`);
    if (seen.has(file)) {
      throw new CatalogError(`${where} lists file ${JSON.stringify(file)} twice`);
    }
    seen.add(file);
    files.push({ file, sha256: fileSha });
  }
  return files;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogError(`${where} must be a non-empty string`);
  }
  return value;
}

function filename(value: unknown, where: string): string {
  const name = string(value, where);
  if (name.includes("/") || name.includes("\\")) {
    throw new CatalogError(`${where} must be a bare filename, got ${JSON.stringify(name)}`);
  }
  return name;
}

function sha256(value: unknown, where: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new CatalogError(
      `${where} must be 64 lowercase hex characters, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
