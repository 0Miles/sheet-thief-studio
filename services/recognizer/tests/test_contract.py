"""Studio's JSON exit (docs/spec/recognizer.md, section 5): what ``contract.py`` makes of a track
``_build_track`` built, checked against the contract's JSON Schema and its fixtures."""

from __future__ import annotations

import copy
import io
from pathlib import Path

import pytest
from PIL import Image

from recognizer import contract
from recognizer.converter import ConversionError, ConversionOptions, _unify_bars
from recognizer.model import Score, ScoreBeat, ScoreMeasure, ScoreNote
from recognizer.notices import PICTURE, TUNING, Notice
from recognizer.sandbox import images_pdf
from recognizer.tunings import TuningChoice
from tests.json_schema import errors, fixture

PICTURES = Path(__file__).resolve().parent / "fixtures"
PROJECT = ConversionOptions(require_all_image_pages=True)
DETECTED = TuningChoice([64, 59, 55, 50, 45, 40], [], "detected")
NO_CAPO = {"detected": None, "effective": 0, "source": "default", "reason": "not_found", "raw": None, "alternatives": []}


def report(**changes) -> dict:
    """A track report as _build_track writes it, with only what the exit reads."""
    return {"_tuning": DETECTED, "_capo": NO_CAPO, "warnings": [], "rhythm_from_notation": 0, **changes}


def score(*measures: ScoreMeasure, strings: int = 6, signature=(4, 4)) -> Score:
    return Score(strings, [64, 59, 55, 50, 45, 40, 35][:strings], list(measures), *signature)


def bar(*beats: ScoreBeat, **marks) -> ScoreMeasure:
    return ScoreMeasure(list(beats), time_signature=marks.pop("time_signature", (4, 4)), **marks)


def quarter(*notes: ScoreNote) -> ScoreBeat:
    return ScoreBeat(8, list(notes))


def exported(track: Score, **changes) -> dict:
    result = contract.result(track, report(**changes))
    assert errors(result) == []
    return result


def test_the_checker_takes_every_fixture_and_refuses_a_broken_one():
    for path in sorted((Path(contract.__file__).resolve().parent.parent / "contract" / "fixtures").glob("*.json")):
        assert errors(fixture(path.stem)) == [], path.name
    broken = fixture("six-strings")
    broken["bars"][0]["beats"][0]["notes"][0]["fret"] = None
    assert errors(broken) != []


def test_a_bar_longer_than_its_time_signature_keeps_every_note():
    # five quarter notes in a 4/4 bar: _unify_bars would cut the fifth, the exit keeps it
    overfull = bar(*(quarter(ScoreNote(string=1, fret=fret)) for fret in range(5)))
    track = score(overfull)
    result = exported(track)
    assert [beat["notes"][0]["fret"] for beat in result["bars"][0]["beats"]] == [0, 1, 2, 3, 4]
    assert sum(beat["units"] for beat in result["bars"][0]["beats"]) == 40

    cut = copy.deepcopy(track)
    assert _unify_bars([cut], (4, 4)) == [(0, 1)]
    assert sum(beat.units for beat in cut.measures[0].beats) == 32  # what Sheet Thief wrote


def test_a_note_is_written_with_its_marks_resolved():
    dead = ScoreNote(string=2, fret=0, dead=True)
    grace = ScoreNote(string=3, fret=5, grace_fret=3, grace_hammer=True, slide=True, velocity=79, stroke="down")
    lone_hammer = ScoreNote(string=4, fret=2, grace_hammer=True)
    result = exported(score(bar(quarter(dead, grace, lone_hammer), ScoreBeat(24))))
    notes = result["bars"][0]["beats"][0]["notes"]
    assert (notes[0]["dead"], notes[0]["fret"]) == (True, None)
    assert (notes[1]["graceFret"], notes[1]["graceHammer"], notes[1]["slide"]) == (3, True, True)
    assert (notes[1]["velocity"], notes[1]["stroke"]) == (79, "down")
    assert notes[2]["graceHammer"] is False
    assert result["bars"][0]["beats"][1] == {"units": 24, "tuplet": False, "notes": []}


def test_bar_marks_are_codes_and_a_time_signature_is_written_where_it_changes():
    rest = ScoreBeat(32)
    track = score(
        bar(rest, sign="Segno", marker="Intro", tempo=96, repeat_open=True),
        bar(rest, endings=(0, 1), repeat_times=3, jump="Da Coda"),
        bar(ScoreBeat(24), time_signature=(3, 4), sign="Fine", jump="Da Segno al Coda"),
        bar(ScoreBeat(24), time_signature=(3, 4), tempo=1000),
    )
    bars = exported(track)["bars"]
    assert [b["timeSignature"] for b in bars] == [None, None, {"numerator": 3, "denominator": 4}, None]
    assert (bars[0]["sign"], bars[0]["marker"], bars[0]["tempo"], bars[0]["repeatOpen"]) == ("segno", "Intro", 96, True)
    assert (bars[1]["endings"], bars[1]["repeatTimes"], bars[1]["jump"]) == ([1], 3, "to_coda")  # no volta "0."
    assert (bars[2]["sign"], bars[2]["jump"]) == ("fine", "da_segno_al_coda")
    assert bars[3]["tempo"] is None  # out of the contract's range


