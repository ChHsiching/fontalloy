"""Pipeline stage 6: rewrite the name table and correct OS/2.

The graft leaves the base font as the container (ADR-0001); this stage
gives that container a coherent identity of its own:

- The name table's identity records (nameID 1, 2, 3, 4, 6, and the
  typographic pair 16/17) are rewritten around the output family — the
  fixed brand default ``ChHsich`` unless the recipe overrides it, never
  a name derived from the source fonts (RFN compliance, ADR-0005; the
  tool does not police user-entered names either). Attribution records
  (copyright, trademark, license, URLs...) pass through from the base.
- Every rewritten nameID is cleared across *all* platform and language
  records, then written twice: Windows Unicode BMP (3, 1, 0x409) and
  Macintosh Roman (1, 0, 0). Both platforms must agree, because a stale
  record on either one wins naive reads — ``getDebugName`` returns the
  first record in file order, not the Windows one (see the fontTools
  research note).
- nameID 16/17 follow the classic rule: a RIBBI subfamily (Regular,
  Bold, Italic, Bold Italic) needs no typographic pair, and a stale one
  from the base is removed; anything else splits — nameID 1 carries
  family + subfamily, nameID 2 carries the RIBBI style derived from the
  base's bold/italic bits, and 16/17 carry the typographic pair.
  Emitting both pairs inconsistently makes Windows synthesize bogus
  weights — the trap the old storefront hit. The subfamily itself is
  the base's TYPographic one (nameID 17) first, the legacy nameID 2
  second: a family with more than four styles keeps "Regular" in
  nameID 2 for every non-RIBBI weight (the JetBrainsMono/Noto
  convention — Thin..ExtraBold all say "Regular" there), so reading
  nameID 2 first would collapse a 16-face output onto eight
  "ChHsich Regular" faces and every RIBBI-matching application would
  resolve the wrong one (round 23, owner item 6: the flagship report).
- OS/2 is corrected, not redesigned: ``xAvgCharWidth`` is the mean of
  the lowercase a–z advance widths per the OpenType specification
  (fontTools' ``recalcAvgCharWidth`` averages *all* advances, which
  diverges badly once CJK glyphs dominate a merged font), the weight
  class is the base's own by construction (the container's OS/2 table
  is the base's), and the PANOSE mono digits follow the base's declared
  monospaced-ness (``post.isFixedPitch`` or ``bProportion`` 9).

Naming rules (DESIGN.md "Output naming"): letters any case, digits,
hyphens; spaces convert to hyphens rather than rejecting; ASCII only
(localized names are out of scope for v1); the family name is at most
31 characters and the PostScript name at most 63.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from fontTools.misc.roundTools import otRound
from fontTools.ttLib import TTFont, newTable

from fontalloy_core.errors import BuildError, RecipeError

#: The fixed brand default output family (ADR-0005).
BRAND_DEFAULT_FAMILY = "ChHsich"

#: Output naming length limits (DESIGN.md "Output naming").
FAMILY_MAX_CHARS = 31
POSTSCRIPT_MAX_CHARS = 63

#: The Windows Unicode BMP and Macintosh Roman name record encodings.
WINDOWS = (3, 1, 0x409)
MACINTOSH = (1, 0, 0)

#: The style names nameID 2 may carry directly (the "RIBBI" set).
_RIBBI = ("Regular", "Bold", "Italic", "Bold Italic")

#: Characters a validated family name (and a PostScript name) may use.
_NAME_CHARS = re.compile(r"[A-Za-z0-9-]+")

#: The WWS weight names of the OpenType usWeightClass registry — what a
#: borrowed union slot's subfamily is called when the base has no face
#: at its weight (issue #27).
WEIGHT_NAMES = {
    100: "Thin",
    200: "ExtraLight",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "SemiBold",
    700: "Bold",
    800: "ExtraBold",
    900: "Black",
}


def weight_subfamily(weight: int, italic: bool) -> str:
    """The WWS style name of a ``(weight, italic)`` slot identity.

    The four RIBBI combinations keep their canonical names; every other
    weight takes its registry name (a non-registry value the nearest
    one, a tie preferring the lighter) with ``Italic`` appended for the
    slanted style — the JetBrainsMono/Noto convention the identity
    rewrite already stands behind.
    """
    name = WEIGHT_NAMES.get(weight)
    if name is None:
        name = WEIGHT_NAMES[
            min(WEIGHT_NAMES, key=lambda w: (abs(w - weight), w))
        ]
    if name == "Regular":
        return "Italic" if italic else "Regular"
    if name == "Bold":
        return "Bold Italic" if italic else "Bold"
    return f"{name} Italic" if italic else name


@dataclass(frozen=True)
class OutputNaming:
    """The output identity a recipe asks for (a validated family)."""

    family: str = BRAND_DEFAULT_FAMILY


def validate_family_name(value: object, where: str = "output.family") -> str:
    """Validate and normalize an output family name.

    Spaces (any run) become single hyphens and the ends are trimmed —
    spaces convert rather than reject. Everything else must be ASCII
    letters, digits, or hyphens, and the result must fit the 31-char
    family limit. Returns the normalized name.
    """
    if not isinstance(value, str):
        raise RecipeError(
            f"recipe field '{where}' must be the output family name "
            f"(a string; got {value!r})"
        )
    normalized = "-".join(value.split())
    if not normalized:
        raise RecipeError(
            f"recipe field '{where}' must be a non-empty family name"
        )
    if not normalized.isascii():
        offending = next(ch for ch in normalized if ord(ch) > 0x7F)
        raise RecipeError(
            f"recipe field '{where}' must be ASCII only — localized names "
            f"are out of scope for v1 (got {offending!r} in {value!r})"
        )
    if not _NAME_CHARS.fullmatch(normalized):
        offending = next(
            ch for ch in normalized if not _NAME_CHARS.fullmatch(ch)
        )
        raise RecipeError(
            f"recipe field '{where}' may contain only letters, digits, "
            f"hyphens, and spaces — spaces become hyphens "
            f"(got {offending!r} in {value!r})"
        )
    if len(normalized) > FAMILY_MAX_CHARS:
        raise RecipeError(
            f"recipe field '{where}' must be at most {FAMILY_MAX_CHARS} "
            f"characters after spaces become hyphens (got {len(normalized)})"
        )
    return normalized


def apply_output_identity(font: TTFont, naming: OutputNaming) -> None:
    """Rewrite the identity name records of ``font``, in place.

    Attribution records (copyright, trademark, license...) pass through
    untouched; every record of the rewritten nameIDs is replaced on
    both platform encodings.
    """
    family = naming.family
    # The base's own subfamily, typographic record first: nameID 17
    # carries the real style for >4-style families whose nameID 2 is
    # "Regular" for every non-RIBBI weight (round 23, owner item 6).
    subfamily = " ".join(
        (_base_name(font, 17) or _base_name(font, 2) or "Regular").split()
    ) or "Regular"

    if subfamily.casefold() in {style.casefold() for style in _RIBBI}:
        canonical = next(
            style for style in _RIBBI if style.casefold() == subfamily.casefold()
        )
        legacy_family = family
        legacy_subfamily = canonical
        typographic: tuple[str, str] | None = None
    else:
        legacy_family = f"{family} {subfamily}"
        legacy_subfamily = _ribbi_from_style_bits(font)
        typographic = (family, subfamily)

    full_name = f"{family} {subfamily}"
    postscript_name = f"{family}-{subfamily.replace(' ', '')}"
    _validate_postscript_name(postscript_name, subfamily)

    values = {
        1: legacy_family,
        2: legacy_subfamily,
        3: f"FontAlloy: {full_name}",
        4: full_name,
        6: postscript_name,
    }
    if typographic is not None:
        values[16], values[17] = typographic

    name = font.get("name")
    if name is None:  # a degenerate base without one still gets a valid output
        name = font["name"] = newTable("name")
        name.names = []
    # Clear every record of the owned nameIDs — any platform, any
    # language. A stale Macintosh or localized record left behind would
    # either leak a source family or shadow the rewrite. The
    # typographic pair (16/17) is owned whether or not this face
    # writes it: a RIBBI face drops the pair, and a stale pair from
    # the base must die with that drop — the real JetBrainsMono Nerd
    # Font carries nameID 16, and applications preferring the
    # typographic family would read the source's name, not the
    # output's (the RFN trap, exposed by issue #23's flagship).
    owned = set(values) | {16, 17}
    name.names = [r for r in name.names if r.nameID not in owned]
    for name_id, text in values.items():
        name.setName(text, name_id, *WINDOWS)
        name.setName(text, name_id, *MACINTOSH)


def apply_weight_identity(font: TTFont, weight: int, italic: bool) -> str:
    """Stamp a borrowed container with a union slot's weight, in place.

    A donor-only slot borrows the nearest base face as its container
    (transform-only: the outlines stay the borrowed face's own — no
    interpolation toward the slot's weight). The output slot still
    NAMES its own weight: OS/2 ``usWeightClass``, the RIBBI style bits
    (fsSelection and head.macStyle), and the subfamily name records
    (the typographic 17 and the legacy 2, both platform encodings)
    state the slot's ``(weight, style)``, so :func:`apply_output_identity`
    reads a coherent weight off a borrowed container exactly the way it
    reads a base's own face. Returns the subfamily name written.
    """
    subfamily = weight_subfamily(weight, italic)
    bold = subfamily in ("Bold", "Bold Italic")
    os2 = font.get("OS/2")
    if os2 is not None:
        os2.usWeightClass = weight
        selection = os2.fsSelection & ~0x61  # clear ITALIC, BOLD, REGULAR
        if bold:
            selection |= 0x20
        if italic:
            selection |= 0x01
        elif not bold:
            selection |= 0x40  # REGULAR: neither bold nor italic
        os2.fsSelection = selection
    head = font.get("head")
    if head is not None:
        mac_style = head.macStyle & ~0x3  # clear the BOLD and ITALIC bits
        if bold:
            mac_style |= 0x1
        if italic:
            mac_style |= 0x2
        head.macStyle = mac_style
    name = font.get("name")
    if name is not None:
        for name_id in (2, 17):
            name.setName(subfamily, name_id, *WINDOWS)
            name.setName(subfamily, name_id, *MACINTOSH)
    return subfamily


def apply_os2_corrections(font: TTFont) -> None:
    """Correct the OS/2 table of ``font``, in place.

    Runs after the graft, on the font about to be saved: xAvgCharWidth
    is measured against the output cmap and hmtx, so donor glyphs that
    won lowercase codepoints are accounted for. ``usWeightClass`` needs
    no code here — the container's OS/2 table is the base's, which is
    precisely the "inherited from the base" contract (a borrowed union
    container's weight was already restamped by
    :func:`apply_weight_identity` at the planning stage).
    """
    os2 = font.get("OS/2")
    if os2 is None:  # a base without OS/2 has nothing to correct
        return
    os2.xAvgCharWidth = _avg_char_width(font)
    if _declares_monospace(font):
        os2.panose.bFamilyType = 2  # Latin Text and Display
        os2.panose.bProportion = 9  # Monospaced


def _avg_char_width(font: TTFont) -> int:
    """The OpenType xAvgCharWidth: the mean lowercase a–z advance.

    Falls back to half the em when the font has none of a–z (the
    spec's escape hatch for non-Latin fonts). Deliberately not
    fontTools' ``recalcAvgCharWidth``, which averages all advances.
    """
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    widths = [hmtx[cmap[cp]][0] for cp in range(0x61, 0x7B) if cp in cmap]
    if widths:
        return otRound(sum(widths) / len(widths))
    return font["head"].unitsPerEm // 2


def _declares_monospace(font: TTFont) -> bool:
    """Whether the base font declares itself monospaced.

    ``post.isFixedPitch`` and the PANOSE proportion digit are the two
    declarations a font can make; OS/2 itself has no mono flag
    (fontconfig measures metrics instead).
    """
    post = font.get("post")
    if post is not None and post.isFixedPitch:
        return True
    return font["OS/2"].panose.bProportion == 9


def _ribbi_from_style_bits(font: TTFont) -> str:
    """The RIBBI style implied by the base's bold/italic flags."""
    bold = bool(font["OS/2"].fsSelection & 0x20) or bool(font["head"].macStyle & 0x1)
    italic = bool(font["OS/2"].fsSelection & 0x01) or bool(font["head"].macStyle & 0x2)
    parts = [flag and name for flag, name in ((bold, "Bold"), (italic, "Italic"))]
    return " ".join(part for part in parts if part) or "Regular"


def _base_name(font: TTFont, name_id: int) -> str | None:
    """Read a record preferring Windows, then Macintosh, then any.

    Never ``getDebugName`` — it returns the first record in file order
    for the platform it finds first, so a stale Mac record shadows the
    Windows one. Reading the base's own subfamily must see the record
    the rewrite will stand behind.
    """
    name = font.get("name")
    if name is None:
        return None
    found = [r for r in name.names if r.nameID == name_id]
    for platform in (WINDOWS, MACINTOSH):
        for record in found:
            if (record.platformID, record.platEncID, record.langID) == platform:
                return record.toUnicode()
    return found[0].toUnicode() if found else None


def _validate_postscript_name(postscript_name: str, subfamily: str) -> None:
    """Guard the derived PostScript name: ASCII word chars, ≤ 63."""
    if not postscript_name.isascii() or not _NAME_CHARS.fullmatch(postscript_name):
        raise BuildError(
            f"the base font's subfamily {subfamily!r} cannot form an ASCII "
            "PostScript name (letters, digits, and hyphens only)"
        )
    if len(postscript_name) > POSTSCRIPT_MAX_CHARS:
        raise BuildError(
            f"the PostScript name must be at most {POSTSCRIPT_MAX_CHARS} "
            f"characters (got {len(postscript_name)}: {postscript_name!r})"
        )
