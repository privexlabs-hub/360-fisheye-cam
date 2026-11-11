#!/usr/bin/env bash
# Rebuilds vendor/ and models/ from npm. Needs Node.js and Python 3.
# Usage: bash tools/setup_vendor.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund @mediapipe/tasks-vision@1.2.2 mediabunny@1.65.2 \
  @mediapipe/face_detection@0.4.1646425229 @mediapipe/selfie_segmentation@0.1.1675465747
mkdir -p "$ROOT/vendor/mediapipe/wasm" "$ROOT/models"
cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs "$ROOT/vendor/mediapipe/"
cp node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.{js,wasm} "$ROOT/vendor/mediapipe/wasm/"
cp node_modules/mediabunny/dist/bundles/mediabunny.min.mjs "$ROOT/vendor/"
cp node_modules/mediabunny/LICENSE "$ROOT/vendor/MEDIABUNNY_LICENSE"
python3 "$ROOT/tools/patch_mediapipe.py" "$ROOT/vendor/mediapipe/vision_bundle.mjs"
# The models need MediaPipe Tasks metadata: pip install mediapipe
python3 "$ROOT/tools/add_metadata.py" \
  node_modules/@mediapipe/face_detection/face_detection_short_range.tflite \
  node_modules/@mediapipe/selfie_segmentation/selfie_segmentation.tflite "$ROOT/models"
rm -rf "$TMP"
echo "vendor/ and models/ rebuilt"
