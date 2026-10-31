import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeZip, sha256hex } from "./catalog-fixtures";

/**
 * Serve-side catalog fixtures (ticket #30, spec #25): a real
 * `file://` release origin the spawned `fontalloy serve` syncs its
 * catalog from — the same offline-site convention the core suite's
 * `test_serve_family_docs.py` uses (`build_picker_site`), built here
 * from host font binaries the way `catalog-fixtures.ts` builds its
 * simulated origins.
 *
 * The page never sees the origin: it consumes the SERVE's /catalog
 * endpoints. Family ids are URL-safe by the manifest's convention
 * (compact ASCII) — the serve's byte endpoints address families by
 * their unencoded manifest id.
 */

const RELEASE_SCHEMA = "fontalloy/catalog-release@v1";
const MANIFEST_SCHEMA = "fontalloy/font-catalog@v1";
const TAG = "font-catalog-e2e";

/** One face inside a family zip: listed name + host font binary. */
export interface SiteFace {
  file: string;
  fontPath: string;
}

/** One manifest entry override (axes ride the real manifest's shape). */
export interface SiteManifestEntry {
  variant: string;
  file: string;
  axes?: Record<string, string>;
}

export interface SiteFamilySpec {
  family: string;
  /** The zip's faces (one `<family>-Regular.ttf` is the convention). */
  faces: SiteFace[];
  /** Manifest entries for the family (defaults to one Regular entry). */
  manifestEntries?: SiteManifestEntry[];
  /** Poison the archive's pinned sha256 (the sync must fail it). */
  corruptZipSha?: boolean;
}

export interface ServeCatalogSite {
  /** The temp root; the caller removes it. */
  root: string;
  /** `file://` origin for `--catalog-release-origin`. */
  originUri: string;
  /** Empty cache dir for `--catalog-dir` (and `--font-dir`). */
  catalogDir: string;
  /** The generated manifest for `--manifest` (null when skipped). */
  manifestPath: string | null;
}

const FAKE_OFL = "Fake OFL 1.1 license text for the e2e catalog site.\n";

/**
 * Build the release origin + manifest for a serve-backed catalog.
 * With `manifest: false` the serve runs manifest-less (release-only
 * families, one default cut each).
 */
