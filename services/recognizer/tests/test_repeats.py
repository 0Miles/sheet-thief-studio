"""Repeats and time signatures from the PDF to the scores."""

from recognizer.converter import ConversionOptions, convert
from recognizer.repeats import playback_order
from tests import scores
from tests.pdf_factory import ascii_tab_pdf

TAB = [
    "e|:-0---3-:|-5---5-|   x3",
    "B|--1------|-------|",
    "G|:-------:|-------|",
    "D|---------|-------|",
    "A|---------|-------|",
    "E|---------|-------|",
]


def test_text_tab_repeat_reaches_the_score():
    result = convert(ascii_tab_pdf([TAB]), ConversionOptions())
    bars = scores.measures(result)
    assert [m.repeat_open for m in bars] == [True, False]
    assert [m.repeat_times for m in bars] == [3, 0]  # played 3 times in all
    assert result.report["repeats"] == 1
    assert result.report["time_signature_changes"] == []


def test_user_time_signature_replaces_only_the_opening_one():
    from recognizer.converter import _drop_opening
    from recognizer.model import TabSystem

    first = TabSystem(1, 6, [], [0, 100], 0, 100, 6, time_signatures=[(5, 4, 4)])
    second = TabSystem(1, 6, [], [0, 100], 0, 100, 6, time_signatures=[(5, 3, 4)])
    _drop_opening([first, second], "time_signatures")
    assert first.time_signatures == [] and second.time_signatures == [(5, 3, 4)]


def test_repeats_written_out_for_rocksmith():
    result = convert(ascii_tab_pdf([TAB]), ConversionOptions(expand_repeats=True))
    bars = scores.measures(result)
    assert len(bars) == 4  # bar 1 three times, then bar 2
    assert not any(m.repeat_open or m.repeat_times or m.endings for m in bars)
    frets = [[n.fret for b in m.beats for n in b.notes] for m in bars]
    assert frets[0] == frets[1] == frets[2] != frets[3]
    assert result.report["repeats"] == 1 and result.report["repeats_expanded"]
    assert result.report["measures"] == 4


def test_written_out_repeat_copies_the_lyrics_of_each_pass():
    from recognizer.converter import _expand_repeats
    from recognizer.model import Score, ScoreBeat, ScoreMeasure

    score = Score(6, [64] * 6, [ScoreMeasure([ScoreBeat(32)], repeat_times=2), ScoreMeasure([ScoreBeat(32)])], 4, 4)
    report = {"_lyrics": [(1, 0.0, "la", False), (2, 0.5, "end", False)]}
    _expand_repeats([score], [report], [0, 0, 1])
    assert report["_lyrics"] == [(1, 0.0, "la", False), (2, 0.0, "la", False), (3, 0.5, "end", False)]
    assert [m.number for m in score.measures] == [1, 2, 3] and not any(m.repeat_times for m in score.measures)
    assert score.measures[0] is not score.measures[1]


def _bars(*marks):
    from recognizer.model import ScoreBeat, ScoreMeasure

    measures = []
    for values in marks:
        measure = ScoreMeasure([ScoreBeat(32)], time_signature=(4, 4))
        for name, value in values.items():
            setattr(measure, name, value)
        measures.append(measure)
    return measures


def test_only_real_tempo_changes_and_each_mark_once():
    from recognizer.converter import _tidy_navigation
    from recognizer.model import Score

    score = Score(
        6, [64] * 6, _bars({"tempo": 120}, {"tempo": 90, "sign": "Segno"}, {"tempo": 90}, {"sign": "Segno"}), 4, 4
    )
    warnings = _tidy_navigation([score], 120)
    assert [m.tempo for m in score.measures] == [None, 90, None, None]
    assert [m.sign for m in score.measures] == [None, "Segno", None, None]
    assert warnings and "Segno (compasso 4)" in warnings[0]


def test_written_out_jump_restores_the_tempo_in_force():
    from recognizer.converter import _expand_repeats
    from recognizer.model import Score

    score = Score(6, [64] * 6, _bars({}, {"tempo": 90}, {"jump": "Da Capo"}), 4, 4)
    _expand_repeats([score], [{"_lyrics": []}], playback_order(score.measures), 120)
    assert [m.tempo for m in score.measures] == [None, 90, None, 120, 90, None]
    assert not any(m.jump or m.sign for m in score.measures)
