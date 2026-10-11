"""Recipe loading: parse a recipe YAML file strictly.

Recipe fields (base + donors since issue #2; rules + sets since issue
#3; normalization since issue #8; output naming since issues #6/#10;
weights since issue #9):

- ``base``: the base font reference
- ``donors``: the donor list of font references
- ``rules``: precedence rules, in declaration order — each rule declares
  exactly one target field (``codepoint`` for a single codepoint,
  ``range`` for a custom interval like ``"0x2100-0x214F"``, ``set`` for a
  named range set) plus ``fonts``, an ordered font list whose entries
  reference ``base`` or ``donor-<join index>``
- ``sets``: user-defined named range sets — a mapping of a name to a
  codepoint, an interval string, or a non-empty list of either
- ``normalization``: the normalization switches (ADR-0003) — ``mode``
  (``grid``, the terminal 2:1 default, or ``optical``),
  ``optical_ratio`` (Han ink to cap height; default 1.23), and
  ``quote_dash_width`` (``halfwidth``, the UAX #11 default, or
  ``fullwidth`` for the CJK locale convention). Every key is optional;
  a recipe without a ``normalization`` block builds with the defaults.
- ``output``: the build's output settings — ``format`` selects the
  output format tier (``ttf`` the default, ``ttc``, or ``woff2``;
  issue #10) and ``family`` the output family name (default: the fixed
  brand default ``ChHsich``, never a name derived from the source
  fonts; validated ASCII letters/digits/hyphens, spaces converted to
  hyphens, at most 31 characters; issue #6)
- ``weights``: the requested weight/style matrix (issue #9) — a list
  of slot selections. Each entry carries ``weight`` (a base face's
  OS/2 usWeightClass), an optional ``style`` (``upright`` the default,
  or ``italic``), and an optional ``donors`` mapping rewriting the
  weight mapping for that slot: donor id → the donor family weight
  that must land in this output (explicit demand, exact — never a
  silent nearest approximation)

A font reference (issue #4; catalog form since issue #23) is a plain
path string, a mapping with a ``path``, or a mapping naming a catalog
``family`` the committed manifest pins:

.. code-block:: yaml

    base:
      family: JetBrainsMono            # catalog family (manifest-pinned)
      pattern: "JetBrainsMonoNerdFont-*.ttf"   # narrow a multi-file zip
    donors:
      - family: MapleMono
        variant: NF-CN                 # required when the family has several
        pattern: "MapleMono-NF-CN-*.ttf"
      - path: SourceHanSans.ttc        # path form: full face/instance control
        face: 2
      - path: Inter-Variable.ttf
        instance:
          wght: 600
        sha256: "<64 hex chars>"       # optional: pin the file's exact bytes
    normalization:
      mode: grid
      quote_dash_width: fullwidth

Path references resolve against the recipe file's directory, not the
working directory — a recipe is a share unit and must mean the same
thing wherever it is run. A path reference may pin its file with
``sha256`` (64 lowercase hex): the build verifies the pin when it loads
the file and fails naming the reference and both hashes on a mismatch;
without a pin the build proceeds and the report still records the
file's hash. Catalog references never carry URLs: the
assets machinery resolves them against the sha256-verified fetched
catalog (``fontalloy assets fetch``), so a recipe names pinned source
fonts, exactly what CI builds and the storefront releases. :func:`parse_recipe` is the same schema over
already-decoded data (serve submits recipes as JSON, issue #11), with
paths resolving against the caller's root. Parsing is strict: unknown
fields, missing fields, and type errors all raise
:class:`~fontalloy_core.errors.RecipeError` with a message naming the
offending field. ``rules``, ``sets``, ``normalization``, and ``weights``
are optional, so a v0 recipe (base + donors only) parses unchanged.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from fontalloy_core.errors import RecipeError
from fontalloy_core.normalize import (
    DEFAULT_OPTICAL_RATIO,
    FULLWIDTH,
    GRID,
    HALFWIDTH,
    MODES,
    NormalizationOptions,
    QUOTE_DASH_POLICIES,
)
from fontalloy_core.output import OUTPUT_FORMATS
from fontalloy_core.precedence import (
    BUILTIN_NAMED_SETS,
    CODEPOINT,
    RANGE,
    SET,
    Interval,
    PrecedenceRule,
    compress_intervals,
    is_unicode_scalar,
)
from fontalloy_core.rewrite import BRAND_DEFAULT_FAMILY, validate_family_name

#: The fields the recipe accepts.
RECIPE_FIELDS = (
    "base",
    "donors",
    "rules",
    "sets",
    "normalization",
    "output",
    "weights",
)

#: The keys a weights-section entry accepts.
WEIGHT_FIELDS = ("weight", "style", "donors")

#: The style names a weights entry may select.
WEIGHT_STYLES = ("upright", "italic")

#: The OS/2 usWeightClass range a recipe weight may demand.
WEIGHT_MIN, WEIGHT_MAX = 1, 1000

#: The target fields a rule may declare; exactly one per rule.
_TARGET_FIELDS = (CODEPOINT, RANGE, SET)

#: The keys a font-reference mapping accepts: ``path`` (a font file,
#: resolved against the recipe) or ``family`` (a catalog family pinned
#: by the manifest; ``variant`` disambiguates a family with several
#: entries, ``pattern`` is a bare-filename glob narrowing a multi-file
#: artifact such as a Nerd Fonts zip), plus ``face``/``instance`` and
#: ``sha256`` (a path reference's optional content pin).
REF_FIELDS = ("path", "face", "instance", "family", "variant", "pattern", "sha256")

#: A pinned source hash: 64 lowercase hex characters, like the catalog
#: manifest's pins.
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

#: The keys the normalization block accepts.
_NORMALIZATION_FIELDS = ("mode", "optical_ratio", "quote_dash_width")

#: The keys the output section accepts.
OUTPUT_FIELDS = ("format", "family")


@dataclass(frozen=True)
class FontRef:
    """A reference to one face of one font file.

    Two forms (issue #23): a *path* reference (``path`` set — one font
    file, resolved against the recipe root) or a *catalog* reference
    (``family`` set — a family the committed manifest pins). A catalog
    reference carries no loose URL: the assets machinery resolves it
    against the fetched catalog (:func:`fontalloy_core.assets.resolve_recipe_fonts`),
    filling ``paths`` with the referenced files (an optional
    ``pattern`` — a bare-filename glob — narrows a multi-file artifact
    such as a Nerd Fonts zip, whose extracted directory carries several
    internal families) and ``artifact`` with the manifest-pinned file
    the reference resolved through (the zip or the bare font file),
    which the build's source records carry as provenance.

    ``face`` selects a face of a TTC collection (``None`` means "not a
    collection reference"). ``instance`` pins variable-font axis values
    (``None`` means "no pinning; use the default instance"), as an ordered
    tuple of ``(axis tag, value)`` pairs in declaration order.

    ``sha256`` (path references only, ``None`` = unpinned) pins the
    referenced file's exact bytes: the build verifies the pin when it
    loads the file and fails naming the reference and both hashes on a
    mismatch. A catalog reference pins through the manifest instead and
    never carries ``sha256``.
    """

    path: Path | None = None
    face: int | None = None
    instance: tuple[tuple[str, int | float], ...] | None = None
    family: str | None = None
    variant: str | None = None
    pattern: str | None = None
    sha256: str | None = None
    paths: tuple[Path, ...] = ()
    artifact: Path | None = None

    @property
    def is_catalog_ref(self) -> bool:
        """True when this reference names a manifest family, not a path."""
        return self.family is not None


@dataclass(frozen=True)
class OutputSpec:
    """The build's output settings (issues #6 and #10).

    ``format`` selects the output format tier: ``ttf`` (the default),
    ``ttc`` (a collection packaging one merged face per selected face
    of the base font file), or ``woff2`` (optional, behind this
    explicit choice). ``family`` is the validated output family name
    (default: the fixed brand default ``ChHsich``, never a name derived
    from the source fonts).
    """

    format: str = "ttf"
    family: str = BRAND_DEFAULT_FAMILY


@dataclass(frozen=True)
class WeightRequest:
    """One requested output slot of the weight/style matrix (issue #9).

    ``weight`` and ``italic`` identify the slot (a base face's
    ``(usWeightClass, italic)``); ``donor_weights`` rewrites the weight
    mapping for this slot only — donor id → the family weight that must
    land here, an explicit demand that beats nearest-match.
    """

    weight: int
    italic: bool = False
    donor_weights: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Recipe:
    """A parsed recipe, with font paths resolved to absolute locations."""

    base: FontRef
    donors: tuple[FontRef, ...]
    rules: tuple[PrecedenceRule, ...] = ()
    named_sets: dict[str, tuple[Interval, ...]] = field(default_factory=dict)
    normalization: NormalizationOptions = field(
        default_factory=NormalizationOptions
    )
    output: OutputSpec = field(default_factory=OutputSpec)
    weights: tuple[WeightRequest, ...] = ()


def load_recipe(path: Path | str) -> Recipe:
    """Load and validate a recipe file, resolving its font paths."""
    recipe_path = Path(path)
    if not recipe_path.is_file():
        raise RecipeError(f"recipe file not found: {recipe_path}")

    text = recipe_path.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise RecipeError(f"recipe is not valid YAML: {exc}") from None

    return parse_recipe(data, recipe_path.parent)


def parse_recipe(data: object, root: Path | str) -> Recipe:
    """Parse already-decoded recipe data, resolving font paths to ``root``.

    The single validation path for the recipe schema: ``load_recipe``
    feeds it the YAML it read from a file, and serve (issue #11) feeds
    it the JSON body of a merge submission — the same recipe schema,
    parsed by the same code, never duplicated. ``root`` is the
    directory relative font paths resolve against (the recipe file's
    directory on disk; the serve process's working directory for a
    submission).
    """
    if not isinstance(data, dict):
        raise RecipeError(
            "recipe must be a YAML mapping with the fields "
            f"{', '.join(repr(f) for f in RECIPE_FIELDS)}"
        )

    unknown = sorted(set(data) - set(RECIPE_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown recipe field {unknown[0]!r} "
            f"(the recipe accepts: {', '.join(RECIPE_FIELDS)})"
        )

    root = Path(root)
    base = _parse_base(data, root)
    donors = _parse_donors(data, root)

    named_sets = _parse_sets(data.get("sets"))
    rules = _parse_rules(data.get("rules"), len(donors), named_sets)
    normalization = _parse_normalization(data.get("normalization"))
    output = _parse_output(data.get("output"))
    weights = _parse_weights(data.get("weights"), len(donors))

    return Recipe(
        base=base,
        donors=donors,
        rules=rules,
        named_sets=named_sets,
        normalization=normalization,
        output=output,
        weights=weights,
    )


def _parse_weights(raw: object, donor_count: int) -> tuple[WeightRequest, ...]:
    """Parse the requested weight/style matrix strictly (issue #9)."""
    if raw is None:
        return ()
    if not isinstance(raw, list) or not raw:
        raise RecipeError(
            "recipe field 'weights' must be a non-empty list of slot "
            "selections (a weight, an optional style, optional donor "
            "weight overrides)"
        )

    requests: list[WeightRequest] = []
    seen: set[tuple[int, bool]] = set()
    for index, entry in enumerate(raw):
        where = f"weights[{index}]"
        if not isinstance(entry, dict):
            raise RecipeError(
                f"recipe field '{where}' must be a mapping with the fields "
                f"{', '.join(repr(f) for f in WEIGHT_FIELDS)}"
            )
        unknown = sorted(set(entry) - set(WEIGHT_FIELDS))
        if unknown:
            raise RecipeError(
                f"recipe field '{where}' has unknown field {unknown[0]!r} "
                f"(a weights entry accepts: "
                f"{', '.join(repr(f) for f in WEIGHT_FIELDS)})"
            )
        if "weight" not in entry:
            raise RecipeError(
                f"recipe field '{where}' is missing the required 'weight' "
                "key (a base face's OS/2 usWeightClass)"
            )

        weight = _parse_weight(entry["weight"], f"{where}.weight")

        italic = False
        if "style" in entry:
            style = entry["style"]
            if style not in WEIGHT_STYLES:
                raise RecipeError(
                    f"recipe field '{where}.style' must be one of: "
                    f"{', '.join(WEIGHT_STYLES)} (got {style!r})"
                )
            italic = style == "italic"

        donor_weights: dict[str, int] = {}
        if "donors" in entry:
            raw_donors = entry["donors"]
            if not isinstance(raw_donors, dict) or not raw_donors:
                raise RecipeError(
                    f"recipe field '{where}.donors' must be a non-empty "
                    "mapping of donor reference to weight "
                    "(e.g. {donor-0: 300})"
                )
            for ref, demanded in raw_donors.items():
                if (
                    not isinstance(ref, str)
                    or ref == "base"
                    or not _is_font_ref(ref, donor_count)
                ):
                    available = [f"donor-{i}" for i in range(donor_count)]
                    raise RecipeError(
                        f"recipe field '{where}.donors' keys must reference "
                        f"a donor in this build: {', '.join(available) or 'none'} "
                        f"(got {ref!r})"
                    )
                donor_weights[ref] = _parse_weight(demanded, f"{where}.donors[{ref!r}]")

        slot = (weight, italic)
        if slot in seen:
            raise RecipeError(
                f"recipe field 'weights' lists weight {weight} "
                f"({'italic' if italic else 'upright'}) more than once"
            )
        seen.add(slot)
        requests.append(WeightRequest(weight=weight, italic=italic, donor_weights=donor_weights))
    return tuple(requests)


def _parse_weight(value: object, where: str) -> int:
    """A weight is an integer in the OS/2 usWeightClass range."""
    if _is_bool(value) or not isinstance(value, int) or not (
        WEIGHT_MIN <= value <= WEIGHT_MAX
    ):
        raise RecipeError(
            f"recipe field '{where}' must be an integer weight from "
            f"{WEIGHT_MIN} to {WEIGHT_MAX} (an OS/2 usWeightClass; "
            f"got {value!r})"
        )
    return value


def _parse_output(raw: object) -> OutputSpec:
    if raw is None:
        return OutputSpec()
    if not isinstance(raw, dict):
        raise RecipeError(
            "recipe field 'output' must be a mapping with the fields "
            f"{', '.join(repr(f) for f in OUTPUT_FIELDS)}"
        )
    unknown = sorted(set(raw) - set(OUTPUT_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown output field {unknown[0]!r} in recipe field 'output' "
            f"(accepts: {', '.join(OUTPUT_FIELDS)})"
        )
    fmt = raw.get("format", "ttf")
    if fmt not in OUTPUT_FORMATS:
        raise RecipeError(
            f"recipe field 'output.format' must be one of: "
            f"{', '.join(OUTPUT_FORMATS)} (got {fmt!r})"
        )
    if "family" not in raw:
        return OutputSpec(format=fmt)
    return OutputSpec(
        format=fmt,
        family=validate_family_name(raw["family"], "output.family"),
    )


def _parse_base(data: dict, root: Path) -> FontRef:
    if "base" not in data:
        raise RecipeError("recipe field 'base' is required (a font file path string)")
    return _parse_font_ref(data["base"], "base", root)


def _parse_donors(data: dict, root: Path) -> tuple[FontRef, ...]:
    if "donors" not in data:
        raise RecipeError("recipe field 'donors' is required (a list of font file paths)")
    donors_raw = data["donors"]
    if not isinstance(donors_raw, list):
        raise RecipeError("recipe field 'donors' must be a list of font file paths")
    return tuple(
        _parse_font_ref(donor, f"donors[{index}]", root)
        for index, donor in enumerate(donors_raw)
    )


def _parse_sets(raw: object) -> dict[str, tuple[Interval, ...]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise RecipeError(
            "recipe field 'sets' must be a mapping of names to codepoints, "
            'interval strings like "0x4E00-0x9FFF", or lists of either'
        )
    named_sets: dict[str, tuple[Interval, ...]] = {}
    for name, body in raw.items():
        if not isinstance(name, str) or not name.strip():
            raise RecipeError(
                "recipe field 'sets' keys must be non-empty names"
            )
        named_sets[name] = _parse_set_body(body, f"sets[{name!r}]")
    return named_sets


def _parse_set_body(body: object, where: str) -> tuple[Interval, ...]:
    elements = body if isinstance(body, list) else [body]
    if not elements:
        raise RecipeError(f"recipe field '{where}' must declare at least one codepoint")
    intervals: list[Interval] = []
    for element in elements:
        if _is_int(element):
            intervals.append((_parse_codepoint(element, where),) * 2)
        elif isinstance(element, str):
            intervals.append(_parse_interval(element, where))
        else:
            raise RecipeError(
                f"recipe field '{where}' entries must be a codepoint or an "
                f'interval string like "0x4E00-0x9FFF" (got {element!r})'
            )
    return compress_intervals(intervals)


def _parse_normalization(raw: object) -> NormalizationOptions:
    """Parse the optional ``normalization`` block (strictly)."""
    if raw is None:
        return NormalizationOptions()
    if not isinstance(raw, dict):
        raise RecipeError(
            "recipe field 'normalization' must be a mapping with any of "
            f"the fields {', '.join(_NORMALIZATION_FIELDS)}"
        )

    unknown = sorted(set(raw) - set(_NORMALIZATION_FIELDS))
    if unknown:
        raise RecipeError(
            f"recipe field 'normalization.{unknown[0]}' is unknown "
            f"(the normalization switches are: "
            f"{', '.join(_NORMALIZATION_FIELDS)})"
        )

    mode = GRID
    if "mode" in raw:
        mode = raw["mode"]
        if mode not in MODES:
            raise RecipeError(
                f"recipe field 'normalization.mode' must be one of "
                f"{', '.join(repr(m) for m in MODES)} (got {raw['mode']!r})"
            )

    ratio = DEFAULT_OPTICAL_RATIO
    if "optical_ratio" in raw:
        ratio = raw["optical_ratio"]
        if _is_bool(ratio) or not isinstance(ratio, (int, float)):
            raise RecipeError(
                f"recipe field 'normalization.optical_ratio' must be a "
                f"positive number (the Han ink to cap height ratio; got "
                f"{ratio!r})"
            )
        ratio = float(ratio)
        if not math.isfinite(ratio) or ratio <= 0:
            raise RecipeError(
                f"recipe field 'normalization.optical_ratio' must be a "
                f"positive number (the Han ink to cap height ratio; got "
                f"{ratio!r})"
            )

    quote_dash_width = HALFWIDTH
    if "quote_dash_width" in raw:
        quote_dash_width = raw["quote_dash_width"]
        if quote_dash_width not in QUOTE_DASH_POLICIES:
            raise RecipeError(
                f"recipe field 'normalization.quote_dash_width' must be "
                f"{FULLWIDTH!r} (the CJK locale convention) or "
                f"{HALFWIDTH!r} (the UAX #11 default; got "
                f"{raw['quote_dash_width']!r})"
            )

    return NormalizationOptions(
        mode=mode,
        optical_ratio=ratio,
        quote_dash_width=quote_dash_width,
    )


def _parse_rules(
    raw: object, donor_count: int, named_sets: dict[str, tuple[Interval, ...]]
) -> tuple[PrecedenceRule, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise RecipeError(
            "recipe field 'rules' must be a list of precedence rules "
            "(each with one target field and a fonts list)"
        )

    available_sets = {**BUILTIN_NAMED_SETS, **named_sets}
    rules: list[PrecedenceRule] = []
    for index, entry in enumerate(raw):
        where = f"rules[{index}]"
        if not isinstance(entry, dict):
            raise RecipeError(
                f"recipe field '{where}' must be a mapping declaring exactly "
                f"one of {', '.join(repr(f) for f in _TARGET_FIELDS)} plus "
                "'fonts'"
            )

        unknown = sorted(set(entry) - set(_TARGET_FIELDS) - {"fonts"})
        if unknown:
            raise RecipeError(
                f"recipe field '{where}' has unknown field {unknown[0]!r} "
                f"(a rule accepts: {', '.join(repr(f) for f in _TARGET_FIELDS)}, 'fonts')"
            )

        targets = [field for field in _TARGET_FIELDS if field in entry]
        if len(targets) != 1:
            raise RecipeError(
                f"recipe field '{where}' must declare exactly one target "
                f"field: {', '.join(repr(f) for f in _TARGET_FIELDS)}"
            )
        target = targets[0]

        fonts = _parse_fonts(entry.get("fonts"), f"{where}.fonts", donor_count)

        if target == CODEPOINT:
            rule = PrecedenceRule(
                granularity=CODEPOINT,
                codepoint=_parse_codepoint(entry[target], f"{where}.{CODEPOINT}"),
                fonts=fonts,
            )
        elif target == RANGE:
            rule = PrecedenceRule(
                granularity=RANGE,
                span=_parse_interval(entry[target], f"{where}.{RANGE}"),
                fonts=fonts,
            )
        else:
            name = entry[target]
            if not isinstance(name, str) or not name.strip():
                raise RecipeError(
                    f"recipe field '{where}.{SET}' must be a named set reference"
                )
            if name not in available_sets:
                raise RecipeError(
                    f"recipe field '{where}.{SET}' references the unknown named "
                    f"set {name!r} (declared sets: "
                    f"{', '.join(sorted(available_sets)) or 'none'})"
                )
            rule = PrecedenceRule(granularity=SET, set_name=name, fonts=fonts)
        rules.append(rule)
    return tuple(rules)


def _parse_fonts(raw: object, where: str, donor_count: int) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw:
        raise RecipeError(
            f"recipe field '{where}' must be a non-empty list of font "
            "references ('base' or 'donor-<index>')"
        )
    fonts: list[str] = []
    for position, ref in enumerate(raw):
        if not isinstance(ref, str) or not _is_font_ref(ref, donor_count):
            available = ["base"] + [f"donor-{i}" for i in range(donor_count)]
            raise RecipeError(
                f"recipe field '{where}[{position}]' must reference a font in "
                f"this build: {', '.join(available)} (got {ref!r})"
            )
        if ref in fonts:
            raise RecipeError(
                f"recipe field '{where}' lists {ref!r} more than once"
            )
        fonts.append(ref)
    return tuple(fonts)


def _is_font_ref(ref: str, donor_count: int) -> bool:
    if ref == "base":
        return True
    match = re.fullmatch(r"donor-(\d+)", ref)
    return match is not None and int(match.group(1)) < donor_count


def _parse_codepoint(value: object, where: str) -> int:
    if not _is_int(value) or not is_unicode_scalar(value):
        raise RecipeError(
            f"recipe field '{where}' must be a Unicode scalar value "
            f"(an integer like 0x4E2D; got {value!r})"
        )
    return value


def _parse_interval(value: object, where: str) -> Interval:
    if not isinstance(value, str):
        raise RecipeError(
            f"recipe field '{where}' must be an interval string like "
            f'"0x4E00-0x9FFF" (got {value!r})'
        )
    parts = value.split("-")
    if len(parts) != 2:
        raise RecipeError(
            f"recipe field '{where}' must be an interval string like "
            f'"0x4E00-0x9FFF" (got {value!r})'
        )
    try:
        start, end = (int(part, 0) for part in parts)
    except ValueError:
        raise RecipeError(
            f"recipe field '{where}' must be an interval string like "
            f'"0x4E00-0x9FFF" (got {value!r})'
        ) from None
    if not is_unicode_scalar(start) or not is_unicode_scalar(end):
        raise RecipeError(
            f"recipe field '{where}' bounds must be Unicode scalar values "
            f"(got {value!r})"
        )
    if start > end:
        raise RecipeError(
            f"recipe field '{where}' start must not exceed the end "
            f"(got {value!r})"
        )
    return (start, end)


def _parse_font_ref(value: object, field: str, root: Path) -> FontRef:
    """Parse one font reference (string or mapping) against the recipe root."""
    if isinstance(value, str):
        return _parse_string_ref(value, field, root)
    if isinstance(value, dict):
        return _parse_mapping_ref(value, field, root)
    raise RecipeError(
        f"recipe field '{field}' must be a font file path string or a mapping "
        f"with the fields {', '.join(REF_FIELDS)}"
    )


def _parse_string_ref(value: str, field: str, root: Path) -> FontRef:
    """Parse ``path`` or ``path#face`` — the compact share-unit form."""
    path_text, sep, tail = value.rpartition("#")
    if sep and tail.isdigit():
        path = (root / path_text).resolve()
        return FontRef(path=path, face=int(tail), paths=(path,))
    path = (root / value).resolve()
    return FontRef(path=path, paths=(path,))


def _parse_mapping_ref(value: dict, field: str, root: Path) -> FontRef:
    """Parse ``{path, face, instance, family, variant, pattern, sha256}``."""
    unknown = sorted(set(value) - set(REF_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown font reference field {unknown[0]!r} in recipe field "
            f"{field!r} (accepts: {', '.join(REF_FIELDS)})"
        )

    if "path" in value and "family" in value:
        raise RecipeError(
            f"font reference in recipe field {field!r} declares both 'path' "
            "and 'family' — a reference is exactly one of them"
        )
    for dependent in ("variant", "pattern"):
        if dependent in value and "family" not in value:
            raise RecipeError(
                f"font reference field {dependent!r} in recipe field "
                f"{field!r} requires 'family' (it narrows a catalog-family "
                "reference)"
            )
    if "sha256" in value and "path" not in value:
        raise RecipeError(
            f"font reference field 'sha256' in recipe field {field!r} "
            "requires 'path' (it pins a path-form reference; a "
            "catalog-family reference pins through the manifest)"
        )
    if "path" not in value and "family" not in value:
        raise RecipeError(
            f"font reference in recipe field {field!r} is missing the "
            "required 'path' key (a font file) or 'family' key (a catalog "
            "family pinned by the manifest)"
        )

    face = None
    if "face" in value:
        face = value["face"]
        if _is_bool(face) or not isinstance(face, int):
            raise RecipeError(
                f"font reference 'face' in recipe field {field!r} must be a "
                "non-negative integer (the TTC face index)"
            )
        if face < 0:
            raise RecipeError(
                f"font reference 'face' in recipe field {field!r} must be a "
                "non-negative integer (the TTC face index)"
            )

    instance: tuple[tuple[str, int | float], ...] | None = None
    if "instance" in value:
        raw = value["instance"]
        if not isinstance(raw, dict):
            raise RecipeError(
                f"font reference 'instance' in recipe field {field!r} must be "
                "a mapping of variable-font axis tag to value"
            )
        pins: list[tuple[str, int | float]] = []
        for tag, pinned in raw.items():
            if not isinstance(tag, str) or not tag:
                raise RecipeError(
                    f"font reference 'instance' in recipe field {field!r} has "
                    f"a non-string axis tag {tag!r} (axis tags are "
                    "4-character strings like 'wght')"
                )
            if _is_bool(pinned) or not isinstance(pinned, (int, float)):
                raise RecipeError(
                    f"font reference 'instance' axis {tag!r} in recipe field "
                    f"{field!r} must be a number"
                )
            pins.append((tag, pinned))
        instance = tuple(pins)

    if "family" in value:
        family = value["family"]
        if not _is_path_string(family):
            raise RecipeError(
                f"font reference 'family' in recipe field {field!r} must be "
                "a non-empty catalog family name (the manifest pins it)"
            )
        variant = None
        if "variant" in value:
            variant = value["variant"]
            if not isinstance(variant, str):
                raise RecipeError(
                    f"font reference 'variant' in recipe field {field!r} "
                    "must be a string (the manifest variant)"
                )
        pattern = None
        if "pattern" in value:
            pattern = value["pattern"]
            if (
                not _is_path_string(pattern)
                or "/" in pattern
                or "\\" in pattern
            ):
                raise RecipeError(
                    f"font reference 'pattern' in recipe field {field!r} "
                    "must be a bare filename glob like "
                    f'"Family-Regular*.ttf" (got {pattern!r})'
                )
        return FontRef(
            face=face,
            instance=instance,
            family=family,
            variant=variant,
            pattern=pattern,
        )

    path_text = value["path"]
    if not _is_path_string(path_text):
        raise RecipeError(
            f"font reference 'path' in recipe field {field!r} must be a "
            "non-empty font file path string"
        )
    sha256 = None
    if "sha256" in value:
        sha256 = value["sha256"]
        if not isinstance(sha256, str) or not _SHA256_RE.fullmatch(sha256):
            raise RecipeError(
                f"font reference 'sha256' in recipe field {field!r} must be "
                f"64 lowercase hex characters (the pinned file's hash; "
                f"got {sha256!r})"
            )
    path = (root / path_text).resolve()
    return FontRef(
        path=path, face=face, instance=instance, sha256=sha256, paths=(path,)
    )


def _is_bool(value: object) -> bool:
    """YAML booleans are Python ints; a face of ``true`` is a type error."""
    return isinstance(value, bool)


def _is_path_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)
