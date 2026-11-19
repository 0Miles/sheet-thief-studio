"""End-to-end pipeline: PDF bytes -> tab systems -> scores (one per track).

Studio's copy stops at the model: Sheet Thief wrote the scores to GP5 (``gp5_writer``) and drew a
text preview (``preview``); neither is copied (docs/spec/recognizer.md, section 2).
"""

from __future__ import annotations

import copy
import dataclasses
import itertools
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from .extract.ascii_tab import extract_ascii_systems
from .extract.engraved_tab import extract_engraved_systems
from .extract.metadata import SongMetadata, detect_metadata, detect_part_name, track_name_from_filename
from .extract.pdf_reader import Page, PdfReadError, read_document
from .extract.raster_tab import image_kind, read_image, read_pdf_page
from .i18n import tr
from .model import Score, ScoreBeat, ScoreMeasure, ScoreNote, TabSystem
from .music_settings import (
    DEFAULT_CAPO,
    DEFAULT_TEMPO,
    DEFAULT_TIME_SIGNATURE,
    time_signature_in_range,
)
from .notices import PICTURE, Notice
from .repeats import playback_order
from .rhythm import RhythmMode, RhythmOptions, RhythmStats, build_measures, first_bar_end, signature_units, split_units
from .tunings import TUNINGS, TuningChoice, resolve_tuning

# Sheet Thief took these from its GP5 writer: a track header holds at most 7 string tunings, and two
# MIDI channels per track (port 1 without the percussion channel) leave room for 7 tracks.
MAX_STRINGS = 7
MAX_TRACKS = 7
# MIDI velocities of the dynamic marks (ppp … fff); f is Guitar Pro's default.
MIN_VELOCITY, DEFAULT_VELOCITY, MAX_VELOCITY = 15, 95, 127

INSTRUMENTS: dict[str, int] = {
    "nylon": 24,
    "steel": 25,
    "clean": 27,
    "overdrive": 29,
    "distortion": 30,
    "bass": 33,
}
# The TabSystem marks an override of the tempo / time signature replaces in the first bar.
OverriddenMarks = Literal["tempos", "time_signatures"]


class ConversionError(Exception):
    """A user-facing error: the message is safe to return to the client."""

    def __init__(self, message: str, *, diagnostics: list[dict] | None = None):
        super().__init__(message)
        self.diagnostics = diagnostics or []


@dataclass(frozen=True)
class TrackOptions:
    """Per-PDF choices; empty/"auto"/None values mean "detect"."""

    name: str = ""
    filename: str = ""
    tuning: str = "auto"
    instrument: str = "auto"
    capo: int | None = None


@dataclass(frozen=True)
class ConversionOptions:
    """Song-level choices; empty/None values mean "detect from the PDFs"."""

    title: str = ""
    artist: str = ""
    tempo: int | None = None
    numerator: int | None = None
    denominator: int | None = None
    tracks: tuple[TrackOptions, ...] = ()
    rhythm_mode: RhythmMode = "auto"
    fixed_value: int = 8
    max_pages: int = 40
    max_image_pages: int = 15  # pages read from a picture (OCR) per file: about a second each
    max_image_pixels: int = 40_000_000
    max_events: int = 50_000
    max_measures: int = 2000
    expand_repeats: bool = False  # write repeated passages out (Rocksmith has no repeats)
    require_all_image_pages: bool = False  # projects must not silently omit failed pages

    def track(self, index: int) -> TrackOptions:
        return self.tracks[index] if index < len(self.tracks) else TrackOptions()


@dataclass
class ConversionResult:
    """The scores (one per track, all with the same bars) and the report of what was read."""

    scores: list[Score]
    report: dict


@dataclass
class _ParsedPdf:
    systems: list[TabSystem]
    metadata: SongMetadata
    part_name: str | None
    warnings: list[str] = field(default_factory=list)


def _drawn_lines(page: Page) -> bool:
    """The page has lines drawn across it, enough for a staff."""
    return sum(segment.is_horizontal for segment in page.segments) >= 4


def _read(pdf: bytes, options: ConversionOptions) -> tuple[list[Page], dict[str, str]]:
    try:
        pages, info = read_document(pdf, options.max_pages)
    except PdfReadError as exc:
        raise ConversionError(str(exc)) from exc
    # text, pictures, or drawn staff lines (text printed as outlines is read by OCR, see _parse_pdf)
    if not any(page.chars or page.images or _drawn_lines(page) for page in pages):
        raise ConversionError(
            tr(
                "O PDF não contém texto nem imagens: não há tablatura para ler.",
                "The PDF has no text and no images: there is no tablature to read.",
            )
        )
    return pages, info


# Shown once per track read from a picture.
# Progress of the file being read (0…1), for the page's progress bar: set by the worker process
# (sandbox.py), which passes it on to the server. None: nobody is listening.
_progress: Callable[[float], None] | None = None


def set_progress(callback: Callable[[float], None] | None) -> None:
    global _progress
    _progress = callback


def _report(fraction: float) -> None:
    if _progress is not None:
        _progress(min(max(fraction, 0.0), 1.0))


# A page read as a picture (OCR) takes about this many times as long as one read as text.
_PICTURE_WEIGHT = 8


def _image_warning() -> str:
    return Notice(
        tr(
            "Tablatura lida de uma imagem (OCR): confira as notas. O ritmo é lido das hastes, barras e pausas quando "
            "estão desenhadas, e senão estimado pelo espaçamento das notas; confira também as técnicas (bends, "
            "slides, ligaduras, vibrato…).",
            "Tablature read from an image (OCR): check the notes. The rhythm is read from the stems, beams and rests "
            "where they are drawn, and otherwise estimated from the spacing of the notes; check the techniques too "
            "(bends, slides, ties, vibrato…).",
        ),
        PICTURE,
    )


def _image_systems(page: Page) -> list[TabSystem]:
    return [dataclasses.replace(s, source="image") for s in extract_engraved_systems(page)]


