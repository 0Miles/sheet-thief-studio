import os

import pytest


@pytest.fixture(autouse=True)
def _ocr_or_skip(request):
    """Tests marked ``ocr`` need the OCR packages. The test image sets ``RECOGNIZER_REQUIRE_OCR=1``
    (Dockerfile): there a missing package fails those tests instead of skipping them."""
    if request.node.get_closest_marker("ocr"):
        from recognizer.ocr import ocr_ready

        ready, problem = ocr_ready()
        if not ready:
            if os.environ.get("RECOGNIZER_REQUIRE_OCR") == "1":
                pytest.fail(problem)
            pytest.skip("OCR packages are not installed")
