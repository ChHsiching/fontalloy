/**
 * The face-set rules for a family+variant pick — pure functions over
 * the release document's file list, no imports (the spec exercises
 * them directly in a bare node context).
 */

/**
 * Every face of a family+variant (round 12, owner item 8): the release
 * zip carries every variant's faces; match the variant's tokens against
 * the file names (NF→NerdFont, Mono, HW, Screen, GB, TC, weights) — the
 * pick's face SET. The cn token is a CUT DISCRIMINATOR (round 17, owner
 * item 1: a multi-cut family like MapleMono ships NF and NF-CN under
 * one zip): present in the variant IFF present in the file, so the
 * plain NF cut never pools the CN faces, and a prototype-era non-NF CN
 * face matches neither cut. Falls back to every file when no token
 * matches — a one-face family resolves to exactly that face.
 */
export function variantFaceFiles(
  files: ReadonlyArray<{ file: string }>,
  variant: string | null,
): ReadonlyArray<{ file: string }> {
  if (variant === null || files.length <= 1) return files;
  const lower = variant.toLowerCase();
  const wants = (token: string): boolean => lower.includes(token);
  const wantsCn = lower.includes("cn");
  const matches = files.filter((f) => {
    const name = f.file.toLowerCase();
    return (
      (!wants("nf") || /nerd ?font|nf/.test(name)) &&
      (!wants("mono") || name.includes("mono")) &&
      (!wants("hw") || name.includes("hw")) &&
      (!wants("screen") || name.includes("screen")) &&
      (!wants("gb") || name.includes("gb")) &&
      (!wants("tc") || name.includes("tc")) &&
      (!wants("light") || name.includes("light")) &&
      (!wants("medium") || name.includes("medium")) &&
      // The cut discriminator: cn rides the variant word IFF it rides
      // the file name (NF vs NF-CN; the bare CN cut matches neither).
      wantsCn === name.includes("cn")
    );
  });
  return matches.length > 0 ? matches : files;
}
