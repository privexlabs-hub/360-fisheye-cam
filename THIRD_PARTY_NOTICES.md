# Third-party software

## MediaPipe Tasks Vision (`vendor/mediapipe/`)
Copyright Google LLC. Licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
Modification: the usage-logging upload in `vision_bundle.mjs` is disabled (see `tools/patch_mediapipe.py`).

## MediaPipe models (`models/`)
`face_detector.tflite` (BlazeFace short range) and `selfie_segmenter.tflite` (Selfie Segmentation), from the `@mediapipe/face_detection` and `@mediapipe/selfie_segmentation` npm packages. Copyright Google LLC, Apache License 2.0.
Modification: MediaPipe Tasks metadata (input normalisation) was added with `tools/add_metadata.py`; the weights are unchanged.

## Mediabunny (`vendor/mediabunny.min.mjs`)
Copyright Vanilagy. Licensed under the Mozilla Public License 2.0; see `vendor/MEDIABUNNY_LICENSE`. Unmodified. Source: https://github.com/Vanilagy/mediabunny
