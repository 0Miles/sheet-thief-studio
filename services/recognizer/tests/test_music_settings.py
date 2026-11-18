"""Recognition reports, for each music setting, what the picture says and where the value used came from."""

from pathlib import Path

import pytest

from recognizer.converter import ConversionOptions, TrackOptions, convert, convert_many
from recognizer.sandbox import images_pdf
from tests import scores
from tests.pdf_factory import engraved_tab_pdf, labelled_tab_pdf, small_heading_png, tab_png
from tests.test_raster import _signature_picture, _signatures

BAR = [(1, 0), (2, 3), (3, 5), (1, 2)]
LINES = [[BAR, BAR], [BAR, BAR]]


def _settings(pdf: bytes, options: ConversionOptions | None = None) -> dict:
    return convert(pdf, options or ConversionOptions()).report["settings"]


def test_automatic_tempo_takes_the_heading_mark():
    tempo = _settings(engraved_tab_pdf(LINES, knockout=True, heading=("Song", "Artist", 90)))["tempo"]
    assert tempo == {
        "detected": 90,
        "effective": 90,
        "source": "detected",
        "reason": None,
        "raw": None,
        "alternatives": [],
    }


def test_overriding_only_the_tempo_keeps_the_other_settings_automatic():
    pdf = engraved_tab_pdf(LINES, knockout=True, heading=("Song", "Artist", 90), heading_lines=["Tuning: Drop D"])
    settings = _settings(pdf, ConversionOptions(tempo=100))
    assert settings["tempo"] == {
        "detected": 90,
        "effective": 100,
        "source": "manual",
        "reason": None,
        "raw": None,
        "alternatives": [],
    }
    assert settings["tuning"]["source"] == "detected"
    assert settings["tuning"]["effective"] == {"name": "drop_d", "midi": [64, 59, 55, 50, 45, 38]}


def test_without_any_mark_every_setting_says_which_default_it_used():
    settings = _settings(engraved_tab_pdf(LINES, knockout=True))
    assert {name: (item["effective"], item["source"], item["reason"]) for name, item in settings.items()} == {
        "tempo": (120, "default", "not_found"),
        "time_signature": ("4/4", "default", "not_found"),
        "tuning": ({"name": "standard", "midi": [64, 59, 55, 50, 45, 40]}, "default", "not_found"),
        "capo": (0, "default", "not_found"),
    }
    assert all(item["detected"] is None and item["raw"] is None for item in settings.values())


def test_a_tempo_out_of_range_is_reported_as_read_and_not_used():
    tempo = _settings(engraved_tab_pdf(LINES, knockout=True, heading_lines=["Tempo: 1200"]))["tempo"]
    assert tempo == {
        "detected": None,
        "effective": 120,
        "source": "default",
        "reason": "out_of_range",
        "raw": "1200",
        "alternatives": [],
    }


def _capo(pdf: bytes, override: int | None = None) -> tuple[dict, int]:
    """The capo setting reported, and the capo of the score."""
    result = convert(pdf, ConversionOptions(tracks=(TrackOptions(capo=override),)))
    return result.report["settings"]["capo"], scores.capos(result)[0]


def test_automatic_capo_takes_the_heading_mark():
    pdf = engraved_tab_pdf(LINES, knockout=True, heading=("Song", "Artist", 90), heading_lines=["Capo: III"])
    assert _capo(pdf) == (
        {"detected": 3, "effective": 3, "source": "detected", "reason": None, "raw": None, "alternatives": []},
        3,
    )


def test_no_capo_printed_is_detected_as_no_capo():
    capo, written = _capo(engraved_tab_pdf(LINES, knockout=True, heading_lines=["Tuning: E A D G B E", "No capo"]))
    assert (capo["detected"], capo["effective"], capo["source"], capo["reason"], written) == (0, 0, "detected", None, 0)


def test_a_manual_capo_is_written_and_still_reports_the_heading_mark():
    pdf = engraved_tab_pdf(LINES, knockout=True, heading_lines=["Capo 3"])
    capo, written = _capo(pdf, override=0)
    assert (capo["detected"], capo["effective"], capo["source"], written) == (3, 0, "manual", 0)
    capo, written = _capo(engraved_tab_pdf(LINES, knockout=True), override=5)
    assert (capo["detected"], capo["effective"], capo["source"], written) == (None, 5, "manual", 5)


def test_a_capo_out_of_range_is_reported_as_printed_and_not_used():
    assert _capo(engraved_tab_pdf(LINES, knockout=True, heading_lines=["Capo 30"])) == (
        {
            "detected": None,
            "effective": 0,
            "source": "default",
            "reason": "out_of_range",
            "raw": "Capo 30",
            "alternatives": [],
        },
        0,
    )


