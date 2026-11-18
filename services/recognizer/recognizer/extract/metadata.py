"""Detect song title, artist, tempo, time signature, tuning and capo from the first page."""

from __future__ import annotations

import re
from dataclasses import dataclass
from statistics import median
from typing import NamedTuple

from ..music_settings import capo_in_range, tempo_in_range, time_signature_in_range
from .pdf_reader import Char, Page, TextLine, group_lines

# SMuFL metronome note glyphs -> tempo factor relative to a quarter note.
_METRONOME_NOTES = {
    "": 2.0,  # half note up
    "": 2.0,
    "": 1.0,  # quarter note up
    "": 1.0,
    "": 0.5,  # eighth note up
    "": 0.5,
    "": 1.0,  # noteQuarterUp
    "♩": 1.0,  # ♩
}
_METRONOME_DOT = ""
TIME_SIGNATURE_DIGITS = {chr(0xE080 + d): d for d in range(10)}
COMMON_TIME, CUT_TIME = "", ""

# Up to four digits, so a misread "1200" is reported as read (out of range), not cut to "120".
_TEMPO_PATTERNS = [
    re.compile(r"(?P<note>[-♩])\s*(?P<dot>[.]?)\s*=\s*(?P<bpm>\d{2,4})\b"),
    re.compile(r"^\W*=\s*(?P<bpm>\d{2,4})\b"),
    re.compile(r"\b(?:tempo|bpm)\s*[:=]?\s*(?P<bpm>\d{2,4})\b", re.IGNORECASE),
    re.compile(r"\b(?P<bpm>\d{2,4})\s*bpm\b", re.IGNORECASE),
]
_LABELLED = {
    "title": re.compile(r"^\s*(?:title|song|t[ií]tulo|m[uú]sica)\s*[:\-]\s*(?P<v>.+)$", re.IGNORECASE),
    "artist": re.compile(r"^\s*(?:artist|artista|band|banda|performed by)\s*[:\-]\s*(?P<v>.+)$", re.IGNORECASE),
}
_CREDIT = re.compile(r"^\s*(?:words\s*(?:and|&)\s*music\s+by|music\s+by|by|por)\s+(?P<v>.+)$", re.IGNORECASE)
_NOT_ARTIST = re.compile(r"tuning|afina|tempo|capo|words\s+by|arranged|transcri|page|p[aá]gina|=|:", re.IGNORECASE)


# The heading of a page printed as text is in its top 30 %: the title, the artist, the part, the capo.
HEADING_AREA = 0.3


def in_heading(line: TextLine, page: Page) -> bool:
    return line.top < HEADING_AREA * page.height


@dataclass(frozen=True)
class SongMetadata:
    title: str | None = None
    artist: str | None = None
    tempo: int | None = None
    numerator: int | None = None
    denominator: int | None = None
    tuning_labels: tuple[str, ...] = ()  # string 1 (highest) first
    capo: int | None = None  # 0: the heading says no capo
    # Marks read but not used, kept to explain why: a tempo, time signature or capo out of range
    # ("1200", "7/3", "Capo 30"), a "Tuning:" line whose notes cannot be read.
    tempo_raw: str | None = None
    time_signature_raw: str | None = None
    tuning_raw: str | None = None
    capo_raw: str | None = None
    capo_alternatives: tuple[int, ...] = ()  # other capo values printed


def line_text(line: TextLine) -> str:
    """Line text with spaces restored from horizontal gaps (PDFs rarely store them)."""
    out: list[str] = []
    prev: Char | None = None
    for char in line.chars:
        if prev is not None and char.x0 - prev.x1 > 0.2 * (char.bottom - char.top):
            out.append(" ")
        out.append(char.text)
        prev = char
    return "".join(out).strip()


def _is_music_glyph(text: str) -> bool:
    return any("" <= ch <= "" or ch == "♩" for ch in text)


def tempo_from_text(text: str) -> int | None:
    """BPM of a tempo mark ("♩ = 90", "= 90", "Tempo 90", "90 bpm"), or None."""
    return _detect_tempo([text])


def tempo_readings(texts: list[str]) -> list[tuple[str, float]]:
    """Every tempo mark in the lines, in range or not, as (the number printed, BPM of a quarter
    note): a half note = 300 is ("300", 600.0). One mark per line: the most specific pattern."""
    readings: list[tuple[str, float]] = []
    for text in texts:
        match = next((found for pattern in _TEMPO_PATTERNS if (found := pattern.search(text))), None)
        if not match:
            continue
        bpm = float(match.group("bpm"))
        groups = match.groupdict()
        if groups.get("note"):
            bpm *= _METRONOME_NOTES[groups["note"]] * (1.5 if groups.get("dot") else 1.0)
        readings.append((match.group("bpm"), bpm))
    return readings


