import pytest

from recognizer import sandbox
from recognizer.converter import ConversionError, ConversionOptions
from recognizer.sandbox import GENERIC_ERROR, ConversionTimeout, _decode_reply, run_isolated
from tests.pdf_factory import ascii_tab_pdf, blank_pdf, engraved_tab_pdf, image_pdf, tab_png

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
