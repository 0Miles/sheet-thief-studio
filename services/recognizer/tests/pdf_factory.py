"""Build small fixtures in memory: PDFs with reportlab, and the pictures of them (or of a page drawn
with Pillow) that the picture reader gets."""

from __future__ import annotations

import io
from typing import TYPE_CHECKING

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

if TYPE_CHECKING:
    from PIL import Image

# Digits drawn in this font come out as the SMuFL time-signature glyphs (U+E080…) an editor's music
# font writes: _music_font() gives the font that encoding once the PDF is saved.
MUSIC_DIGITS_FONT = "Courier-Bold"


def _music_font(data: bytes) -> bytes:
    """Map the digits of MUSIC_DIGITS_FONT to the SMuFL time-signature glyph names (uniE080…).
    The PDF must be written uncompressed; the readers rebuild the cross-reference table."""
    names = b" ".join(b"/uniE08%d" % digit for digit in range(10))
    encoding = b"<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [ 48 " + names + b" ] >>"
    font = f"/BaseFont /{MUSIC_DIGITS_FONT} /Encoding /WinAnsiEncoding".encode()
    assert font in data
    return data.replace(font, font.replace(b"/WinAnsiEncoding", encoding))


def _music_signature(pdf, x: float, drawn_top: float, numerator: int, denominator: int, size: float = 14) -> None:
    """A time signature in the music font whose numerator is drawn from ``drawn_top`` (PDF y) down.
    Text extraction puts a music glyph's box about one em below the glyph (rhythm_marks.glyph_ys):
    the digits are drawn there."""
    pdf.setFont(MUSIC_DIGITS_FONT, size)
    for row, value in enumerate((numerator, denominator)):
        pdf.drawString(x, drawn_top - (row + 1) * 0.9 * size - 0.9 * size, str(value))


