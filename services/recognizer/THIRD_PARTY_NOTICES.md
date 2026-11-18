# Third-party notices · 第三方聲明

This directory is copied from Sheet Thief (`0Miles/sheet-thief`) at commit `fd60ff6`: its
recognition core, without its web API, database, queue, storage, GP5 writer, Guitar Pro editing,
MusicXML export and preview (`docs/spec/recognizer.md`, section 2).

Sheet Thief is derived from [F100Pilot/PDF-to-GP5](https://github.com/F100Pilot/PDF-to-GP5) at
commit `01d9e799d938313ce8e4f6320fc6f16b1ee8adfd`, under the MIT licence retained in
[`LICENSE`](LICENSE).

這個目錄複製自 Sheet Thief（`0Miles/sheet-thief`）的 commit `fd60ff6`，只取辨識核心。Sheet Thief 衍生自
[F100Pilot/PDF-to-GP5](https://github.com/F100Pilot/PDF-to-GP5) 的 commit
`01d9e799d938313ce8e4f6320fc6f16b1ee8adfd`，以 MIT 授權，授權條款原樣保留在 [`LICENSE`](LICENSE)。

## Installed at build time · 建置時安裝

The Python packages (`requirements.txt`, `requirements-ocr.txt`, and for the tests
`requirements-dev.txt`) are downloaded when the image is built, each under its own licence, notably: pdfplumber
and pdfminer.six (MIT), Pillow (MIT-CMU), RapidOCR (Apache-2.0), ONNX Runtime (MIT), OpenCV
(Apache-2.0), NumPy (BSD-3-Clause), pytest (MIT), reportlab (BSD).
