/**
 * The face-set rules for a family+variant pick — pure functions over
 * the release document's file list, no imports (the spec exercises
 * them directly in a bare node context).
 */

/**
 * The family-name words stripped from a face stem before cut-token
 * tests: the file's own words after the family prefix (dash- and
 * underscore-tolerant — `Go-Mono`'s `GoMonoNerdFont-Regular.ttf` and
 * `MapleMono`'s `MapleMono-NF-Regular.ttf` both strip cleanly), or the
 * whole stem when the file does not carry the family name
 * (`SourceHanSansHWSC` inside NotoSansSC). Without the strip the
 * family's own words would read as cut axes (every MapleMono face
 * "is" a Mono cut; GlowSans' `SC-Normal` would read as cn).
 */
function cutWords(file: string, family: string): string {
  const stem = file.replace(/\.[^.]+$/, "").toLowerCase();
  const famKey = family.replace(/[-_\s]/g, "").toLowerCase();
  if (famKey === "") return stem;
  let raw = 0;
  let key = 0;
  while (raw < stem.length && key < famKey.length) {
    if (/[-_\s]/.test(stem[raw]!)) {
      raw++;
      continue;
    }
    if (stem[raw] === famKey[key]) {
      raw++;
      key++;
      continue;
    }
    return stem; // the file does not carry the family prefix
  }
  return key === famKey.length ? stem.slice(raw) : stem;
}

/**
 * Every face of a family+variant (round 12, owner item 8): the release
 * zip carries every variant's faces — round 20 (owner item 2) serves
 * EVERY cut's faces under one family zip, so the variant filter must
 * keep a cut's face set to ITS OWN cut.
 *
 * Each axis the manifest records on a cut rides the variant word IFF
 * it rides the file's own words (after the family strip above): nf
 * (BizinGothicNF vs BizinGothic, HackGen's NerdFont console faces),
 * cn (NF vs NF-CN), hw and mono (NotoSansSC's SourceHanSansHWSC /
 * NotoSansMonoCJKsc cuts), variable (`/\[|VF|wght/i`), gb, tc
 * (LxgwBrightCode's six cuts), screen, plus. A variant naming NO axis
 * (Standard / Regular / Nerd Font) is the residual plain cut: it
 * matches the faces carrying NO discriminator — so a family's plain
 * cut never pools its siblings' cuts, in either direction.
 *
 * Weight words (light, medium) stay ONE-DIRECTIONAL: WenKai's
 * Light/Medium/Regular entries are one cut (round 8: weight is data,
 * not a chip) whose matrix pools every weight. Falls back to every
 * file when no file matches — a one-cut family serves all its faces
 * whatever its variant word happens to contain.
 */
/**
 * Whether ONE face file belongs to the variant's cut (round 23: the
 * per-file predicate, exported so callers can ask "does this variant
 * have ANY face here?" — `variantFaceFiles` falls back to every file
 * when nothing matches, which must never read as a genuine match).
 */
export function faceMatchesVariant(
  file: { file: string },
  variant: string,
  family = "",
): boolean {
  const v = variant.toLowerCase();
  const wantsNf = /nf|nerd ?font/.test(v);
  const wantsCn = v.includes("cn");
  const wantsHw = v.includes("hw");
  const wantsMono = v.includes("mono");
  const wantsVariable = /variable|vf|\[|wght/.test(v);
  const wantsGb = v.includes("gb");
  const wantsTc = v.includes("tc");
  const wantsScreen = v.includes("screen");
  const wantsPlus = v.includes("plus");
  const n = cutWords(file.file, family);
  return (
    wantsNf === /nerd ?font|nf/.test(n) &&
    wantsCn === n.includes("cn") &&
    wantsHw === n.includes("hw") &&
    wantsMono === n.includes("mono") &&
    wantsVariable === /\[|vf|wght/.test(n) &&
    wantsGb === n.includes("gb") &&
    wantsTc === n.includes("tc") &&
    wantsScreen === n.includes("screen") &&
    wantsPlus === n.includes("plus") &&
    (!v.includes("light") || n.includes("light")) &&
    (!v.includes("medium") || n.includes("medium"))
  );
}

export function variantFaceFiles(
  files: ReadonlyArray<{ file: string }>,
  variant: string | null,
  family = "",
): ReadonlyArray<{ file: string }> {
  if (variant === null || files.length <= 1) return files;
  const matches = files.filter((f) => faceMatchesVariant(f, variant, family));
  return matches.length > 0 ? matches : files;
}

/**
 * The stored face a variant selection registers as its REPRESENTATIVE
 * (round 20): the cut's plainest Regular-named face — among the
 * Regulars, the SHORTEST file name, so an artifact's sub-face suffixes
 * (UDEVGothic35NF, JetBrainsMonoNL, HackGen35Console) never outrank
 * the cut's own plain Regular (they are sibling faces with their own
 * name-table families; the plainest name is the cut's identity). With
 * no Regular-named face (a bare variable font, a single-file entry)
 * the set's plainest face is the pick. It is the pick key, the preview
 * face, and the identity every surface reads.
 */
export function pickVariantRepresentative(
  files: ReadonlyArray<{ file: string }>,
  variant: string | null,
  family = "",
): { file: string } | undefined {
  const set = variantFaceFiles(files, variant, family);
  const regulars = set.filter((f) => /regular/i.test(f.file));
  const pool = regulars.length > 0 ? regulars : set;
  return pool.reduce<{ file: string } | undefined>(
    (best, f) => (best === undefined || f.file.length < best.file.length ? f : best),
    undefined,
  );
}
