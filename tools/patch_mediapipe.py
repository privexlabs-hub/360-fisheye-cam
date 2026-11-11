"""Disable MediaPipe's built-in usage logging (it POSTs to odml.pa.googleapis.com).
The app promises that nothing leaves the device, so the vendored bundle is
patched to drop log batches instead of sending them. The app's CSP
(connect-src 'self') would block the request anyway; this removes the attempt.
Usage: python3 tools/patch_mediapipe.py vendor/mediapipe/vision_bundle.mjs"""
import sys
path = sys.argv[1]
s = open(path, encoding='utf-8').read()
needle = 'flush(t,e){if(this.error)'
patched = 'flush(t,e){this.i=[];t?.();return;if(this.error)'
if patched in s:
    print('already patched')
elif s.count(needle) == 1 and 'odml.pa.googleapis.com' in s:
    open(path, 'w', encoding='utf-8').write(s.replace(needle, patched))
    print('patched')
else:
    sys.exit('Could not find the logging code; check the MediaPipe version before shipping.')