def _fill_in(printed: SongMetadata, read: SongMetadata) -> SongMetadata:
    """Metadata from the PDF's text, with the gaps filled from the picture. A title or artist
    the PDF has without spaces between words ("YoureAGod") takes the picture's spacing."""

    def text(field: str) -> str | None:
        mine, other = getattr(printed, field), getattr(read, field)
        if mine and other and mine.replace(" ", "").lower() == other.replace(" ", "").lower():
            return other if other.count(" ") > mine.count(" ") else mine
        return mine or other

    signature = (printed.numerator, printed.denominator) if printed.numerator else (read.numerator, read.denominator)
    capo_source = printed if printed.capo is not None or printed.capo_raw else read  # one text's capo marks
    return dataclasses.replace(
        printed,
        title=text("title"),
        artist=text("artist"),
        tempo=printed.tempo or read.tempo,
        numerator=signature[0],
        denominator=signature[1],
        tuning_labels=printed.tuning_labels or read.tuning_labels,
        tempo_raw=None if printed.tempo or read.tempo else printed.tempo_raw or read.tempo_raw,
        time_signature_raw=None if signature[0] else printed.time_signature_raw or read.time_signature_raw,
        tuning_raw=None if printed.tuning_labels or read.tuning_labels else printed.tuning_raw or read.tuning_raw,
        capo=capo_source.capo,
        capo_raw=capo_source.capo_raw,
        capo_alternatives=capo_source.capo_alternatives,
    )


def _check_picture_count(count: int, options: ConversionOptions) -> None:
    if count > options.max_image_pages:
        raise ConversionError(
            tr(
                f"O PDF tem {count} páginas em imagem; o máximo para ler por OCR é {options.max_image_pages}.",
                f"The PDF has {count} pages that are images; the maximum read by OCR is {options.max_image_pages}.",
            )
        )


def _parse_pdf(
    pdf: bytes, options: ConversionOptions, frets: bool = True, progress: Callable[[float], None] = _report
) -> _ParsedPdf:
    """Tab systems, metadata and part name of one file. Without ``frets`` (inspect) pictures are
    read only for their staves and heading. ``progress`` gets how much of the file is read (0…1)."""
    warnings: list[str] = []
    systems: list[TabSystem] = []
    heading = None  # the text read above the first staff of a PDF's page 1 when it is a picture
    diagnostics: list[dict] = []

    def add_picture(picture: Page) -> None:
        found = _image_systems(picture)
        if not found or (frets and not any(system.events for system in found)):
            diagnostics.append({"page": picture.number, "code": "no_staff" if not found else "no_notes"})
        systems.extend(found)

    if image_kind(pdf):
        try:
            picture, image_heading = read_image(pdf, options.max_image_pixels, frets)
        except PdfReadError as exc:
            raise ConversionError(str(exc)) from exc
        add_picture(picture)
        # title, artist, tempo, tuning and capo come from the text above the first staff
        metadata_pages, info = [image_heading] if image_heading else [], {}
        heading_only = True
    else:
        pages, info = _read(pdf, options)
        metadata_pages = pages
        heading_only = False
        # Pages read as pictures (OCR): no tab with notes found in their text, and either an image
        # (a print saved as PDF, a scan) or drawings with no text at all ("Microsoft Print to PDF"
        # of a web page such as Songsterr writes the numbers and words as outlines, not text).
        pictures: list[int] = []
        for index, page in enumerate(pages):
            ascii_systems, page_warnings = extract_ascii_systems(page)
            warnings.extend(page_warnings)
            found = ascii_systems or extract_engraved_systems(page)
            outlines = not page.chars and _drawn_lines(page)
            if not any(system.events for system in found) and (page.images or outlines):
                pictures.append(index)
            else:
                systems.extend(found)
        _check_picture_count(len(pictures), options)
        steps = len(pages) + _PICTURE_WEIGHT * len(pictures)
        progress(len(pages) / steps if steps else 1.0)
        for done, index in enumerate(pictures, start=1):
            try:
                picture, page_heading = read_pdf_page(pdf, index, heading=index == 0, frets=frets)
            except PdfReadError as exc:
                raise ConversionError(str(exc)) from exc
            add_picture(picture)
            heading = heading or page_heading
            progress((len(pages) + _PICTURE_WEIGHT * done) / steps)
        systems.sort(key=lambda system: system.page)  # pictures read last; stable within a page
    if not systems or (diagnostics and options.require_all_image_pages):
        raise ConversionError(
            tr(
                "Não foi encontrada tablatura no ficheiro. São suportadas tablaturas em texto (ex.: e|--0--2--|), "
                "tablaturas gravadas por editores (Guitar Pro, MuseScore, TuxGuitar) e imagens de tablaturas "
                "com as linhas das cordas desenhadas.",
                "No tablature was found in the file. Text tablatures (e.g. e|--0--2--|), tablatures engraved "
                "by editors (Guitar Pro, MuseScore, TuxGuitar) and images of tablatures with the string lines "
                "drawn are supported.",
            ),
            diagnostics=diagnostics,
        )
    if any(s.source == "image" for s in systems):
        warnings.append(_image_warning())
    if heading is None:
        metadata = detect_metadata(metadata_pages, info, heading_only)
    else:
        # page 1 is a picture: what its own text lacks (often the tempo mark and the time
        # signature, drawn in the picture) comes from the text read in the picture, and only
        # then from the file's properties (a printed web page's title there is the page's)
        metadata = _fill_in(detect_metadata(metadata_pages, {}), detect_metadata([heading], info, heading_only=True))
    part = detect_part_name(metadata_pages, metadata) or (detect_part_name([heading], metadata) if heading else None)
    return _ParsedPdf(systems, metadata, part, warnings)


def _merge_metadata(items: list[SongMetadata]) -> SongMetadata:
    """First detected value for each field across the PDFs."""

    def first(attr: str):
        return next((getattr(m, attr) for m in items if getattr(m, attr) is not None), None)

    signature = next(((m.numerator, m.denominator) for m in items if m.numerator and m.denominator), (None, None))
    tempo = first("tempo")
    return SongMetadata(
        first("title"),
        first("artist"),
        tempo,
        *signature,
        tempo_raw=None if tempo else first("tempo_raw"),
        time_signature_raw=None if signature[0] else first("time_signature_raw"),
    )


def _main_staves(systems: list[TabSystem], warnings: list[str], notes_read: bool = True) -> tuple[int, list[TabSystem]]:
    # Only staves with notes vote: empty engraved staves may be standard-notation staves. When the
    # notes were not read (inspecting a picture), every staff votes.
    with_notes = [s for s in systems if s.events] if notes_read else systems
    if not with_notes:
        raise ConversionError(
            tr("A tablatura foi encontrada mas não contém notas.", "The tablature was found but has no notes.")
        )
    string_count, _ = Counter(s.string_count for s in with_notes).most_common(1)[0]
    dropped = sum(1 for s in with_notes if s.string_count != string_count)
    if dropped:
        warnings.append(
            Notice(
                tr(
                    f"{dropped} linha(s) de tab com número de cordas diferente de {string_count} foram ignoradas.",
                    f"{dropped} tab line(s) with a number of strings other than {string_count} were ignored.",
                ),
                "staves_ignored",
                count=dropped,
            )
        )
    return string_count, [s for s in systems if s.string_count == string_count]


