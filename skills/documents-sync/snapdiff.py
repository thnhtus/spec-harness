#!/usr/bin/env python3
"""Compare a fetched ClickUp page against its last-synced manifest snapshot.

Usage:
    python3 snapdiff.py <pageId> <fetchedContentFile>
    python3 snapdiff.py --show <pageId>      # print stored snapshot

Prints IDENTICAL / CHANGED (+unified diff) / NEW-PAGE. Exit 0 always;
read the first line for the verdict.

ponytail: whitespace-normalised compare only, no markdown-aware diff —
add one if BA reformatting starts causing false CHANGED verdicts.
"""
import json
import sys
import difflib
import pathlib

MANIFEST = pathlib.Path(__file__).resolve().parents[3] / "docs/.sync-state/clickup-docs.json"


def snapshot(page_id):
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for doc in m["documents"].values():
        if page_id in doc["pages"]:
            return doc["pages"][page_id].get("contentSnapshot", "")
    return None


def norm(s):
    return "\n".join(line.rstrip() for line in (s or "").strip().splitlines())


def main():
    if sys.argv[1] == "--show":
        s = snapshot(sys.argv[2])
        print("NEW-PAGE" if s is None else s)
        return
    page_id, fetched_file = sys.argv[1], sys.argv[2]
    old = snapshot(page_id)
    new = pathlib.Path(fetched_file).read_text(encoding="utf-8")
    if old is None:
        print(f"NEW-PAGE {page_id} ({len(new)} chars)")
        return
    a, b = norm(old), norm(new)
    if a == b:
        print(f"IDENTICAL {page_id}")
        return
    print(f"CHANGED {page_id} (was {len(a)} chars, now {len(b)} chars)")
    for line in difflib.unified_diff(
        a.splitlines(), b.splitlines(), "manifest-snapshot", "clickup-live", lineterm="", n=2
    ):
        print(line)


if __name__ == "__main__":
    main()
