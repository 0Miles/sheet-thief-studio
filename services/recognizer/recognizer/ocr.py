"""Whether the OCR packages needed to read tabs from pictures are installed."""

from __future__ import annotations

import importlib.util

from .i18n import tr

_OCR_MODULES = ("rapidocr_onnxruntime", "onnxruntime", "cv2", "numpy")


def ocr_ready() -> tuple[bool, str]:
    """(usable, problem) of reading tabs from images."""
    missing = [name for name in _OCR_MODULES if importlib.util.find_spec(name) is None]
    if not missing:
        return True, ""
    return False, tr(
        f"faltam pacotes do OCR ({', '.join(missing)})", f"OCR packages are missing ({', '.join(missing)})"
    )
