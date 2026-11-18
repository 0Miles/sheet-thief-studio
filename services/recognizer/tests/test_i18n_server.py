"""Server messages follow the request's language (header X-App-Lang); Portuguese without it."""

import pytest

from recognizer import i18n
from recognizer.converter import ConversionError, ConversionOptions, TrackOptions, convert_many
from recognizer.sandbox import run_isolated
from tests.pdf_factory import ascii_tab_pdf, blank_pdf

TAB = [
    "e|-0---3---5h7---|",
    "B|---------------|",
    "G|---------------|",
    "D|---------------|",
    "A|---------------|",
    "E|---------------|",
]
BASS = ["G|-------------|", "D|-------------|", "A|-3---5---7---|", "E|-------------|"]


@pytest.fixture
def lang():
    tokens = []

    def use(code):
        tokens.append(i18n.use(code))

    yield use
    for token in reversed(tokens):
        i18n.reset(token)


def test_conversion_error_from_the_worker_process_follows_the_language(lang):
    with pytest.raises(ConversionError, match="não contém texto nem imagens"):
        run_isolated(blank_pdf(), ConversionOptions(), timeout_s=30, memory_mb=1024)
    lang("en")
    with pytest.raises(ConversionError, match="no text and no images"):
        run_isolated(blank_pdf(), ConversionOptions(), timeout_s=30, memory_mb=1024)


def test_conversion_warning_follows_the_language(lang):
    guitar = ascii_tab_pdf([TAB, TAB], extra_lines=["Title: Riff Song", "Tempo: 100"])
    bass = ascii_tab_pdf([[line.replace("|", "|--", 1) for line in BASS]])
    options = ConversionOptions(tracks=(TrackOptions(filename="Lead.pdf"), TrackOptions(filename="Bass.pdf")))
    portuguese = convert_many([guitar, bass], options).report["warnings"]
    lang("en")
    english = convert_many([guitar, bass], options).report["warnings"]
    assert any("Bass: It has 1 bar(s)" in w and "rest bar(s)" in w for w in english)
    assert any("Bass: Tem 1 compassos" in w and "pausa" in w for w in portuguese)


def test_request_header_sets_the_language():
    seen = []

    async def app(scope, receive, send):
        seen.append(i18n.current())

    import asyncio

    middleware = i18n.LanguageMiddleware(app)
    for header in ([(b"x-app-lang", b"en")], [(b"x-app-lang", b"EN")], [(b"x-app-lang", b"zh-Hant")], []):
        asyncio.run(middleware({"type": "http", "headers": header}, None, None))
    assert seen == ["en", "en", "pt", "pt"]


def test_unknown_language_reads_english(lang):
    lang("xx")
    assert i18n.tr("não", "no") == "no"
