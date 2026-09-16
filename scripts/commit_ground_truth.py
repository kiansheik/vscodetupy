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
    if len(sys.argv) != 4:
        sys.stdout.write(
            json.dumps({"ok": False, "error": "usage: commit_ground_truth.py <corpus_root> <file> <ordinal>"})
        )
        return 1

    corpus_root = Path(sys.argv[1]).resolve()
    file_path = Path(sys.argv[2]).resolve()
    try:
        ordinal = int(sys.argv[3])
    except ValueError:
        sys.stdout.write(json.dumps({"ok": False, "error": f"invalid ordinal: {sys.argv[3]!r}"}))
        return 1

    if str(corpus_root) not in sys.path:
        sys.path.insert(0, str(corpus_root))

    source = source_name_for(file_path)
    if not source:
        sys.stdout.write(json.dumps({"ok": False, "error": f"not a tracked source file: {file_path}"}))
        return 1

    try:
        from authoring import service
    except Exception as error:
        sys.stdout.write(json.dumps({"ok": False, "error": f"{error.__class__.__name__}: {error}"}))
        return 1

    try:
        result = service.commit_ground_truth(source, ordinal)
    except Exception as error:
        sys.stdout.write(json.dumps({"ok": False, "error": f"{error.__class__.__name__}: {error}"}))
        return 1

    sys.stdout.write(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
