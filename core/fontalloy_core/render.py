"""The human-readable verification report (issue #12).

One generator, both consumers: :func:`render_text` is the terminal form
the CLI build prints, :func:`render_html` is the self-contained page
(no external resources — the styling is embedded) the GUI and WebApp
display. Both are pure functions of the :class:`~fontalloy_core.report.
VerificationReport` object: no clocks, no locale-dependent formatting,
no iteration over unordered sets — so a rendered report is exactly as
reproducible as the JSON beside it, and the byte-identical rebuild gate
covers it.

The renderings summarize: per-codepoint provenance stays in the JSON
(the machine form); the human form states the coverage scope and gaps,
the borrow table, and the before/after metrics with the
untouched-line-height proof.
"""

from __future__ import annotations

import html
from pathlib import Path

from fontalloy_core.report import (
    MISSING_CAP,
    SCHEMA,
    BorrowRecord,
    CoverageRecord,
    VerificationReport,
    WeightSlotRecord,
)

#: How many gap labels the text form shows per coverage record (the
#: JSON carries the full bounded list; the terminal gets a preview).
_TEXT_GAPS_SHOWN = 8


def render_text(report: VerificationReport) -> str:
    """The terminal-friendly rendering of one build's report."""
    lines: list[str] = []
    summary = report.summary
    lines.append(f"FontAlloy verification report ({SCHEMA})")
    lines.append(f"output: {report.output_path} (format {report.format})")
    lines.append(f"  sha256 {report.output_sha256}")
    lines.append("")
    lines.append("sources:")
    for source in report.sources:
        placeholder = (
            f"  ({source.placeholder_codepoints} placeholder codepoints)"
            if source.placeholder_codepoints
            else ""
        )
        lines.append(
            f"  {source.id:<9} {source.path}  {source.codepoints} codepoints"
            f"{placeholder}  sha256 {source.sha256}"
        )
    lines.extend(_coverage_lines(report))
    lines.extend(_weights_lines(report))
    for face in report.metrics:
        lines.extend(_metrics_lines(face))
    lines.append("")
    lines.append(
        f"summary: {summary['codepoints_total']} codepoints total "
        f"({summary['from_base']} from base, {summary['from_donors']} from donors), "
        f"{summary['output_codepoints']} in the output"
    )
    counts = report.precedence_counts
    lines.append(
        f"precedence: {counts['base']} base, {counts['fill']} fill, "
        f"{counts['override']} override"
    )
    return "\n".join(lines) + "\n"