@dataclass
class _Ramp:
    """A hairpin, possibly drawn over several lines: (system index, x0, x1) per line."""

    direction: int  # +1 crescendo, -1 diminuendo
    segments: list[tuple[int, float, float]]
    start: int = 0  # velocity where it starts
    end: int = 0  # velocity it reaches


def _hairpin_ramps(systems: list[TabSystem]) -> list[_Ramp]:
    """Hairpins in reading order; one that runs to the end of a line and goes on at the start
    of the next line is the same hairpin."""
    ramps: list[_Ramp] = []
    for index, system in enumerate(systems):
        for x0, x1, direction in sorted(system.hairpins):
            if ramps and ramps[-1].direction == direction and ramps[-1].segments[-1][0] == index - 1:
                previous = systems[index - 1]
                reach = 6 * system.char_width
                if ramps[-1].segments[-1][2] >= previous.end_x - reach and x0 <= system.start_x + reach:
                    ramps[-1].segments.append((index, x0, x1))
                    continue
            ramps.append(_Ramp(direction, [(index, x0, x1)]))
    return ramps


def _apply_dynamics(systems: list[TabSystem]) -> None:
    """Each dynamic mark sets the velocity of the notes from its position on, across lines.

    A hairpin changes it gradually over its length: from the velocity in force where it starts
    to the next dynamic mark (at its end or on the next line), or two levels up / down when no
    mark follows (the notes after it keep that level).
    """
    marks = [(i, x, velocity) for i, system in enumerate(systems) for x, velocity in system.dynamics]
    ramps = _hairpin_ramps(systems)
    for ramp in ramps:
        first, x0, _ = ramp.segments[0]
        last, _, x1 = ramp.segments[-1]
        slack = systems[first].char_width
        before = [v for i, x, v in marks if (i, x) <= (first, x0 + 2 * slack)]
        ramp.start = before[-1] if before else DEFAULT_VELOCITY
        after = [v for i, x, v in marks if (i, x) >= (last, x1 - 2 * slack) and i <= last + 1]
        if after:
            ramp.end = after[0]
        else:
            ramp.end = min(max(ramp.start + 32 * ramp.direction, MIN_VELOCITY), MAX_VELOCITY)
            marks.append((last, x1, ramp.end))  # the level reached stays
    marks.sort()

    def ramped(index: int, x: float, char_width: float) -> int | None:
        for ramp in ramps:
            total = sum(x1 - x0 for _, x0, x1 in ramp.segments)
            done = 0.0
            for i, x0, x1 in ramp.segments:
                if i == index and x0 - char_width <= x <= x1:
                    t = min(max((done + x - x0) / total, 0.0), 1.0)
                    velocity = ramp.start + (ramp.end - ramp.start) * t
                    # 8 levels (ppp … fff, 16 apart, as Guitar Pro has them): the nearest one, not the one below.
                    return MIN_VELOCITY + 16 * round((velocity - MIN_VELOCITY) / 16)
                done += x1 - x0
        return None

    current: int | None = None
    position = 0
    for index, system in enumerate(systems):
        for event in sorted(system.events, key=lambda e: e.x):
            while position < len(marks) and marks[position][:2] <= (index, event.x + system.char_width):
                current = marks[position][2]
                position += 1
            velocity = ramped(index, event.x, system.char_width) if ramps else None
            event.velocity = velocity if velocity is not None else current
        while position < len(marks) and marks[position][0] <= index:
            current = marks[position][2]
            position += 1


def _bar_of(system: TabSystem, x: float, previous: int) -> int:
    """Printed bar number of the bar containing ``x`` (counting on from ``previous`` when unknown)."""
    bounds = sorted(system.bars)
    numbers = system.bar_numbers if len(system.bar_numbers) == len(bounds) - 1 else []
    number = previous
    for index, (start, end) in enumerate(itertools.pairwise(bounds)):
        known = numbers[index] if index < len(numbers) else None
        number = known if known is not None else number + 1
        if x < end:
            return number
    return max(number, previous)


def _position_in_bar(bounds: list[float], x: float) -> float:
    """Where ``x`` falls inside its bar, from 0 (bar line) to 1 (next bar line)."""
    for start, end in itertools.pairwise(bounds):
        if x < end:
            return min(1.0, max(0.0, (x - start) / (end - start))) if end > start else 0.0
    return 1.0


def _lyric_syllables(systems: list[TabSystem]) -> list[tuple[int, float, str, bool]]:
    """Lyric syllables in reading order as (bar, position in the bar, syllable, joins_next)."""
    syllables: list[tuple[int, float, str, bool]] = []
    last_bar = 0
    for system in systems:
        bounds = sorted(system.bars)
        for x, syllable, joins in sorted(system.lyrics):
            last_bar = _bar_of(system, x, last_bar)
            syllables.append((last_bar, _position_in_bar(bounds, x), syllable, joins))
        if system.bars:
            last_bar = _bar_of(system, max(system.bars), last_bar)
    return syllables


_LYRIC_SYNTAX = re.compile(r"[\s\[\]+\-]")  # characters with a meaning in Guitar Pro lyrics


