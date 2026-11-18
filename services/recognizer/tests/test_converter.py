"""End-to-end conversions through the converter (formerly exercised via the legacy /api/convert)."""

import pytest

from recognizer.converter import ConversionError, ConversionOptions, TrackOptions, convert_many, inspect
from tests import scores
from tests.pdf_factory import ascii_tab_pdf, blank_pdf, engraved_tab_pdf, tab_png

TAB = [
    "e|-0---3---5h7---|",
    "B|---------------|",
    "G|---------------|",
    "D|---------------|",
    "A|---------------|",
    "E|---------------|",
]
BASS = ["G|-------------|", "D|-------------|", "A|-3---5---7---|", "E|-------------|"]


def test_convert_with_user_options():
    options = ConversionOptions(title="Riff", tempo=90, tracks=(TrackOptions(filename="a.pdf", tuning="drop_d"),))
    result = convert_many([ascii_tab_pdf([TAB])], options)
    assert result.report["measures"] == 1 and result.report["notes"] == 4
    assert result.report["title"] == "Riff" and result.report["tempo"] == 90
    assert result.scores[0].tuning[5] == 38


def test_fixed_rhythm_time_signature_and_instrument():
    options = ConversionOptions(
        numerator=3,
        denominator=4,
        rhythm_mode="fixed",
        fixed_value=8,
        tracks=(TrackOptions(instrument="distortion"),),
    )
    result = convert_many([ascii_tab_pdf([TAB])], options)
    assert scores.signatures(result)[0] == (3, 4)
    assert result.scores[0].instrument == 30


def test_pdf_without_text_or_images_reports_nothing_to_read():
    with pytest.raises(ConversionError, match="nem imagens"):
        convert_many([blank_pdf()], ConversionOptions())


def test_corrupt_pdf_is_a_user_error():
    with pytest.raises(ConversionError):
        convert_many([b"%PDF-1.4\n garbage"], ConversionOptions())


def test_converts_a_picture_of_a_tab():
    png = tab_png(engraved_tab_pdf([[(1, 0), (2, 3)], [(3, 5)]], knockout=True))
    track = convert_many([png], ConversionOptions()).report["tracks"][0]
    assert track["sources"] == ["image"] and track["notes"] == 3


def test_empty_staves_do_not_vote_and_become_rests():
    pdf = engraved_tab_pdf([[[(1, 0)], [(2, 1)]], [[], []]])
    report = convert_many([pdf], ConversionOptions()).report
    assert report["measures"] == 4 and report["warnings"] == []
    assert [d["measures"] for d in report["tracks"][0]["systems_detail"]] == [2, 2]


def test_metadata_is_detected_when_fields_are_left_empty():
    pdf = ascii_tab_pdf([TAB], extra_lines=["Title: Riff Song", "Artist: The Band", "Tempo: 96"])
    report = convert_many([pdf], ConversionOptions()).report
    assert (report["title"], report["artist"], report["tempo"]) == ("Riff Song", "The Band", 96)
    assert report["auto"] == {"title": True, "artist": True, "tempo": True, "time_signature": False}
    assert report["time_signature"] == "4/4"


def test_user_values_override_detection():
    pdf = ascii_tab_pdf([TAB], extra_lines=["Title: Riff Song", "Tempo: 96"])
    options = ConversionOptions(title="Mine", tempo=140, numerator=3, denominator=4)
    report = convert_many([pdf], options).report
    assert (report["title"], report["tempo"], report["time_signature"]) == ("Mine", 140, "3/4")


def test_inspect_returns_detected_metadata_only():
    pdf = ascii_tab_pdf([TAB], extra_lines=["Title: Riff Song", "Artist: The Band", "Tempo: 96"])
    assert inspect(pdf, ConversionOptions()) == {
        "title": "Riff Song",
        "artist": "The Band",
        "tempo": 96,
        "time_signature": None,
        "part_name": None,
        "strings": 6,
        "tuning": "standard",
    }


