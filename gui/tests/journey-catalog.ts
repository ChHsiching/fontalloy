import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The journey run's ONE serve catalog directory (ticket #37 / spec #25,
 * the heavy batch's finding 1): a STABLE gitignored scratch path under
 * the repo root — never a per-worker temp — so the whole run shares
 * one catalog: the first serve pays the sync, and every later serve
 * starts warm (the sync's stat-only launch check — markers, release
 * tag, and byte sizes; no hashing, no download). A fresh per-test dir
 * would re-download the whole catalog for every journey (~GBs × N),
 * exactly the v1 batch's cost amplification.
 *
 * Persistent across runs by design (a warm rerun settles in seconds);
 * delete the directory to force a cold re-sync.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * The stable catalog dir for a named journey scratch area. The journeys
 * all use the default name (ONE dir for the whole run — gui and web
 * suites alike, both resolving this same repo-root path); the proof
 * spec uses its own name so it never evicts a real run's warm catalog.
 */
export function journeyServeCatalogDir(name = "journey-catalog"): Promise<string> {
  return (async () => {
    const dir = resolve(REPO_ROOT, ".scratch", name);
    await mkdir(dir, { recursive: true });
    return dir;
  })();
}

/**
 * The serve flags that wire a journey serve onto the shared catalog.
 * The default release origin is the vite server's REAL dev catalog
 * (the same families production serves; where its bytes come from is
 * the middleware's own env seam — FONTALLOY_DEV_FONT_DIR /
 * FONTALLOY_DEV_CATALOG_CACHE). FONTALLOY_JOURNEY_CATALOG_ORIGIN
 * overrides the origin outright — the fixture-scale proof and any
 * pinned rerun environment ride it without code changes.
 */
export async function journeyCatalogFlags(
  defaultOrigin: string,
  name = "journey-catalog",
): Promise<string[]> {
  const origin =
    process.env.FONTALLOY_JOURNEY_CATALOG_ORIGIN ?? defaultOrigin;
  return ["--catalog-release-origin", origin, "--catalog-dir", await journeyServeCatalogDir(name)];
}
