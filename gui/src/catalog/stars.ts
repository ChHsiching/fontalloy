/**
 * Live GitHub stars for the picker meta lines (round 5, owner item 14).
 *
 * Star counts are fetched ONCE per launch, at startup, from the repos
 * the catalog manifest pins (`upstream_url` → owner/repo): never
 * hardcoded at render time. Unauthenticated GitHub API rate limits are
 * respected by construction — only the families whose pickers DISPLAY
 * stars are fetched (the CJK set plus the featured EN front), which
 * dedupes to a handful of repos queried sequentially.
 *
 * Offline behavior: the last successful count per repo is cached in the
 * app's blob storage and reused when the launch cannot reach the API;
 * the curated display data (`curated-meta.json`) remains the final
 * seed fallback, so a row never loses its star count entirely.
 */

import catalogManifest from "../data/catalog.json";
import curatedMeta from "../data/curated-meta.json";
import { readConfig } from "../platform/config";

interface ManifestEntry {
  family: string;
  upstream_url?: string | null;
}

const ENTRIES = catalogManifest.families as ManifestEntry[];

const CURATED_META = curatedMeta.families as Record<
  string,
  { name?: string; stars?: number; trait?: string }
>;

/** The curated featured EN front — the EN rows that display stars. */
const FEATURED_EN: ReadonlySet<string> = new Set(
  (curatedMeta as { front: { en: string[] } }).front.en,
);

/** owner/repo of a pinned upstream URL (null when not a github URL). */
export function repoOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "raw.githubusercontent.com") {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return `${segments[0]}/${segments[1]}`;
}

/** The repo a catalog family pins (null when it pins none). */
export function repoOfFamily(family: string): string | null {
  for (const entry of ENTRIES) {
    if (entry.family !== family) continue;
    return repoOfUrl(entry.upstream_url);
  }
  return null;
}

/** The families whose pickers display stars (the fetch set). */
function displaySet(): string[] {
  const out = new Set<string>();
  for (const [family, meta] of Object.entries(CURATED_META)) {
    if (meta.stars !== undefined) out.add(family);
  }
  for (const family of FEATURED_EN) out.add(family);
  return [...out];
}

/* ---------- the live overlay + its listeners ------------------------- */

const liveStars = new Map<string, number>();
const listeners = new Set<() => void>();

/** The star count a picker row shows (live → curated seed → none). */
export function starsFor(family: string): number | undefined {
  return liveStars.get(family) ?? CURATED_META[family]?.stars;
}

/** Subscribe to star-count updates (the pickers re-render on change). */
export function subscribeStars(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/* ---------- the once-per-launch refresh ------------------------------ */

const CACHE_KEY = "catalog/github-stars.json";

let refreshStarted = false;

interface StorageLike {
  read(path: string): Promise<ArrayBuffer | null>;
  write(path: string, data: ArrayBuffer): Promise<void>;
}

/** One bounded GET, never throwing (offline is a state, not an error). */
async function fetchRepoStars(
  repo: string,
  signal: AbortSignal,
): Promise<number | null> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 8_000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!res.ok) return null; // rate-limited (403) or gone (404): cache stands
    const doc = (await res.json()) as { stargazers_count?: number };
    return typeof doc.stargazers_count === "number" ? doc.stargazers_count : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function readCache(storage: StorageLike): Promise<Record<string, number>> {
  try {
    const buffer = await storage.read(CACHE_KEY);
    if (buffer === null) return {};
    const doc = JSON.parse(new TextDecoder().decode(buffer)) as Record<string, number>;
    if (doc && typeof doc === "object") return doc;
  } catch {
    // A corrupt cache is the same as none.
  }
  return {};
}

/**
 * Refresh the live star counts once per launch. Fire-and-forget by
 * design: nothing here may delay or block the workspace, and every
 * failure mode leaves the curated seed in place.
 *
 * Gated on the catalog bootstrap being configured: a page without a
 * catalog (plain-browser builds, the catalog-free test pages) never
 * phones home.
 */
export async function refreshStars(): Promise<void> {
  if (refreshStarted) return;
  if (readConfig().catalogBootstrapUrl === null) return;
  refreshStarted = true;

  const families = displaySet().filter((family) => repoOfFamily(family) !== null);
  const repos = [...new Set(families.map((family) => repoOfFamily(family)!))];

  // Storage is best-effort: without it the launch simply goes uncached.
  let storage: StorageLike | null = null;
  try {
    const { createStorage } = await import("../platform/storage");
    storage = await createStorage();
  } catch {
    storage = null;
  }

  // Seed the overlay from the cache so an offline launch still shows
  // the last-known counts.
  if (storage !== null) {
    const cache = await readCache(storage);
    let seeded = false;
    for (const family of families) {
      const stars = cache[repoOfFamily(family)!];
      if (stars !== undefined) {
        liveStars.set(family, stars);
        seeded = true;
      }
    }
    if (seeded) notify();
  }

  const abort = new AbortController();
  const fresh: Record<string, number> = {};
  // Sequential on purpose: a handful of requests, paced, is exactly
  // what an unauthenticated client owes the shared rate limit.
  for (const repo of repos) {
    if (abort.signal.aborted) break;
    const stars = await fetchRepoStars(repo, abort.signal);
    if (stars !== null) fresh[repo] = stars;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (Object.keys(fresh).length === 0) return;
  for (const family of families) {
    const stars = fresh[repoOfFamily(family)!];
    if (stars !== undefined) liveStars.set(family, stars);
  }
  notify();
  if (storage !== null) {
    try {
      const merged = { ...(storage ? await readCache(storage) : {}), ...fresh };
      await storage.write(
        CACHE_KEY,
        new TextEncoder().encode(JSON.stringify(merged)).buffer as ArrayBuffer,
      );
    } catch {
      // A failed cache write costs nothing but a cold next launch.
    }
  }
}
