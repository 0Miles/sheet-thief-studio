"""The capo printed in a picture's heading, read from its lines of text."""

import pytest

from recognizer.extract.metadata import detect_metadata, read_capo
from recognizer.extract.pdf_reader import Char, Page


def test_capo_and_a_number():
    assert read_capo(["Capo 3"]) == (3, None, ())


@pytest.mark.parametrize(
    ("text", "capo"),
    [
        ("Capo: 2", 2),
        ("CAPO - 5", 5),
        ("capo on 4", 4),
        ("Capo at 7", 7),
        ("Capo 3rd fret", 3),
        ("Capo on the 1st fret", 1),
        ("Capo: 2nd fret", 2),
        ("capo fret 6", 6),
        ("Tuning: Standard, Capo 2 (sounds a tone higher)", 2),
    ],
)
def test_the_ways_a_capo_is_written(text, capo):
    assert read_capo([text]).detected == capo


@pytest.mark.parametrize(
    ("text", "capo"),
    [("Capo: III", 3), ("Capo IV", 4), ("capo on VII.", 7), ("Capo XII", 12), ("Capo I", 1), ("Capo IX fret", 9)],
)
def test_a_capo_in_roman_numerals(text, capo):
    assert read_capo([text]).detected == capo


@pytest.mark.parametrize(
    "text", ["Capo Island", "Capo XIII", "Capo Illinois", "Capo II3", "capo in E", "Capo Vibes", "Capo lI", "Capo iv"]
)
def test_roman_numerals_only_as_a_word_of_their_own(text):
    assert read_capo([text]) == (None, None, ())


@pytest.mark.parametrize(("text", "capo"), [("Capo:I lI", 3), ("Capo I ll", 3), ("Capo: Xll", 12), ("Capo: Il", 2)])
def test_roman_numerals_as_text_recognition_reads_them(text, capo):
    # in a sans-serif font "I" and "l" look the same, and the recogniser may split the numeral
    assert read_capo([text]).detected == capo


@pytest.mark.parametrize(
    ("text", "capo"),
    [("Capotraste: 2", 2), ("Capotraste na 3ª casa", 3), ("capotraste na casa 5", 5), ("Capotraste IV", 4)],
)
def test_capotraste_in_portuguese(text, capo):
    assert read_capo([text]).detected == capo


@pytest.mark.parametrize("text", ["Capo 0", "No capo", "NO CAPO", "Played without capo", "Tuning: Drop D (no capo)"])
def test_no_capo_printed_is_detected_as_zero(text):
    assert read_capo([text]) == (0, None, ())


@pytest.mark.parametrize(
    "text",
    [
        "Da Capo",
        "Da Capo al Fine",
        "D.C. al Coda",
        "D.C. al Fine",
        "Capo al Fine",
        "capo al coda 2",
        "Da Capo II",
        "DA CAPO 2",
    ],
)
def test_repeat_signs_are_not_a_capo(text):
    assert read_capo([text]) == (None, None, ())


def test_the_first_capo_printed_wins_and_the_others_are_kept():
    assert read_capo(["Capo 2", "Tuning: Standard", "capo 5 (live)", "Capo II", "Capo: 7th fret"]) == (2, None, (5, 7))
    assert read_capo(["No capo", "Capo 0", "Capo 3 for the solo"]) == (0, None, (3,))


@pytest.mark.parametrize(("text", "raw"), [("Capo 30", "Capo 30"), ("capo on 25th fret", "capo on 25th fret")])
def test_a_capo_out_of_range_is_kept_as_printed_and_not_used(text, raw):
    assert read_capo([text]) == (None, raw, ())


def test_a_capo_in_range_wins_over_one_out_of_range():
    assert read_capo(["Capo 99", "Capo 4"]) == (4, None, ())
    assert read_capo(["Capo 24"]) == (24, None, ())


@pytest.mark.parametrize(("text", "capo"), [("Capo3", 3), ("CAPO2nd fret", 2), ("Capo:4", 4), ("Capo-5", 5)])
def test_a_number_right_after_the_word(text, capo):
    # text recognition and PDFs without spaces can join the number to the word
    assert read_capo([text]).detected == capo


@pytest.mark.parametrize(("text", "capo"), [("no capotraste na 2ª casa", 2), ("Capo V I", 5), ("Capo I am", 1)])
def test_separate_words_are_not_joined_into_one_reading(text, capo):
    assert read_capo([text]).detected == capo


def test_a_negative_capo_is_out_of_range():
    assert read_capo(["Capo -1"]) == (None, "Capo -1", ())


def _page(lines: list[tuple[str, float]]) -> Page:
    """Lines of text at these heights (from the top) on an 800-high page."""
    chars = [Char(ch, 50 + 6 * i, 56 + 6 * i, top, top + 10) for text, top in lines for i, ch in enumerate(text)]
    return Page(1, 600, 800, chars, [])


def test_only_the_heading_of_page_1_is_read():
    page = _page([("Capo 2", 400)])  # half way down: the page body
    assert detect_metadata([page]).capo is None
    # the text read above the first staff of a picture is all heading, however tall
    assert detect_metadata([page], heading_only=True).capo == 2
    assert detect_metadata([_page([("Capo 3", 40), ("Capo 2", 400)])]).capo_alternatives == ()
