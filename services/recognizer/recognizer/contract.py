"""Studio's JSON exit: the recognizer's own intermediate model (docs/spec/recognizer.md, section 5;
ADR 0006), described by ``contract/recognition.schema.json``.

The exit takes the track as ``_build_track`` gives it, before ``convert_many`` aligns it to the
printed bar numbers and cuts each bar to its time signature (``_unify_bars``): Studio marks a bar
that does not fit, it never rewrites one. Only stable codes and parameters leave the service; the
core's sentences (Portuguese or English) go to the log.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from .converter import ConversionError, ConversionOptions, build_tracks
from .model import Score, ScoreBeat, ScoreMeasure, ScoreNote
from .music_settings import tempo_in_range
from .notices import PICTURE, TUNING, Notice

logger = logging.getLogger(__name__)

CONTRACT = "sheet-thief-studio/recognition"
VERSION = 1

# The warnings the contract has codes for, with the parameters each takes (section 5.1).
WARNING_PARAMS: dict[str, tuple[str, ...]] = {
    "overlapping_notes": ("page", "count"),
    "staves_ignored": ("count",),
    "bar_too_dense": ("page", "notes"),
    "fixed_durations": (),
}
# The core's names of the navigation marks (extract/bar_signs.py), and the contract's codes.
SIGNS = {"Segno": "segno", "Coda": "coda", "Fine": "fine"}
JUMPS = {
    "Da Capo": "da_capo",
    "Da Capo al Coda": "da_capo_al_coda",
    "Da Capo al Fine": "da_capo_al_fine",
    "Da Segno": "da_segno",
    "Da Segno al Coda": "da_segno_al_coda",
    "Da Segno al Fine": "da_segno_al_fine",
    "Da Coda": "to_coda",  # Guitar Pro's name of "To Coda"
}
# Failures of the whole job (section 5.2); "busy" is answered with HTTP 503, the others with 422.
FAILURE_CODES = ("recognition_failed", "timeout", "unavailable", "busy")


def failure(code: str, pages: Iterable[dict] = ()) -> dict:
    """The contract's failure: ``pages`` (``{page, code}``) only for ``recognition_failed``."""
    if code not in FAILURE_CODES:
        raise ValueError(f"unknown failure code {code!r}")
    listed = [{"page": item["page"], "code": item["code"]} for item in pages] if code == "recognition_failed" else []
    return {"contract": CONTRACT, "version": VERSION, "error": {"code": code, "params": {}, "pages": listed}}


def result_of_pdf(pdf: bytes, options: ConversionOptions) -> dict:
    """Read one PDF (the pictures of one request, a page each) as one part: the contract's result."""
    built = build_tracks([pdf], options)
    return result(built.scores[0], built.track_reports[0])


def result(score: Score, report: dict) -> dict:
    """The contract's result for a track ``_build_track`` built, and its report."""
    if not 4 <= score.string_count <= 7:
        raise ConversionError(f"The tablature has {score.string_count} strings; the contract takes 4 to 7.")
    return {
        "contract": CONTRACT,
        "version": VERSION,
        "strings": score.string_count,
        "tuning": _tuning(score, report["_tuning"]),
        "capo": _capo(report["_capo"]),
        "timeSignature": {"numerator": score.numerator, "denominator": score.denominator},
        "bars": _bars(score),
        "warnings": _warnings(score, report),
    }


def _tuning(score: Score, choice) -> dict:
    """The tuning used and where it comes from (tunings.py's TuningChoice). The service never takes
    a requested tuning, so the sources are only "detected" and "default"."""
    midi = list(score.tuning)
    if choice.source == "detected":
        return {"midi": midi, "source": "detected", "reason": None, "raw": None}
    if choice.source == "default" and choice.reason == "unrecognized" and choice.raw:
        return {"midi": midi, "source": "default", "reason": "unrecognized", "raw": choice.raw}
    if choice.source == "default" and choice.reason in ("not_found", "unrecognized"):  # nothing printed to keep
        return {"midi": midi, "source": "default", "reason": "not_found", "raw": None}
    raise ValueError(f"a tuning the contract has no case for: {choice.source}, {choice.reason}")