def ascii_tab_pdf(
    systems: list[list[str]], font_size: int = 10, extra_lines: list[str] | None = None, line_spacing: float = 1.15
) -> bytes:
    """Render tab systems as monospaced text lines (like a printed .txt tab)."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.setFont("Courier", font_size)
    y = A4[1] - 60
    for line in extra_lines or []:
        pdf.drawString(40, y, line)
        y -= font_size * 2
    for system in systems:
        for line in system:
            pdf.drawString(40, y, line)
            y -= font_size * line_spacing
        y -= font_size * 2 * line_spacing
    pdf.save()
    return buffer.getvalue()


def engraved_tab_pdf(
    staves: list,
    strings: int = 6,
    bar_numbers: list[list[int]] | None = None,
    widths: list[float] | None = None,
    measure_number_noise: int = 0,
    ranges: list[tuple[int, str, float, float]] | None = None,
    knockout: bool = False,
    heading: tuple[str, str, int] | None = None,
    signatures: list[tuple[int, int, int, int]] | None = None,
    gap: float = 0.6,
    words: list[tuple[int, float, str, str, float]] | None = None,
    heading_lines: list[str] | None = None,
    music_signatures: list[tuple[int, int, int, int]] | None = None,
    heading_signature: tuple[int, int] | None = None,
) -> bytes:
    """Draw tab staves with vector lines.

    ``staves`` is a list of staves, each a list of measures, each a list of
    (string, fret) or (string, fret, flags). A plain list of measures is treated
    as one staff. Flags: "(" draws parentheses as curved paths, "P"/"H" prints
    the letter above the staff between the previous note and this one, "/" draws a
    slide from the previous note on the same string (a straight stroke between the two
    numbers, rising when the fret goes up), "<" a slide into the note from below and
    ">" a slide out of it downwards (short strokes beside the number), "b" a full bend
    (a curve rising from the number to an arrowhead over the staff, "full" above it), "B" a
    half bend ("1/2"), "R" after either a release (a curve down from the peak to an arrowhead
    pointing down), "^" a pre-bend (a straight arrow up from the number), "~" a
    vibrato (a wavy line over the staff from the note on, drawn as a path: a picture of it
    looks like an editor's wiggle glyph, but the vector reader, which reads the glyphs, does
    not see it), "t" a tie from the previous note on the same string (an arc over the string
    between the two numbers; the tied number in parentheses, as editors print it), "s" a slur
    from the previous note on the same string (an arc above both numbers: with "/", a legato
    slide) and "T" a tie from the note over the next bar line (into an empty bar).
    ``ranges`` are (staff, text, x_from, x_to): text such as "let ring" under the
    staff followed by a dashed line up to x_to; a harmonic mark ("PH", "AH", "N.H.") is
    printed over the staff instead, above the "H"/"P" letters. Staff lines are drawn one
    segment per measure, right to left, as some editors do. ``knockout`` blanks
    the line behind each number, as editors do on screen and in print, ``gap`` points
    beyond the digits on each side.
    ``heading`` is (title, artist, BPM): title and artist centred at the top and
    a tempo mark (a drawn quarter note, "= BPM") above the first staff.
    ``signatures`` are (staff, measure, numerator, denominator): a time signature
    in big bold digits at the start of that measure, the staff lines through them.
    ``words`` are (staff, x, text, font, size): text over that staff (a section label, a
    direction such as "rit." or "una corda").
    ``heading_lines`` are any text lines printed at the top left of the page, above the title
    ("Tuning: Drop D", "Tempo: 1200").
    ``music_signatures`` are (staff, measure, numerator, denominator): a time signature as an
    editor writes it, in music-font glyphs at the start of that measure; ``heading_signature`` one
    printed in the heading, left of everything else.
    """
    if staves and staves[0] and isinstance(staves[0][0], tuple):
        staves = [staves]  # type: ignore[list-item]
    buffer = io.BytesIO()
    music = bool(music_signatures or heading_signature)
    pdf = canvas.Canvas(buffer, pagesize=A4, pageCompression=0 if music else None)
    spacing = 7.0
    x0 = 60.0
    if heading_signature:
        _music_signature(pdf, 20, A4[1] - 15, *heading_signature)
    pdf.setFont("Helvetica", 9)
    for number, line in enumerate(heading_lines or []):
        pdf.drawString(x0, A4[1] - 20 - 11 * number, line)
    if heading:
        title, artist, bpm = heading
        pdf.setFont("Helvetica", 22)
        pdf.drawCentredString(A4[0] / 2, A4[1] - 45, title)
        pdf.setFont("Helvetica", 12)
        pdf.drawCentredString(A4[0] / 2, A4[1] - 63, artist)
        pdf.ellipse(x0, A4[1] - 88, x0 + 4.5, A4[1] - 84.5, stroke=0, fill=1)  # quarter note head
        pdf.line(x0 + 4.2, A4[1] - 86, x0 + 4.2, A4[1] - 76)  # and stem
        pdf.setFont("Helvetica", 9)
        pdf.drawString(x0 + 8, A4[1] - 88, f"= {bpm}")
    for index, measures in enumerate(staves):
        top = A4[1] - 100 - index * 90
        x1 = x0 + (widths[index] if widths else 480.0)
        width = (x1 - x0) / max(len(measures), 1)
        for m in reversed(range(len(measures))):
            for s in range(strings):
                pdf.line(x0 + m * width, top - s * spacing, x0 + (m + 1) * width, top - s * spacing)
        last_on_string: dict[int, tuple[float, int, bool]] = {}  # string -> (x, fret, in parentheses)
        for m, notes in enumerate(measures):
            start = x0 + m * width
            pdf.line(start, top, start, top - (strings - 1) * spacing)
            if bar_numbers:
                pdf.setFont("Helvetica-Oblique", 5)
                pdf.drawString(start - 2, top + 4, str(bar_numbers[index][m]))
            pdf.setFont("Helvetica", 7)
            step = width / (len(notes) + 1)
            for k, (string, fret, *rest) in enumerate(notes):
                flags = rest[0] if rest else ""
                if "t" in flags:
                    flags += "("
                y = top - (string - 1) * spacing
                x = start + step * (k + 0.5) + 4
                if knockout:  # the gap also takes the parentheses, as editors draw them
                    half = pdf.stringWidth(str(fret), "Helvetica", 7) / 2 + (2.4 if "(" in flags else gap)
                    pdf.setFillColorRGB(1, 1, 1)
                    pdf.rect(x - half, y - 3, 2 * half, 6, stroke=0, fill=1)
                    pdf.setFillColorRGB(0, 0, 0)
                pdf.drawCentredString(x, y - 2.5, str(fret))
                if "(" in flags:
                    half = pdf.stringWidth(str(fret), "Helvetica", 7) / 2 + 0.8
                    for side, bulge in ((x - half, -1.2), (x + half, 1.2)):
                        path = pdf.beginPath()
                        path.moveTo(side, y - 3)
                        path.curveTo(side + bulge, y - 1.5, side + bulge, y + 1.5, side, y + 3)
                        path.close()
                        pdf.drawPath(path, stroke=0, fill=1)
                for letter in "HP":
                    if letter in flags:
                        pdf.drawCentredString(x - step / 2, top + 6, letter)
                half = pdf.stringWidth(str(fret), "Helvetica", 7) / 2
                if "/" in flags and string in last_on_string:
                    px, pfret, paren = last_on_string[string]
                    pwidth = pdf.stringWidth(str(pfret), "Helvetica", 7) / 2 + (1.8 if paren else 0)
                    rise = 2.1 if fret > pfret else -2.1  # PDF y goes up
                    pdf.line(px + pwidth + 1.2, y - rise, x - half - 1.2, y + rise)
                if "<" in flags:
                    pdf.line(x - half - 6.5, y - 3.5, x - half - 1.2, y + 0.7)
                if ">" in flags:
                    pdf.line(x + half + 1.2, y - 0.7, x + half + 6.5, y - 4.9)

                def arrowhead(cx: float, base: float, up: bool) -> None:
                    head = pdf.beginPath()
                    head.moveTo(cx - 1.7, base)
                    head.lineTo(cx + 1.7, base)
                    head.lineTo(cx, base + (3.5 if up else -3.5))
                    head.close()
                    pdf.drawPath(head, stroke=0, fill=1)

                def amount(cx: float, text: str, top: float = top) -> None:
                    pdf.setFont("Helvetica", 5)
                    pdf.drawCentredString(cx, top + 11, text)
                    pdf.setFont("Helvetica", 7)

                if "b" in flags or "B" in flags:
                    peak = x + half + 5.5
                    path = pdf.beginPath()
                    path.moveTo(x + half + 0.6, y)
                    path.curveTo(x + half + 4, y, peak, top - 2, peak, top + 6)
                    pdf.drawPath(path, stroke=1, fill=0)
                    arrowhead(peak, top + 6, up=True)
                    amount(peak, "1/2" if "B" in flags else "full")
                    if "R" in flags:
                        back = peak + 0.45 * step
                        path = pdf.beginPath()
                        path.moveTo(peak, top + 9.5)
                        path.curveTo(peak + 2, top + 9.5, back, top + 6, back, top + 1)
                        pdf.drawPath(path, stroke=1, fill=0)
                        arrowhead(back, top + 1, up=False)
                if "^" in flags:
                    pdf.line(x, y + 3.6, x, top + 6)
                    arrowhead(x, top + 6, up=True)
                    amount(x, "full")
                if "~" in flags:
                    wave = pdf.beginPath()
                    wx, wy, end = x - 2, top + 14, x + 0.55 * step
                    wave.moveTo(wx, wy)
                    up = True
                    while wx < end:
                        wave.curveTo(
                            wx + 0.5, wy + (1.1 if up else -1.1), wx + 1.0, wy + (1.1 if up else -1.1), wx + 1.5, wy
                        )
                        wx += 1.5
                        up = not up
                    pdf.setLineWidth(0.7)
                    pdf.drawPath(wave, stroke=1, fill=0)
                    pdf.setLineWidth(1)

                def arc(x_from: float, x_to: float, low: float, rise: float) -> None:
                    path = pdf.beginPath()
                    path.moveTo(x_from, low)
                    span = x_to - x_from
                    path.curveTo(x_from + span / 4, low + rise, x_to - span / 4, low + rise, x_to, low)
                    pdf.setLineWidth(0.6)
                    pdf.drawPath(path, stroke=1, fill=0)
                    pdf.setLineWidth(1)

                if "t" in flags and string in last_on_string:
                    px, pfret, paren = last_on_string[string]
                    pwidth = pdf.stringWidth(str(pfret), "Helvetica", 7) / 2
                    arc(px + pwidth + (2.6 if paren else 0.8), x - half - 2.6, y + 1.6, 3.2)
                if "s" in flags and string in last_on_string:
                    px, _, _ = last_on_string[string]
                    arc(px - 1, x + 1, y + 4.0, 2.4)
                if "T" in flags:
                    arc(x + half + (2.6 if "(" in flags else 0.8), start + width + 0.35 * width, y + 1.6, 3.2)
                last_on_string[string] = (x, fret, "(" in flags)
        pdf.line(x1, top, x1, top - (strings - 1) * spacing)
        middle = top - (strings - 1) * spacing / 2
        for staff_index, measure, numerator, denominator in signatures or []:
            if staff_index == index:
                pdf.setFont("Helvetica-Bold", 19)
                x = x0 + measure * width + 10
                pdf.drawCentredString(x, middle + 0.5, str(numerator))
                pdf.drawCentredString(x, middle - 14.5, str(denominator))
        for staff_index, measure, numerator, denominator in music_signatures or []:
            if staff_index == index:
                _music_signature(pdf, x0 + measure * width + 4, top + 1, numerator, denominator, size=2.2 * spacing)
        for staff_index, x, text, font, size in words or []:
            if staff_index == index:
                pdf.setFont(font, size)
                pdf.drawString(x, top + 9, text)
        for staff_index, text, x_from, x_to in ranges or []:
            if staff_index != index:
                continue
            above = text in ("PH", "AH", "N.H.")
            y = top + 16 if above else top - (strings - 1) * spacing - 20
            pdf.setFont("Helvetica", 6)
            pdf.drawString(x_from, y, text)
            dash = pdf.stringWidth(text, "Helvetica", 6) + x_from + 3
            while dash < x_to:
                pdf.line(dash, y + 2, min(dash + 3, x_to), y + 2)
                dash += 5
    # Many small digits elsewhere on the page (e.g. lyrics or bar numbers) must not
    # influence which digits are accepted as frets.
    pdf.setFont("Helvetica", 4)
    for i in range(measure_number_noise):
        pdf.drawString(60 + (i % 40) * 12, 60 + (i // 40) * 10, str(i % 10))
    pdf.save()
    return _music_font(buffer.getvalue()) if music else buffer.getvalue()


def chord_tab_pdf(measures: list[list[list[tuple[int, int]]]], font_size: float = 9.5) -> bytes:
    """One tab staff of chords printed as some songbooks do: digits as tall as the space between
    the strings, the line blanked behind each, so in a small picture the digits of a chord touch
    one above the other. Each measure is a list of chords, each a list of (string, fret)."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    spacing, x0, x1, top = 7.0, 60.0, 540.0, A4[1] - 120
    for s in range(6):
        pdf.line(x0, top - s * spacing, x1, top - s * spacing)
    width = (x1 - x0) / len(measures)
    for m in range(len(measures) + 1):
        pdf.line(x0 + m * width, top, x0 + m * width, top - 5 * spacing)
    pdf.setFont("Helvetica", font_size)
    for m, chords in enumerate(measures):
        step = width / (len(chords) + 1)
        for c, chord in enumerate(chords):
            x = x0 + m * width + step * (c + 1)
            for string, fret in chord:
                y = top - (string - 1) * spacing
                half = pdf.stringWidth(str(fret), "Helvetica", font_size) / 2 + 0.4
                pdf.setFillColorRGB(1, 1, 1)
                pdf.rect(x - half, y - spacing / 2, 2 * half, spacing, stroke=0, fill=1)
                pdf.setFillColorRGB(0, 0, 0)
                pdf.drawCentredString(x, y - 0.36 * font_size, str(fret))
    pdf.save()
    return buffer.getvalue()