def _detect_tempo(texts: list[str]) -> int | None:
    return _tempo(tempo_readings(texts))[0]


def _tempo(readings: list[tuple[str, float]]) -> tuple[int | None, str | None]:
    """(the first BPM in range, else None and the first mark read as printed: "1200")."""
    usable = next((round(bpm) for _, bpm in readings if tempo_in_range(bpm)), None)
    if usable is not None or not readings:
        return usable, None
    return None, readings[0][0]


def _detect_time_signature(page: Page) -> tuple[int, int] | None:
    """First stacked pair of SMuFL time-signature glyphs (or common/cut time), when in range."""
    signature = _read_time_signature(page)
    return signature if signature and time_signature_in_range(*signature) else None


def _read_time_signature(page: Page) -> tuple[int, int] | None:
    """First stacked pair of SMuFL time-signature glyphs (or common/cut time), as read."""
    glyphs = sorted((c for c in page.chars if c.text in TIME_SIGNATURE_DIGITS), key=lambda c: (c.x0, c.top))
    for special in page.chars:
        if special.text == COMMON_TIME and (not glyphs or special.x0 < glyphs[0].x0):
            return 4, 4
        if special.text == CUT_TIME and (not glyphs or special.x0 < glyphs[0].x0):
            return 2, 2
    if not glyphs:
        return None
    first = glyphs[0]
    width = first.x1 - first.x0
    cluster = [c for c in glyphs if first.x0 - width <= c.x0 <= first.x1 + width]
    tops = sorted({round(c.top) for c in cluster})
    if len(tops) != 2:
        return None
    rows = [sorted((c for c in cluster if round(c.top) == t), key=lambda c: c.x0) for t in tops]
    numerator, denominator = (int("".join(str(TIME_SIGNATURE_DIGITS[c.text]) for c in row)) for row in rows)
    return numerator, denominator


class CapoReading(NamedTuple):
    """The capo printed in a heading: the first value in range (0 = no capo), else None and the
    first mark out of range as printed ("Capo 30"); the other values in range printed, in order."""

    detected: int | None
    raw: str | None
    alternatives: tuple[int, ...]


_ROMAN = dict(
    zip(("I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"), range(1, 13), strict=True)
)
# The word, a number may be joined to it ("Capo3"), and what follows it: "Capo 3", "Capo: 3",
# "CAPO - 3", "Capo-3", "capo on/at 3", "Capo 3rd fret", "Capo on the 2nd fret", "capo fret 6", "Capo: III"
# (capital Roman numerals I–XII, a word of their own: text recognition may read an "I" as "l" and
# split the numeral, "Capo:I lI"), "Capotraste na 3ª casa". "Capo -1" is a capo out of range.
_CAPO_WORD = r"\bcapo(?:traste)?(?![^\W\d_])"


def _capo_value(capture: bool) -> str:
    """The pattern of what follows the word in a capo mark (": 3", " on the 3rd fret", " III").
    With ``capture`` the number is group ``n`` and the Roman numeral group ``roman``; without, the
    pattern has no groups, to be used again in the same expression (a group is named only once)."""
    n, roman = ("?P<n>", "?P<roman>") if capture else ("?:", "?:")
    return (
        # a hyphen is a sign only between a space and the number
        r"\s*(?:[:=–]|-(?=\s)|(?<!\s)-)?\s*(?:(?:on|at|na|no|em)\s+)?(?:the\s+)?(?:(?:fret|casa)\s+)?"
        rf"(?:({n}-?\d{{1,3}})(?:st|nd|rd|th|ª|º)?|(?-i:({roman}[IVX](?:[IVXl]|(?<=[Il]) (?=[Il]))*)))"
        r"(?:\s+(?:fret|casa))?(?!\w)"
    )


# A capo mark; "No capo" / "without capo" (no capo, when no number follows); and "Da Capo", read
# only to be left out ("Da Capo II" is no capo 2; "D.C." and "capo al Fine" have no number).
_CAPO = re.compile(
    rf"(?P<none>\b(?:no|without|sem)\s+{_CAPO_WORD}(?!{_capo_value(capture=False)}))"
    rf"|(?P<repeat>\bda\s*{_CAPO_WORD})"
    rf"|{_CAPO_WORD}{_capo_value(capture=True)}",
    re.IGNORECASE,
)


