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


def is_predicate_instance(value):
    try:
        from pydicate.predicate import Predicate
    except Exception:
        return False

    return isinstance(value, Predicate)


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


def source_path_for_module(module) -> Path | None:
    module_file = getattr(module, "__file__", None)
    if not module_file:
        return None

    path = Path(module_file).resolve()
    if path.suffix == ".pyc":
        source_path = path.with_suffix(".py")
        if source_path.exists():
            return source_path

    return path


def assignment_lines_for(path: Path, cache: dict[str, dict[str, int]]) -> dict[str, int]:
    key = str(path)
    if key in cache:
        return cache[key]

    lines = {}
    try:
        module = ast.parse(path.read_text(encoding="utf-8"), filename=key)
    except Exception:
        cache[key] = lines
        return lines

    for name, line in top_level_assignments(module):
        lines.setdefault(name, line)

    cache[key] = lines
    return lines


def prefer_source_candidate(candidate, incumbent):
    if incumbent is None:
        return True

    candidate_score = candidate["score"]
    incumbent_score = incumbent["score"]
    if candidate_score != incumbent_score:
        return candidate_score < incumbent_score

    return str(candidate["source_path"]) < str(incumbent["source_path"])


def build_pydicate_source_index():
    source_index = {}
    assignment_cache = {}

    for module_name, module in tuple(sys.modules.items()):
        if not module_name.startswith("pydicate"):
            continue

        module_dict = getattr(module, "__dict__", None)
        if not isinstance(module_dict, dict):
            continue

        source_path = source_path_for_module(module)
        if source_path is None or not source_path.exists():
            continue

        assignment_lines = assignment_lines_for(source_path, assignment_cache)
        is_init = source_path.name == "__init__.py"

        for name, value in module_dict.items():
            if name.startswith("_") or not is_predicate_instance(value):
                continue

            line = assignment_lines.get(name)
            candidate = {
                "source_path": source_path,
                "line": line or 1,
                "score": (
                    0 if line is not None else 1,
                    1 if is_init else 0,
                    -len(module_name.split(".")),
                ),
            }

            identity = id(value)
            incumbent = source_index.get(identity)
            if prefer_source_candidate(candidate, incumbent):
                source_index[identity] = candidate

    return source_index


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

    pydicate_sources = build_pydicate_source_index()
    assigned_names = {name for name, _line in ordered_names}
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
                "source_path": str(file_path),
            }
        )

    for name, value in namespace.items():
        if name.startswith("_") or name in assigned_names or not is_predicate_instance(value):
            continue

        source = pydicate_sources.get(id(value))
        if not source:
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
                "line": source["line"],
                "source_path": str(source["source_path"]),
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