def songbook_tab_pdf(measures: list[list[tuple]], font_size: float = 9.5) -> bytes:
    """One tab staff of chords with the rhythm a tab book prints: each stem drawn from just under
    the lowest digit down 2.5 spaces (so stems end at different heights), a lone 8th's flag rising
    from the stem's end back up beside it, 8ths in a row beamed at the shortest one's end, and an
    8th rest (a dot with a tail) between the middle lines. Each measure is a list of items:
    ("4" | "8" | "8f" | "2", [(string, fret), ...]) — a quarter, a beamed 8th, a flagged 8th, a half
    note (its numbers ringed) — or ("r8",), or ("2t",): a half note tied over, an empty ring with a
    stem. Digits as tall as the space between the strings, as chord_tab_pdf."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    spacing, x0, x1, top = 7.0, 60.0, 540.0, A4[1] - 120
    bottom = top - 5 * spacing
    for s in range(6):
        pdf.line(x0, top - s * spacing, x1, top - s * spacing)
    width = (x1 - x0) / len(measures)
    for m in range(len(measures) + 1):
        pdf.line(x0 + m * width, top, x0 + m * width, bottom)
    for m, items in enumerate(measures):
        step = width / (len(items) + 1)
        xs = [x0 + m * width + step * (i + 1) for i in range(len(items))]
        ends: list[float | None] = []
        for x, item in zip(xs, items, strict=True):
            if item[0] == "2t":
                ends.append(None)
                continue
            if item[0] == "r8":
                y = top - 2.3 * spacing
                pdf.circle(x - 0.2 * spacing, y, 0.18 * spacing, stroke=0, fill=1)
                pdf.setLineWidth(0.9)
                pdf.line(x - 0.2 * spacing, y, x + 0.45 * spacing, y + 0.05 * spacing)
                pdf.line(x + 0.45 * spacing, y + 0.05 * spacing, x - 0.05 * spacing, y - 1.0 * spacing)
                pdf.setLineWidth(1)
                ends.append(None)
                continue
            pdf.setFont("Helvetica", font_size)
            for string, fret in item[1]:
                y = top - (string - 1) * spacing
                half = pdf.stringWidth(str(fret), "Helvetica", font_size) / 2 + 0.4
                pdf.setFillColorRGB(1, 1, 1)
                pdf.rect(x - half, y - spacing / 2, 2 * half, spacing, stroke=0, fill=1)
                pdf.setFillColorRGB(0, 0, 0)
                pdf.drawCentredString(x, y - 0.36 * font_size, str(fret))
            lowest = top - (max(string for string, _ in item[1]) - 1) * spacing
            if item[0] == "2":
                lowest = bottom + 0.2 * spacing  # the stem hangs from the ring
            ends.append(lowest - 0.5 * spacing - 2.5 * spacing)
        for x, item in zip(xs, items, strict=True):  # rings over the numbers' blanked lines
            if item[0] in ("2", "2t"):
                pdf.setLineWidth(2.0)
                pdf.ellipse(
                    x - 1.1 * spacing, bottom - 0.6 * spacing, x + 1.1 * spacing, top + 0.75 * spacing, stroke=1, fill=0
                )
                pdf.setLineWidth(1)
                if item[0] == "2t":
                    pdf.setLineWidth(0.6)
                    pdf.line(x - 1.1 * spacing, bottom, x - 1.1 * spacing, bottom - 2.5 * spacing)
                    pdf.setLineWidth(1)
        beamed = [i for i, item in enumerate(items) if item[0] == "8"]
        beam_y = min((ends[i] for i in beamed), default=None)
        for i, (x, item, end) in enumerate(zip(xs, items, ends, strict=True)):
            if end is None:
                continue
            lowest = top - (max(string for string, _ in item[1]) - 1) * spacing
            if item[0] == "2":
                lowest = bottom + 0.2 * spacing
            stem_end = beam_y if item[0] == "8" else end
            pdf.setLineWidth(0.6)
            pdf.line(x, lowest - 0.5 * spacing, x, stem_end)
            pdf.setLineWidth(1)
            if item[0] == "8f":
                path = pdf.beginPath()
                path.moveTo(x, stem_end)
                path.curveTo(
                    x + 0.5 * spacing,
                    stem_end + 0.4 * spacing,
                    x + 0.65 * spacing,
                    stem_end + 0.8 * spacing,
                    x + 0.6 * spacing,
                    stem_end + 1.2 * spacing,
                )
                pdf.setLineWidth(1.4)
                pdf.drawPath(path, stroke=1, fill=0)
                pdf.setLineWidth(1)
        if len(beamed) >= 2:
            pdf.rect(xs[beamed[0]], beam_y, xs[beamed[-1]] - xs[beamed[0]], 0.35 * spacing, stroke=0, fill=1)
    pdf.save()
    return buffer.getvalue()


def rhythm_tab_pdf(measures: list[list[tuple]], strings: int = 6) -> bytes:
    """One tab staff with rhythm drawn under it, as MuseScore prints "tab with stems".

    Each measure is a list of ("4" | "8" | "8." | "16", string, fret) notes and ("r2",) half
    rests, one slot each. Stems start 2/3 of a space under the staff and end 2.54 spaces under
    it; 8ths and 16ths next to each other are beamed (a lone 16th gets a partial beam towards
    the note before it); a dotted note has its dot right of the stem; a half rest is a block
    sitting on the middle line.
    """
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    spacing, x0, x1, top = 7.0, 60.0, 540.0, A4[1] - 120
    bottom = top - (strings - 1) * spacing
    stem_top, stem_end = bottom - 0.67 * spacing, bottom - 2.54 * spacing
    beam = 0.35 * spacing
    width = (x1 - x0) / len(measures)
    for s in range(strings):
        pdf.line(x0, top - s * spacing, x1, top - s * spacing)
    for m in range(len(measures) + 1):
        pdf.line(x0 + m * width, top, x0 + m * width, bottom)
    for m, items in enumerate(measures):
        step = width / (len(items) + 1)
        xs = [x0 + m * width + step * (k + 0.5) + 4 for k in range(len(items))]
        group: list[int] = []  # beamed notes in a row
        for k, item in enumerate(items + [("end",)]):
            beamed = item[0] in ("8", "8.", "16")
            if not beamed and len(group) >= 2:
                pdf.rect(xs[group[0]], stem_end, xs[group[-1]] - xs[group[0]], beam, stroke=0, fill=1)
                for i, j in enumerate(group):
                    if items[j][0] != "16":
                        continue
                    nxt = i + 1 < len(group) and items[group[i + 1]][0] == "16"
                    prev = i > 0 and items[group[i - 1]][0] == "16"
                    if nxt:
                        pdf.rect(xs[j], stem_end + 2 * beam, xs[group[i + 1]] - xs[j], beam, stroke=0, fill=1)
                    elif not prev:
                        pdf.rect(xs[j] - 1.2 * spacing, stem_end + 2 * beam, 1.2 * spacing, beam, stroke=0, fill=1)
            group = group + [k] if beamed else []
            if item[0] == "end":
                break
            if item[0] == "r2":
                middle = top - (strings // 2 - 1) * spacing
                pdf.rect(xs[k] - 0.45 * spacing, middle, 0.9 * spacing, 0.42 * spacing, stroke=0, fill=1)
                continue
            duration, string, fret = item
            y = top - (string - 1) * spacing
            pdf.setFillColorRGB(1, 1, 1)
            half = pdf.stringWidth(str(fret), "Helvetica", 7) / 2 + 0.6
            pdf.rect(xs[k] - half, y - 3, 2 * half, 6, stroke=0, fill=1)
            pdf.setFillColorRGB(0, 0, 0)
            pdf.setFont("Helvetica", 7)
            pdf.drawCentredString(xs[k], y - 2.5, str(fret))
            pdf.setLineWidth(0.6)
            pdf.line(xs[k], stem_top, xs[k], stem_end)
            pdf.setLineWidth(1)
            if duration.endswith("."):
                pdf.circle(xs[k] + 0.5 * spacing, (stem_top + stem_end) / 2, 0.15 * spacing, stroke=0, fill=1)
    pdf.save()
    return buffer.getvalue()


def labelled_tab_pdf(labels: list[str], heading_lines: list[str] | None = None) -> bytes:
    """One tab staff with the strings' notes written left of it (as Songsterr prints the tuning),
    the lines starting just after them, and a few frets; ``heading_lines`` printed above it."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    spacing, x0, x1, top = 7.0, 70.0, 540.0, A4[1] - 120
    pdf.setFont("Helvetica", 9)
    for number, line in enumerate(heading_lines or []):
        pdf.drawString(x0, A4[1] - 40 - 11 * number, line)
    for index, label in enumerate(labels):
        y = top - index * spacing
        pdf.line(x0, y, x1, y)
        pdf.setFont("Helvetica", 6)
        pdf.drawRightString(x0 - 4, y - 2.1, label)
    pdf.line(x1, top, x1, top - (len(labels) - 1) * spacing)
    pdf.setFont("Helvetica", 7)
    for k, (string, fret) in enumerate([(1, 0), (3, 2), (5, 3), (6, 5)]):
        x, y = x0 + 40 + 60 * k, top - (string - 1) * spacing
        pdf.setFillColorRGB(1, 1, 1)
        pdf.rect(x - 3, y - 3, 6, 6, stroke=0, fill=1)
        pdf.setFillColorRGB(0, 0, 0)
        pdf.drawCentredString(x, y - 2.5, str(fret))
    pdf.save()
    return buffer.getvalue()


