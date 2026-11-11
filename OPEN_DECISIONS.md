# Open decisions

Decisions already made by the product owner (this build follows them):

| Topic | Decision |
|---|---|
| Platform | Web app instead of the desktop app, so phones can be used. |
| Input | Live camera **and** uploaded photos/videos. |
| Default look | Tiny-planet background behind the person. It can be changed (own image) or removed (real background, as a planet or fisheye). |
| Unseen areas | Filled with mirrored/stretched edges that blend naturally with the surroundings; no AI generation. |
| Face effect | Automatic face following with manual override (PRD decision 3, option C). |
| Mirroring | Recordings and photos match the preview (mirrored for the front camera); the Mirror switch changes both. Confirmed 8 Nov 2026. |
| Live recording length | Up to 10 minutes, streamed to on-device storage where supported. Confirmed 8 Nov 2026. |
| Built-in scenes | Three illustrated scenes: Sunny street, Beach, Night city. Approved 8 Nov 2026; more can be added. |

Still open:

## 1. Supported devices and browser versions
**Why it matters:** WebCodecs, recording formats and performance vary by browser.
**Options:** (a) latest iOS + Android + desktop Chrome/Safari only; (b) also older iOS (16–18) with real-time export; (c) a specific device list.
**Consequence:** (b) is already supported in code, but untested.
**Needed:** the list of phones and computers to test on.

## 2. Performance targets
**Why it matters:** the PRD forbids invented targets.
**Options:** e.g. ≥24 fps live preview at 720p on a named mid-range phone; export ≤2× clip length.
**Consequence:** may require lowering the default analysis rate or resolution.
**Needed:** target numbers and the reference devices. Measured so far: in headless Chrome with software rendering only (no GPU), a 4 s 720×940 clip exported in about 27–29 s. Real devices with a GPU will be much faster, but this is not yet measured.

## 3. Virtual webcam output (PRD decision 2)
Browsers cannot create a system webcam device. That needs a desktop companion (e.g. OBS with a browser source). **Needed:** confirm it is out of scope.

## 4. Visual acceptance
The effects were checked against the two reference screenshots using test images only. **Needed:** product-owner review on a real phone with real footage, then default tuning.
