"""The service's limits, from environment variables (docs/spec/recognizer.md, section 4).

Only what the recognition needs of Sheet Thief's ``app/config.py``, with its names and defaults:
an environment variable named after a field in upper case (``WORKER_MEMORY_MB=2048``) overrides it.
Its database, session and web settings are not copied.
"""

from __future__ import annotations

import dataclasses
import os
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache

MB = 1024 * 1024


@dataclass(frozen=True)
class Settings:
    # Uploads
    max_upload_mb: int = 10
    max_total_upload_mb: int = 40
    max_image_pages: int = 15
    max_image_megapixels: int = 40

    # Recognition
    conversion_timeout_s: int = 120  # without progress (a page read)
    max_job_timeout_s: int = 900  # whole job, however it advances
    # Address space of one recognition child: decoding the pictures plus OCR (onnxruntime) needs ~2.5 GB.
    worker_memory_mb: int = 3072
    # One recognition at a time is not a setting: the HTTP service answers 503 to a second one (service.py).
    max_pages: int = 40
    max_events: int = 50_000
    max_measures: int = 2000

    def __post_init__(self) -> None:
        for item in dataclasses.fields(self):
            value = getattr(self, item.name)
            if type(value) is not int or value <= 0:
                raise ValueError(f"{item.name} must be a positive integer, not {value!r}")

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        environ = os.environ if environ is None else environ
        values: dict[str, int] = {}
        for item in dataclasses.fields(cls):
            raw = environ.get(item.name.upper())
            if raw is None or not raw.strip():
                continue
            try:
                values[item.name] = int(raw)
            except ValueError as exc:
                raise ValueError(f"{item.name.upper()} must be a positive integer, not {raw!r}") from exc
        return cls(**values)

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * MB

    @property
    def max_total_upload_bytes(self) -> int:
        return self.max_total_upload_mb * MB

    @property
    def max_image_pixels(self) -> int:
        return self.max_image_megapixels * 1_000_000


@lru_cache
def get_settings() -> Settings:
    return Settings.from_env()
