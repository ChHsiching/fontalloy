/**
 * The live precedence document (ticket #35, spec #25): the effective
 * table AS THE SERVE RESOLVES IT — one `POST /precedence-resolve` per
 * picks/rules change, the response's compressed runs answering every
 * local lookup (binary search per cell, never per-cell requests). The
 * grid pages, the scenes render, the 已调整 counters, and the char
 * popup all read the SAME landed document; nothing resolves
 * client-side anymore (the TS mirror and its memo layer are deleted).
 *
 * Pull-based like the memo layer it replaces: renderers call
 * `liveDocument()` on every render; a cheap synchronous key (the
 * picks' identity + the rules' wire form) gates the async work, so
 * paging the grid, switching categories, or moving the cursor never
 * touches the network. When the key changes, the request fires and
 * the landed document bumps `precedenceStore` — subscribers re-render
 * with fresh runs.
 *
 * A second, derived document rides along while single-codepoint
 * overrides exist: the resolve of the rules MINUS every codepoint rule
 * — for any one codepoint that is exactly the layers beneath its own
 * override (codepoint rules cover a single codepoint each), i.e. the
 * popup's revert/恢复默认 verdict. Without codepoint rules the
 * effective document IS the deeper answer.
 */

import { store, createStore, type LoadedFont } from "../state";
import { pickRefs } from "./picks";
import type { EditorRule } from "./model";
import { applyRulesToDraft } from "./serialize";
import { defaultDraft, fontRef, type FontSlot } from "../recipe/model";
import { synthStore } from "../service/state";
import type { PrecedenceDocument, PrecedenceRun } from "../service/client";

/** The landed-document state the renderers subscribe to. */
interface PrecedenceState {
  /** Monotonic bump per applied change (render signatures key on it). */
  version: number;
  /** The last landed effective document (null until one resolves). */
  document: PrecedenceDocument | null;
  /**
   * The live pull's failure reason, VERBATIM (the serve's own 400
   * message), null while a document is landed or no pull has failed.
   * Round 31: a transient resolve failure (the first-run catalog sync
   * racing the pull) used to vanish silently AND never retry — the
   * table blanked until the picks changed. The message now surfaces
   * (statsbar) and the catalog-state subscription below retries.
   */
  error: string | null;
  /**
   * The deeper-layer document (rules minus codepoint rules). Null when
   * no codepoint rule exists (the effective document is the deeper
   * answer) or while its request is still in flight.
   */
  deeper: PrecedenceDocument | null;
}

export const precedenceStore = createStore<PrecedenceState>({
  version: 0,
  document: null,
  deeper: null,
  error: null,
});

/** Apply a state change with the version bump consumers key on. */
function apply(patch: Partial<PrecedenceState>): void {
  precedenceStore.set({
    ...patch,
    version: precedenceStore.get().version + 1,
  });
}

/** The last landed effective document (pulling the refresh in flight). */
export function liveDocument(): PrecedenceDocument | null {
  const key = pullSignature();
  if (key !== pullKey) {
    pullKey = key;
    void refresh();
  }
  return precedenceStore.get().document;
}

/** The render-signature input: bumps once per applied change. */
export function precedenceVersion(): number {
  return precedenceStore.get().version;
}

/**
 * The live pull's failure reason (null when a document is landed):
 * the serve's own message, verbatim — the honest-error contract.
 */
export function precedenceError(): string | null {
  return precedenceStore.get().error;
}

/**
 * The run covering `cp`, or null when no font of the merge covers it —
 * the grid's per-cell read (binary search over the compressed runs).
 */
export function lookupEntry(
  doc: PrecedenceDocument,
  cp: number,
): PrecedenceRun | null {
  const runs = doc.runs;
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid]!;
    if (cp < run.start) hi = mid - 1;
    else if (cp > run.end) lo = mid + 1;
    else return run;
  }
  return null;
}

/**
 * The winner under the layers BENEATH single-codepoint overrides — the
 * prototype's `layC`: block assignments and custom ranges included,
 * the per-character override excluded (the popup's revert decision
 * and the 恢复默认 gate). Null when nothing resolves it.
 */
export function deeperWinner(cp: number): string | null {
  const state = precedenceStore.get();
  if (state.deeper !== null) {
    return lookupEntry(state.deeper, cp)?.winner ?? null;
  }
  // No deeper document: without codepoint rules the effective document
  // IS the deeper answer; with them still in flight there is no honest
  // answer yet.
  const hasOverride = store.get().rules.some(
    (rule) => rule.target.kind === "codepoint" && rule.target.cp !== null,
  );
  if (!hasOverride && state.document !== null) {
    return lookupEntry(state.document, cp)?.winner ?? null;
  }
  return null;
}