def render_html(report: VerificationReport) -> str:
    """The self-contained HTML rendering of one build's report."""
    summary = report.summary
    counts = report.precedence_counts
    parts: list[str] = []
    parts.append("<!DOCTYPE html>")
    parts.append('<html lang="en">')
    parts.append("<head>")
    parts.append('<meta charset="utf-8">')
    parts.append(f"<title>FontAlloy verification report ({SCHEMA})</title>")
    parts.append(f"<style>{_STYLESHEET}</style>")
    parts.append("</head>")
    parts.append("<body>")
    parts.append(f"<h1>FontAlloy verification report</h1>")
    parts.append(f"<p class='schema'>{SCHEMA}</p>")
    parts.append(
        "<p class='output'>output <code>"
        + html.escape(str(report.output_path))
        + "</code> (format "
        + html.escape(report.format)
        + "), sha256 <code>"
        + html.escape(report.output_sha256)
        + "</code></p>"
    )
    parts.append("<h2 id='sources'>Sources</h2>")
    parts.append("<table>")
    parts.append("<tr><th>id</th><th>role</th><th>path</th>"
                 "<th>codepoints</th><th>placeholder codepoints</th>"
                 "<th>sha256</th></tr>")
    for source in report.sources:
        parts.append(
            "<tr><td>{}</td><td>{}</td><td><code>{}</code></td>"
            "<td class='num'>{}</td><td class='num'>{}</td>"
            "<td><code>{}</code></td></tr>".format(
                html.escape(source.id),
                html.escape(source.role),
                html.escape(str(source.path)),
                source.codepoints,
                source.placeholder_codepoints,
                html.escape(source.sha256),
            )
        )
    parts.append("</table>")

    parts.append("<h2 id='coverage'>Codepoint coverage</h2>")
    overall = report.coverage_overall
    parts.append(
        "<p>overall: {} requested, {} covered, {} missing</p>".format(
            overall["requested"], overall["covered"], overall["missing_total"]
        )
    )
    if report.coverage_rules:
        parts.append("<table>")
        parts.append("<tr><th>rule</th><th>target</th><th>requested</th>"
                     "<th>covered</th><th>missing</th></tr>")
        for record in report.coverage_rules:
            parts.append(
                "<tr><td>{}</td><td><code>{}</code></td>"
                "<td class='num'>{}</td><td class='num'>{}</td>"
                "<td>{}</td></tr>".format(
                    html.escape(record.rule),
                    html.escape(record.target),
                    record.requested,
                    record.covered,
                    _gap_summary_html(record),
                )
            )
        parts.append("</table>")
    else:
        parts.append("<p>no rules declared: the build is a plain default merge</p>")

    parts.append("<h2 id='weights'>Weight borrow table</h2>")
    parts.append("<table>")
    parts.append("<tr><th>slot</th><th>output</th><th>donor</th><th>family</th>"
                 "<th>donor weight</th><th>style</th><th>via</th></tr>")
    for slot in report.weights:
        if not slot.borrows:
            parts.append(_slot_row_html(slot, "<em>no donors</em>"))
        for borrow in slot.borrows:
            body = "{} from {} ({}){}".format(
                html.escape(borrow.donor),
                borrow.weight,
                html.escape(borrow.via),
                " upright" if borrow.style_fallback else "",
            )
            parts.append(_slot_row_html(slot, body, borrow))
    parts.append("</table>")

    parts.append("<h2 id='metrics'>Metric comparison</h2>")
    for face in report.metrics:
        parts.append(
            "<h3>slot {} — weight {} {} (base face {})</h3>".format(
                face.slot,
                face.weight,
                "italic" if face.italic else "upright",
                face.base_face,
            )
        )
        parts.append("<table>")
        parts.append("<tr><th>metric</th><th>base</th><th>output</th></tr>")
        for label, pair in (
            ("upem", _pair_cells(face.upem)),
            ("latin advance (A)", _pair_cells(face.latin_advance)),
            ("cjk advance", _pair_cells(face.cjk_advance)),
            ("grid ratio", ("<td></td>", _num(face.grid_ratio))),
            ("hhea ascent", _pair_cells(face.hhea_ascent)),
            ("hhea descent", _pair_cells(face.hhea_descent)),
            ("hhea line gap", _pair_cells(face.hhea_line_gap)),
            ("typo ascender", _pair_cells(face.typo_ascender)),
            ("typo descender", _pair_cells(face.typo_descender)),
            ("typo line gap", _pair_cells(face.typo_line_gap)),
            ("usWin ascent", _pair_cells(face.win_ascent)),
            ("usWin descent", _pair_cells(face.win_descent)),
        ):
            base_cell, output_cell = pair
            parts.append(
                f"<tr><td>{label}</td>{base_cell}{output_cell}</tr>"
            )
        parts.append("</table>")
        parts.append(
            "<p>line height untouched: hhea {}, typo {}</p>".format(
                "yes" if face.hhea_untouched else "NO",
                "yes" if face.typo_untouched else "NO",
            )
        )
        if face.normalization:
            parts.append("<h3>Normalization</h3>")
            parts.append("<table>")
            parts.append("<tr><th>donor</th><th>upem</th><th>s0</th>"
                         "<th>H_ink</th><th>k</th><th>scale</th></tr>")
            for record in face.normalization:
                parts.append(
                    "<tr><td>{}</td><td class='num'>{}</td><td class='num'>{}</td>"
                    "<td class='num'>{}</td><td class='num'>{}</td>"
                    "<td class='num'>{}</td></tr>".format(
                        html.escape(record.donor),
                        record.upem,
                        _num(record.s0),
                        _num(record.han_ink_height),
                        _num(record.k),
                        _num(record.scale),
                    )
                )
            parts.append("</table>")

    parts.append(
        "<h2>Summary</h2><p>{} codepoints total ({} from base, {} from donors), "
        "{} in the output; precedence: {} base, {} fill, {} override.</p>".format(
            summary["codepoints_total"],
            summary["from_base"],
            summary["from_donors"],
            summary["output_codepoints"],
            counts["base"],
            counts["fill"],
            counts["override"],
        )
    )
    parts.append("</body>")
    parts.append("</html>")
    return "\n".join(parts) + "\n"


_STYLESHEET = (
    "body{font-family:ui-monospace,Consolas,monospace;margin:2rem;max-width:60rem;"
    "color:#1a1a1a;background:#fff}"
    "h1{font-size:1.3rem;margin-bottom:0}h2{font-size:1.05rem;margin-top:1.6rem}"
    "h3{font-size:0.95rem}"
    "table{border-collapse:collapse;margin:0.6rem 0}"
    "th,td{border:1px solid #ccc;padding:0.25rem 0.6rem;text-align:left;"
    "font-size:0.85rem}"
    "th{background:#f3f3f3}"
    ".num{text-align:right;font-variant-numeric:tabular-nums}"
    ".schema{color:#666;margin-top:0.2rem}"
    "code{word-break:break-all}"
)


def _coverage_lines(report: VerificationReport) -> list[str]:
    """The coverage block of the text form (face 0's scope)."""
    overall = report.coverage_overall
    lines = [""]
    lines.append(
        "coverage: {} requested, {} covered, {} missing".format(
            overall["requested"], overall["covered"], overall["missing_total"]
        )
    )
    for record in report.coverage_rules:
        lines.append(
            "  {} ({} {}): {} requested, {} covered, {} missing".format(
                record.rule,
                record.granularity,
                record.target,
                record.requested,
                record.covered,
                record.missing_total,
            )
        )
        if record.missing:
            lines.append(f"    missing: {_gap_preview(record)}")
    return lines


