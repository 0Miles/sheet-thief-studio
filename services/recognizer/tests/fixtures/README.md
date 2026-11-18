# TAB OCR smoke fixtures

These synthetic 1600×1050 PNG pages cover the manual release checks:

- `single-page.png`: ordinary one-page TAB.
- `three-page-1.png` through `three-page-3.png`: ordered multi-page merge.
- `double-digit-chord.png`: simultaneous notes and frets 10–17.
- `techniques.png`: hammer-on, pull-off, slide and bend marks.

Regenerate them with `python scripts/generate_smoke_fixtures.py`. They are deliberately clean and
are only smoke inputs; they are not an accuracy benchmark.

`single-page.png` is also a regression input for reading a picture's heading (#18):
`tests/test_music_settings.py` reads its tempo, 120, from the heading line, which the reader sees only
about 7 px tall (the page is rescaled to its big staff), both as a picture and composed into a PDF as
a project's pages are. The generator draws with the first font it finds on the machine (DejaVu Sans,
then Arial, then Pillow's default), so a regenerated page can differ in its pixels: run that test
again after regenerating. The same page with other heading lines is drawn by `small_heading_png` in
`tests/pdf_factory.py`, which shares the drawing with the generator but always uses Pillow's own font.

`touching-ties-1000-arial.png` is a regression fixture, not a smoke input: the touching-ties page of
`tests/test_raster.py` (`TOUCHING_TIES`), rendered 1000 px wide by pypdfium2 on Windows, where pdfium
draws the PDF's non-embedded Helvetica with Arial (the Linux image has no system fonts and uses
pdfium's built-in sans). There the bar of the 4 in "(4)" touches the opening parenthesis through one
faint pixel. It cannot be regenerated on Linux. To regenerate it on Windows (pypdfium2 5.14.0, Pillow
12.3.0: this reproduces the committed file byte for byte), from `services/recognizer`:

```powershell
.venv\Scripts\python.exe -c "from pathlib import Path; from tests.pdf_factory import engraved_tab_pdf, tab_png; from tests.test_raster import TOUCHING_TIES; Path('tests/fixtures/touching-ties-1000-arial.png').write_bytes(tab_png(engraved_tab_pdf(TOUCHING_TIES, knockout=True), 1000))"
```