def test_a_capo_out_of_range_printed_first_gives_way_to_one_in_range():
    # as for the tempo: a reading out of range is skipped when one in range is printed too
    capo, written = _capo(engraved_tab_pdf(LINES, knockout=True, heading_lines=["Capo 99", "Capo 4"]))
    assert (capo["detected"], capo["source"], capo["raw"], written) == (4, "detected", None, 4)
    assert capo["alternatives"] == []


def test_repeat_signs_in_the_heading_are_no_capo():
    capo, written = _capo(engraved_tab_pdf(LINES, knockout=True, heading_lines=["Da Capo al Fine", "D.C. al Coda"]))
    assert (capo["detected"], capo["source"], capo["reason"], written) == (None, "default", "not_found", 0)


def test_the_first_capo_printed_wins_and_the_others_are_alternatives():
    capo, written = _capo(engraved_tab_pdf(LINES, knockout=True, heading_lines=["Capo 2", "Capo 4 (live version)"]))
    assert (capo["detected"], capo["effective"], capo["alternatives"], written) == (2, 2, ["4"], 2)


def test_a_capo_in_the_page_body_is_not_the_heading_s():
    # a note over the fourth line of tab, well below the heading
    body = [(3, 60, "Capo 2 for the bridge", "Helvetica", 9)]
    capo, written = _capo(engraved_tab_pdf(LINES * 2, knockout=True, words=body))
    assert (capo["detected"], capo["source"], capo["reason"], written) == (None, "default", "not_found", 0)
    capo, written = _capo(engraved_tab_pdf(LINES * 2, knockout=True, words=body, heading_lines=["Capo 4"]))
    assert (capo["detected"], capo["alternatives"], written) == (4, [], 4)


def test_each_part_takes_the_capo_its_own_heading_prints():
    guitar = engraved_tab_pdf(LINES, knockout=True, heading_lines=["Capo 2"])
    other = engraved_tab_pdf(LINES, knockout=True)
    result = convert_many([guitar, other], ConversionOptions())
    assert [track["capo"] for track in result.report["tracks"]] == [2, 0]
    assert scores.capos(result)[:2] == [2, 0]
    assert result.report["settings"]["capo"]["detected"] == 2  # the first part's, as for the tuning


def _tuning(pdf: bytes, requested: str = "auto") -> tuple:
    tuning = _settings(pdf, ConversionOptions(tracks=(TrackOptions(tuning=requested),)))["tuning"]
    return tuning["detected"], tuning["effective"], tuning["source"], tuning["reason"], tuning["raw"]


DROP_D = {"name": "drop_d", "midi": [64, 59, 55, 50, 45, 38]}
STANDARD = {"name": "standard", "midi": [64, 59, 55, 50, 45, 40]}


def test_the_string_names_left_of_the_staff_come_before_the_heading():
    pdf = labelled_tab_pdf(["E", "B", "G", "D", "A", "D"], heading_lines=["Tuning: Open G"])
    assert _tuning(pdf) == (DROP_D, DROP_D, "detected", None, None)


def test_the_heading_tuning_is_used_when_the_staff_has_no_string_names():
    pdf = engraved_tab_pdf(LINES, knockout=True, heading_lines=["Tuning: D A D G B E"])
    assert _tuning(pdf) == (DROP_D, DROP_D, "detected", None, None)


def test_a_tuning_off_the_list_is_detected_as_custom():
    open_c = {"name": "custom", "midi": [64, 60, 55, 48, 43, 36]}
    assert _tuning(labelled_tab_pdf(["E", "C", "G", "C", "G", "C"])) == (open_c, open_c, "detected", None, None)


def test_string_names_that_do_not_fit_the_staff_are_unrecognized():
    pdf = engraved_tab_pdf(LINES, knockout=True, heading_lines=["Tuning: D A D G B"])
    assert _tuning(pdf) == (None, STANDARD, "default", "unrecognized", "D A D G B")
    unreadable = engraved_tab_pdf(LINES, knockout=True, heading_lines=["Tuning: whatever the band uses"])
    assert _tuning(unreadable) == (None, STANDARD, "default", "unrecognized", "whatever the band uses")


def test_an_override_still_reports_the_detected_tuning():
    pdf = labelled_tab_pdf(["E", "B", "G", "D", "A", "D"])
    assert _tuning(pdf, "open_g") == (
        DROP_D,
        {"name": "open_g", "midi": [62, 59, 55, 50, 43, 38]},
        "manual",
        None,
        None,
    )