/**
 * The document for a HYPOTHETICAL rule state under the current picks
 * (the assignment announcements diff two documents). Memoized through
 * the same cache the live pull reads — committing those rules makes
 * the next pull a cache hit, never a second request.
 */
export async function documentFor(
  rules: readonly EditorRule[],
): Promise<PrecedenceDocument | null> {
  const slots = await resolveSlots();
  if (slots === null) return null;
  return fetchDocument(bodyFor(slots.en, slots.cjk, rules));
}

/* ------------------------------ refresh ------------------------------ */

/** The pull key the renderers last saw (null before the first pull). */
let pullKey: string | null = null;

/** Guards stale lands: only the newest refresh may apply its document. */
let pullSeq = 0;

async function refresh(): Promise<void> {
  const mine = ++pullSeq;
  const { rules } = store.get();
  const slots = await resolveSlots();
  if (slots === null) {
    if (mine !== pullSeq) return;
    apply({ document: null, deeper: null, error: null });
    scheduleRetry(); // the slot may resolve once the serve settles
    return;
  }
  const document = await fetchDocument(bodyFor(slots.en, slots.cjk, rules));
  // The deeper-layer document — only while codepoint overrides exist.
  const deeperRules = rules.filter(
    (rule) => rule.target.kind !== "codepoint" || rule.target.cp === null,
  );
  const deeper =
    deeperRules.length !== rules.length
      ? await fetchDocument(bodyFor(slots.en, slots.cjk, deeperRules))
      : null;
  if (mine !== pullSeq) return;
  apply({ document, deeper, error: document === null ? lastResolveError : null });
  if (document === null) scheduleRetry();
}

/**
 * The synchronous pull key: the picks' identity plus the rules' wire
 * form. Anything that can change the request changes this string —
 * every other store mutation (paging, selection, mode) keeps it
 * stable, and the async work is skipped entirely.
 */
function pullSignature(): string {
  const picks = pickRefs();
  if (picks.base === null) return "none"; // picks.base is required
  return `${fontSig(picks.base)}|${fontSig(picks.donor)}|${rulesSig(
    store.get().rules,
    picks.donor !== null,
  )}`;
}

/** A pick's identity as the request sees it (the slot's inputs). */
function fontSig(font: LoadedFont | null): string {
  return font === null
    ? ""
    : `${font.origin}:${font.cssFamily}:${font.fileName}:${font.path ?? ""}`;
}

/** The rules' wire form (refs stripped to what the merge carries). */
function rulesSig(rules: readonly EditorRule[], hasDonor: boolean): string {
  return JSON.stringify(rulesWire(rules, hasDonor));
}

/** The pick slots a build submission would resolve (null: unresolvable). */
async function resolveSlots(): Promise<{
  en: FontSlot;
  cjk: FontSlot | null;
} | null> {
  const picks = pickRefs();
  if (picks.base === null) return null; // a lone donor has no request
  if (synthStore.get().service.client === null) return null;
  // The synthesize module owns slot resolution (and imports the UI's
  // message surfaces); the dynamic import keeps this module's graph
  // acyclic at load time.
  const { resolvePickSlot } = await import("../service/synthesize");
  const en = await resolvePickSlot(picks.base, "base");
  if (en === null) return null;
  const cjk =
    picks.donor !== null ? await resolvePickSlot(picks.donor, "donor") : null;
  return { en, cjk };
}

/** The request body over resolved slots (picks/rules/sets, recipe schema). */
function bodyFor(
  en: FontSlot,
  cjk: FontSlot | null,
  rules: readonly EditorRule[],
): Record<string, unknown> {
  const wire = rulesWire(rules, cjk !== null);
  const body: Record<string, unknown> = {
    picks: {
      base: fontRef(en),
      ...(cjk !== null ? { donors: [fontRef(cjk)] } : {}),
    },
    rules: wire.rules,
  };
  if (Object.keys(wire.sets).length > 0) body.sets = wire.sets;
  return body;
}

/** Uppercase `0x`-prefixed hex (the interval string syntax). */
function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

/**
 * The GUI rule state in the recipe schema, with font refs the merge
 * cannot carry dropped — a rule naming `donor-0` while no donor is
 * picked behaves exactly as the deleted mirror treated the absent
 * font (skipped; a rule left with no refs cannot supply). Incomplete
 * rows and unknown presets never serialize (`applyRulesToDraft`).
 */
