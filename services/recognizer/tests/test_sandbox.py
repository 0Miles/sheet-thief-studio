import io
import threading
import time

import pytest
from PIL import Image

from recognizer import sandbox
from recognizer.converter import ConversionError, ConversionOptions
from recognizer.recognition_errors import recognition_error
from recognizer.sandbox import GENERIC_ERROR, ConversionCancelled, ConversionTimeout, _decode_reply, run_isolated
from tests.pdf_factory import ascii_tab_pdf, blank_pdf, engraved_tab_pdf, image_pdf, tab_png
from tests.test_dark_tab import tab_picture

TAB = [
    "e|-0---3---5h7---|",
    "B|---------------|",
    "G|---------------|",
    "D|---------------|",
    "A|---------------|",
    "E|---------------|",
]


def test_sandbox_timeout_kills_worker():
    with pytest.raises(ConversionTimeout):
        run_isolated(ascii_tab_pdf([TAB]), ConversionOptions(), timeout_s=0, memory_mb=1024)


def test_sandbox_propagates_user_errors():
    with pytest.raises(ConversionError, match="nem imagens"):
        run_isolated(blank_pdf(), ConversionOptions(), timeout_s=30, memory_mb=1024)


@pytest.mark.parametrize("raw", [b"not json", b'{"status": "ok"}', b'{"status": "ok", "report": []}'])
def test_sandbox_rejects_malformed_replies(raw):
    with pytest.raises(ConversionError, match=GENERIC_ERROR):
        _decode_reply(raw)


def test_sandbox_success_roundtrip():
    report = run_isolated(ascii_tab_pdf([TAB]), ConversionOptions(), timeout_s=30, memory_mb=1024)
    assert report["notes"] == 4 and report["measures"] == 1


def test_sandbox_reports_progress_of_a_pdf_of_pictures():
    page = tab_png(engraved_tab_pdf([[[(1, 0), (2, 3)]]], knockout=True))
    seen = []
    report = run_isolated(image_pdf([page, page]), ConversionOptions(), 60, 2048, on_progress=seen.append)
    assert report["notes"] == 4
    assert seen == sorted(seen) and seen[0] < 50 and seen[-1] >= 95  # per page read, in order


def test_a_job_that_advances_is_not_cut_off(monkeypatch):
    # each progress report (a page read) gives the child the idle time again; the cap still holds
    def slow_worker(conn, pdfs, options, memory_mb, job, cpu_seconds, lang="pt"):
        import time as t

        for percent in range(0, 100, 25):
            sandbox._reply(conn, status="progress", percent=percent)
            t.sleep(0.6)
        sandbox._reply(conn, status="ok", report={"notes": 0})
        conn.close()

    monkeypatch.setattr(sandbox, "_worker", slow_worker)
    monkeypatch.setattr(sandbox, "_CTX", sandbox.mp.get_context("fork"))
    report = run_isolated(b"x", ConversionOptions(), timeout_s=1, memory_mb=1024, total_s=10)
    assert report == {"notes": 0}  # 2.4 s in all, never 1 s without news
    with pytest.raises(ConversionTimeout):
        run_isolated(b"x", ConversionOptions(), timeout_s=1, memory_mb=1024, total_s=1.5)


def test_sandbox_start_failure_is_reported_as_unavailable(monkeypatch):
    class Broken:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            raise OSError("too many processes")

    monkeypatch.setattr(sandbox._CTX, "Process", Broken)
    with pytest.raises(sandbox.ConversionUnavailable):
        run_isolated(ascii_tab_pdf([TAB]), ConversionOptions(), timeout_s=5, memory_mb=1024)


# The recognition of a set of pictures, as Sheet Thief's worker ran it (its tests/test_worker.py,
# without the API and the database): the "images" job, every page required.
PROJECT = ConversionOptions(require_all_image_pages=True)


def png(color: str = "white", size=(80, 50)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


@pytest.mark.ocr
def test_pictures_are_recognized_in_the_sandbox():
    report = run_isolated([tab_picture()], PROJECT, 60, 3072, "images")
    assert report["notes"] > 0 and report["tracks"][0]["sources"] == ["image"]


@pytest.mark.ocr
def test_a_failed_page_is_named():
    with pytest.raises(ConversionError) as caught:
        run_isolated([tab_picture(), png("white", (400, 200))], PROJECT, 60, 3072, "images")
    assert caught.value.diagnostics == [{"page": 2, "code": "no_staff"}]
    error = recognition_error(caught.value.diagnostics)
    assert error["code"] == "recognition_failed" and error["pages"] == [{"page": 2, "code": "no_staff"}]
    assert "第 2 頁" in error["message"] and error["suggestions"]


@pytest.mark.parametrize(
    ("picture", "code", "max_pixels"),
    [
        (b"\x89PNG\r\n\x1a\ntruncated", "invalid_image", 40_000_000),
        (png("white", (100, 100)), "image_too_large", 5000),
    ],
)
def test_pictures_that_cannot_be_decoded_are_diagnosed_in_the_sandbox(picture, code, max_pixels):
    options = ConversionOptions(require_all_image_pages=True, max_image_pixels=max_pixels)
    with pytest.raises(ConversionError) as caught:
        run_isolated([png(), picture], options, 60, 2048, "images")
    assert caught.value.diagnostics == [{"page": 2, "code": code}]


@pytest.mark.parametrize("code", ["timeout", "busy", "interrupted"])
def test_a_failure_of_the_whole_job_has_its_code_and_no_pages(code):
    error = recognition_error(code=code)
    assert (error["code"], error["pages"]) == (code, []) and error["message"] and error["suggestions"]


def test_a_cancelled_job_stops_at_once(monkeypatch):
    def endless_worker(conn, pdfs, options, memory_mb, job, cpu_seconds, lang="pt"):
        import time as t

        t.sleep(30)

    monkeypatch.setattr(sandbox, "_worker", endless_worker)
    monkeypatch.setattr(sandbox, "_CTX", sandbox.mp.get_context("fork"))
    cancel = threading.Event()
    cancel.set()  # before the child is done: a timer thread would make fork() warn
    started = time.monotonic()
    with pytest.raises(ConversionCancelled):
        run_isolated(b"x", ConversionOptions(), timeout_s=20, memory_mb=1024, cancel=cancel)
    assert time.monotonic() - started < 5  # the child (asleep for 30 s) was killed
