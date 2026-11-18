"""Warnings with a stable code (docs/spec/recognizer.md, section 5.1).

Sheet Thief's core writes its warnings as sentences for people, in Portuguese or English. Studio
reports a code and its parameters only: each warning the contract has a code for is a ``Notice``, a
``str`` (the sentence, still read by the core and its tests as before) that also carries the code.
The JSON exit (``contract.py``) reports the codes and writes the sentences only to the log.
"""

from __future__ import annotations


class Notice(str):
    """A warning's text, with its ``code`` and ``params``."""

    code: str
    params: dict[str, int]

    def __new__(cls, text: str, code: str, **params: int) -> Notice:
        notice = super().__new__(cls, text)
        notice.code = code
        notice.params = params
        return notice


# Warnings the contract does not report, because the result already says so: the tuning's
# ``source`` and ``reason``; and that the tab was read from a picture, as every Studio recognition is.
TUNING = "tuning"
PICTURE = "picture"