def test_warnings_are_codes_and_their_text_goes_to_the_log(caplog):
    warnings = [
        Notice("Page 2: 3 overlapping note(s)…", "overlapping_notes", page=2, count=3),
        Notice("1 tab line(s)…", "staves_ignored", count=1),
        Notice("Page 1: bar with 40 notes…", "bar_too_dense", page=1, notes=40),
        Notice("fixed durations used.", "fixed_durations"),
        Notice("Tuning given in the PDF … not recognized", TUNING),
        Notice("Tablature read from an image (OCR)…", PICTURE),
        "A sentence nobody gave a code yet.",
    ]
    with caplog.at_level("INFO", logger="recognizer.contract"):
        result = exported(score(bar(quarter(ScoreNote(string=1, fret=0)), ScoreBeat(24))), warnings=warnings)
    assert result["warnings"] == [
        {"code": "overlapping_notes", "params": {"page": 2, "count": 3}},
        {"code": "staves_ignored", "params": {"count": 1}},
        {"code": "bar_too_dense", "params": {"page": 1, "notes": 40}},
        {"code": "fixed_durations", "params": {}},
        {"code": "other", "params": {}},
    ]
    assert "A sentence nobody gave a code yet." in caplog.text


@pytest.mark.parametrize(("read", "warned"), [(2, True), (0, False)])
def test_estimated_rhythm_is_a_warning_when_the_part_reads_rhythm_elsewhere(read, warned):
    note = quarter(ScoreNote(string=1, fret=0))
    track = score(bar(note, ScoreBeat(24)), bar(note, ScoreBeat(24), rhythm_estimated=True))
    result = exported(track, rhythm_from_notation=read)
    expected = [{"code": "rhythm_estimated", "params": {"bars": [2]}}] if warned else []
    assert result["warnings"] == expected
    assert result["bars"][1]["rhythmEstimated"] is True


@pytest.mark.parametrize(
    ("choice", "expected"),
    [
        (DETECTED, {"source": "detected", "reason": None, "raw": None}),
        (TuningChoice([64, 59, 55, 50, 45, 40], [], "default", "not_found"), {"source": "default", "reason": "not_found", "raw": None}),
        (
            TuningChoice([64, 59, 55, 50, 45, 40], [], "default", "unrecognized", raw="Standard (Eb)"),
            {"source": "default", "reason": "unrecognized", "raw": "Standard (Eb)"},
        ),
    ],
)
def test_the_tuning_says_where_it_comes_from(choice, expected):
    result = exported(score(bar(ScoreBeat(32))), _tuning=choice)
    assert result["tuning"] == {"midi": [64, 59, 55, 50, 45, 40], **expected}


def test_a_detected_capo_and_four_or_seven_strings():
    capo = {**NO_CAPO, "detected": 2, "effective": 2, "source": "detected", "reason": None}
    assert exported(score(bar(ScoreBeat(32))), _capo=capo)["capo"] == {"fret": 2, "source": "detected"}
    for strings in (4, 7):
        result = exported(score(bar(quarter(ScoreNote(string=strings, fret=1)), ScoreBeat(24)), strings=strings))
        assert result["strings"] == strings and len(result["tuning"]["midi"]) == strings


def test_three_strings_are_not_a_result():
    with pytest.raises(ConversionError):
        contract.result(score(bar(ScoreBeat(32)), strings=3), report())


@pytest.mark.parametrize("name", ["error-busy", "error-timeout", "error-unavailable"])
def test_a_failure_of_the_whole_job_is_the_fixture(name):
    assert contract.failure(name.removeprefix("error-")) == fixture(name)


def test_a_failure_with_its_pages_is_the_fixture():
    pages = [{"page": 1, "code": "no_staff"}, {"page": 2, "code": "no_notes"}, {"page": 3, "code": "invalid_image"}]
    pages.append({"page": 4, "code": "image_too_large"})
    assert contract.failure("recognition_failed", pages) == fixture("error-pages")
    assert contract.failure("timeout", pages)["error"]["pages"] == []


def _picture(path: Path) -> bytes:
    return path.read_bytes()


@pytest.mark.ocr
@pytest.mark.parametrize(
    "pages",
    [[path.name] for path in sorted(PICTURES.glob("*.png"))] + [["three-page-1.png", "three-page-2.png", "three-page-3.png"]],
    ids=lambda pages: "+".join(pages),
)
def test_the_result_of_each_fixture_picture_passes_the_schema(pages):
    pdf = images_pdf([_picture(PICTURES / name) for name in pages], PROJECT.max_image_pixels)
    result = contract.recognize(pdf, PROJECT)
    assert errors(result) == []
    assert result["strings"] == 6 and any(beat["notes"] for b in result["bars"] for beat in b["beats"])


@pytest.mark.ocr
def test_a_picture_with_no_staff_fails_with_its_page():
    blank = io.BytesIO()
    Image.new("RGB", (400, 200), "white").save(blank, "PNG")
    pdf = images_pdf([_picture(PICTURES / "single-page.png"), blank.getvalue()], PROJECT.max_image_pixels)
    with pytest.raises(ConversionError) as caught:
        contract.recognize(pdf, PROJECT)
    answer = contract.failure("recognition_failed", caught.value.diagnostics)
    assert errors(answer) == [] and answer["error"]["pages"] == [{"page": 2, "code": "no_staff"}]
