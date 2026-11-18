"""Reading a conversion's scores in the tests.

Sheet Thief's tests read the notes back from the GP5 file the converter wrote; the copy stops at the
model (docs/spec/recognizer.md, section 2), so they read ``ConversionResult.scores``. The names are
the ones Sheet Thief's GP5 writer gave the model's values (``slides``, ``note_type``, ``duration``),
so the expectations of the tests stay as they were.
"""

from __future__ import annotations

from collections.abc import Iterator

from recognizer.converter import ConversionResult
from recognizer.model import ScoreBeat, ScoreMeasure, ScoreNote

# Written length in 32nd notes -> (note value, dotted), as the GP5 writer wrote it.
_DURATIONS = {
    48: (1, True),
    32: (1, False),
    24: (2, True),
    16: (2, False),
    12: (4, True),
    8: (4, False),
    6: (8, True),
    4: (8, False),
    3: (16, True),
    2: (16, False),
    1: (32, False),
}
_SLIDE_IN = {"below": "intoFromBelow", "above": "intoFromAbove"}
_SLIDE_OUT = {"down": "outDownwards", "up": "outUpwards"}


def measures(result: ConversionResult, track: int = 0) -> list[ScoreMeasure]:
    return result.scores[track].measures


def notes(result: ConversionResult, track: int = 0, *, by_string: bool = False) -> Iterator[tuple[int, ScoreNote]]:
    """(index of the bar, note) of every note of a track, each beat's as read or by string."""
    for index, measure in enumerate(measures(result, track)):
        for beat in measure.beats:
            yield from ((index, note) for note in (sorted(beat.notes, key=lambda n: n.string) if by_string else beat.notes))


def note_type(note: ScoreNote) -> str:
    return "dead" if note.dead else "tie" if note.tie else "normal"


def slides(note: ScoreNote) -> list[str]:
    found = []
    if note.slide:
        found.append("legatoSlideTo")
    elif note.slide_shift:
        found.append("shiftSlideTo")
    if note.slide_in in _SLIDE_IN:
        found.append(_SLIDE_IN[note.slide_in])
    if note.slide_out in _SLIDE_OUT:
        found.append(_SLIDE_OUT[note.slide_out])
    return sorted(found)


def duration(beat: ScoreBeat) -> tuple[int, bool]:
    """(note value, dotted): 4 is a quarter note."""
    return _DURATIONS[beat.units]


def signatures(result: ConversionResult) -> list[tuple[int, int]]:
    """The time signature in force in each bar (bars without their own take the song's)."""
    first = result.scores[0]
    return [measure.time_signature or (first.numerator, first.denominator) for measure in first.measures]


def capos(result: ConversionResult) -> list[int]:
    return [score.capo for score in result.scores]


def bend(note: ScoreNote) -> tuple[str, int] | None:
    """(kind, amount in hundredths of a tone): (``"bend"``, 100) is a bend of a whole tone."""
    if not note.bend_semitones or note.dead:
        return None
    if note.bend_pre:
        kind = "prebendRelease" if note.bend_release else "prebend"
    else:
        kind = "bendRelease" if note.bend_release else "bend"
    return kind, note.bend_semitones * 50