def _lyrics_text(
    syllables: list[tuple[int, float, str, bool]], score: Score
) -> tuple[tuple[int, str] | None, list[int]]:
    """One lyric line in Guitar Pro's form (start bar, text), as Sheet Thief wrote it into the GP5,
    putting each syllable on the note played where it is printed, and the bars whose syllables had
    to be left out (the track rests there, and a syllable can only be shown on a played note;
    piling them onto the next note would misplace all the following text).

    Guitar Pro (and alphaTab) give the next chunk of text to each non-rest beat of the lyrics
    track, from the start bar on: an extra space is an empty chunk that skips a beat, "+" keeps
    two words on one beat and "-" ends a syllable inside a word. After "-" no beat can be skipped,
    so the rest of a word goes on the next note.
    """
    if not syllables:
        return None, []
    start_bar = syllables[0][0]
    beats: list[tuple[int, float]] = []  # (bar, onset in the bar) of each non-rest beat
    first_in_bar: dict[int, int] = {}
    for number in range(max(1, start_bar), len(score.measures) + 1):
        measure = score.measures[number - 1]
        total = measure.units or 1
        onset = 0
        for beat in measure.beats:
            if not beat.is_rest:
                first_in_bar.setdefault(number, len(beats))
                beats.append((number, onset / total))
            onset += beat.duration
    if not beats:
        return None, sorted({bar for bar, *_ in syllables})
    chunks: list[list[tuple[str, bool]]] = [[] for _ in beats]
    dropped: set[int] = set()
    previous = -1
    previous_joins = False
    for bar, position, text, joins in syllables:
        text = _LYRIC_SYNTAX.sub("", text)
        if not text:
            continue
        if bar not in first_in_bar and not previous_joins:
            dropped.add(bar)
            continue
        if previous_joins and previous + 1 < len(beats):
            target = previous + 1
        else:
            first = first_in_bar[bar]
            last = first
            while last + 1 < len(beats) and beats[last + 1][0] == bar:
                last += 1
            target = min(range(first, last + 1), key=lambda i: abs(beats[i][1] - position))
        target = max(target, previous)  # never go back; share the previous note if needed
        if target == previous and previous_joins:
            target = min(previous + 1, len(beats) - 1)
        chunks[target].append((text, joins))
        previous, previous_joins = target, joins

    used = [i for i, chunk in enumerate(chunks) if chunk]
    if not used:
        return None, sorted(dropped)
    first_used, last_used = used[0], used[-1]
    start_bar = beats[first_used][0]
    text = " " * (first_used - first_in_bar[start_bar])  # skip the notes before the first syllable
    for i in range(first_used, last_used + 1):
        token = ""
        for k, (syllable, joins) in enumerate(chunks[i]):
            if k and not chunks[i][k - 1][1]:
                token += "+"  # another word on the same note
            token += syllable
        if chunks[i] and chunks[i][-1][1]:
            token += "-"
        text += token
        if i < last_used and not token.endswith("-"):
            text += " "
    return (start_bar, text), sorted(dropped)


VOCAL_TRACK_NAME = "Letra (voz)"
VOICE_PROGRAM = 53  # General MIDI "Voice Oohs"; the track is muted anyway


def _vocal_score(syllables: list[tuple[int, float, str, bool]], meters: list[tuple[int, int]]) -> Score:
    """A silent track with a short note on each lyric syllable, where it is printed.

    Guitar Pro keeps lyrics on the played notes of one track, so no guitar part can carry all of
    them (the parts rest while the singer sings). This track gives every syllable its own note in
    its place, so the whole text has a note to go on (Sheet Thief wrote it into the GP5).
    ``meters``: the time signature of each bar of the song.
    """
    by_bar: dict[int, list[float]] = {}
    for bar, position, *_ in syllables:
        by_bar.setdefault(bar, []).append(position)
    result: list[ScoreMeasure] = []
    for number, meter in enumerate(meters, start=1):
        units = signature_units(meter)
        positions = by_bar.get(number, [])
        grid = 2 if len(positions) <= units // 2 else 1  # 16ths, or 32nds for very dense text
        onsets: list[int] = []
        for position in positions:
            onset = min(units - grid, round(position * units / grid) * grid)
            if onsets and onset <= onsets[-1]:
                onset = onsets[-1] + grid
            if onset < units:  # more syllables than slots: the rest share the last note ("+")
                onsets.append(onset)
        beats: list[ScoreBeat] = []
        cursor = 0
        for i, onset in enumerate(onsets):
            beats.extend(ScoreBeat(part) for part in split_units(onset - cursor))
            end = onsets[i + 1] if i + 1 < len(onsets) else units
            parts = split_units(end - onset)
            beats.append(ScoreBeat(parts[0], [ScoreNote(string=1, fret=0)]))
            beats.extend(ScoreBeat(part) for part in parts[1:])  # no ties: they would take a syllable
            cursor = end
        beats.extend(ScoreBeat(part) for part in split_units(units - cursor))
        result.append(ScoreMeasure(beats, time_signature=meter))
    return Score(
        6,
        list(TUNINGS["standard"]),
        result,
        *meters[0],
        name=VOCAL_TRACK_NAME,
        instrument=VOICE_PROGRAM,
        muted=True,
    )


def _tuning_name(tuning: list[int]) -> str:
    return next((name for name, midi in TUNINGS.items() if list(midi) == tuning), "custom")


def _build_track(
    parsed: _ParsedPdf, track: TrackOptions, rhythm: RhythmOptions, name: str, overridden: list[OverriddenMarks]
) -> tuple[Score, dict]:
    """``overridden``: the printed marks an override replaces in the first bar."""
    warnings = list(parsed.warnings)
    string_count, kept = _main_staves(parsed.systems, warnings)
    for attribute in overridden:
        _drop_opening(kept, attribute)
    if string_count > MAX_STRINGS:
        raise ConversionError(
            tr(
                f"A tablatura tem {string_count} cordas; o máximo é {MAX_STRINGS}.",
                f"The tablature has {string_count} strings; the maximum is {MAX_STRINGS}.",
            )
        )
    # the notes printed left of the staff, else the heading's "Tuning:" line
    labels = next((s.labels for s in kept if s.labels), []) or list(parsed.metadata.tuning_labels)
    try:
        choice = resolve_tuning(track.tuning, string_count, labels, parsed.metadata.tuning_raw)
    except (KeyError, ValueError) as exc:
        raise ConversionError(tr("Afinação inválida.", "Invalid tuning.")) from exc
    tuning = choice.midi
    warnings.extend(choice.warnings)
    capo_setting = _capo_setting(track, parsed.metadata)
    capo = capo_setting["effective"]

    _apply_dynamics(kept)
    system_measures: list[int] = []
    stats = RhythmStats()
    measures = build_measures(kept, rhythm, warnings, system_measures, stats)
    note_count = sum(len(b.notes) for m in measures for b in m.beats if not all(n.tie for n in b.notes))
    if note_count == 0:
        raise ConversionError(
            tr("A tablatura foi encontrada mas não contém notas.", "The tablature was found but has no notes.")
        )
    instrument = track.instrument
    if instrument == "auto":
        instrument = "bass" if string_count <= 5 else "steel"
    score = Score(
        string_count=string_count,
        tuning=tuning,
        measures=measures,
        numerator=rhythm.numerator,
        denominator=rhythm.denominator,
        warnings=warnings,
        name=name,
        instrument=INSTRUMENTS[instrument],
        capo=capo,
    )
    report = {
        "name": name,
        "dynamics": sum(len(s.dynamics) for s in kept),
        "hairpins": sum(len(s.hairpins) for s in kept),
        "filename": track.filename,
        "instrument": instrument,
        "strings": string_count,
        "tuning": _tuning_name(tuning),
        "capo": capo,
        "measures": len(measures),
        "notes": note_count,
        "systems": len(kept),
        "sources": sorted({s.source for s in kept}),
        "pages": sorted({s.page for s in kept}),
        "rhythm_from_notation": stats.notated,
        "rhythm_estimated": stats.estimated,
        "warnings": warnings,
        "systems_detail": [
            {
                "page": s.page,
                "source": s.source,
                "notes": len(s.events),
                "measures": system_measures[i] if i < len(system_measures) else None,
            }
            for i, s in enumerate(kept)
        ],
    }
    report["_lyrics"] = _lyric_syllables(kept)
    report["_tuning"] = choice
    report["_capo"] = capo_setting
    return score, report


