#!/usr/bin/env python3

import ast
import contextlib
import io
import json
import sys
import tokenize
from pathlib import Path


def definition_package(file_path: Path):
    parts = []
    package_dir = file_path.parent
    while (package_dir / "__init__.py").exists():
        parts.append(package_dir.name)
        package_dir = package_dir.parent
    return ".".join(reversed(parts))


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


def line_offsets(source: str):
    lines = source.splitlines(keepends=True)
    offsets = [0]
    running = 0
    for line in lines:
        running += len(line)
        offsets.append(running)
    return lines, offsets


def char_offset_for(offsets, line: int, col: int):
    if line < 1 or line >= len(offsets):
        raise ValueError("line out of range")
    return offsets[line - 1] + col


def utf8_col_to_char_col(line: str, utf8_col: int):
    if utf8_col <= 0:
        return 0

    running = 0
    for index, char in enumerate(line):
        running += len(char.encode("utf-8"))
        if running >= utf8_col:
            return index + 1

    return len(line)


def ast_offset_for(lines, offsets, line: int, utf8_col: int):
    if line < 1 or line > len(lines):
        raise ValueError("line out of range")
    char_col = utf8_col_to_char_col(lines[line - 1], utf8_col)
    return offsets[line - 1] + char_col


def parenthesis_pairs(source: str, offsets):
    opens = []
    pairs = {}
    closes = {}

    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.OP:
            continue
        token_offset = char_offset_for(offsets, token.start[0], token.start[1])

        if token.string == "(":
            opens.append(token_offset)
            continue

        if token.string == ")" and opens:
            open_offset = opens.pop()
            pairs[open_offset] = token_offset
            closes[token_offset] = open_offset

    return pairs, closes


def wrapped_ranges(start: int, end: int, source: str, pairs):
    ranges = [(start, end)]

    while True:
        current_start, current_end = ranges[-1]
        expanded = False

        for open_offset, close_offset in pairs.items():
            if open_offset >= current_start or close_offset + 1 < current_end:
                continue
            if not source[open_offset + 1 : current_start].strip() and not source[current_end:close_offset].strip():
                next_range = (open_offset, close_offset + 1)
                if next_range not in ranges:
                    ranges.append(next_range)
                expanded = True
                break

        if not expanded:
            break

    return ranges


def expression_range(module: ast.AST, source: str, open_offset: int, close_offset: int, lines, offsets, pairs):
    candidates = []

    for node in ast.walk(module):
        if not isinstance(node, ast.expr):
            continue
        if not hasattr(node, "lineno") or not hasattr(node, "end_lineno"):
            continue

        start = ast_offset_for(lines, offsets, node.lineno, node.col_offset)
        end = ast_offset_for(lines, offsets, node.end_lineno, node.end_col_offset)

        for candidate_start, candidate_end in wrapped_ranges(start, end, source, pairs):
            if candidate_end == close_offset + 1:
                candidates.append(
                    {
                        "node_type": type(node).__name__,
                        "range": (candidate_start, candidate_end),
                    }
                )
                break

    if not candidates:
        return None

    exact_scope = [candidate for candidate in candidates if candidate["range"][0] == open_offset]
    if exact_scope and not is_call_like_open(source, open_offset):
        exact_scope.sort(key=lambda candidate: (-candidate["range"][0], candidate["range"][1] - candidate["range"][0]))
        return exact_scope[0]["range"]

    call_candidates = [candidate for candidate in candidates if candidate["node_type"] == "Call"]
    if call_candidates and is_call_like_open(source, open_offset):
        call_candidates.sort(key=lambda candidate: (-candidate["range"][0], candidate["range"][1] - candidate["range"][0]))
        return call_candidates[0]["range"]

    candidates.sort(key=lambda candidate: (-candidate["range"][0], candidate["range"][1] - candidate["range"][0]))
    return candidates[0]["range"]


def is_call_like_open(source: str, open_offset: int):
    index = open_offset - 1
    while index >= 0 and source[index].isspace():
        index -= 1

    if index < 0:
        return False

    return source[index].isalnum() or source[index] in "._)]"


def surface_form(value):
    evaluator = getattr(value, "eval", None)
    if callable(evaluator):
        attempts = (
            lambda: evaluator(),
            lambda: evaluator(False),
            lambda: evaluator(annotated=False),
        )
        for attempt in attempts:
            try:
                result = attempt()
                if result is not None:
                    return str(result)
            except TypeError:
                continue
            except Exception:
                break

    if value is None:
        return None
    return str(value)


def compact(text: str):
    return " ".join(text.split())


def main():
    if len(sys.argv) != 4:
        sys.stdout.write(json.dumps({"hint": None, "error": "usage"}))
        return 1

    file_path = Path(sys.argv[1]).resolve()
    close_line = int(sys.argv[2])
    close_col = int(sys.argv[3])
    source = sys.stdin.read()

    sys_path_candidates(file_path)
    lines, offsets = line_offsets(source)
    close_offset = char_offset_for(offsets, close_line, close_col)
    pairs, closes = parenthesis_pairs(source, offsets)
    if close_offset not in closes:
        sys.stdout.write(json.dumps({"hint": None}))
        return 0

    module = ast.parse(source, filename=str(file_path))
    expr_range = expression_range(module, source, closes[close_offset], close_offset, lines, offsets, pairs)
    if expr_range is None:
        sys.stdout.write(json.dumps({"hint": None}))
        return 0

    expression = source[expr_range[0] : expr_range[1]]
    package_name = definition_package(file_path)
    namespace = {
        "__name__": "__vscodetupy__",
        "__file__": str(file_path),
        "__package__": package_name or None,
    }

    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
        exec(compile(source, str(file_path), "exec"), namespace)
        value = eval(compile(expression, str(file_path), "eval"), namespace)

    hint = surface_form(value)
    sys.stdout.write(json.dumps({"hint": compact(hint) if hint else None}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stdout.write(json.dumps({"hint": None}, ensure_ascii=False))
        raise SystemExit(0)
