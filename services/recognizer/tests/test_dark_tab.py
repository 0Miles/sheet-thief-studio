"""Public converter regressions using synthetic, project-owned tablature."""

import io

import pytest
from PIL import Image, ImageOps

from recognizer.converter import ConversionError, ConversionOptions, convert
from tests import scores
from tests.pdf_factory import engraved_tab_pdf, image_pdf, tab_png


def tab_picture(*, dark=False):
    picture = Image.open(io.BytesIO(tab_png(engraved_tab_pdf([[[(1, 0), (2, 12)], [(3, 5), (6, 3)]]], knockout=True))))
    if dark:
        picture = ImageOps.invert(picture.convert("RGB"))
    output = io.BytesIO()
    picture.save(output, "PNG")
    return output.getvalue()


def frets(result):
    return [(note.string, note.fret) for _, note in scores.notes(result, by_string=True) if not note.tie]


@pytest.mark.parametrize("dark", [False, True])
def test_tab_polarity_preserves_notes(dark):
    result = convert(tab_picture(dark=dark), ConversionOptions())
    assert frets(result) == [(1, 0), (2, 12), (3, 5), (6, 3)]
    assert result.report["measures"] == 2
    assert result.report["tracks"][0]["sources"] == ["image"]


@pytest.mark.parametrize("dark", [False, True])
def test_transparent_tab_preserves_visible_ink(dark):
    picture = Image.open(io.BytesIO(tab_picture())).convert("L")
    ink = ImageOps.invert(picture)
    transparent = Image.new("RGBA", picture.size, "white" if dark else "black")
    transparent.putalpha(ink)
    output = io.BytesIO()
    transparent.save(output, "PNG")
    assert frets(convert(output.getvalue(), ConversionOptions())) == [(1, 0), (2, 12), (3, 5), (6, 3)]


def test_partial_image_pdf_identifies_every_failed_page():
    blank = io.BytesIO()
    Image.new("RGB", (500, 400), "white").save(blank, "PNG")
    pdf = image_pdf([blank.getvalue(), tab_picture(dark=True), blank.getvalue()])
    with pytest.raises(ConversionError) as error:
        convert(pdf, ConversionOptions(require_all_image_pages=True))
    assert error.value.diagnostics == [{"page": 1, "code": "no_staff"}, {"page": 3, "code": "no_staff"}]