export async function buildServeCatalogSite(
  specs: SiteFamilySpec[],
  options: { manifest?: boolean } = {},
): Promise<ServeCatalogSite> {
  const root = await mkdtemp(resolve(tmpdir(), "fontalloy-serve-site-"));
  const originDir = resolve(root, "origin");
  const catalogDir = resolve(root, "catalog");
  await mkdir(originDir, { recursive: true });
  await mkdir(catalogDir, { recursive: true });
  await mkdir(resolve(root, "licenses"), { recursive: true });
  await writeFile(resolve(root, "licenses", "OFL-1.1.txt"), FAKE_OFL, "utf8");

  const releaseFamilies: Array<Record<string, unknown>> = [];
  const manifestEntries: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    const binaries: Array<{ file: string; data: Buffer }> = [];
    for (const face of spec.faces) {
      binaries.push({ file: face.file, data: await readFile(face.fontPath) });
    }
    const zipBytes = makeZip(
      binaries.map(({ file, data }) => ({
        // The round-20 release layout: faces one directory down.
        name: `${spec.family}/${file}`,
        data,
      })),
    );
    const zipName = `${spec.family}.zip`;
    await writeFile(resolve(originDir, zipName), zipBytes);
    const zipSha = sha256hex(zipBytes);
    releaseFamilies.push({
      family: spec.family,
      zip: zipName,
      sha256: spec.corruptZipSha ? "0".repeat(64) : zipSha,
      files: binaries.map(({ file, data }) => ({
        file,
        sha256: sha256hex(data),
      })),
    });
    const entries =
      spec.manifestEntries ?? [{ variant: "Regular", file: zipName }];
    for (const entry of entries) {
      manifestEntries.push({
        family: spec.family,
        variant: entry.variant,
        file: entry.file,
        version: "v1",
        upstream_url: `https://example.com/${spec.family}.zip`,
        sha256: zipSha,
        license_spdx: "OFL-1.1",
        rfn: false,
        rfn_names: [],
        copyright: null,
        license_file: "licenses/OFL-1.1.txt",
        checksum_source: "self-computed",
        ...(entry.axes === undefined ? {} : { axes: entry.axes }),
      });
    }
  }
  await writeFile(
    resolve(originDir, "catalog-release.json"),
    JSON.stringify(
      {
        schema: RELEASE_SCHEMA,
        tag: TAG,
        origins: [{ id: "primary", base_url: pathToFileURL(originDir).href }],
        families: releaseFamilies,
      },
      null,
      1,
    ) + "\n",
    "utf8",
  );

  let manifestPath: string | null = null;
  if (options.manifest !== false) {
    manifestPath = resolve(root, "catalog.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        { schema: MANIFEST_SCHEMA, families: manifestEntries },
        null,
        1,
      ) + "\n",
      "utf8",
    );
  }
  return { root, originUri: pathToFileURL(originDir).href, catalogDir, manifestPath };
}

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * The owner-scenario site (ticket #30's acceptance): the REAL repo
 * manifest's families — filtered to the curated mirror's families so
 * the picker's rows are exactly the owner's baseline (EN 71 / CJK 25;
 * `LxgwBrightCode` is manifest-only and would list as an extra row) —
 * one zip per family over one host font binary, entries verbatim from
 * the manifest (axes and variants included).
 */
export async function buildOwnerCatalogSite(
  hostFont: string,
): Promise<ServeCatalogSite> {
  const root = await mkdtemp(resolve(tmpdir(), "fontalloy-owner-site-"));
  const originDir = resolve(root, "origin");
  const catalogDir = resolve(root, "catalog");
  await mkdir(originDir, { recursive: true });
  await mkdir(catalogDir, { recursive: true });
  const [manifest, mirror] = await Promise.all([
    readFile(resolve(REPO_ROOT, "assets", "fonts.manifest.json"), "utf8"),
    readFile(resolve(REPO_ROOT, "gui", "src", "data", "catalog.json"), "utf8"),
  ]);
  const mirrorFamilies = new Set(
    (JSON.parse(mirror).families as Array<{ family: string }>).map(
      (entry) => entry.family,
    ),
  );
  const entries = (
    JSON.parse(manifest).families as Array<Record<string, unknown>>
  ).filter((entry) => mirrorFamilies.has(entry.family as string));

  const face = await readFile(hostFont);
  const faceSha = sha256hex(face);
  const releaseFamilies: Array<Record<string, unknown>> = [];
  const seenFamilies = new Set<string>();
  for (const entry of entries) {
    const family = entry.family as string;
    // The release schema is unique by FAMILY (one zip per family, all
    // faces inside) — a multi-entry manifest family ships once.
    if (seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    const faceFile = `${family}-Regular.ttf`;
    const zipBytes = makeZip([
      { name: `${family}/${faceFile}`, data: face },
    ]);
    const zipName = `${family}.zip`;
    await writeFile(resolve(originDir, zipName), zipBytes);
    releaseFamilies.push({
      family,
      zip: zipName,
      sha256: sha256hex(zipBytes),
      files: [{ file: faceFile, sha256: faceSha }],
    });
  }
  await writeFile(
    resolve(originDir, "catalog-release.json"),
    JSON.stringify(
      {
        schema: RELEASE_SCHEMA,
        tag: TAG,
        origins: [{ id: "primary", base_url: pathToFileURL(originDir).href }],
        families: releaseFamilies,
      },
      null,
      1,
    ) + "\n",
    "utf8",
  );
  // The manifest's license files resolve against its own directory:
  // rewrite them onto the temp root's licenses tree.
  const licenses = resolve(root, "licenses");
  await mkdir(licenses, { recursive: true });
  const rewritten = entries.map((entry) => ({
    ...entry,
    license_file: "licenses/OFL-1.1.txt",
  }));
  const licenseNames = new Set(
    (entries as Array<{ license_file?: string }>).map(
      (entry) => entry.license_file ?? "",
    ),
  );
  for (const name of licenseNames) {
    if (name === "") continue;
    await writeFile(resolve(licenses, name.split("/").pop()!), FAKE_OFL, "utf8");
  }
  const manifestPath = resolve(root, "catalog.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      { schema: MANIFEST_SCHEMA, families: rewritten },
      null,
      1,
    ) + "\n",
    "utf8",
  );
  return {
    root,
    originUri: pathToFileURL(originDir).href,
    catalogDir,
    manifestPath,
  };
}

/* ------------------------------------------------------------------ */
/* The fetched-layout site (ticket #40)                                */
/* ------------------------------------------------------------------ */

/**
 * A serve layout shaped like `fontalloy assets fetch`'s output — the
 * shape the resolve/build contract reads (#40's finding: the picker
 * works against an empty font-dir, but `POST /precedence-resolve`
 * answers 400 "not fetched" unless EVERY manifest entry's zip sits in
 * the served font-dir, next to the extracted faces — exactly how the
 * real run layout looks and the empty-cache sites never did).
 */
export interface FetchedFaceSpec extends SiteFace {
  /** The extracted directory under fonts/ (defaults to the family). */
  dir?: string;
}

/** One manifest entry — its `file` is ALSO the zip name on disk. */
export interface FetchedEntrySpec {
  variant: string;
  file: string;
  /** Face file names (from the family's faces) packed into the zip. */
  faces: string[];
  axes?: Record<string, string>;
}

export interface FetchedFamilySpec {
  family: string;
  faces: FetchedFaceSpec[];
  entries: FetchedEntrySpec[];
}

export interface FetchedLayoutSite {
  /** The temp root; the caller removes it. */
  root: string;
  /** `--font-dir`: entry-named zips + extracted face directories. */
  fontsDir: string;
  /** `file://` origin for `--catalog-release-origin` (the sync chain). */
  originUri: string;
  /** Empty cache dir (kept for shape parity with the site builder). */
  catalogDir: string;
  /** The generated manifest for `--manifest`. */
  manifestPath: string;
}

export async function buildFetchedLayoutSite(
  specs: FetchedFamilySpec[],
): Promise<FetchedLayoutSite> {
  const root = await mkdtemp(resolve(tmpdir(), "fontalloy-fetched-site-"));
  const fontsDir = resolve(root, "fonts");
  const originDir = resolve(root, "origin");
  const catalogDir = resolve(root, "catalog");
  await mkdir(fontsDir, { recursive: true });
  await mkdir(originDir, { recursive: true });
  await mkdir(catalogDir, { recursive: true });
  await mkdir(resolve(root, "licenses"), { recursive: true });
  await writeFile(resolve(root, "licenses", "OFL-1.1.txt"), FAKE_OFL, "utf8");

  const manifestEntries: Array<Record<string, unknown>> = [];
  const releaseFamilies: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    const byFile = new Map<string, { data: Buffer; dir: string; sha: string }>();
    for (const face of spec.faces) {
      const data = await readFile(face.fontPath);
      const dir = face.dir ?? spec.family;
      await mkdir(resolve(fontsDir, dir), { recursive: true });
      await writeFile(resolve(fontsDir, dir, face.file), data);
      byFile.set(face.file, { data, dir, sha: sha256hex(data) });
    }
    // Every manifest entry's artifact on disk, under the fonts root.
    for (const entry of spec.entries) {
      const zipBytes = makeZip(
        entry.faces.flatMap((file) => {
          const face = byFile.get(file);
          if (face === undefined) {
            throw new Error(
              `entry ${spec.family}/${entry.variant} names face ${file}, ` +
                `which the family's faces do not carry`,
            );
          }
          return [{ name: `${face.dir}/${file}`, data: face.data }];
        }),
      );
      await writeFile(resolve(fontsDir, entry.file), zipBytes);
      manifestEntries.push({
        family: spec.family,
        variant: entry.variant,
        file: entry.file,
        version: "v1",
        upstream_url: `https://example.com/${entry.file}`,
        sha256: sha256hex(zipBytes),
        license_spdx: "OFL-1.1",
        rfn: false,
        rfn_names: [],
        copyright: null,
        license_file: "licenses/OFL-1.1.txt",
        checksum_source: "self-computed",
        ...(entry.axes === undefined ? {} : { axes: entry.axes }),
      });
    }
    // The release transport zip (unique per family, all faces inside).
    const zipBytes = makeZip(
      spec.faces.map((face) => ({
        name: `${face.dir ?? spec.family}/${face.file}`,
        data: byFile.get(face.file)!.data,
      })),
    );
    const zipName = `${spec.family}.zip`;
    await writeFile(resolve(originDir, zipName), zipBytes);
    releaseFamilies.push({
      family: spec.family,
      zip: zipName,
      sha256: sha256hex(zipBytes),
      files: spec.faces.map((face) => ({
        file: face.file,
        sha256: byFile.get(face.file)!.sha,
      })),
    });
  }
  await writeFile(
    resolve(originDir, "catalog-release.json"),
    JSON.stringify(
      {
        schema: RELEASE_SCHEMA,
        tag: TAG,
        origins: [{ id: "primary", base_url: pathToFileURL(originDir).href }],
        families: releaseFamilies,
      },
      null,
      1,
    ) + "\n",
    "utf8",
  );
  const manifestPath = resolve(root, "catalog.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      { schema: MANIFEST_SCHEMA, families: manifestEntries },
      null,
      1,
    ) + "\n",
    "utf8",
  );
  return {
    root,
    fontsDir,
    originUri: pathToFileURL(originDir).href,
    catalogDir,
    manifestPath,
  };
}
