import pytest

from recognizer.tunings import TUNINGS, match_labels, resolve_tuning


@pytest.mark.parametrize(
    ("labels", "expected"),
    [
        (["e", "B", "G", "D", "A", "E"], "standard"),
        (["E", "B", "G", "D", "A", "D"], "drop_d"),
        (["Eb", "Bb", "Gb", "Db", "Ab", "Eb"], "eb_standard"),
        (["D", "A", "G", "D", "A", "D"], "dadgad"),
        (["G", "D", "A", "E"], "bass_4"),
        (["e", "B", "G", "D", "A", "E", "B"], "standard_7"),
        (["X", "B", "G", "D", "A", "E"], None),
    ],
)
def test_match_labels(labels, expected):
    assert match_labels(labels) == expected


def test_resolve_uses_labels_then_default():
    drop_d = resolve_tuning("auto", 6, ["e", "B", "G", "D", "A", "D"])
    assert (drop_d.midi, drop_d.warnings, drop_d.source) == (list(TUNINGS["drop_d"]), [], "detected")
    unknown = resolve_tuning("auto", 6, ["q"] * 6)
    assert unknown.midi == list(TUNINGS["standard"]) and unknown.warnings
    assert (unknown.source, unknown.reason, unknown.raw) == ("default", "unrecognized", "q q q q q q")
    nothing = resolve_tuning("auto", 6, [])
    assert (nothing.source, nothing.reason, nothing.warnings) == ("default", "not_found", [])


def test_resolve_mismatched_string_count_falls_back():
    choice = resolve_tuning("standard", 4, [])
    assert choice.midi == list(TUNINGS["bass_4"]) and choice.warnings
    assert (choice.source, choice.reason) == ("default", "string_count_mismatch")