function rulesWire(
  rules: readonly EditorRule[],
  hasDonor: boolean,
): { rules: Array<Record<string, unknown>>; sets: Record<string, string[]> } {
  const available = new Set<string>(["base", ...(hasDonor ? ["donor-0"] : [])]);
  const draft = defaultDraft();
  applyRulesToDraft(draft, rules);
  const out: Array<Record<string, unknown>> = [];
  for (const rule of draft.rules) {
    const fonts = rule.fonts.filter((ref) => available.has(ref));
    if (fonts.length === 0) continue;
    const target = rule.target;
    const entry: Record<string, unknown> = {};
    if (target.kind === "preset") {
      entry.set = target.name;
    } else if (target.kind === "range") {
      entry.range = `${hex(target.start)}-${hex(target.end)}`;
    } else {
      entry.codepoint = target.cp;
    }
    entry.fonts = fonts;
    out.push(entry);
  }
  return { rules: out, sets: draft.sets };
}

/* ------------------------------- cache ------------------------------- */

/** Request-keyed memo: key (canonical body JSON) → in-flight or landed. */
const cache = new Map<string, Promise<PrecedenceDocument | null>>();

/**
 * One request per distinct body: the memo behind the ticket's "one
 * request per picks/rules change" acceptance. Failures leave the cache
 * (the next pull retries); successes stay, so undo/redo back-and-forth
 * and the announce-vs-live overlap resolve without a second POST.
 */
/** The last resolve attempt's failure message (null after a success). */
let lastResolveError: string | null = null;

function fetchDocument(
  body: Record<string, unknown>,
): Promise<PrecedenceDocument | null> {
  const key = JSON.stringify(body);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const client = synthStore.get().service.client;
  const promise: Promise<PrecedenceDocument | null> =
    client === null
      ? Promise.resolve(null)
      : client.resolvePrecedence(body).then(
          (doc) => {
            if (doc !== null) lastResolveError = null;
            return doc;
          },
          (err: unknown) => {
            lastResolveError =
              err instanceof Error ? err.message : String(err);
            return null;
          },
        );
  cache.set(key, promise);
  // A failed resolve must not pin its absence; bound the successes.
  void promise.then((doc) => {
    if (doc === null) {
      cache.delete(key);
      return;
    }
    if (cache.size > 24) {
      for (const k of cache.keys()) {
        if (cache.size <= 16) break;
        cache.delete(k);
      }
    }
  });
  return promise;
}

/* --------------------------- late unblocks --------------------------- */

/**
 * A pick made before the service connected (local files load without
 * one) has no slot until the connect-time `/fonts` index lands; the
 * pull key would gate its retry away. Service-state changes re-arm the
 * pull whenever picks exist but no document ever landed.
 */
let lastServiceSig = "";
synthStore.subscribe((state) => {
  const sig = `${state.service.status}:${state.service.client !== null}:${
    state.service.fontsIndexAt ?? ""
  }`;
  if (sig === lastServiceSig) return;
  lastServiceSig = sig;
  if (precedenceStore.get().document === null && pickRefs().base !== null) {
    pullKey = null; // force the next render's pull to re-key
    void refresh();
  }
});

/**
 * Round 31: a resolve that fired while the serve's catalog was still
 * syncing (the first-run zip fetch racing the pick) fails as a
 * transient 400 — and used to stick: the pull key had already
 * advanced, so no later render re-pulled, and the blanked table held
 * until the picks changed. The catalog's own settle (per-family
 * progress, the status machine) re-arms the pull under the same
 * contract: picks exist, no document ever landed.
 */
let lastCatalogSig = "";
store.subscribe((state) => {
  const catalog = state.catalog;
  const sig = `${catalog.status}:${catalog.documents.length}:${catalog.progress
    .map((entry) => entry.state)
    .join(",")}`;
  if (sig === lastCatalogSig) return;
  lastCatalogSig = sig;
  if (precedenceStore.get().document === null && pickRefs().base !== null) {
    pullKey = null; // force the next render's pull to re-key
    void refresh();
  }
});

/**
 * Round 31: the serve's lazy boot can outrun BOTH store signals — a
 * coloring serve spawned mid-journey answers /catalog EMPTY for its
 * scan's duration, and the resolve then no-ops (no slot, no request,
 * no document) with nothing left to re-arm it. A bounded heartbeat
 * retries while picks exist and no document has landed: one attempt
 * every 3 s, a 25-attempt budget per picks/rules signature (the
 * budget resets when the signature changes), stopping at the first
 * landed document. The fetch memo dedupes in-flight attempts.
 */
const RETRY_MS = 3_000;
const RETRY_BUDGET = 25;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retrySig: string | null = null;
let retryAttempts = 0;

function scheduleRetry(): void {
  if (retryTimer !== null) return;
  const sig = pullSignature();
  if (sig !== retrySig) {
    retrySig = sig;
    retryAttempts = 0;
  }
  if (retryAttempts >= RETRY_BUDGET) return;
  retryAttempts += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (precedenceStore.get().document !== null) return;
    if (pickRefs().base === null) return;
    pullKey = null; // force the next render's pull to re-key
    void refresh();
  }, RETRY_MS);
}
