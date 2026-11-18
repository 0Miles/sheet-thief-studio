"""The recognizer's internal HTTP interface (docs/spec/recognizer.md, section 3).

``POST /recognize`` takes the pages of one TAB as ``multipart/form-data`` (a field ``images`` per
page, in order) and answers the contract's JSON (``contract.py``): 200 with the result, 422 with a
failure, 503 with ``busy`` while another recognition runs (one at a time: at once, its body not
read). A request that is not one (no images, a file that is not a PNG, JPEG or WebP, an empty or
too large one) is answered 400 with ``{code, params}``, outside the contract: the Studio server
checks the same before calling.
``GET /healthz`` answers 200.

Python's own HTTP server, not a framework: the service has one endpoint, one request at a time,
and the image holds no web framework (requirements.txt). Run it with ``python -m recognizer.service``.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
from collections.abc import Callable
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import i18n
from .config import Settings, get_settings
from .contract import failure
from .converter import ConversionError, ConversionOptions
from .extract.raster_tab import image_kind
from .sandbox import ConversionTimeout, ConversionUnavailable, run_isolated

logger = logging.getLogger(__name__)

PORT = 8000
# Room for the form's boundaries and part headers on top of the images themselves.
FORM_OVERHEAD = 64 * 1024
# A connection that sends nothing for this long is closed (each read and write on the socket).
SOCKET_TIMEOUT_S = 60
# The whole body must arrive within this: a client trickling it in keeps the one recognition's place.
BODY_TIMEOUT_S = 120
# After an answer given without reading the body, what the client still sends is thrown away (never
# kept) for at most this long before the connection closes: closing with data unread resets it, and
# the client could lose the answer.
DISCARD_S = 2

# Runs one recognition of the pages: the contract's result, or one of the sandbox's exceptions.
Run = Callable[[list[bytes], Settings], dict]


class BadRequest(Exception):
    """A request that is not one: answered 400 with ``code`` and ``params``."""

    def __init__(self, code: str, **params: int) -> None:
        super().__init__(code)
        self.code = code
        self.params = params

    def answer(self) -> dict:
        return {"code": self.code, "params": self.params}


def run_recognition(images: list[bytes], settings: Settings) -> dict:
    """Recognize the pages in the sandbox's child process, within the limits of section 4."""
    options = ConversionOptions(
        require_all_image_pages=True,  # a page that cannot be read fails the whole recognition
        max_pages=settings.max_pages,
        max_image_pages=settings.max_image_pages,
        max_image_pixels=settings.max_image_pixels,
        max_events=settings.max_events,
        max_measures=settings.max_measures,
    )
    return run_isolated(
        images,
        options,
        timeout_s=settings.conversion_timeout_s,
        memory_mb=settings.worker_memory_mb,
        job="recognize",
        total_s=settings.max_job_timeout_s,
    )


def recognize(images: list[bytes], settings: Settings, run: Run = run_recognition) -> tuple[int, dict]:
    """(HTTP status, body) of one recognition. The core's sentences go to the log, in English."""
    token = i18n.use("en")
    try:
        return 200, run(images, settings)
    except ConversionTimeout:
        logger.warning("recognition timed out (%d pages)", len(images))
        return 422, failure("timeout")
    except ConversionUnavailable:
        logger.exception("the recognition's child process could not be started")
        return 422, failure("unavailable")
    except ConversionError as exc:
        logger.info("recognition failed: %s %s", exc, exc.diagnostics)
        return 422, failure("recognition_failed", exc.diagnostics)
    except Exception:
        logger.exception("recognition failed")
        return 422, failure("recognition_failed")
    finally:
        i18n.reset(token)


def _boundary(content_type: str) -> bytes:
    header = Message()
    header["content-type"] = content_type
    boundary = header.get_param("boundary")
    if header.get_content_type() != "multipart/form-data" or not isinstance(boundary, str) or not boundary:
        raise BadRequest("bad_request")
    return boundary.encode("latin-1")


def _field_name(headers: bytes) -> str | None:
    for line in headers.split(b"\r\n"):
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-disposition":
            disposition = Message()
            disposition["content-disposition"] = value.decode("latin-1").strip()
            found = disposition.get_param("name", header="content-disposition")
            return found if isinstance(found, str) else None
    return None


