#!/usr/bin/env python3

import ast
import contextlib
import io
import json
import runpy
import sys
from pathlib import Path


def top_level_assignments(module: ast.Module):
    for node in module.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    yield target.id, node.lineno
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            yield node.target.id, node.lineno


def surface_form(value):
    evaluator = getattr(value, "eval", None)
    if not callable(evaluator):
        return None

    attempts = (
        lambda: evaluator(),
        lambda: evaluator(False),
        lambda: evaluator(annotated=False),
    )

    for attempt in attempts:
        try:
            result = attempt()
            if result is None:
                return None
            return str(result)
        except TypeError:
            continue
        except Exception:
            return None

    return None


def definition_for(value):
    definition = getattr(value, "definition", None)
    if definition is None:
        return None
    return str(definition)


def sys_path_candidates(file_path: Path):
    seen = set()

    def add(path: Path):
        resolved = str(path.resolve())
        if resolved not in seen:
            seen.add(resolved)
            sys.path.insert(0, resolved)

    add(file_path.parent)

    package_dir = file_path.parent
    if (package_dir / "__init__.py").exists():
        while (package_dir.parent / "__init__.py").exists():
            package_dir = package_dir.parent
        add(package_dir.parent)


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"entries": [], "error": "usage: extract_runtime_lexicon.py <file>"}))
        return 1

    file_path = Path(sys.argv[1]).resolve()
    sys_path_candidates(file_path)
    source = file_path.read_text(encoding="utf-8")
    module = ast.parse(source, filename=str(file_path))

    ordered_names = []
    seen = set()
    for name, line in top_level_assignments(module):
        key = (name, line)
        if key not in seen:
            seen.add(key)
            ordered_names.append((name, line))

    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()

    with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
        namespace = runpy.run_path(str(file_path), run_name="__vscodetupy__")

    entries = []
    for name, line in ordered_names:
        value = namespace.get(name)
        if value is None:
            continue

        orthography = surface_form(value)
        if not orthography:
            continue

        entries.append(
            {
                "name": name,
                "kind": value.__class__.__name__,
                "orthography": orthography,
                "definition": definition_for(value),
                "line": line,
            }
        )

    payload = {"entries": entries}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stdout.write(
            json.dumps(
                {"entries": [], "error": f"{error.__class__.__name__}: {error}"},
                ensure_ascii=False,
            )
        )
        raise SystemExit(1)