def blank_pdf() -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.rect(100, 100, 200, 200, fill=1)
    pdf.save()
    return buffer.getvalue()


def tab_png(pdf: bytes, width: int = 1300, image_format: str = "PNG") -> bytes:
    """Page 1 of ``pdf`` as a picture, like a screenshot of the tab."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(pdf)
    page = document[0]
    image = page.render(scale=width / page.get_size()[0]).to_pil().convert("RGB")
    document.close()
    buffer = io.BytesIO()
    image.save(buffer, format=image_format)
    return buffer.getvalue()


def image_pdf(pictures: list[bytes], text: tuple[str, str] | None = None) -> bytes:
    """A PDF whose pages are only pictures: a scan, or a web page printed to PDF. ``text`` is a
    title and artist written as text over page 1, as a printed web page has them."""
    from reportlab.lib.utils import ImageReader

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    for number, picture in enumerate(pictures):
        pdf.drawImage(ImageReader(io.BytesIO(picture)), 0, 0, *A4)
        if text and number == 0:
            pdf.setFont("Helvetica", 22)
            pdf.drawCentredString(A4[0] / 2, A4[1] - 45, text[0])
            pdf.setFont("Helvetica", 12)
            pdf.drawCentredString(A4[0] / 2, A4[1] - 63, text[1])
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


# The one staff of tests/fixtures/single-page.png, a string per row (high e first).
SINGLE_PAGE_FRETS = [
    ["--0---3---5---7--|", "--1---3---5---8--|", "--0---4---5---7--|"]
    + ["--2---5---7---9--|", "--3---5---7--10--|", "--0---3---5---8--|"]
]


def smoke_page(title: str, heading: str, systems: list[list[str]], font) -> Image.Image:
    """A 1600×1050 page of the smoke fixtures (scripts/generate_smoke_fixtures.py): ``title`` and a
    smaller ``heading`` line, then each system of ``systems`` as six labelled strings with its frets
    typed over them. ``font(size)`` gives the font at a pixel size. The staff is drawn big and the
    heading small, so the page read at the staff's scale leaves the heading only a few pixels tall."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1600, 1050), "white")
    draw = ImageDraw.Draw(image)
    draw.text((90, 55), title, fill="#111111", font=font(44))
    draw.text((90, 120), heading, fill="#444444", font=font(25))
    tab_font = font(38)
    y = 235
    for system in systems:
        for row, label in enumerate(("e", "B", "G", "D", "A", "E")):
            baseline = y + row * 55
            draw.text((60, baseline - 25), label, fill="#111111", font=font(25))
            draw.line((105, baseline, 1520, baseline), fill="#151515", width=3)
            draw.line((105, baseline - 22, 105, baseline + 22), fill="#151515", width=3)
            draw.text((135, baseline - 25), system[row], fill="#050505", font=tab_font)
        y += 395
    return image


def small_heading_png(line: str) -> bytes:
    """tests/fixtures/single-page.png with ``line`` as its heading line, drawn in Pillow's own font
    (ImageFont.load_default at a size): it ships with Pillow, so with the pinned Pillow the pixels
    are the same on every system — the fixture itself takes whatever font the machine that made it
    had (DejaVu Sans, Arial)."""
    from PIL import ImageFont

    image = smoke_page("Smoke 1 · single page", line, SINGLE_PAGE_FRETS, ImageFont.load_default)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
