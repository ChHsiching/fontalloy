/**
 * The two undo stacks (issue #20): rule undo and selection undo, with
 * separate entry points. Spec story 22 — "undo scoped to my current
 * editing context" — splits exactly along the two editing contexts the
 * workspace has:
 *
 * - RULE undo reverts rule mutations (rail edits, single-cell applies,
 *   batch applies). Ctrl+Z triggers it, and the rail's 撤销规则 button
 *   is its click entry point.
 * - SELECTION undo reverts selection gestures (a drag-paint that grabbed
 *   the wrong cells, a shift-click too far). Its click entry point is the
 *   撤销选择 button in the selection editor.
 *
 * Snapshots are by reference and safe because every mutation builds a new
 * array (the store's patches are immutable spreads — see state.ts); the
 * stacks only ever hand back arrays nobody mutates.
 *
 * Granularity: one entry per mutation. A text field edited live produces
 * one entry per input event (Playwright `fill` = one event; deliberate
 * typing = per-keystroke precision). A drag-paint produces exactly one
 * entry: the gesture pushes at pointer-down, the pointer-moves extend
 * without pushing.
 */

import { store } from "./state";
import type { EditorRule } from "./precedence/model";

const RULE_HISTORY_CAP = 200;
const SELECTION_HISTORY_CAP = 100;

interface SelectionSnapshot {
  selection: number[];
  anchor: number | null;
}

let ruleHistory: EditorRule[][] = [];
let selectionHistory: SelectionSnapshot[] = [];

/* ------------------------- rule undo ------------------------- */

/**
 * Commit a rules mutation with an undo snapshot of the current state.
 * EVERY rules write in the app goes through here — that is what makes
 * the rule undo stack complete.
 */
export function mutateRules(next: EditorRule[]): void {
  const { rules } = store.get();
  if (next === rules) return;
  ruleHistory.push(rules);
  if (ruleHistory.length > RULE_HISTORY_CAP) ruleHistory.shift();
  store.set({ rules: next });
}

/** Is there a rule mutation to undo? */
export function canUndoRules(): boolean {
  return ruleHistory.length > 0;
}

/** Pop the last rules snapshot back into the store. */
export function undoRules(): boolean {
  const previous = ruleHistory.pop();
  if (previous === undefined) return false;
  store.set({ rules: previous });
  return true;
}

/* ---------------------- selection undo ----------------------- */

/**
 * Begin a selection gesture: the PRIOR selection becomes one undo entry,
 * then the new state lands. `selectedCodepoint` rides along when the
 * gesture also moves the details cursor (a plain click, a locate).
 */
export function beginSelectionGesture(
  selection: number[],
  anchor: number | null,
  selectedCodepoint?: number,
): void {
  const state = store.get();
  selectionHistory.push({
    selection: state.selection,
    anchor: state.selectionAnchor,
  });
  if (selectionHistory.length > SELECTION_HISTORY_CAP) {
    selectionHistory.shift();
  }
  const patch: {
    selection: number[];
    selectionAnchor: number | null;
    selectedCodepoint?: number;
  } = { selection, selectionAnchor: anchor };
  if (selectedCodepoint !== undefined) {
    patch.selectedCodepoint = selectedCodepoint;
  }
  store.set(patch);
}

/**
 * Extend the ongoing gesture (drag-paint moves): merges without pushing
 * an undo entry, and skips the store entirely when nothing changed — a
 * paint drag fires pointermove per pixel.
 */
export function extendSelection(add: number[]): void {
  if (add.length === 0) return;
  const { selection } = store.get();
  const merged = [...selection];
  const seen = new Set(merged);
  let grew = false;
  for (const cp of add) {
    if (!seen.has(cp)) {
      seen.add(cp);
      merged.push(cp);
      grew = true;
    }
  }
  if (!grew) return;
  merged.sort((a, b) => a - b);
  store.set({ selection: merged });
}

/** Is there a selection gesture to undo? */
export function canUndoSelection(): boolean {
  return selectionHistory.length > 0;
}

/** Pop the last selection snapshot back into the store. */
export function undoSelection(): boolean {
  const previous = selectionHistory.pop();
  if (previous === undefined) return false;
  store.set({
    selection: previous.selection,
    selectionAnchor: previous.anchor,
  });
  return true;
}

/* --------------------- keyboard entry point ------------------- */

/**
 * Ctrl+Z / Cmd+Z triggers RULE undo (issue #20's scoping: the shortcut
 * belongs to the editing context where experiments need reverting).
 * While focus sits in a text field the native input undo stands — typing
 * its own history is the more precise undo there.
 */
export function installUndoShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "z" && event.key !== "Z") return;
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.shiftKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (undoRules()) event.preventDefault();
  });
}
