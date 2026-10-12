"""THIRD-PARTY-NOTICES generation from the catalog manifest.

The notices file is redistribution compliance, generated — never
hand-edited — so the manifest stays the single source of truth: each
family's copyright line, license, upstream pin, and Reserved Font Name
status render into one deterministic Markdown document, with every
distinct license text embedded once (OFL condition 1 and the equivalent
notice-carrying clauses of the other licenses in the catalog).

Every FontAlloy output font is a Modified Version of its source fonts:
the notices say so, and call out the naming rules (Reserved Font Names,
the Bitstream Vera rename requirement, the Ubuntu Font License
"derivative X" rule, CC-BY-SA share-alike) that merged-output naming
must respect.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path

from fontalloy_core.catalog import Catalog, CatalogEntry, load_manifest
from fontalloy_core.errors import CatalogError

#: Per-license obligations that constrain merged-output naming or
#: relicensing, stated once per family carrying the license id. Keys are
#: SPDX ids (or LicenseRef names) exactly as the manifest records them.
_LICENSE_NOTES: dict[str, str] = {
    "OFL-1.1-RFN": (
        "Modified Versions distributed under this license may not use the "
        "family's Reserved Font Name(s); the license and copyright notice "
        "must accompany every copy."
    ),
    "OFL-1.1-no-RFN": (
        "The license and copyright notice must accompany every copy; this "
        "family declares no Reserved Font Name."
    ),
    "OFL-1.1": (
        "The license and copyright notice must accompany every copy; any "
        "Reserved Font Name declared in the family's copyright line binds "
        "Modified Versions."
    ),
    "Bitstream-Vera": (
        "The Bitstream Vera license requires renamed derivatives: modified "
        "versions must be renamed, and the original name must not be used."
    ),
    "Bitstream-Vera AND MIT": (
        "Both licenses apply: the Bitstream Vera license requires renamed "
        "derivatives, and MIT requires its notice accompany copies."
    ),
    "LicenseRef-UbuntuFont": (
        "The Ubuntu Font License 1.0: modified versions that are not "
        "substantially changed must be renamed to retain the original name "
        'plus a "derivative X" suffix; the licence text must accompany '
        "every copy."
    ),
    "CC-BY-SA-4.0": (
        "Creative Commons Attribution-ShareAlike 4.0: attribution required, "
        "and adaptations distributed under the same license (share-alike)."
    ),
    "Apache-2.0": (
        "Apache 2.0: the copyright notice and license must accompany "
        "redistributions; significant changes must be noted."
    ),
    "BSD-3-Clause": (
        "BSD 3-Clause: the copyright notice, license, and disclaimer must "
        "accompany redistributions."
    ),
    "BSD-3-Clause-Clear": (
        "BSD 3-Clause-Clear: the copyright notice, license, and disclaimer "
        "must accompany redistributions."
    ),
    "MIT": "MIT: the copyright notice and license must accompany copies.",
    "WTFPL": (
        "Do What The Fuck You Want To Public License: no conditions beyond "
        "the license text itself."
    ),
    "LicenseRef-Monofur": (
        "The Monofur free license: the license file must accompany the "
        "font."
    ),
    "LicenseRef-VicFieger": (
        "The Vic Fieger free license: free use and redistribution; the "
        "license text travels with the font."
    ),
    "OFL-1.1-no-RFN OR LGPL-2.1-only": (
        "Dual-licensed (upstream's choice applies): the OFL terms above, or"
        " LGPL-2.1-only; the upstream license file states the choice."
    ),
    "IPA": (
        "The IPA Font License 1.0: redistribution is free, but a Derived"
        " Program may not use the Licensed Program's name as its program,"
        " font, or file name (clause 3(4)) — merged outputs must never"
        " carry the reserved names listed above, and the license text must"
        " accompany every copy."
    ),
    "CC0-1.0": (
        "CC0 1.0 Universal: the author waives all copyright and related"
        " rights; no attribution or share-alike obligation applies (the"
        " license text travels anyway as the notice of record)."
    ),
}

#: Extra per-license note for LXGW's modified OFL: the reserved-name
#: carve-out that excludes installable desktop modified versions.
_LXGW_CARVE_OUT = (
    "LXGW's OFL reserves the names 霞鹜, 霞鶩, 落霞孤鹜, 落霞孤鶩 and LXGW, "
    "with an additional permission covering only Modified Versions "
    "recompiled from the Original Version without font source changes, or "
    "subsetted/web-converted versions for web delivery — explicitly NOT "
    "installable desktop fonts. FontAlloy merged outputs are installable "
    "desktop Modified Versions and must never carry these names (output "
    "names default to the fixed brand default, never source font names)."
)

#: The license files that carry LXGW's modified-OFL carve-out (the
#: reserved-name list above; one file per family, same clause).
_LXGW_CARVE_OUT_FILES = frozenset(
    {"OFL-1.1-LXGW.txt", "OFL-1.1-LXGWZhenKai.txt"}
)


def generate_notices(
    manifest_path: Path | str,
    *,
    families: Sequence[str] | None = None,
) -> str:
    """Render the THIRD-PARTY-NOTICES.md content for a catalog manifest.

    ``families`` narrows the document to the named manifest families
    (issue #23): a recipe release carries the notices of exactly the
    source fonts its recipes merged, not the whole catalog. An unknown
    family name is a clear error.
    """
    catalog: Catalog = load_manifest(manifest_path)
    entries = catalog.entries
    if families is not None:
        selected = set(families)
        unknown = sorted(selected - {entry.family for entry in catalog.entries})
        if unknown:
            raise CatalogError(
                f"unknown family {unknown[0]!r} in the notices filter "
                f"(the manifest carries {len(catalog.entries)} entries)"
            )
        entries = [entry for entry in catalog.entries if entry.family in selected]
    lines: list[str] = []
    w = lines.append

    w("# Third-party notices")
    w("")
    w(
        "<!-- Generated by `fontalloy assets notices` from the font catalog"
        f" manifest ({catalog.manifest_path.name}). Do not edit by hand:"
        " the manifest is the single source of truth; regenerate instead. -->"
    )
    w("")
    w(
        "FontAlloy downloads the font families below from their pinned"
        " upstream releases and redistributes them under each family's own"
        " license. Every font built by FontAlloy is a Modified Version of"
        " its source fonts: a built font follows only the source fonts'"
        " licenses — never FontAlloy's own AGPL-3.0 — and it must not carry"
        " any name those licenses reserve."
    )
    w("")
    w("## Font families")
    w("")
    for entry in sorted(entries, key=lambda e: (e.family.lower(), e.variant.lower())):
        lines.extend(_render_family(entry))
    w("## License texts")
    w("")
    for license_file in sorted({entry.license_file for entry in entries}):
        w(f"### {license_file.name}")
        w("")
        w("```text")
        for line in license_file.read_text(encoding="utf-8").splitlines():
            w(line)
        w("```")
        w("")
    return "\n".join(lines).rstrip("\n") + "\n"


def write_notices(
    manifest_path: Path | str,
    output: Path | str,
    *,
    families: Sequence[str] | None = None,
    reporter: Callable[[Path], None] = lambda _p: None,
) -> Path:
    """Generate and write the notices file; returns its path."""
    content = generate_notices(manifest_path, families=families)
    output_path = Path(output)
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(content, encoding="utf-8", newline="\n")
    except OSError as exc:
        raise CatalogError(f"cannot write notices file {output_path}: {exc}") from None
    reporter(output_path)
    return output_path


def _render_family(entry: CatalogEntry) -> list[str]:
    title = entry.family if not entry.variant else f"{entry.family} — {entry.variant}"
    lines = [f"### {title}", ""]
    lines.append(f"- Upstream: {entry.upstream_url} (tag {entry.version})")
    if entry.copyright:
        lines.append(f"- Copyright: {entry.copyright}")
    else:
        lines.append(
            "- Copyright: no copyright line is published upstream; the"
            " license text below is the notice of record"
        )
    lines.append(f"- License: {entry.license_spdx}")
    if entry.rfn:
        if entry.rfn_names:
            names = ", ".join(repr(n) for n in entry.rfn_names)
            lines.append(
                f"- Reserved Font Names: {names}. Merged/built outputs are"
                " Modified Versions and must not carry these names."
            )
        else:
            lines.append(
                "- Reserved Font Names: yes (names not enumerated upstream;"
                " see the family's license file). Merged/built outputs are"
                " Modified Versions and must not carry the reserved name."
            )
    else:
        lines.append("- Reserved Font Names: none declared")
    note = _LICENSE_NOTES.get(entry.license_spdx)
    if note:
        lines.append(f"- License obligations: {note}")
    if entry.license_file.name in _LXGW_CARVE_OUT_FILES:
        lines.append(f"- Reserved-name carve-out: {_LXGW_CARVE_OUT}")
    lines.append("")
    return lines