def test_an_override_with_another_number_of_strings_falls_back_and_says_so():
    bass = {"name": "bass_4", "midi": [43, 38, 33, 28]}
    assert _tuning(labelled_tab_pdf(["G", "D", "A", "E"]), "drop_d") == (
        bass,
        bass,
        "default",
        "string_count_mismatch",
        None,
    )


def test_the_time_signature_on_the_first_bar_wins_over_the_heading():
    pdf = engraved_tab_pdf(LINES, knockout=True, music_signatures=[(0, 0, 3, 4)], heading_signature=(4, 4))
    result = convert(pdf, ConversionOptions())
    assert result.report["settings"]["time_signature"] == {
        "detected": "3/4",
        "effective": "3/4",
        "source": "detected",
        "reason": None,
        "raw": None,
        "alternatives": ["4/4"],
    }
    assert _signatures(result)[0] == (3, 4)


@pytest.mark.ocr
def test_the_time_signature_on_the_first_bar_is_detected():
    signature = _settings(_signature_picture([(0, 0, 3, 4)]))["time_signature"]
    assert (signature["detected"], signature["effective"], signature["source"]) == ("3/4", "3/4", "detected")


@pytest.mark.ocr
def test_an_overridden_time_signature_still_reports_the_one_printed():
    signature = _settings(_signature_picture([(0, 0, 3, 4)]), ConversionOptions(numerator=6, denominator=8))
    assert (signature["time_signature"]["detected"], signature["time_signature"]["effective"]) == ("3/4", "6/8")
    assert signature["time_signature"]["source"] == "manual"


@pytest.mark.ocr
def test_a_time_signature_out_of_range_is_not_written_into_the_score():
    result = convert(_signature_picture([(0, 0, 24, 8)]), ConversionOptions())
    assert result.report["settings"]["time_signature"] == {
        "detected": None,
        "effective": "4/4",
        "source": "default",
        "reason": "out_of_range",
        "raw": "24/8",
        "alternatives": [],
    }
    assert _signatures(result)[0] == (4, 4)


def _as_project_pages(picture: bytes, project: bool) -> bytes:
    """The picture as recognition gets it: alone, or (a project's pictures) composed into a PDF."""
    return images_pdf([picture], ConversionOptions().max_image_pixels) if project else picture


def _capo_picture(heading_lines: list[str]) -> bytes:
    return tab_png(engraved_tab_pdf(LINES, knockout=True, heading=("Song", "Artist", 90), heading_lines=heading_lines))


@pytest.mark.ocr
@pytest.mark.parametrize("project", [False, True], ids=["picture", "project pages"])
def test_the_capo_printed_over_a_picture_is_written_into_the_score(project):
    picture = _capo_picture(["Tuning: Drop D", "Capo 3"])
    capo, written = _capo(_as_project_pages(picture, project))
    assert (capo["detected"], capo["effective"], capo["source"], written) == (3, 3, "detected", 3)


@pytest.mark.ocr
@pytest.mark.parametrize("project", [False, True], ids=["picture", "project pages"])
def test_a_picture_without_a_capo_mark_has_no_capo(project):
    picture = _capo_picture(["Tuning: Drop D"])
    capo, written = _capo(_as_project_pages(picture, project))
    assert (capo["detected"], capo["effective"], capo["source"], capo["reason"], written) == (
        None,
        0,
        "default",
        "not_found",
        0,
    )
    no_capo, written = _capo(_capo_picture(["No capo"]))
    assert (no_capo["detected"], no_capo["source"], written) == (0, "detected", 0)


@pytest.mark.ocr
@pytest.mark.parametrize("project", [False, True], ids=["picture", "project pages"])
def test_the_tempo_of_the_smoke_page_is_read(project):
    # its heading, "Standard tuning · 120 BPM · 4/4", is about 7 px tall at the staff's scale
    picture = (Path(__file__).parent / "fixtures" / "single-page.png").read_bytes()
    tempo = _settings(_as_project_pages(picture, project))["tempo"]
    assert (tempo["detected"], tempo["source"]) == (120, "detected")


@pytest.mark.ocr
@pytest.mark.parametrize("project", [False, True], ids=["picture", "project pages"])
def test_capo_and_tempo_in_a_small_heading_are_read(project):
    settings = _settings(_as_project_pages(small_heading_png("Capo 3 · 120 BPM · Standard tuning"), project))
    assert (settings["capo"]["detected"], settings["tempo"]["detected"]) == (3, 120)


@pytest.mark.ocr
@pytest.mark.parametrize("project", [False, True], ids=["picture", "project pages"])
def test_a_tempo_word_in_a_small_heading_is_read(project):
    tempo = _settings(_as_project_pages(small_heading_png("Tempo 96"), project))["tempo"]
    assert (tempo["detected"], tempo["source"]) == (96, "detected")
