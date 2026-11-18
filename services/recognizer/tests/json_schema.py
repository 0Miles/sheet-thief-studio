"""Checking JSON against the contract's JSON Schema (2020-12) in the tests.

The image has no JSON Schema library (requirements*.txt), so this checks the keywords the contract
uses, and refuses a schema with any other: a keyword it does not know would otherwise pass silently.
The TypeScript side checks the same schema with Ajv (packages/contracts/tests/recognizer.test.ts).
"""

from __future__ import annotations

import json
from pathlib import Path

CONTRACT = Path(__file__).resolve().parent.parent / "contract"
_ANNOTATIONS = {"$schema", "$id", "title", "description", "$defs"}
_TYPES = {
    "null": lambda v: v is None,
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "string": lambda v: isinstance(v, str),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def load_schema() -> dict:
    return json.loads((CONTRACT / "recognition.schema.json").read_text(encoding="utf-8"))


def fixture(name: str) -> dict:
    return json.loads((CONTRACT / "fixtures" / f"{name}.json").read_text(encoding="utf-8"))


def _equal(a: object, b: object) -> bool:
    """JSON equality: true is not 1."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b, strict=True))
    return type(a) in (int, float) and type(b) in (int, float) and a == b or type(a) is type(b) and a == b


def errors(instance: object, schema: dict | None = None, root: dict | None = None, path: str = "$") -> list[str]:
    """What is wrong with ``instance`` (empty when it passes)."""
    root = root if root is not None else (schema if schema is not None else load_schema())
    schema = schema if schema is not None else root
    found: list[str] = []

    def valid(sub: dict, at: str = path) -> bool:
        return not errors(instance, sub, root, at)

    if ("then" in schema or "else" in schema) and "if" not in schema:
        raise ValueError("then or else without if")
    if ("minContains" in schema or "maxContains" in schema) and "contains" not in schema:
        raise ValueError("minContains or maxContains without contains")
    for keyword, value in schema.items():
        if keyword in _ANNOTATIONS or keyword in ("then", "else", "minContains", "maxContains"):
            continue
        if keyword == "$ref":
            assert value.startswith("#/$defs/"), value
            found += errors(instance, root["$defs"][value.removeprefix("#/$defs/")], root, path)
        elif keyword == "type":
            names = value if isinstance(value, list) else [value]
            if not any(_TYPES[name](instance) for name in names):
                found.append(f"{path}: not {value}")
        elif keyword == "const":
            if not _equal(instance, value):
                found.append(f"{path}: not {value!r}")
        elif keyword == "enum":
            if not any(_equal(instance, option) for option in value):
                found.append(f"{path}: not one of {value!r}")
        elif keyword == "oneOf":
            matches = sum(valid(sub) for sub in value)
            if matches != 1:
                found.append(f"{path}: matches {matches} of oneOf")
        elif keyword == "anyOf":
            if not any(valid(sub) for sub in value):
                found.append(f"{path}: matches none of anyOf")
        elif keyword == "allOf":
            for sub in value:
                found += errors(instance, sub, root, path)
        elif keyword == "not":
            if valid(value):
                found.append(f"{path}: matches not")
        elif keyword == "if":
            branch = schema.get("then") if valid(value) else schema.get("else")
            if branch is not None:
                found += errors(instance, branch, root, path)
        elif keyword in ("minimum", "maximum"):
            if _TYPES["number"](instance) and (instance < value if keyword == "minimum" else instance > value):
                found.append(f"{path}: {keyword} {value}")
        elif keyword == "minLength":
            if isinstance(instance, str) and len(instance) < value:
                found.append(f"{path}: shorter than {value}")
        elif keyword in ("minItems", "maxItems"):
            if isinstance(instance, list) and (len(instance) < value if keyword == "minItems" else len(instance) > value):
                found.append(f"{path}: {keyword} {value}")
        elif keyword == "uniqueItems":
            if value and isinstance(instance, list):
                if any(_equal(a, b) for i, a in enumerate(instance) for b in instance[i + 1 :]):
                    found.append(f"{path}: items not unique")
        elif keyword == "items":
            if isinstance(instance, list):
                for index, item in enumerate(instance):
                    found += errors(item, value, root, f"{path}[{index}]")
        elif keyword == "contains":
            if isinstance(instance, list):
                count = sum(not errors(item, value, root, path) for item in instance)
                low, high = schema.get("minContains", 1), schema.get("maxContains")
                if count < low or high is not None and count > high:
                    found.append(f"{path}: contains {count}")
        elif keyword == "required":
            if isinstance(instance, dict):
                found += [f"{path}: no {name}" for name in value if name not in instance]
        elif keyword == "properties":
            if isinstance(instance, dict):
                for name, sub in value.items():
                    if name in instance:
                        found += errors(instance[name], sub, root, f"{path}.{name}")
        elif keyword == "additionalProperties":
            if isinstance(instance, dict):
                extra = [name for name in instance if name not in schema.get("properties", {})]
                if value is False:
                    found += [f"{path}: unexpected {name}" for name in extra]
                else:
                    for name in extra:
                        found += errors(instance[name], value, root, f"{path}.{name}")
        else:
            raise ValueError(f"a JSON Schema keyword these tests do not check: {keyword}")
    return found