def read_capo(texts: list[str]) -> CapoReading:
    """The capo marks in the lines of a heading ("Capo 3", "No capo")."""
    readings: list[tuple[str, int]] = []  # (as printed, value)
    for text in texts:
        for match in _CAPO.finditer(text):
            if match.group("repeat"):
                continue
            if match.group("none"):
                value = 0
            elif match.group("n"):
                value = int(match.group("n"))
            elif (value := _ROMAN.get(match.group("roman").replace(" ", "").replace("l", "I"))) is None:
                continue  # "Capo XIII": not a numeral of a fret
            readings.append((match.group(0).strip(), value))
    usable = list(dict.fromkeys(value for _, value in readings if capo_in_range(value)))
    if usable:
        return CapoReading(usable[0], None, tuple(usable[1:]))
    return CapoReading(None, readings[0][0] if readings else None, ())


_TUNING_LINE = re.compile(r"^\s*(?:tuning|afina[cç][aã]o)\s*(?P<sep>[:\-]?)\s*(?P<v>.+)$", re.IGNORECASE)
_NOTE_TOKEN = re.compile(r"^[A-Ga-g](?:#|b|♯|♭)?$")
_JOINED_NOTES = re.compile(r"(?:[A-G][#b]?){2,7}")


def _detect_tuning(texts: list[str]) -> tuple[str, ...]:
    """Labels (string 1 first) from a line like "Tuning: E A D G B E" (written low to high)
    or a named tuning ("Tuning: Drop D")."""
    return _read_tuning(texts)[0]


def _read_tuning(texts: list[str]) -> tuple[tuple[str, ...], str | None]:
    """Labels of the first "Tuning:" line that can be read; or () and the text of one that cannot."""
    from ..tunings import TUNING_NAMES, TUNINGS

    unreadable = None
    names = {k: _NOTE_NAMES_OF(TUNINGS[v]) for k, v in TUNING_NAMES.items()}
    for text in texts:
        match = _TUNING_LINE.match(text)
        if not match:
            continue
        value = match.group("v").strip().lower().rstrip(".")
        if value in names:
            return names[value], None
        tokens = [t.replace("♯", "#").replace("♭", "b") for t in re.split(r"[\s,\-–]+", match.group("v").strip()) if t]
        # notes printed without spaces between some or all of them ("D# G# C# F#A# D#")
        tokens = [n for t in tokens for n in (re.findall(r"[A-G][#b]?", t) if _JOINED_NOTES.fullmatch(t) else [t])]
        if 4 <= len(tokens) <= 7 and all(_NOTE_TOKEN.match(t) for t in tokens):
            return tuple(t[0].upper() + t[1:] for t in reversed(tokens)), None
        if match.group("sep"):  # "Tuning: …" names a tuning; "Tuning is great" is just text
            unreadable = unreadable or match.group("v").strip()[:40]
    return (), unreadable


def _NOTE_NAMES_OF(midi: tuple[int, ...]) -> tuple[str, ...]:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return tuple(names[m % 12] for m in midi)


# A web address: the header of a printed web page, or a browser's address bar in a screenshot,
# often in bigger letters than the title.
_WEB_ADDRESS = re.compile(r"https?://|www\.|\b[\w-]+\.(?:com|net|org|io)\b", re.IGNORECASE)


def _visual_title_artist(page: Page, lines: list[TextLine]) -> tuple[str | None, str | None]:
    """Largest text near the top is the title; the next credit-like line is the artist. A web
    address is neither, and does not count among the text sizes."""
    lines = [line for line in lines if not _WEB_ADDRESS.search(line_text(line))]
    if not lines:
        return None, None
    top_area = [line for line in lines if in_heading(line, page)]
    candidates = [
        line for line in top_area if re.search(r"[A-Za-zÀ-ÿ]{2,}", line_text(line)) and not _is_music_glyph(line.text)
    ]
    if not candidates:
        return None, None
    heights = [line.bottom - line.top for line in lines]
    title_line = max(candidates, key=lambda line: line.bottom - line.top)
    if (title_line.bottom - title_line.top) < 1.3 * median(heights):
        return None, None  # uniform font: no visual hierarchy to rely on
    artist = None
    for line in candidates:
        if line.top <= title_line.top:
            continue
        text = line_text(line)
        credit = _CREDIT.match(text)
        if credit:
            artist = credit.group("v").strip()
            break
        if artist is None and not _NOT_ARTIST.search(text):
            artist = text
    return line_text(title_line), artist


# Titles of song pages printed to PDF from the web (the PDF keeps the page title; Windows'
# "Print to PDF" turns the characters a file name cannot have, such as " and |, into _).
_SITE_TITLES = (
    # "_NIGHTFALL_ Tab by Varia _ Songsterr Tabs with Rhythm", "Song Bass Tab by Artist | Songsterr"
    re.compile(
        r"^[\s_\"'“”]*(?P<t>.+?)[\s_\"'“”]*\s+(?:\w+\s+)?(?:Tab|Tabs|Chords)\s+by\s+(?P<a>.+?)\s*[_|]\s*Songsterr",
        re.IGNORECASE,
    ),
    # "OFFICIAL SONG CHORDS & TABS by Artist @ Site.Com"
    re.compile(
        r"^(?:OFFICIAL\s+)?(?P<t>.+?)\s+(?:CHORDS\s*&\s*TABS|CHORDS|TABS?|BASS\s+TABS?|PRO)\s+(?:\(ver\s*\d+\)\s+)?"
        r"by\s+(?P<a>.+?)\s*@\s*\w[\w -]*\.(?:com|net|org)\b",
        re.IGNORECASE,
    ),
)


