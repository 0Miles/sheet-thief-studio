"""A tuning named on a "Tuning:" line with a note after the name (docs/spec/recognizer.md, section 6)."""

import pytest

from recognizer.extract.metadata import _read_tuning, detect_metadata
from recognizer.extract.pdf_reader import Char, Page

STANDARD = ("E", "B", "G", "D", "A", "E")  # string 1 (highest) first
DROP_D = ("E", "B", "G", "D", "A", "D")
HALF_STEP_DOWN = ("D#", "A#", "F#", "C#", "G#", "D#")


@pytest.mark.parametrize(
    ("value", "labels"),
    [
        ("Standard (E A D G B E)", STANDARD),
        ("Standard - E A D G B E", STANDARD),
        ("Standard - EADGBE", STANDARD),
        ("Standard [E A D G B E]", STANDARD),
        ("Standard (low to high: E A D G B E)", STANDARD),
        ("Standard (high to low: E B G D A E)", STANDARD),
        ("Standard (E B G D A E)", STANDARD),
        ("Drop D: D A D G B E", DROP_D),
        ("Drop D (D A D G B E)", DROP_D),
        ("Half step down - Eb Ab Db Gb Bb Eb", HALF_STEP_DOWN),
        ("Standard - No capo", STANDARD),
        ("Standard - capo 2", STANDARD),
        ("Standard (E A D G B E) - capo 2", STANDARD),
        ("Drop D - Key: D", DROP_D),
        ("Standard (key of E minor)", STANDARD),
        ("Standard (A = 440)", STANDARD),
        ("Standard (A = 432 Hz)", STANDARD),
    ],
)
def test_a_note_in_the_whitelist_reads_the_named_tuning(value, labels):
    assert _read_tuning([f"Tuning: {value}"]) == (labels, None)


def test_notes_that_disagree_with_the_name_win_with_their_number_of_strings():
    assert _read_tuning(["Tuning: Standard (D A D G B E)"]) == (DROP_D, None)
    assert _read_tuning(["Tuning: Standard (E A D G)"]) == (("G", "D", "A", "E"), None)  # four strings, E lowest
    # in the order labelled
    assert _read_tuning(["Tuning: Standard (high to low: E B G D A D)"]) == (DROP_D, None)
    assert _read_tuning(["Tuning: Standard (high to low: E A D G B E)"]) == (("E", "A", "D", "G", "B", "E"), None)


@pytest.mark.parametrize(
    "value",
    [
        "Standard (Eb)",
        "Standard, down 1/2 step",
        "Standard - drop d",
        "Standard - 1/2 below",
        "Standard - lowered 1/2",
        "Standard - DADGAD on the intro",
        "Drop D - drop c on song 2",
        "Standard - Nashville tuning",
        "Drop D (D A D G B E) down a whole step",
        "Standard (E A D G B E) half step down",
        "Standard tuning",
        "Standardized",
    ],
)
def test_anything_outside_the_whitelist_is_unrecognized_and_kept_as_printed(value):
    assert _read_tuning([f"Tuning: {value}"]) == ((), value)


def test_only_a_labelled_line_reads_a_note_after_the_name():
    assert _read_tuning(["Tuning Standard (E A D G B E)"]) == ((), None)  # a sentence, not a label
    assert _read_tuning(["Tuning - Standard (E A D G B E)"]) == (STANDARD, None)


def test_no_capo_on_the_tuning_line_is_also_read_as_capo_0():
    line = "Tuning: Standard - No capo"
    page = Page(1, 600, 800, [Char(ch, 50 + 6 * i, 56 + 6 * i, 40, 50) for i, ch in enumerate(line)], [])
    meta = detect_metadata([page])
    assert (meta.tuning_labels, meta.tuning_raw, meta.capo) == (STANDARD, None, 0)