def _track_name(index: int, track: TrackOptions, parsed: _ParsedPdf, song: SongMetadata) -> str:
    return (
        track.name.strip()
        or parsed.part_name
        or track_name_from_filename(track.filename, song.title, song.artist)
        or f"Track {index + 1}"
    )


def _rest_bar(score: Score) -> ScoreMeasure:
    units = score.numerator * 32 // score.denominator
    return ScoreMeasure([ScoreBeat(part) for part in split_units(units)])


def _ranges(numbers: list[int]) -> str:
    """[3, 4, 5, 9] -> "3–5, 9"."""
    parts: list[str] = []
    for _, group in itertools.groupby(enumerate(numbers), key=lambda item: item[1] - item[0]):
        values = [n for _, n in group]
        parts.append(f"{values[0]}–{values[-1]}" if len(values) > 1 else str(values[0]))
    return ", ".join(parts)


def _flag_estimated_rhythm(score: Score, report: dict) -> None:
    """The bars (numbered as the file plays them) whose rhythm was estimated from the spacing.

    Listed in the report, and in a warning when the part prints rhythm elsewhere: there a bar
    estimated from the spacing is the one to check before trusting the playback."""
    bars = [number for number, measure in enumerate(score.measures, start=1) if measure.rhythm_estimated]
    report["rhythm_estimated_bars"] = bars
    if not bars or not report["rhythm_from_notation"]:
        return
    read = report["rhythm_from_notation"]
    if len(bars) == 1:
        message = tr(
            f"Ritmo lido da partitura em {read} compasso(s); estimado pelo espaçamento das notas no "
            f"compasso {bars[0]}: confira-o antes de confiar na reprodução.",
            f"Rhythm read from the score in {read} bar(s); estimated from the spacing of the notes in "
            f"bar {bars[0]}: check it before trusting the playback.",
        )
    else:
        message = tr(
            f"Ritmo lido da partitura em {read} compasso(s); estimado pelo espaçamento das notas nos "
            f"compassos {_ranges(bars)}: confira-os antes de confiar na reprodução.",
            f"Rhythm read from the score in {read} bar(s); estimated from the spacing of the notes in "
            f"bars {_ranges(bars)}: check them before trusting the playback.",
        )
    report["warnings"].append(message)


def _align_by_numbers(score: Score) -> list[int] | None:
    """Put each bar at its printed bar number, filling gaps with rests.

    Returns the missing bar numbers, or None when the numbering is absent or not
    strictly increasing (the measures are then left untouched).
    """
    measures = score.measures
    if not measures or sum(m.number is not None for m in measures) < 0.8 * len(measures):
        return None
    # A misread (or hostile) bar number far beyond the bars actually read would
    # create that many rest bars; distrust the numbering instead.
    if max(m.number or 0 for m in measures) > 2 * len(measures) + 64:
        return None
    slots: dict[int, ScoreMeasure] = {}
    position = 0
    for measure in measures:
        target = measure.number if measure.number is not None else position + 1
        if target <= position:
            return None
        slots[target] = measure
        position = target
    missing = [n for n in range(1, position + 1) if n not in slots]
    score.measures = [slots.get(n) or _rest_bar(score) for n in range(1, position + 1)]
    for number, measure in enumerate(score.measures, start=1):
        measure.number = number
    return missing


def _fit(beats: list[ScoreBeat], units: int) -> list[ScoreBeat]:
    """Cut or pad (with rests) a bar's beats to ``units`` 32nds."""
    fitted: list[ScoreBeat] = []
    filled = 0
    for beat in beats:
        if filled + beat.duration <= units:
            fitted.append(beat)
            filled += beat.duration
            continue
        parts = split_units(int(units - filled))
        if parts:
            fitted.append(ScoreBeat(parts[0], beat.notes))
            fitted.extend(ScoreBeat(part) for part in parts[1:])
        filled = units
        break
    fitted.extend(ScoreBeat(part) for part in split_units(units - filled))
    return fitted


def _unify_bars(scores: list[Score], signature: tuple[int, int]) -> list[tuple[int, int]]:
    """Give all tracks the same time signature and repeat signs in each bar (Sheet Thief's GP5
    stored them once per bar for every track).

    A bar takes the time signature read by the first track that has it (bars filled in with rests
    keep the one in force); repeat signs and voltas found in any track apply to all. Returns the
    (track index, bar number) pairs whose notes did not fit the bar and were cut.
    """
    cut: list[tuple[int, int]] = []
    for index in range(len(scores[0].measures)):
        column = [score.measures[index] for score in scores]
        signature = next((m.time_signature for m in column if m.time_signature), signature)
        units = signature_units(signature)
        repeat_open = any(m.repeat_open for m in column)
        repeat_times = max(m.repeat_times for m in column)
        endings = next((m.endings for m in column if m.endings), ())
        tempo = next((m.tempo for m in column if m.tempo), None)
        sign = next((m.sign for m in column if m.sign), None)
        jump = next((m.jump for m in column if m.jump), None)
        for track, measure in enumerate(column):
            if measure.units != units:
                if measure.units > units and any(b.notes for b in measure.beats):
                    cut.append((track, index + 1))
                measure.beats = _fit(measure.beats, units)
            measure.time_signature = signature
            measure.repeat_open, measure.repeat_times, measure.endings = repeat_open, repeat_times, endings
            measure.tempo, measure.sign, measure.jump = tempo, sign, jump
    return cut


def _tidy_navigation(scores: list[Score], tempo: int) -> list[str]:
    """Keep only real tempo changes, and each navigation mark once (Sheet Thief's GP5 stored each
    of "Segno", "Coda", "D.S. al Coda"… for one bar only). Returns warnings for marks left out."""
    current = tempo
    seen: set[str] = set()
    dropped: list[str] = []
    for index in range(len(scores[0].measures)):
        column = [score.measures[index] for score in scores]
        first = column[0]
        change = first.tempo if first.tempo and first.tempo != current else None
        current = first.tempo or current
        marks = []
        for name in (first.sign, first.jump):
            if name and name in seen:
                dropped.append(tr(f"{name} (compasso {index + 1})", f"{name} (bar {index + 1})"))
            marks.append(name if name and name not in seen else None)
            if name:
                seen.add(name)
        for measure in column:
            measure.tempo = change
            measure.sign, measure.jump = marks
    if not dropped:
        return []
    return [
        tr(
            "Sinais de navegação repetidos ignorados (o GP5 guarda cada um uma só vez): " + ", ".join(dropped) + ".",
            "Repeated navigation marks ignored (the GP5 stores each one only once): " + ", ".join(dropped) + ".",
        )
    ]


