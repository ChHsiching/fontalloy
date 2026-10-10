/**
 * Blob storage for downloaded catalog artifacts (issue #17).
 *
 * One abstraction, two backends, chosen at runtime:
 *
 * - **Tauri**: the app's writable data directory (`appDataDir()`/`catalog`)
 *   through the fs plugin — the same on-disk layout the core sidecar will
 *   read in ticket #16. Keys are forward-slash paths under that root:
 *
 * ```
 * {appDataDir}/catalog/catalog-release.json            bootstrap copy
 * {appDataDir}/catalog/families/<family>/<face>.ttf    extracted faces
 * {appDataDir}/catalog/families/<family>/.complete     written LAST, after
 *                                                      every face passed its
 *                                                      sha256 check
 * ```
 *
 * - **Browser (dev server / WebApp / Playwright)**: IndexedDB, keyed by the
 *   same path strings. The Playwright suite therefore exercises the real
 *   persistence semantics — a `page.reload()` is a genuine later launch,
 *   and the skip-verified/retry logic is observed, not mocked.
 *
 * The interface is deliberately tiny (read/write/list). Family name
 * segments are percent-encoded by the catalog engine before they reach
 * storage, so a key never contains a path separator from metadata.
 */

export interface BlobStorage {
  /** Read one blob; null when the key does not exist. */
  read(path: string): Promise<ArrayBuffer | null>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  /** All stored keys that start with `prefix` (full keys, sorted). */
  list(prefix: string): Promise<string[]>;
}

const KEY_RE = /^[^/]+(?:\/[^/]+)*$/;

function assertSafeKey(path: string): void {
  if (!KEY_RE.test(path) || path.split("/").includes("..")) {
    throw new Error(`unsafe storage key: ${path}`);
  }
}

/* ---------------- browser backend: IndexedDB ---------------- */

const DB_NAME = "fontalloy-storage";
const DB_VERSION = 1;
const STORE = "blobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB open failed"));
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB request failed"));
  });
}

export function idbStorage(): BlobStorage {
  let db: Promise<IDBDatabase> | null = null;
  const ready = (): Promise<IDBDatabase> => (db ??= openDb());
  return {
    async read(path) {
      assertSafeKey(path);
      const value = await idbRequest(
        (await ready())
          .transaction(STORE, "readonly")
          .objectStore(STORE)
          .get(path),
      );
      return value === undefined ? null : (value as ArrayBuffer);
    },
    async write(path, data) {
      assertSafeKey(path);
      await idbRequest(
        (await ready())
          .transaction(STORE, "readwrite")
          .objectStore(STORE)
          .put(data, path),
      );
    },
    async list(prefix) {
      const keys = (await idbRequest(
        (await ready())
          .transaction(STORE, "readonly")
          .objectStore(STORE)
          .getAllKeys(),
      )) as string[];
      return keys.filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

/* ---------------- Tauri backend: appDataDir via fs plugin ---------------- */

/** The fs plugin module shape this backend needs (kept minimal for tests). */
export interface FsBackend {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  /** The plugin's readDir is flat and name-only; the walk below recurses. */
  readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  exists(path: string): Promise<boolean>;
}

export function tauriStorage(fs: FsBackend, baseDir: string): BlobStorage {
  const join = (key: string): string =>
    `${baseDir.replace(/[/\\]+$/, "")}/${key}`;
  return {
    async read(path) {
      assertSafeKey(path);
      const target = join(path);
      if (!(await fs.exists(target))) return null;
      const bytes = await fs.readFile(target);
      // Copy out of the IPC buffer so callers own a plain ArrayBuffer.
      return new Uint8Array(bytes).buffer;
    },
    async write(path, data) {
      assertSafeKey(path);
      const target = join(path);
      const dir = target.slice(0, target.lastIndexOf("/"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(target, new Uint8Array(data));
    },
    async list(prefix) {
      const full = join(prefix);
      const dir = full.slice(0, full.lastIndexOf("/"));
      if (!(await fs.exists(dir))) return [];
      const keys: string[] = [];
      const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
        for (const entry of await fs.readDir(dirAbs)) {
          const key = `${relPrefix}${entry.name}`;
          if (entry.isDirectory) {
            await walk(`${dirAbs}/${entry.name}`, `${key}/`);
          } else {
            keys.push(key);
          }
        }
      };
      await walk(dir, prefix);
      return keys.filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

import { isTauri } from "./config";

/** The backend for the current environment. */
export async function createStorage(): Promise<BlobStorage> {
  if (isTauri()) {
    const [fs, pathApi] = await Promise.all([
      import("@tauri-apps/plugin-fs"),
      import("@tauri-apps/api/path"),
    ]);
    const backend: FsBackend = {
      readFile: (p) => fs.readFile(p),
      writeFile: (p, d) => fs.writeFile(p, d),
      mkdir: (p, o) => fs.mkdir(p, o),
      readDir: (p) => fs.readDir(p),
      exists: (p) => fs.exists(p),
    };
    return tauriStorage(backend, await pathApi.appDataDir());
  }
  return idbStorage();
}
