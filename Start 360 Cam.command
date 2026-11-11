#!/bin/bash
# Double-click to run 360 Fisheye Cam on this Mac.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is needed. Install it from https://www.python.org/downloads/ and double-click this file again."
  read -r -p "Press Return to close." _
  exit 1
fi
exec python3 serve.py
