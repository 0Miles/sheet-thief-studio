"""An override of the tempo / time signature replaces only the opening printed mark: changes later in the song stay."""

import pytest

from recognizer.converter import ConversionOptions, convert
from tests.pdf_factory import ascii_tab_pdf, engraved_tab_pdf, tab_png
from tests.test_raster import _signature_picture, _signatures

BAR = [(1, 0), (2, 3), (3, 5), (1, 2)]
LINES = [[BAR, BAR], [BAR, BAR], [BAR, BAR]]


def _tempo_tab(opening: int | None = None) -> bytes:
    """Three lines of engraved tab with a "= 140" tempo mark over the first bar of the third line,
    and an ``opening`` one over the first bar of the song."""
    words = [(0, 70.0, f"= {opening}", "Helvetica", 9)] if opening else []
    return engraved_tab_pdf(LINES, knockout=True, words=[*words, (2, 70.0, "= 140", "Helvetica", 9)])


def test_user_tempo_keeps_a_tempo_change_later_in_the_song():
    report = convert(_tempo_tab(), ConversionOptions(tempo=100)).report
    assert report["tempo"] == 100
    assert report["tempo_changes"] == [{"bar": 5, "tempo": 140}]


def test_user_tempo_keeps_a_tempo_change_in_the_second_bar():
    pdf = engraved_tab_pdf(LINES, knockout=True, words=[(0, 310.0, "= 140", "Helvetica", 9)])
    assert convert(pdf, ConversionOptions(tempo=100)).report["tempo_changes"] == [{"bar": 2, "tempo": 140}]


def test_user_tempo_replaces_the_opening_mark_after_an_ignored_staff():
    # a 4-string line among 6-string ones is left out of the track: the opening bar is the next line's
    bass = ["G|-------------|", "D|-------------|", "A|-3---5---7---|", "E|-------------|"]
    guitar = ["e|-0---3-|-5---5-|", "B|--1----|-------|", *(f"{name}|-------|-------|" for name in "GDAE")]
    pdf = ascii_tab_pdf([bass, ["= 96", *guitar], guitar, guitar])
    assert convert(pdf, ConversionOptions(tempo=100)).report["tempo_changes"] == []


def test_user_tempo_replaces_the_opening_mark_after_a_double_bar_line():
    # "||" at the start of the line: the sliver between its two bar lines is no bar, the mark after it is bar 1's
    guitar = ["e||-0---3-|-5---5-|", "B||--1----|-------|", *(f"{name}||-------|-------|" for name in "GDAE")]
    pdf = ascii_tab_pdf([["   = 96", *guitar], guitar])
    assert convert(pdf, ConversionOptions(tempo=100)).report["tempo_changes"] == []


def test_user_tempo_replaces_the_opening_tempo_mark():
    report = convert(_tempo_tab(opening=96), ConversionOptions(tempo=100)).report
    assert report["tempo"] == 100
    assert report["tempo_changes"] == [{"bar": 5, "tempo": 140}]


@pytest.mark.ocr
def test_user_time_signature_keeps_a_change_on_a_later_line():
    lines = [LINES[0], LINES[1]]
    picture = tab_png(engraved_tab_pdf(lines, knockout=True, signatures=[(1, 0, 3, 4)]))
    result = convert(picture, ConversionOptions(numerator=4, denominator=4))
    assert result.report["time_signature"] == "4/4"
    assert result.report["time_signature_changes"] == [{"bar": 3, "time_signature": "3/4"}]
    assert _signatures(result)[:4] == [(4, 4), (4, 4), (3, 4), (3, 4)]


@pytest.mark.ocr
def test_user_time_signature_keeps_a_change_in_the_second_bar():
    result = convert(_signature_picture([(0, 1, 3, 4)]), ConversionOptions(numerator=4, denominator=4))
    assert result.report["time_signature_changes"] == [{"bar": 2, "time_signature": "3/4"}]
    assert _signatures(result)[:3] == [(4, 4), (3, 4), (3, 4)]


@pytest.mark.ocr
def test_user_time_signature_replaces_the_opening_one():
    result = convert(_signature_picture([(0, 0, 3, 4)]), ConversionOptions(numerator=4, denominator=4))
    assert result.report["time_signature"] == "4/4"
    assert result.report["time_signature_changes"] == []
    assert _signatures(result)[:3] == [(4, 4), (4, 4), (4, 4)]