def _capo(setting: dict) -> dict:
    """The capo printed in the heading (converter.py's ``_capo_setting``), else none."""
    if setting["source"] == "detected":
        return {"fret": int(setting["effective"]), "source": "detected"}
    return {"fret": 0, "source": "default"}


def _bars(score: Score) -> list[dict]:
    in_force = (score.numerator, score.denominator)
    bars = []
    for measure in score.measures:
        signature = measure.time_signature
        changed = signature is not None and tuple(signature) != in_force
        if changed:
            in_force = tuple(signature)
        bars.append(_bar(measure, {"numerator": in_force[0], "denominator": in_force[1]} if changed else None))
    return bars


def _bar(measure: ScoreMeasure, signature: dict | None) -> dict:
    tempo = measure.tempo if measure.tempo and tempo_in_range(measure.tempo) else None
    return {
        # A bar's signature only where it changes; null keeps the one in force.
        "timeSignature": signature,
        "marker": measure.marker or None,
        "tempo": int(tempo) if tempo is not None else None,
        "repeatOpen": bool(measure.repeat_open),
        "repeatTimes": int(measure.repeat_times),
        # A volta "0." the bar-sign reader also takes (its \d) is not a pass of the repeat.
        "endings": sorted({int(n) for n in measure.endings if n >= 1}),
        "sign": _named(measure.sign, SIGNS, "sign"),
        "jump": _named(measure.jump, JUMPS, "jump"),
        "rhythmEstimated": bool(measure.rhythm_estimated),
        "beats": [_beat(beat) for beat in measure.beats],
    }


def _named(name: str | None, codes: dict[str, str], kind: str) -> str | None:
    if not name:
        return None
    if name not in codes:
        logger.warning("a %s the contract has no code for, left out: %r", kind, name)
        return None
    return codes[name]


def _beat(beat: ScoreBeat) -> dict:
    return {"units": int(beat.units), "tuplet": bool(beat.tuplet), "notes": [_note(note) for note in beat.notes]}


def _note(note: ScoreNote) -> dict:
    """A note, its marks resolved by the rhythm builder (``resolve_links``): parenthesised notes
    are ties or ghost notes, links are hammers and slides on the note they start from."""
    return {
        "string": note.string,
        "fret": None if note.dead else note.fret,  # the core keeps 0 for a dead note
        "dead": note.dead,
        "ghost": note.ghost,
        "tie": note.tie,
        "vibrato": note.vibrato,
        "hammer": note.hammer,
        "slide": note.slide,
        "slideShift": note.slide_shift,
        "slideIn": note.slide_in,
        "slideOut": note.slide_out,
        "harmonic": note.harmonic,
        "tapped": note.tapped,
        "graceFret": note.grace_fret,
        "graceHammer": note.grace_hammer and note.grace_fret is not None,
        "staccato": note.staccato,
        "bendSemitones": note.bend_semitones,
        "bendRelease": note.bend_release,
        "bendPre": note.bend_pre,
        "letRing": note.let_ring,
        "palmMute": note.palm_mute,
        "stroke": note.stroke,
        "velocity": note.velocity,
    }


def _warnings(score: Score, report: dict) -> list[dict]:
    """The warnings as codes; every sentence goes to the log only. A sentence with no code yet is
    "other"; the tuning's and the picture's are left out (the result already says them)."""
    found: list[dict] = []
    for warning in report["warnings"]:
        code = warning.code if isinstance(warning, Notice) else None
        if code in (TUNING, PICTURE):
            logger.info("warning, not reported (%s): %s", code, warning)
            continue
        if code in WARNING_PARAMS:
            params = {name: int(warning.params[name]) for name in WARNING_PARAMS[code]}
            found.append({"code": code, "params": params})
        else:
            code = "other"
            found.append({"code": code, "params": {}})
        logger.info("warning, reported as %s: %s", code, warning)
    # Rhythm estimated from the spacing, where the part reads its printed rhythm elsewhere: by the
    # predecessor's count of bars read (rhythm_from_notation), on the bars as _build_track numbers
    # them (its own _flag_estimated_rhythm runs after the bars are aligned and cut).
    estimated = [number for number, measure in enumerate(score.measures, start=1) if measure.rhythm_estimated]
    if estimated and report["rhythm_from_notation"]:
        found.append({"code": "rhythm_estimated", "params": {"bars": estimated}})
    return found
