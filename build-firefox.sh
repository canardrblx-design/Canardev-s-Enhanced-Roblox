#!/bin/bash
# Generates firefox-build/ from extension/ with a Firefox-compatible manifest.
# Firefox uses background.scripts; Chrome MV3 hard-rejects that and needs
# service_worker — so we keep extension/ as Chrome and build a Firefox copy.
set -e
cd "$(dirname "$0")"
rm -rf firefox-build
cp -r extension firefox-build
python3 - <<'PY'
import json
p = "firefox-build/manifest.json"
m = json.load(open(p))
# Firefox: background page runs the listeners as plain scripts
m["background"] = {"scripts": ["background.js"]}
json.dump(m, open(p, "w"), indent=2)
print("firefox-build ready — background switched to scripts")
PY