def test_multi_track_song():
    guitar = ascii_tab_pdf([TAB, TAB], extra_lines=["Title: Riff Song", "Tempo: 100"])
    bass = ascii_tab_pdf([[line.replace("|", "|--", 1) for line in BASS]])
    options = ConversionOptions(
        tracks=(TrackOptions(filename="Riff Song - Lead.pdf"), TrackOptions(filename="Riff Song - Bass.pdf"))
    )
    result = convert_many([guitar, bass], options)
    report = result.report
    assert [t["name"] for t in report["tracks"]] == ["Lead", "Bass"]
    assert [t["strings"] for t in report["tracks"]] == [6, 4]
    assert report["measures"] == 2 and report["tempo"] == 100
    assert any("Bass:" in w and "pausa" in w for w in report["warnings"])  # bass padded to 2 bars
    assert [s.name for s in result.scores] == ["Lead", "Bass"]
    assert [len(s.measures) for s in result.scores] == [2, 2]
    assert result.scores[1].instrument == 33


def test_per_track_options():
    pdf = ascii_tab_pdf([TAB])
    options = ConversionOptions(
        tracks=(
            TrackOptions(name="Rhythm", tuning="drop_d", instrument="distortion"),
            TrackOptions(name="Lead", tuning="standard", instrument="clean"),
        )
    )
    tracks = convert_many([pdf, pdf], options).report["tracks"]
    assert [(t["name"], t["tuning"], t["instrument"]) for t in tracks] == [
        ("Rhythm", "drop_d", "distortion"),
        ("Lead", "standard", "clean"),
    ]


def test_too_many_tracks():
    with pytest.raises(ConversionError):
        convert_many([ascii_tab_pdf([TAB])] * 8, ConversionOptions())


def test_error_names_the_failing_track():
    options = ConversionOptions(tracks=(TrackOptions(filename="ok.pdf"), TrackOptions(filename="scan.pdf")))
    with pytest.raises(ConversionError) as caught:
        convert_many([ascii_tab_pdf([TAB]), blank_pdf()], options)
    assert str(caught.value).startswith("Track 2 (scan.pdf):")


def test_parenthesized_repeat_is_written_as_a_tie():
    pdf = ascii_tab_pdf([["e|-0---(0)---0---|", *TAB[1:]]])
    notes = [n for _, n in scores.notes(convert_many([pdf], ConversionOptions()))]
    assert [scores.note_type(n) for n in notes[:3]] == ["normal", "tie", "normal"]
    assert not any(n.ghost for n in notes[:3])


def test_tracks_are_aligned_by_printed_bar_numbers():
    full = engraved_tab_pdf(
        [[[(1, 0)], [(1, 1)], [(1, 2)]], [[(1, 3)], [(1, 4)], [(1, 5)]]], bar_numbers=[[1, 2, 3], [4, 5, 6]]
    )
    # Second track: the line with bars 3-4 was not read, so its bars 5-6 must not slide to 3-4.
    gappy = engraved_tab_pdf([[[(2, 7)], [(2, 7)]], [[(2, 9)], [(2, 9)]]], bar_numbers=[[1, 2], [5, 6]])
    result = convert_many([full, gappy], ConversionOptions())
    report = result.report
    assert report["measures"] == 6
    assert report["tracks"][1]["missing_bars"] == [3, 4]
    assert any("3–4" in w for w in report["warnings"])
    frets = [[n.fret for b in m.beats for n in b.notes] for m in scores.measures(result, 1)]
    assert frets == [[7], [7], [], [], [9], [9]]


def test_eight_string_tab_is_rejected_with_clear_message():
    eight = [*TAB, "B|---------------|", "F#|--------------|"]
    with pytest.raises(ConversionError, match="7"):
        convert_many([ascii_tab_pdf([eight])], ConversionOptions())


def test_huge_printed_bar_number_does_not_create_rest_bars():
    pdf = engraved_tab_pdf([[[(1, 0)], [(1, 2)]]], bar_numbers=[[1, 300000]])
    assert convert_many([pdf], ConversionOptions()).report["measures"] == 2