def _drop_opening(systems: list[TabSystem], attribute: OverriddenMarks) -> None:
    """Forget the time signature / tempo mark printed in the first bar of a part: the override
    replaces it. Later changes, even on the first line, still apply."""
    if not systems:
        return
    first = systems[0]
    opening_end = first_bar_end(first)
    setattr(first, attribute, [mark for mark in getattr(first, attribute) if mark[0] >= opening_end])


def _expand_repeats(scores: list[Score], track_reports: list[dict], order: list[int], tempo: int = 0) -> None:
    """Write every track out in playing order (bars copied; repeat signs, voltas and D.C./D.S./Coda
    removed), and move the lyric syllables of each bar to every place the bar is played. A bar
    played after a jump gets the tempo in force at its place in the score."""
    in_force: list[int] = []
    for measure in scores[0].measures:
        tempo = measure.tempo or tempo
        in_force.append(tempo)
    for score in scores:
        measures = score.measures
        score.measures = [copy.deepcopy(measures[index]) for index in order]
        previous = None
        for number, (measure, index) in enumerate(zip(score.measures, order, strict=True), start=1):
            measure.number = number
            measure.repeat_open, measure.repeat_times, measure.endings = False, 0, ()
            measure.sign = measure.jump = None
            measure.tempo = in_force[index] if previous is not None and in_force[index] != previous else None
            if number == 1 and measures[index].tempo:
                measure.tempo = measures[index].tempo
            previous = in_force[index]
    for report in track_reports:
        by_bar: dict[int, list[tuple[int, float, str, bool]]] = {}
        for syllable in report["_lyrics"]:
            by_bar.setdefault(syllable[0], []).append(syllable)
        report["_lyrics"] = [
            (number, position, text, joins)
            for number, index in enumerate(order, start=1)
            for _, position, text, joins in by_bar.get(index + 1, [])
        ]


def _pad(score: Score, measures: int) -> int:
    """Append full-bar rests so every track has the same number of bars; returns bars added."""
    missing = measures - len(score.measures)
    score.measures.extend(_rest_bar(score) for _ in range(missing))
    return missing


def _opening_signature(parsed: _ParsedPdf) -> tuple[int, int] | None:
    """The time signature printed on the staff in the first bar of a part, as read (in range or not)."""
    try:
        _, kept = _main_staves(parsed.systems, [])
    except ConversionError:
        return None  # no notes: building the track says so
    if not kept:
        return None
    opening_end = first_bar_end(kept[0])
    marks = [(n, d) for x, n, d in sorted(kept[0].time_signatures) if x < opening_end]
    return marks[-1] if marks else None


def _setting(
    detected, effective, source: str, reason: str | None = None, raw: str | None = None, alternatives=()
) -> dict:
    """One music setting in the report (see CONTEXT.md): ``reason`` only explains a default."""
    return {
        "detected": detected,
        "effective": effective,
        "source": source,
        "reason": reason if source == "default" else None,
        "raw": raw,
        "alternatives": list(alternatives),
    }


def _tuning_value(midi: list[int] | None) -> dict | None:
    return None if midi is None else {"name": _tuning_name(midi), "midi": list(midi)}


def _tuning_setting(choice: TuningChoice) -> dict:
    return _setting(
        _tuning_value(choice.detected), _tuning_value(choice.midi), choice.source, choice.reason, choice.raw
    )


def _capo_setting(track: TrackOptions, metadata: SongMetadata) -> dict:
    """The capo of a part: the override, else the one its heading prints, else none."""
    detected = metadata.capo
    alternatives = [str(value) for value in metadata.capo_alternatives]
    if track.capo is not None:
        return _setting(detected, track.capo, "manual", raw=metadata.capo_raw, alternatives=alternatives)
    if detected is not None:
        return _setting(detected, detected, "detected", alternatives=alternatives)
    reason = "out_of_range" if metadata.capo_raw else "not_found"
    return _setting(None, DEFAULT_CAPO, "default", reason, metadata.capo_raw)


def convert(pdf: bytes, options: ConversionOptions) -> ConversionResult:
    return convert_many([pdf], options)


@dataclass
class BuiltTracks:
    """Each track as ``_build_track`` gives it (its score and report, the report still holding its
    ``_tuning``, ``_capo`` and ``_lyrics``), with what was read for the whole song. Nothing is cut or
    filled in yet: that comes after, in ``convert_many`` (``_align_by_numbers``, ``_unify_bars``…).
    Studio's JSON exit (``contract.py``) stops here (docs/spec/recognizer.md, section 5)."""

    scores: list[Score]
    track_reports: list[dict]
    detected: SongMetadata
    title: str
    artist: str
    tempo: int
    tempo_source: str
    tempo_reason: str | None
    numerator: int
    denominator: int
    signature_detected: tuple[int, int] | None
    signature_raw: str | None
    signature_alternatives: list[str]
    signature_source: str
    signature_reason: str | None