def _weights_lines(report: VerificationReport) -> list[str]:
    """The borrow table of the text form — the same line per slot the
    CLI has stated since issue #9, so every consumer reads one shape."""
    lines = ["", "weights:"]
    if not report.weights:
        return lines
    for slot in report.weights:
        style = "italic" if slot.italic else "upright"
        borrows = ", ".join(_borrow_text(borrow) for borrow in slot.borrows)
        lines.append(f"  weight {slot.weight} {style}: {borrows or 'no donors'}")
    return lines


def _borrow_text(borrow: BorrowRecord) -> str:
    text = f"{borrow.donor} from {borrow.weight} ({borrow.via})"
    if borrow.style_fallback:
        text += " upright"
    return text


def _metrics_lines(face) -> list[str]:
    """One face's before/after block of the text form."""
    lines = [
        "",
        "metrics (slot {}, weight {} {}, base face {}):".format(
            face.slot,
            face.weight,
            "italic" if face.italic else "upright",
            face.base_face,
        ),
        f"  upem                 {_cell(face.upem[0])} -> {_cell(face.upem[1])}",
        "  latin advance (A)    {} -> {}".format(
            _cell(face.latin_advance[0]), _cell(face.latin_advance[1])
        ),
        "  cjk advance          {} -> {}   grid ratio {}".format(
            _cell(face.cjk_advance[0]),
            _cell(face.cjk_advance[1]),
            _num(face.grid_ratio),
        ),
        "  hhea ascent          {} -> {}   descent {} -> {}   line gap {} -> {}".format(
            _cell(face.hhea_ascent[0]),
            _cell(face.hhea_ascent[1]),
            _cell(face.hhea_descent[0]),
            _cell(face.hhea_descent[1]),
            _cell(face.hhea_line_gap[0]),
            _cell(face.hhea_line_gap[1]),
        ),
        "  typo ascent          {} -> {}   descent {} -> {}   line gap {} -> {}".format(
            _cell(face.typo_ascender[0]),
            _cell(face.typo_ascender[1]),
            _cell(face.typo_descender[0]),
            _cell(face.typo_descender[1]),
            _cell(face.typo_line_gap[0]),
            _cell(face.typo_line_gap[1]),
        ),
        "  usWin ascent         {} -> {}   descent {} -> {}".format(
            _cell(face.win_ascent[0]),
            _cell(face.win_ascent[1]),
            _cell(face.win_descent[0]),
            _cell(face.win_descent[1]),
        ),
        "  line height untouched: hhea {}, typo {}".format(
            "yes" if face.hhea_untouched else "NO",
            "yes" if face.typo_untouched else "NO",
        ),
    ]
    if face.normalization:
        lines.append("  normalization:")
        for record in face.normalization:
            lines.append(
                "    {}: upem {}  s0 {}  H_ink {}  k {}  scale {}".format(
                    record.donor,
                    record.upem,
                    _num(record.s0),
                    _num(record.han_ink_height),
                    _num(record.k),
                    _num(record.scale),
                )
            )
    return lines


def _gap_preview(record: CoverageRecord) -> str:
    """A bounded one-line preview of a record's gap list."""
    shown = " ".join(record.missing[:_TEXT_GAPS_SHOWN])
    rest = record.missing_total - len(record.missing[:_TEXT_GAPS_SHOWN])
    if record.missing_truncated and rest > 0:
        beyond = record.missing_total - MISSING_CAP
        note = f" (+{beyond} more)" if beyond > 0 else ""
        return f"{shown} ...{note}"
    return shown


def _gap_summary_html(record: CoverageRecord) -> str:
    shown = " ".join(record.missing[:MISSING_CAP])
    text = html.escape(shown)
    if record.missing_truncated:
        beyond = record.missing_total - MISSING_CAP
        if beyond > 0:
            text += f" ... (+{beyond} more)"
    return f"<code>{text}</code>" if text else "&mdash;"


def _slot_row_html(slot: WeightSlotRecord, body: str, borrow=None) -> str:
    style = "italic" if slot.italic else "upright"
    cells = [
        str(slot.index),
        f"{slot.weight} {style}",
        body,
    ]
    if borrow is not None:
        cells += [
            html.escape(borrow.family),
            str(borrow.weight),
            "italic" if borrow.italic else "upright",
            html.escape(borrow.via),
        ]
    else:
        cells += ["", "", "", ""]
    return "<tr>" + "".join(f"<td>{cell}</td>" for cell in cells) + "</tr>"


def _pair_cells(pair: tuple) -> tuple[str, str]:
    return (
        f"<td class='num'>{_cell(pair[0])}</td>",
        f"<td class='num'>{_cell(pair[1])}</td>",
    )


def _cell(value) -> str:
    """One metric value as text ('--' for the absent)."""
    if value is None:
        return "--"
    if isinstance(value, float):
        return _num(value)
    return str(value)


def _num(value) -> str:
    """A float in fixed, deterministic text: up to four decimals, no
    trailing zeros, '--' for the absent."""
    if value is None:
        return "--"
    text = f"{float(value):.4f}".rstrip("0").rstrip(".")
    return text or "0"
