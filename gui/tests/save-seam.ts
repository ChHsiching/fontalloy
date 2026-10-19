import { type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The journeys' native-save stand-in, at REAL artifact scale
 * (ticket #37, round 31's J9 failure).
 *
 * The old seam encoded an artifact with the one-shot
 * `btoa(Array.from(bytes, …).join(""))` — and in Chromium
 * `Array.from` over a ≥ ~134 MiB Uint8Array throws
 * `RangeError: Invalid array length` (measured: 100 MB fine, 200 MB
 * throws; the real-scale J9 ttc ≈ 300 MB reproduced the exact recorded
 * signature). No single accumulated base64 string survives either:
 * past ~400 MB of artifact the 4/3-grown string crosses V8's maximum
 * string length (`RangeError: Invalid string length`), and one giant
 * DevTools-protocol message is its own hazard. The seam therefore
 * never builds a whole-artifact string ANYWHERE: the page encodes and
 * sends the artifact in 3 MiB base64 chunks (each a multiple of 3
 * bytes, so every interior `btoa` chunk is unpadded — only the final
 * chunk may carry '=' padding), and Node reassembles per-chunk
 * buffers and writes the file with one `Buffer.concat`.
 *
 * Two flows, mirroring the app's savers (round 12):
 * `saveArtifact` — the DEFAULT-PATH save synthesis uses; and
 * `saveArtifactAs` — the 另存为 dialog flow (an `as-` copy, counted).
 */

/** One transfer chunk: 3 MiB, a multiple of 3 (unpadded interior b64). */
export const SAVE_CHUNK_BYTES = 3 * 1_048_576;
/**
 * The `String.fromCharCode(...)` piece inside a chunk: small enough to
 * stay far under the spread argument-count limit (the call stack).
 */
export const SAVE_PIECE_BYTES = 30_720;

/**
 * The page-side installer (Playwright serializes this function's
 * source into every page the context loads — it must close over
 * NOTHING from this module). Installs `window.__FONTALLOY_CONFIG__
 * .saveArtifact` / `.saveArtifactAs`: chunk-encode, chunk-send, and
 * resolve `{saved, path}` from the Node-side end call.
 */
export function saveSeamPageScript(): void {
  const config = (
    window as unknown as { __FONTALLOY_CONFIG__: Record<string, unknown> }
  ).__FONTALLOY_CONFIG__ ??= {};
  const CHUNK = 3 * 1_048_576;
  const PIECE = 30_720;
  const seam = window as unknown as {
    __fontalloyJourneySaveBegin(): Promise<number>;
    __fontalloyJourneySaveChunk(id: number, b64: string): Promise<void>;
    __fontalloyJourneySaveEnd(
      id: number,
      name: string,
    ): Promise<string | null>;
    __fontalloyJourneySaveAsEnd(
      id: number,
      name: string,
    ): Promise<string | null>;
  };
  const transfer = async (
    name: string,
    bytes: Uint8Array,
    end: (id: number, name: string) => Promise<string | null>,
  ): Promise<string | null> => {
    const id = await seam.__fontalloyJourneySaveBegin();
    for (let i = 0; i < bytes.length; i += CHUNK) {
      // One 3 MiB binary string per chunk (well under every string
      // limit), built in spread-safe pieces, then one b64 per chunk.
      let binary = "";
      const sub = bytes.subarray(i, i + CHUNK);
      for (let j = 0; j < sub.length; j += PIECE) {
        binary += String.fromCharCode(...sub.subarray(j, j + PIECE));
      }
      await seam.__fontalloyJourneySaveChunk(id, btoa(binary));
    }
    return end(id, name);
  };
  config.saveArtifact = async (
    name: string,
    bytes: Uint8Array,
  ): Promise<{ saved: boolean; path: string | null }> => {
    const path = await transfer(
      name,
      bytes,
      (id, n) => seam.__fontalloyJourneySaveEnd(id, n),
    );
    return path === null ? { saved: false, path: null } : { saved: true, path };
  };
  config.saveArtifactAs = async (
    name: string,
    bytes: Uint8Array,
  ): Promise<{ saved: boolean; path: string | null }> => {
    const path = await transfer(
      name,
      bytes,
      (id, n) => seam.__fontalloyJourneySaveAsEnd(id, n),
    );
    return path === null ? { saved: false, path: null } : { saved: true, path };
  };
}

/** What the Node-side seam needs from its host suite. */
export interface SaveSeamOptions {
  /**
   * The CURRENT save directory, read at call time (the journeys swap
   * the dir per journey through a module-level variable; null disarms
   * the seam exactly like the old single-shot binding did).
   */
  resolveSaveDir: () => string | null;
  /**
   * Fires once per settled 另存为 save (the dialog-flow counter the
   * journeys assert: the automatic save must never depend on it).
   */
  onDialogSave?: () => void;
}

/**
 * Expose the seam's Node side on the page: a begin/chunk/end session
 * protocol per save. `end` decodes nothing into one string — every
 * chunk arrives as its own base64 block and becomes its own Buffer;
 * the file write is one `Buffer.concat`.
 */
export async function exposeSaveSeam(
  page: Page,
  options: SaveSeamOptions,
): Promise<void> {
  const sessions = new Map<number, Buffer[]>();
  let nextId = 0;
  await page.exposeFunction("__fontalloyJourneySaveBegin", (): number => {
    const id = nextId;
    nextId += 1;
    sessions.set(id, []);
    return id;
  });
  await page.exposeFunction(
    "__fontalloyJourneySaveChunk",
    (id: number, b64: string): void => {
      const parts = sessions.get(id);
      if (parts === undefined) {
        throw new Error(`save seam: unknown chunk session ${id}`);
      }
      parts.push(Buffer.from(b64, "base64"));
    },
  );
  const settle = async (
    id: number,
    name: string,
    dialog: boolean,
  ): Promise<string | null> => {
    const parts = sessions.get(id);
    if (parts === undefined) {
      throw new Error(`save seam: unknown end session ${id}`);
    }
    sessions.delete(id);
    const dir = options.resolveSaveDir();
    if (dir === null) return null;
    if (dialog) options.onDialogSave?.();
    const target = resolve(dir, dialog ? `as-${name}` : name);
    await writeFile(target, Buffer.concat(parts));
    return target;
  };
  await page.exposeFunction("__fontalloyJourneySaveEnd", (id: number, name: string) =>
    settle(id, name, false),
  );
  await page.exposeFunction(
    "__fontalloyJourneySaveAsEnd",
    (id: number, name: string) => settle(id, name, true),
  );
}
