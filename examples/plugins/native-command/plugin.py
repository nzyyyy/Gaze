#!/usr/bin/env python3
import json
import sys

request = json.load(sys.stdin)
text = request["text"]
lines = text.split("\n")
trailing = lines.pop() if text.endswith("\n") else None
result = "\n".join(sorted(lines))
if trailing is not None:
    result += "\n"
json.dump({"kind": "replace", "text": result}, sys.stdout)