def build_tracks(pdfs: list[bytes], options: ConversionOptions) -> BuiltTracks:
    """Read one PDF per track and build each track's score, as read."""
    if not pdfs:
        raise ConversionError(tr("Nenhum PDF enviado.", "No PDF uploaded."))
    if len(pdfs) > MAX_TRACKS:
        raise ConversionError(
            tr(f"Máximo de {MAX_TRACKS} PDFs (tracks) por música.", f"Maximum of {MAX_TRACKS} PDFs (tracks) per song.")
        )
    multi = len(pdfs) > 1

    def labelled(index: int, message: str) -> str:
        filename = options.track(index).filename
        return f"Track {index + 1}{f' ({filename})' if filename else ''}: {message}" if multi else message

    parsed: list[_ParsedPdf] = []
    for index, pdf in enumerate(pdfs):
        try:
            # reading is nearly all the time; building the tracks takes the last 5 %
            parsed.append(_parse_pdf(pdf, options, progress=lambda f, i=index: _report(0.95 * (i + f) / len(pdfs))))
        except ConversionError as exc:
            raise ConversionError(labelled(index, str(exc)), diagnostics=exc.diagnostics) from exc

    event_count = sum(len(s.events) for p in parsed for s in p.systems)
    if event_count > options.max_events:
        raise ConversionError(
            tr(
                f"Tablatura demasiado grande ({event_count} notas; máximo {options.max_events}).",
                f"Tablature too large ({event_count} notes; maximum {options.max_events}).",
            )
        )

    detected = _merge_metadata([p.metadata for p in parsed])
    title = options.title.strip() or detected.title or ""
    artist = options.artist.strip() or detected.artist or ""
    # Recognition always reads the marks, also when an override replaces them (ADR 0002).
    tempo = options.tempo or detected.tempo or DEFAULT_TEMPO
    if options.tempo:
        tempo_source, tempo_reason = "manual", None
    elif detected.tempo:
        tempo_source, tempo_reason = "detected", None
    else:
        tempo_source, tempo_reason = "default", "out_of_range" if detected.tempo_raw else "not_found"
    overridden: list[OverriddenMarks] = []  # printed marks an override replaces in each part's first bar
    if options.tempo:
        overridden.append("tempos")
    # Time signature: the one on the staff in the first bar, else the heading's.
    staff = next((sign for sign in map(_opening_signature, parsed) if sign), None)
    readings = [sign for sign in (staff, (detected.numerator, detected.denominator)) if sign and sign[0]]
    usable = [sign for sign in readings if time_signature_in_range(*sign)]
    signature_raw = None
    if not usable:
        out_of_range = next((sign for sign in readings if not time_signature_in_range(*sign)), None)
        signature_raw = f"{out_of_range[0]}/{out_of_range[1]}" if out_of_range else detected.time_signature_raw
    signature_detected = usable[0] if usable else None
    signature_alternatives = [f"{n}/{d}" for n, d in dict.fromkeys(usable[1:]) if (n, d) != signature_detected]
    if options.numerator and options.denominator:
        numerator, denominator = options.numerator, options.denominator
        overridden.append("time_signatures")
        signature_source, signature_reason = "manual", None
    elif signature_detected:
        numerator, denominator = signature_detected
        signature_source, signature_reason = "detected", None
    else:
        numerator, denominator = DEFAULT_TIME_SIGNATURE
        signature_source, signature_reason = "default", "out_of_range" if signature_raw else "not_found"
    if staff and not time_signature_in_range(*staff) and "time_signatures" not in overridden:
        overridden.append("time_signatures")  # never written into the score: the value used replaces it
    rhythm = RhythmOptions(
        mode=options.rhythm_mode,
        fixed_value=options.fixed_value,
        numerator=numerator,
        denominator=denominator,
    )

    scores: list[Score] = []
    track_reports: list[dict] = []
    for index, item in enumerate(parsed):
        track = options.track(index)
        try:
            score, report = _build_track(item, track, rhythm, _track_name(index, track, item, detected), overridden)
        except ConversionError as exc:
            raise ConversionError(labelled(index, str(exc))) from exc
        scores.append(score)
        track_reports.append(report)
    return BuiltTracks(
        scores=scores,
        track_reports=track_reports,
        detected=detected,
        title=title,
        artist=artist,
        tempo=tempo,
        tempo_source=tempo_source,
        tempo_reason=tempo_reason,
        numerator=numerator,
        denominator=denominator,
        signature_detected=signature_detected,
        signature_raw=signature_raw,
        signature_alternatives=signature_alternatives,
        signature_source=signature_source,
        signature_reason=signature_reason,
    )


