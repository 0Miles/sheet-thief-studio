# syntax=docker/dockerfile:1
# The recognition service (docs/spec/recognizer.md, ADR 0006). Targets: test (the copied pytest
# suite, run by the CI) and runtime, the last: the target Compose will build (#61).

FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# OpenCV and ONNX Runtime need GLib and OpenMP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 recognizer
WORKDIR /service
COPY requirements.txt requirements-ocr.txt ./
RUN python -m pip install -r requirements.txt \
    && python -m pip install --no-deps --ignore-requires-python -r requirements-ocr.txt
# One thread per library: the sandbox runs one recognition at a time, in a child with a memory cap.
ENV OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    OPENCV_FOR_THREADS_NUM=1
COPY recognizer ./recognizer

FROM base AS test
COPY requirements-dev.txt ./
RUN python -m pip install -r requirements-dev.txt
COPY pyproject.toml LICENSE THIRD_PARTY_NOTICES.md ./
COPY tests ./tests
# A test marked "ocr" fails here when the OCR packages are missing, instead of being skipped.
ENV RECOGNIZER_REQUIRE_OCR=1
USER recognizer
CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime
COPY LICENSE THIRD_PARTY_NOTICES.md ./
USER recognizer
# The HTTP interface (docs/spec/recognizer.md, section 3) is not there yet: the image only holds the core.
CMD ["python", "-c", "import recognizer.converter, recognizer.sandbox"]
