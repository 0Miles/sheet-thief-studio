"""Generate deterministic, synthetic TAB pages used for manual OCR smoke tests."""

import sys
from pathlib import Path

from PIL import ImageFont

REPOSITORY = Path(__file__).resolve().parent.parent
ROOT = REPOSITORY / "tests" / "fixtures"
sys.path.insert(0, str(REPOSITORY))  # the page is drawn as the tests draw it
from tests.pdf_factory import SINGLE_PAGE_FRETS, smoke_page


def font(size: int):
    for name in ("DejaVuSans.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def page(name: str, title: str, measures: list[list[str]]) -> None:
    image = smoke_page(title, "Standard tuning · 120 BPM · 4/4", measures, font)
    ROOT.mkdir(parents=True, exist_ok=True)
    image.save(ROOT / name, "PNG", optimize=True)


def main() -> None:
    page("single-page.png", "Smoke 1 · single page", SINGLE_PAGE_FRETS)
    for number, start in enumerate((0, 3, 7), 1):
        page(
            f"three-page-{number}.png",
            f"Smoke 2 · ordered page {number}/3",
            [[f"--{start}---{start + 2}---{start + 3}---{start + 5}--|" for _ in range(6)]],
        )
    page(
        "double-digit-chord.png",
        "Smoke 3 · double-digit chord",
        [["--10------12------15--|", "--12------13------17--|", "--12------14------17--|", "--12------14------17--|", "--10------12------15--|", "--10------12------15--|"]],
    )
    page(
        "techniques.png",
        "Smoke 4 · hammer / pull / slide / bend",
        [["--5h7---7p5---5/7---7b9--|", "--------------------------|", "--7h9---9p7---7\\5--------|", "--------------------------|", "--5-----7-----9-----------|", "--------------------------|"]],
    )


if __name__ == "__main__":
    main()
