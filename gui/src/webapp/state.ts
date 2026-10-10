/**
 * The builder store: the GUI store pattern (createStore from state.ts)
 * applied to a RecipeDraft. Region components subscribe and patch
 * themselves; text inputs push state without rebuilding their own
 * region (focus preservation), so regions compare a signature before
 * rebuilding DOM.
 */

import { createStore } from "../state";
import {
  defaultDraft,
  type BuilderRule,
  type RecipeDraft,
  type RuleTarget,
} from "../recipe/model";

export interface BuilderState {
  draft: RecipeDraft;
  /** Monotonic id source for rules and donors. */
  nextId: number;
}

export const builderStore = createStore<BuilderState>({
  draft: defaultDraft(),
  nextId: 1,
});

/** Apply a pure transform to the draft and notify the regions. */
export function updateDraft(transform: (draft: RecipeDraft) => RecipeDraft): void {
  const { draft, nextId } = builderStore.get();
  builderStore.set({ draft: transform(draft), nextId });
}

export function takeId(): number {
  const { nextId } = builderStore.get();
  builderStore.set({ nextId: nextId + 1 });
  return nextId;
}

/** Update one rule by id (immutably). */
export function updateRule(
  id: number,
  patch: (rule: BuilderRule) => BuilderRule,
): void {
  updateDraft((draft) => ({
    ...draft,
    rules: draft.rules.map((rule) => (rule.id === id ? patch(rule) : rule)),
  }));
}

/** Update a rule's target, resetting value fields per target kind. */
export function retargetRule(id: number, target: RuleTarget): void {
  updateRule(id, (rule) => ({ ...rule, target }));
}
