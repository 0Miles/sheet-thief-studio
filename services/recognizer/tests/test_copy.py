"""What the copy of Sheet Thief's core holds (docs/spec/recognizer.md, section 2): none of the
modules it leaves out, nor an import of one, and the licence and the notice of where it comes from."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from recognizer.config import Settings

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "recognizer"
# Sheet Thief's modules the copy leaves out, and the package only its GP5 writer used.
LEFT_OUT = ("api", "db", "jobs", "storage", "gp5_writer", "gp_edit", "musicxml", "preview")
LEFT_OUT_PACKAGES = ("guitarpro",)


def _imports(module: Path) -> list[tuple[int, str]]:
    """(line, dotted name inside the package or of a top-level package) of each import."""
    package = module.parent.relative_to(ROOT).parts
    found: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(module.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found += [(node.lineno, alias.name) for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = list(package[: len(package) - node.level + 1])
                if node.module:
                    found.append((node.lineno, ".".join([*base, *node.module.split(".")])))
                else:  # from . import x
                    found += [(node.lineno, ".".join([*base, alias.name])) for alias in node.names]
            elif node.module:
                found.append((node.lineno, node.module))
    return found


def test_the_modules_left_out_are_not_copied() -> None:
    present = {path.stem for path in PACKAGE.rglob("*.py")} | {path.name for path in PACKAGE.rglob("*") if path.is_dir()}
    assert sorted(present & set(LEFT_OUT)) == []


def test_no_module_imports_one_left_out() -> None:
    offenders = []
    for module in sorted(PACKAGE.rglob("*.py")):
        for line, name in _imports(module):
            parts = name.split(".")
            inside = parts[0] == "recognizer"
            left_out = (inside and len(parts) > 1 and parts[1] in LEFT_OUT) or parts[0] in LEFT_OUT_PACKAGES
            # Sheet Thief's package was "app": an absolute import of it would be one of its modules.
            if left_out or parts[0] == "app":
                offenders.append(f"{module.relative_to(ROOT)}:{line} imports {name}")
    assert offenders == []


def test_the_package_imports_itself_relatively() -> None:
    """As in Sheet Thief: the modules never import the package by its name."""
    offenders = [
        f"{module.relative_to(ROOT)}:{node.lineno}"
        for module in PACKAGE.rglob("*.py")
        for node in ast.walk(ast.parse(module.read_text(encoding="utf-8")))
        if isinstance(node, ast.ImportFrom) and node.level == 0 and (node.module or "").startswith("recognizer")
    ]
    assert offenders == []


def test_every_module_imports() -> None:
    import importlib

    for module in sorted(PACKAGE.rglob("*.py")):
        name = ".".join(module.with_suffix("").relative_to(ROOT).parts)
        importlib.import_module(name.removesuffix(".__init__"))


def test_the_licence_and_the_notice_are_kept() -> None:
    licence = (ROOT / "LICENSE").read_text(encoding="utf-8")
    assert licence.startswith("MIT License")
    notice = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    for needle in ("0Miles/sheet-thief", "fd60ff6", "F100Pilot/PDF-to-GP5", "01d9e799d938313ce8e4f6320fc6f16b1ee8adfd"):
        assert needle in notice


def test_the_limits_of_the_sandbox() -> None:
    """docs/spec/recognizer.md, section 4: 120 s without progress, 900 s in all, 3072 MB a child."""
    settings = Settings.from_env({})
    assert (settings.conversion_timeout_s, settings.max_job_timeout_s, settings.worker_memory_mb) == (120, 900, 3072)
    assert (settings.max_image_pages, settings.max_image_megapixels) == (15, 40)
    assert (settings.max_upload_mb, settings.max_total_upload_mb) == (10, 40)


def test_an_environment_variable_overrides_a_limit() -> None:
    settings = Settings.from_env({"WORKER_MEMORY_MB": "2048", "MAX_JOB_TIMEOUT_S": " "})
    assert (settings.worker_memory_mb, settings.max_job_timeout_s) == (2048, 900)


@pytest.mark.parametrize("raw", ["0", "-1", "lots", "1.5"])
def test_a_limit_must_be_a_positive_integer(raw: str) -> None:
    with pytest.raises(ValueError, match="WORKER_MEMORY_MB|worker_memory_mb"):
        Settings.from_env({"WORKER_MEMORY_MB": raw})
