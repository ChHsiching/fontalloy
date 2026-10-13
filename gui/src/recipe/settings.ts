/**
 * Settings → recipe mapping (issue #19): the synthesis settings land in
 * the recipe draft the synthesize flow submits — the SAME draft rules
 * serialize into — mapping honestly onto the fields the pipeline has:
 *
 * - baseline alignment → `normalization.mode` (auto/grid are the grid
 *   default, optical is the optical school; the shared baseline and
 *   em box are ADR-0003 invariants, not knobs);
 * - CJK width → `normalization.width_factor` (the prototype's 两倍 /
 *   1.8 倍 / 1.5 倍 English-width setting — a real pipeline knob; the
 *   halfwidth/fullwidth quotes-dashes convention stays a recipe-level
 *   default the GUI does not expose);
 * - output format → `output.format` (round 12, owner item 7: ttf /
 *   ttc / woff2 — the machine layer always supported it; the GUI
 *   draft just never set it);
 * - weight merge mode → the `weights` selection (ADR-0006: output
 *   slots can only be the base file's faces):
 *     nearest → no selection (the default: every base face, donors
 *               nearest-match per slot),
 *     base    → an explicit slot per base-file face,
 *     donor   → the slots whose weight the donor file also provides
 *               (the shared subset; empty intersection degrades to
 *               the default).
 *
 * Face data comes from the serve `/fonts` index (paths + weights). When
 * the index cannot see a pick's file, the weight selection degrades to
 * the default — normalization is unaffected (it needs no face data).
 */

import type { FaceDocument } from "../service/client";
import type { SynthesisSettings } from "../state";
import type { RecipeDraft, WeightSlotDraft } from "./model";

/** One output slot candidate: a face's (weight, style) pair. */
export interface FaceSlot {
  weight: number;
  italic: boolean;
}

/** The faces of one font file, from the serve /fonts index. */
export function fileFaceSlots(
  faces: readonly FaceDocument[],
  path: string,
): FaceSlot[] {
  const norm = (p: string): string => p.replaceAll("\\", "/").toLowerCase();
  const wanted = norm(path);
  return faces
    .filter((face) => norm(face.path) === wanted)
    .map((face) => ({ weight: face.weight, italic: face.italic }));
}

function slotsToWeights(slots: readonly FaceSlot[]): WeightSlotDraft[] {
  // One slot per distinct (weight, style): the selection is a set, and
  // a file carrying two faces at the same weight/style is one slot.
  const seen = new Set<string>();
  const out: WeightSlotDraft[] = [];
  for (const slot of slots) {
    const key = `${slot.weight}:${slot.italic ? "i" : "u"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: out.length,
      weight: slot.weight,
      style: slot.italic ? "italic" : "upright",
      donors: {},
    });
  }
  return out;
}

/**
 * Apply the synthesis settings to a recipe draft. `baseFaces` /
 * `donorFaces` are the picked files' faces (empty = unknown to the
 * service index; the weight selection then degrades to the default).
 */
export function applySettingsToDraft(
  draft: RecipeDraft,
  settings: SynthesisSettings,
  baseFaces: readonly FaceSlot[],
  donorFaces: readonly FaceSlot[],
): void {
  // Baseline: the scale school. auto/grid = the grid default (omitted
  // by the JSON writer); optical selects the optical school.
  draft.normalization.mode =
    settings.baseline === "optical" ? "optical" : "grid";

  // CJK width: the grid school's advance factor (2 / 1.8 / 1.5).
  draft.normalization.widthFactor = settings.cjkWidth;

  // Output format (round 12, owner item 7): the machine layer has
  // supported `output.format` all along; the GUI draft simply never
  // set it. The setting lands here so the serve submission and the
  // no-service YAML carry the same format.
  draft.output.format = settings.outputFormat;

  // Weight merge mode: the weights selection (see the module docstring).
  if (settings.weightMode === "base" && baseFaces.length > 0) {
    draft.weights = slotsToWeights(baseFaces);
  } else if (settings.weightMode === "donor" && baseFaces.length > 0) {
    const donorWeights = new Set(donorFaces.map((face) => face.weight));
    const shared = baseFaces.filter((face) => donorWeights.has(face.weight));
    draft.weights = shared.length > 0 ? slotsToWeights(shared) : [];
  } else {
    draft.weights = [];
  }
}
