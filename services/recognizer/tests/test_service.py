"""The recognizer's internal HTTP interface (docs/spec/recognizer.md, section 3), through a real
server on a free port: requests that are not ones, one recognition at a time, and failures shaped as
the contract's fixtures."""

from __future__ import annotations

import http.client
import json
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from recognizer.config import Settings
from recognizer.converter import ConversionError
from recognizer.sandbox import ConversionTimeout, ConversionUnavailable
from recognizer.service import RecognizerServer, run_recognition
from tests.json_schema import errors, fixture

PICTURES = Path(__file__).resolve().parent / "fixtures"
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 32
WEBP = b"RIFF\0\0\0\0WEBPVP8 " + b"\0" * 32
BOUNDARY = "studio-test-boundary"


def form(*images: bytes, field: str = "images") -> bytes:
    """``multipart/form-data`` as the server's FormData writes it: one part per image, in order."""
    body = b""
    for index, image in enumerate(images, start=1):
        body += (
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{field}"; filename="page-{index}.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode() + image + b"\r\n"
    return body + f"--{BOUNDARY}--\r\n".encode()


@contextmanager
def serving(run: Callable | None = None, settings: Settings | None = None) -> Iterator[RecognizerServer]:
    calls: list[list[bytes]] = []

    def recorded(images, settings):
        calls.append(images)
        return run(images, settings) if run else fixture("six-strings")

    server = RecognizerServer(("127.0.0.1", 0), settings or Settings(), recorded)
    server.calls = calls
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def call(server, method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> tuple[int, dict]:
    connection = http.client.HTTPConnection(*server.server_address[:2], timeout=60)
    try:
        if body is not None and headers is None:
            headers = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}
        connection.request(method, path, body=body, headers=headers or {})
        answer = connection.getresponse()
        return answer.status, json.loads(answer.read())
    finally:
        connection.close()


def recognize(server, *images: bytes) -> tuple[int, dict]:
    return recognize_body(server, form(*images))


def recognize_body(server, body: bytes) -> tuple[int, dict]:
    return call(server, "POST", "/recognize", body)


def test_the_health_check():
    with serving() as server:
        assert call(server, "GET", "/healthz") == (200, {"status": "ok"})
        assert call(server, "GET", "/nothing")[0] == 404


def test_the_pages_are_recognized_in_order_and_the_result_returned():
    with serving() as server:
        assert recognize(server, PNG, JPEG, WEBP) == (200, fixture("six-strings"))
        assert server.calls == [[PNG, JPEG, WEBP]]


@pytest.mark.parametrize(
    ("body", "settings", "answer"),
    [
        (form(PNG, b"not a picture at all"), Settings(), {"code": "unsupported_image", "params": {"page": 2}}),
        (form(b"%PDF-1.7\n"), Settings(), {"code": "unsupported_image", "params": {"page": 1}}),
        (form(PNG, b""), Settings(), {"code": "empty_image", "params": {"page": 2}}),
        (form(PNG + b"\0" * (1024 * 1024)), Settings(max_upload_mb=1), {"code": "file_too_large", "params": {"page": 1}}),
        (
            # together just over 1 MB: the body is read, within the room left for the form
            form(PNG + b"\0" * (520 * 1024), PNG + b"\0" * (520 * 1024)),
            Settings(max_upload_mb=1, max_total_upload_mb=1),
            {"code": "upload_too_large", "params": {}},
        ),
        (form(PNG, PNG, PNG), Settings(max_image_pages=2), {"code": "too_many_images", "params": {}}),
        (form(), Settings(), {"code": "no_images", "params": {}}),
        (form(PNG, field="pages"), Settings(), {"code": "no_images", "params": {}}),
        (form(PNG)[:-8], Settings(), {"code": "bad_request", "params": {}}),
    ],
    ids=["not a picture", "a PDF", "empty", "too large", "too large together", "too many", "none", "another field", "cut"],
)
def test_a_request_that_is_not_one_is_answered_400_with_its_code(body, settings, answer):
    with serving(settings=settings) as server:
        assert recognize_body(server, body) == (400, answer)
        assert server.calls == []


def test_a_body_that_is_not_a_form_is_answered_400():
    with serving() as server:
        assert call(server, "POST", "/recognize", PNG, {"Content-Type": "image/png"}) == (
            400,
            {"code": "bad_request", "params": {}},
        )


def test_a_body_longer_than_all_the_images_may_be_is_not_read():
    with serving(settings=Settings(max_total_upload_mb=1)) as server:
        connection = http.client.HTTPConnection(*server.server_address[:2], timeout=10)
        connection.putrequest("POST", "/recognize")
        connection.putheader("Content-Type", f"multipart/form-data; boundary={BOUNDARY}")
        connection.putheader("Content-Length", str(100 * 1024 * 1024))
        connection.endheaders()  # and no body at all: the answer comes without it
        answer = connection.getresponse()
        assert (answer.status, json.loads(answer.read())) == (400, {"code": "upload_too_large", "params": {}})
        connection.close()


def test_a_second_request_while_one_runs_is_busy():
    started, release = threading.Event(), threading.Event()

    def slow(images, settings):
        started.set()
        assert release.wait(30)
        return fixture("four-strings")

    with serving(slow) as server:
        first: list[tuple[int, dict]] = []
        thread = threading.Thread(target=lambda: first.append(recognize(server, PNG)))
        thread.start()
        try:
            assert started.wait(30)
            assert recognize(server, PNG) == (503, fixture("error-busy"))
            assert call(server, "GET", "/healthz")[0] == 200  # the health check still answers
        finally:
            release.set()
            thread.join()
        assert first == [(200, fixture("four-strings"))]
        assert len(server.calls) == 1
        assert recognize(server, PNG) == (200, fixture("four-strings"))  # free again


PAGES = [{"page": 1, "code": "no_staff"}, {"page": 2, "code": "no_notes"}, {"page": 3, "code": "invalid_image"}]
PAGES.append({"page": 4, "code": "image_too_large"})


def raising(error: Exception) -> Callable:
    def run(images, settings):
        raise error

    return run


@pytest.mark.parametrize(
    ("error", "name"),
    [
        (ConversionTimeout(), "error-timeout"),
        (ConversionUnavailable(), "error-unavailable"),
        (ConversionError("Página 1: …", diagnostics=PAGES), "error-pages"),
    ],
    ids=["timeout", "unavailable", "pages"],
)
def test_a_failure_is_answered_422_shaped_as_the_contract_fixture(error, name):
    with serving(raising(error)) as server:
        assert recognize(server, PNG, PNG, PNG, PNG) == (422, fixture(name))


def test_an_unexpected_error_is_a_recognition_failure_with_no_text():
    with serving(raising(RuntimeError("internal details"))) as server:
        status, answer = recognize(server, PNG)
    assert (status, answer["error"]) == (422, {"code": "recognition_failed", "params": {}, "pages": []})


@pytest.mark.ocr
def test_a_picture_is_recognized_through_the_sandbox():
    with serving() as server:
        server.run = run_recognition
        status, answer = recognize(server, (PICTURES / "single-page.png").read_bytes())
    assert status == 200 and errors(answer) == [] and answer["strings"] == 6


@pytest.mark.ocr
def test_a_picture_that_cannot_be_decoded_names_its_page():
    with serving() as server:
        server.run = run_recognition
        status, answer = recognize(server, (PICTURES / "single-page.png").read_bytes(), PNG)
    assert (status, answer["error"]["code"], answer["error"]["pages"]) == (
        422,
        "recognition_failed",
        [{"page": 2, "code": "invalid_image"}],
    )
    assert errors(answer) == []
