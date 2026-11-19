"""The sensible range of each music setting, defined once: the API validates overrides with it,
recognition rejects (never clamps) readings outside it, and ``/api/options`` hands it to the page."""

from __future__ import annotations

from typing import Literal, NamedTuple

from .tunings import TUNINGS


class MusicSetting(NamedTuple):
    """One music setting's names: in the API (camelCase), in requests and the recognition report
    (snake_case), and its override column."""

    api: str
    key: str

    @property
    def column(self) -> str:
        return f"{self.key}_override"


MUSIC_SETTINGS = (
    MusicSetting("tuning", "tuning"),
    MusicSetting("capo", "capo"),
    MusicSetting("tempo", "tempo"),
    MusicSetting("timeSignature", "time_signature"),
)

# Where a setting's effective value came from, and why a default was used (CONTEXT.md).
Source = Literal["manual", "detected", "default"]
Reason = Literal["not_found", "unrecognized", "out_of_range", "string_count_mismatch"]

# Version of the recognition snapshot stored in Project.recognized_settings.
SNAPSHOT_VERSION = 2

CAPO_RANGE = (0, 24)
TEMPO_RANGE = (20, 400)
NUMERATOR_RANGE = (1, 16)
DENOMINATORS = (2, 4, 8, 16)
TIME_SIGNATURE_PATTERN = (
    "^("
    + "|".join(str(n) for n in range(NUMERATOR_RANGE[0], NUMERATOR_RANGE[1] + 1))
    + ")/("
    + "|".join(str(d) for d in DENOMINATORS)
    + ")$"
)
# Recognition reads six-string guitar TAB: an override can only name one of those tunings.
PROJECT_TUNINGS = tuple(name for name, notes in TUNINGS.items() if len(notes) == 6)

# The defaults used when a picture says nothing usable.
DEFAULT_TEMPO = 120
DEFAULT_TIME_SIGNATURE = (4, 4)
DEFAULT_CAPO = 0


def capo_in_range(fret: int) -> bool:
    return CAPO_RANGE[0] <= fret <= CAPO_RANGE[1]


def tempo_in_range(bpm: float) -> bool:
    return TEMPO_RANGE[0] <= bpm <= TEMPO_RANGE[1]


def time_signature_in_range(numerator: int, denominator: int) -> bool:
    return NUMERATOR_RANGE[0] <= numerator <= NUMERATOR_RANGE[1] and denominator in DENOMINATORS