def _site_title(text: str) -> tuple[str, str] | None:
    for pattern in _SITE_TITLES:
        match = pattern.search(text)
        if match:
            return match.group("t").strip(), match.group("a").strip()
    return None


def detect_metadata(pages: list[Page], info: dict[str, str] | None = None, heading_only: bool = False) -> SongMetadata:
    """``heading_only``: page 1 holds only heading text (read above the first staff of a picture),
    else its heading is its top HEADING_AREA."""
    if not pages:
        return SongMetadata()
    page = pages[0]
    lines = group_lines(page.chars)
    texts = [line_text(line) for line in lines]

    labelled: dict[str, str] = {}
    for text in texts:
        for key, pattern in _LABELLED.items():
            match = pattern.match(text)
            if match and key not in labelled:
                labelled[key] = match.group("v").strip()

    visual_title, visual_artist = _visual_title_artist(page, lines)
    info = info or {}
    # A web page printed to PDF: its title names the song and the artist ("… Tab by Varia |
    # Songsterr…"); the Author is then the computer's user, not the artist.
    site = _site_title(info.get("Title") or "")
    title = labelled.get("title") or visual_title or (site[0] if site else info.get("Title"))
    artist = labelled.get("artist") or visual_artist or (site[1] if site else info.get("Author"))
    title = title.strip().strip("\"'“”‘’«»_").strip() if title else title
    read_signature = _read_time_signature(page)
    tempo, tempo_raw = _tempo(tempo_readings(texts))
    signature = read_signature if read_signature and time_signature_in_range(*read_signature) else None
    tuning_labels, tuning_raw = _read_tuning(texts)
    capo = read_capo([line_text(line) for line in lines if heading_only or in_heading(line, page)])
    return SongMetadata(
        tuning_labels=tuning_labels,
        title=title[:100] if title else None,
        artist=artist[:100] if artist else None,
        tempo=tempo,
        numerator=signature[0] if signature else None,
        denominator=signature[1] if signature else None,
        tempo_raw=tempo_raw,
        time_signature_raw=f"{read_signature[0]}/{read_signature[1]}" if read_signature and not signature else None,
        tuning_raw=tuning_raw,
        capo=capo.detected,
        capo_raw=capo.raw,
        capo_alternatives=capo.alternatives,
    )


_PART_NAME = re.compile(
    r"\b(?:(?:electric|acoustic|classical|lead|rhythm|solo|clean|distortion)\s+)?"
    r"(?:guitar|bass|guitarra|baixo|viol[aã]o|ukulele|banjo)(?:\s*\d+)?\b",
    re.IGNORECASE,
)


# Songsterr's part line under the title: "Track: Rhythm Guitar (retranscribed) - Distortion Guitar".
_TRACK_LINE = re.compile(r"^\s*Track\s*:\s*(?P<v>.+?)(?:\s*\(|\s+-\s+|$)", re.IGNORECASE)


def detect_part_name(pages: list[Page], metadata: SongMetadata) -> str | None:
    """Instrument/part label printed near the top of page 1 (e.g. "Electric Guitar", "Bass")."""
    if not pages:
        return None
    page = pages[0]
    for line in group_lines(page.chars):
        if not in_heading(line, page):
            break
        text = line_text(line)
        track = _TRACK_LINE.match(text)
        if track and track.group("v").strip():
            return track.group("v").strip()[:40]
        if text in (metadata.title, metadata.artist) or len(text) > 40:
            continue
        match = _PART_NAME.search(text)
        if match:
            return match.group(0).strip().title()
    return None


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def track_name_from_filename(filename: str, title: str | None, artist: str | None) -> str | None:
    """Part name from a file like "Artist - Song - Bass.pdf": what remains after removing song/artist."""
    stem = re.sub(r"\.(?:pdf|png|jpe?g|webp)$", "", filename.replace("\\", "/").rsplit("/", 1)[-1], flags=re.IGNORECASE)
    stem = stem.replace("_", " ")
    known = {_normalize(value) for value in (title, artist) if value}
    parts = [p.strip() for p in re.split(r"\s+-\s+|\s*[–—]\s*", stem) if p.strip()]
    remaining = [p for p in parts if _normalize(p) not in known]
    return " - ".join(remaining)[:40] or None