def convert_many(pdfs: list[bytes], options: ConversionOptions) -> ConversionResult:
    """Convert one PDF per track into scores with the same bars."""
    built = build_tracks(pdfs, options)
    scores, track_reports, detected = built.scores, built.track_reports, built.detected
    title, artist, tempo = built.title, built.artist, built.tempo
    numerator, denominator = built.numerator, built.denominator
    multi = len(pdfs) > 1

    aligned: list[bool] = []
    for score, report in zip(scores, track_reports, strict=True):
        missing = _align_by_numbers(score)
        aligned.append(missing is not None)
        report["missing_bars"] = missing or []
        if missing:
            report["warnings"].append(
                tr(
                    f"Compassos não encontrados no PDF, preenchidos com pausa: {_ranges(missing)}.",
                    f"Bars not found in the PDF, filled with rests: {_ranges(missing)}.",
                )
            )
    total_measures = max(len(s.measures) for s in scores)
    if total_measures > options.max_measures:
        raise ConversionError(
            tr(
                f"A música tem {total_measures} compassos; o máximo é {options.max_measures}.",
                f"The song has {total_measures} bars; the maximum is {options.max_measures}.",
            )
        )
    for score, report, by_number in zip(scores, track_reports, aligned, strict=True):
        first_added = len(score.measures) + 1
        added = _pad(score, total_measures)
        if added:
            report["missing_bars"].extend(range(first_added, total_measures + 1))
            where = (
                ""
                if by_number
                else tr(
                    " (sem numeração de compassos no PDF: pode estar desalinhada)",
                    " (no bar numbers in the PDF: it may be misaligned)",
                )
            )
            report["warnings"].append(
                tr(
                    f"Tem {first_added - 1} compassos e a música tem {total_measures}: "
                    f"acrescentados {added} compasso(s) de pausa no fim{where}.",
                    f"It has {first_added - 1} bar(s) and the song has {total_measures}: "
                    f"added {added} rest bar(s) at the end{where}.",
                )
            )

    cut = _unify_bars(scores, (numerator, denominator))
    for track, bar in cut:
        track_reports[track]["warnings"].append(
            tr(
                f"Compasso {bar}: as notas não cabem na métrica do compasso; o excesso foi cortado.",
                f"Bar {bar}: the notes do not fit the bar's time signature; the excess was cut.",
            )
        )
    song_warnings: list[str] = _tidy_navigation(scores, tempo)
    repeats = sum(1 for measure in scores[0].measures if measure.repeat_times)
    tempo_changes = [{"bar": n, "tempo": m.tempo} for n, m in enumerate(scores[0].measures, start=1) if m.tempo]
    navigation = [
        {"bar": n, "name": name} for n, m in enumerate(scores[0].measures, start=1) for name in (m.sign, m.jump) if name
    ]
    expanded = False
    if options.expand_repeats and (repeats or navigation or any(m.endings for m in scores[0].measures)):
        order = playback_order(scores[0].measures, options.max_measures + 1)
        if len(order) > options.max_measures:
            song_warnings.append(
                tr(
                    f"Repetições por extenso: a música teria mais de {options.max_measures} compassos; "
                    "ficam as repetições.",
                    f"Repeats written out: the song would have more than {options.max_measures} bars; "
                    "the repeats are kept.",
                )
            )
        else:
            _expand_repeats(scores, track_reports, order, tempo)
            total_measures = len(order)
            expanded = True
    meters = [measure.time_signature or (numerator, denominator) for measure in scores[0].measures]

    lyric_candidates = [i for i, r in enumerate(track_reports) if r["_lyrics"]]
    lyrics: dict | None = None  # the track the lyrics line goes on, when there is one
    timed_lyrics: list[list] = []
    lyric_warnings: list[str] = []
    lyrics_track_name = ""
    if lyric_candidates:
        # The lyrics printed in one PDF; they are sung over bars where that part may rest, and
        # Guitar Pro can only show a syllable on a played note. Bars are aligned across tracks,
        # so put them on the track that plays in most of the bars that have lyrics.
        source = max(lyric_candidates, key=lambda i: len(track_reports[i]["_lyrics"]))
        syllables = track_reports[source]["_lyrics"]

        def coverage(index: int) -> tuple[int, int]:
            measures = scores[index].measures
            played = {n for n, m in enumerate(measures, start=1) if any(not b.is_rest for b in m.beats)}
            return sum(bar in played for bar, *_ in syllables), track_reports[index]["notes"]

        if len(scores) < MAX_TRACKS:
            # A silent "Letra (voz)" track with a note per syllable: every syllable has a note.
            scores.append(_vocal_score(syllables, meters))
            _unify_bars(scores, (numerator, denominator))  # the repeat signs
            chosen = len(scores) - 1
            lyrics_track_name = VOCAL_TRACK_NAME
        else:  # no room for another track: the part playing in most bars with lyrics
            chosen = max(range(len(scores)), key=coverage)
            lyrics_track_name = track_reports[chosen]["name"]
        line, dropped = _lyrics_text(syllables, scores[chosen])
        if line:
            lyrics = {"track": lyrics_track_name}
        if dropped:
            lyric_warnings.append(
                tr(
                    f"Letra: no GP5 fica na track {lyrics_track_name}, que não toca nos compassos "
                    f"{_ranges(dropped)}; a letra desses compassos não pode ficar no GP5 (o Guitar Pro só mostra "
                    "uma sílaba numa nota tocada). A pista 3D da aplicação mostra a letra completa.",
                    f"Lyrics: in the GP5 they go on the {lyrics_track_name} track, which does not play in bars "
                    f"{_ranges(dropped)}; the lyrics of those bars cannot go in the GP5 (Guitar Pro only shows "
                    "a syllable on a played note). The app's 3D highway shows the full lyrics.",
                )
            )
        # Every syllable with its place in the music, for the page (lyrics line on the 3D highway).
        timed_lyrics = [[bar, round(position, 4), text, joins] for bar, position, text, joins in syllables]
    for report in track_reports:
        del report["_lyrics"]
    tuning_choice: TuningChoice = track_reports[0]["_tuning"]
    capo_setting = track_reports[0]["_capo"]
    for report in track_reports:
        del report["_tuning"], report["_capo"]
    sections = []
    for index in range(total_measures):
        name = next((s.measures[index].marker for s in scores if s.measures[index].marker), None)
        if name:
            sections.append({"bar": index + 1, "name": name})

    for score, report in zip(scores[: len(track_reports)], track_reports, strict=True):  # not the lyrics track
        _flag_estimated_rhythm(score, report)
    warnings = (
        [f"{r['name']}: {w}" if multi else w for r in track_reports for w in r["warnings"]]
        + song_warnings
        + lyric_warnings
    )
    report = {
        "title": title,
        "artist": artist,
        "tempo": tempo,
        "time_signature": f"{meters[0][0]}/{meters[0][1]}",
        # Bars where the time signature changes, and repeats (":|") in the song.
        "time_signature_changes": [
            {"bar": bar, "time_signature": f"{n}/{d}"}
            for bar, (previous, (n, d)) in enumerate(itertools.pairwise(meters), start=2)
            if (n, d) != previous
        ],
        "repeats": repeats,
        "tempo_changes": tempo_changes,
        "navigation": navigation,  # Segno / Coda / Fine and D.C. / D.S. / To Coda, by bar
        "repeats_expanded": expanded,  # written out in playing order (no repeat signs in the file)
        "auto": {
            "title": not options.title.strip() and bool(detected.title),
            "artist": not options.artist.strip() and bool(detected.artist),
            "tempo": not options.tempo and detected.tempo is not None,
            "time_signature": not (options.numerator and options.denominator) and detected.numerator is not None,
        },
        # Each music setting: what the picture says, the value written and where it came from.
        "settings": {
            "tempo": _setting(detected.tempo, tempo, built.tempo_source, built.tempo_reason, detected.tempo_raw),
            "time_signature": _setting(
                f"{built.signature_detected[0]}/{built.signature_detected[1]}" if built.signature_detected else None,
                f"{meters[0][0]}/{meters[0][1]}",
                built.signature_source,
                built.signature_reason,
                built.signature_raw,
                built.signature_alternatives,
            ),
            "tuning": _tuning_setting(tuning_choice),
            "capo": capo_setting,
        },
        "measures": total_measures,
        "notes": sum(r["notes"] for r in track_reports),
        "sections": sections,
        "lyrics": lyrics,
        "timed_lyrics": timed_lyrics,
        "warnings": warnings,
        "tracks": track_reports,
    }
    return ConversionResult(scores=scores, report=report)


def inspect(pdf: bytes, options: ConversionOptions) -> dict:
    """Detect song metadata and the track's part, so the user can review them before converting."""
    parsed = _parse_pdf(pdf, options, frets=False)
    meta = parsed.metadata
    pictures_only = all(s.source == "image" for s in parsed.systems)
    string_count, kept = _main_staves(parsed.systems, [], notes_read=not pictures_only)
    labels = next((s.labels for s in kept if s.labels), []) or list(meta.tuning_labels)
    tuning = resolve_tuning("auto", string_count, labels, meta.tuning_raw).midi
    return {
        "title": meta.title,
        "artist": meta.artist,
        "tempo": meta.tempo,
        "time_signature": f"{meta.numerator}/{meta.denominator}" if meta.numerator and meta.denominator else None,
        # Part label printed in the PDF; the client falls back to the file name once it
        # knows the song title/artist from all PDFs (same rule as track_name_from_filename).
        "part_name": parsed.part_name,
        "strings": string_count,
        "tuning": _tuning_name(tuning),
    }
