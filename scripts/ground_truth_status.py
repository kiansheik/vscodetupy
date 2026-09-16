#!/usr/bin/env python3

import json
import sys
from pathlib import Path


def source_name_for(file_path: Path) -> str | None:
    name = file_path.name
    if name.endswith(".tu.py"):
        return name[: -len(".tu.py")]
    if name.endswith(".py"):
        return name[: -len(".py")]
    return None


def main() -> int:
    if len(sys.argv) != 3:
        sys.stdout.write(json.dumps({"lines": [], "error": "usage: ground_truth_status.py <corpus_root> <file>"}))
        return 1

    corpus_root = Path(sys.argv[1]).resolve()
    file_path = Path(sys.argv[2]).resolve()

    if str(corpus_root) not in sys.path:
        sys.path.insert(0, str(corpus_root))

    source = source_name_for(file_path)
    if not source:
        sys.stdout.write(json.dumps({"lines": []}))
        return 0

    text = sys.stdin.read()

    try:
        from authoring import service
    except Exception as error:
        sys.stdout.write(json.dumps({"lines": [], "error": f"{error.__class__.__name__}: {error}"}))
        return 1

    try:
        result = service.line_status_for_text(source, text)
    except KeyError:
        sys.stdout.write(json.dumps({"lines": []}))
        return 0
    except Exception as error:
        sys.stdout.write(json.dumps({"lines": [], "error": f"{error.__class__.__name__}: {error}"}))
        return 1

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