def form_fields(content_type: str, body: bytes) -> list[tuple[str | None, bytes]]:
    """(field name, content) of each part of a ``multipart/form-data`` body, in order (RFC 7578)."""
    delimiter = b"\r\n--" + _boundary(content_type)
    chunks = (b"\r\n" + body).split(delimiter)
    fields: list[tuple[str | None, bytes]] = []
    for chunk in chunks[1:]:  # chunks[0]: the preamble
        if chunk.startswith(b"--"):  # the close delimiter
            return fields
        line_end = chunk.find(b"\r\n")
        if line_end < 0 or chunk[:line_end].strip(b" \t"):
            raise BadRequest("bad_request")
        part = chunk[line_end + 2 :]
        if part.startswith(b"\r\n"):  # a part with no headers
            headers, content = b"", part[2:]
        else:
            headers, separator, content = part.partition(b"\r\n\r\n")
            if not separator:
                raise BadRequest("bad_request")
        fields.append((_field_name(headers), content))
    raise BadRequest("bad_request")  # no close delimiter: the body was cut


def images_of(content_type: str, body: bytes, settings: Settings) -> list[bytes]:
    """The pages of a request, checked: at most ``max_image_pages``, each a PNG, JPEG or WebP no
    larger than ``max_upload_mb``, together no larger than ``max_total_upload_mb``."""
    images = [content for name, content in form_fields(content_type, body) if name == "images"]
    if not images:
        raise BadRequest("no_images")
    if len(images) > settings.max_image_pages:
        raise BadRequest("too_many_images")
    for page, content in enumerate(images, start=1):
        if not content:
            raise BadRequest("empty_image", page=page)
        if len(content) > settings.max_upload_bytes:
            raise BadRequest("file_too_large", page=page)
        if image_kind(content[:16]) is None:
            raise BadRequest("unsupported_image", page=page)
    if sum(len(content) for content in images) > settings.max_total_upload_bytes:
        raise BadRequest("upload_too_large")
    return images


class RecognizerServer(ThreadingHTTPServer):
    """One recognition at a time: another request while one runs is answered 503 ``busy``."""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], settings: Settings | None = None, run: Run = run_recognition):
        super().__init__(address, _Handler)
        self.settings = settings or get_settings()
        self.run = run
        self.running = threading.Lock()


class _Handler(BaseHTTPRequestHandler):
    server: RecognizerServer
    protocol_version = "HTTP/1.1"
    timeout = SOCKET_TIMEOUT_S

    def do_GET(self) -> None:  # noqa: N802 (the name http.server calls)
        if self.path == "/healthz":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"code": "not_found", "params": {}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/recognize":
            self._refuse(404, {"code": "not_found", "params": {}})
            return
        # Busy first, before reading anything: while one runs, the others cost no memory.
        if not self.server.running.acquire(blocking=False):
            self._refuse(503, failure("busy"))
            return
        refused: BadRequest | None = None
        try:
            settings = self.server.settings
            try:
                body = self._body(settings.max_total_upload_bytes + FORM_OVERHEAD)
                images = images_of(self.headers.get("content-type", ""), body, settings)
            except BadRequest as exc:
                refused = exc
            else:
                status, answer = recognize(images, settings, self.server.run)
        finally:
            self.server.running.release()  # before answering a request that is not one, too
        if refused is not None:
            (self._refuse if self.close_connection else self._send)(400, refused.answer())
            return
        self._send(status, answer)

    def _body(self, limit: int) -> bytes:
        """The request's body; one with no length, or longer than ``limit``, is not read at all."""
        if self.headers.get("transfer-encoding"):
            self.close_connection = True
            raise BadRequest("bad_request")
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            length = -1
        if length < 0:
            self.close_connection = True
            raise BadRequest("bad_request")
        if length > limit:
            self.close_connection = True
            raise BadRequest("upload_too_large")
        chunks: list[bytes] = []
        received = 0
        deadline = time.monotonic() + BODY_TIMEOUT_S
        try:
            while received < length and time.monotonic() < deadline:
                chunk = self.rfile.read1(min(length - received, 1024 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                received += len(chunk)
        except OSError:  # the socket timed out, or the client went away
            pass
        if received != length:
            self.close_connection = True
            raise BadRequest("bad_request")
        return b"".join(chunks)

    def _refuse(self, status: int, body: dict) -> None:
        """Answer without reading the rest of the request, and close the connection."""
        self.close_connection = True
        self._send(status, body)
        try:
            self.connection.shutdown(socket.SHUT_WR)
            self.connection.settimeout(0.2)
            stop = time.monotonic() + DISCARD_S
            while time.monotonic() < stop and self.connection.recv(64 * 1024):
                pass
        except OSError:
            pass

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 (http.server's name)
        logger.info("%s " + format, self.address_string(), *args)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    server = RecognizerServer((os.environ.get("HOST", "0.0.0.0"), PORT))
    logger.info("recognizer listening on %s:%d", *server.server_address[:2])
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
