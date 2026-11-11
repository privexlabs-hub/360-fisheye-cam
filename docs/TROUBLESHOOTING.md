# Troubleshooting

## The camera doesn't start

- The page must be opened over **https://** (or `localhost`).
- **iPhone:** Settings → Apps → Safari → Camera → Allow, then reload. Inside TikTok, Instagram or Facebook's built-in browser the camera often can't start: open the page in Safari.
- **Android/desktop:** tap the icon next to the address bar → Permissions → Camera → Allow.
- "The camera is busy": close other apps or tabs using it.

## "Face tracking is unavailable" / "person cut-out could not start"

The face and cut-out components could not load on this device (old browser, low memory, or blocked WebAssembly). The fisheye and real-background planet still work: turn off **Follow my face** and place the effect with the position sliders. The planet covers need the cut-out.

## The effect lags or stutters

- Choose **Quality → Standard**.
- The cover planets do the most work (face tracking plus cut-out every frame). The real-background looks are lighter.
- On slow devices the app analyses every other frame automatically.

## Recordings and exports

| Browser | Live recording | Video export |
|---|---|---|
| Safari (iOS/macOS) | MP4 (H.264/AAC) | MP4, frame by frame (Safari 26+). Older iOS records in real time. |
| Chrome/Edge | MP4 where the system has an H.264 encoder, otherwise WebM | MP4 (H.264) or WebM, frame by frame |
| Firefox | WebM | Frame by frame on desktop; real time on Android |

- **WebM files may not open in iPhone Photos.** Export on the iPhone itself, or convert the file.
- If the result says the sound could not be kept, the browser had no encoder for the original audio format in the output container.
- Live recordings stop at 10 minutes. A 10-minute recording is roughly 300–750 MB depending on quality. Browsers that support private on-device storage write it there as you record; others keep it in memory (at a lower bitrate), which can fail on phones with little memory. If the device runs out of space the recording stops with a message.
- If saving fails, the device may be out of storage.

## Supported files

- Photos: JPG, PNG, WebP, GIF (first frame), AVIF. HEIC only opens in Safari; elsewhere, export it as JPG first.
- Videos: MP4/MOV (H.264, HEVC where the device supports it), WebM (VP8/VP9/AV1). Rotation metadata from phones is applied.

## Known limitations

- **Not 360° capture.** The camera can't see behind you. In the real-background planet, everything beyond the camera's view is mirrored and blended from the visible edges. Objects at the edge of the frame, including your own head, can appear mirrored.
- The built-in tiny-planet scenes (Sunny street, Beach, Night city) are illustrations, not real places.
- The cut-out can lose fingers, hair strands or objects you hold, and can flicker in poor light or against busy backgrounds.
- Face tracking needs a reasonably frontal face. When it loses you for more than a second, the effect returns to the manual position.
- A flat picture is warped in 2D. There is no real depth or parallax.
- Performance has not been measured on real phones yet. See OPEN_DECISIONS.md.

## Reporting a problem

Open the browser's developer console (on desktop) to see technical details, which are logged there and not shown in the app.
