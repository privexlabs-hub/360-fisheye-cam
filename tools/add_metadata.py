"""Adds MediaPipe Tasks metadata (input normalization) to the Apache-2.0 legacy
MediaPipe models bundled in the @mediapipe/face_detection and
@mediapipe/selfie_segmentation npm packages, so @mediapipe/tasks-vision can load them.
Usage: python3 add_metadata.py <face_in> <seg_in> <out_dir>"""
import sys, types, os
# The pip wheel ships without this compiled helper; it only reports a version string.
stub = types.ModuleType('_pywrap_metadata_version')
stub.GetMinimumMetadataParserVersion = lambda *_: '1.0.0'
for name in ['mediapipe.tasks.cc', 'mediapipe.tasks.cc.metadata', 'mediapipe.tasks.cc.metadata.python']:
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['mediapipe.tasks.cc.metadata.python._pywrap_metadata_version'] = stub
from mediapipe.tasks.python.metadata.metadata_writers import metadata_writer, image_segmenter

face_in, seg_in, out_dir = sys.argv[1:4]
os.makedirs(out_dir, exist_ok=True)

# BlazeFace short range: input expected in [-1, 1].
w = metadata_writer.MetadataWriter.create(open(face_in, 'rb').read())
w.add_general_info('BlazeFace short range', 'Face detector (Apache-2.0, MediaPipe)')
w.add_image_input(norm_mean=[127.5], norm_std=[127.5])
w.add_feature_output(name='regressors')
w.add_feature_output(name='classificators')
model, _ = w.populate()
open(os.path.join(out_dir, 'face_detector.tflite'), 'wb').write(model)

# Selfie segmentation: input expected in [0, 1].
labels = metadata_writer.Labels().add(['person'])
seg = image_segmenter.MetadataWriter.create(open(seg_in, 'rb').read(), input_norm_mean=[0.0], input_norm_std=[255.0], labels=labels)
model, _ = seg.populate()
open(os.path.join(out_dir, 'selfie_segmenter.tflite'), 'wb').write(model)
print('written', os.listdir(out_dir))
