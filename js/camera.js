// Live camera access.

export class CameraError extends Error {
  constructor(message, cause) { super(message); this.cause = cause; }
}

export function cameraErrorMessage(e) {
  const name = e?.name || '';
  if (!window.isSecureContext) return 'The camera only works when the app is opened over HTTPS (or on localhost).';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return ios
      ? 'Camera access was blocked. On iPhone, open Settings → Apps → Safari → Camera and choose Allow or Ask, then reload this page.'
      : 'Camera access was blocked. Allow the camera for this site in your browser\'s site settings (the icon next to the address), then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is busy in another app. Close other apps using it and try again.';
  return 'The camera could not be started on this device.';
}

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facing = 'user';
  }

  async start(facing = this.facing) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('This browser does not support camera access.');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (e) {
      throw new CameraError(cameraErrorMessage(e), e);
    }
    this.facing = facing;
    const v = this.video;
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.srcObject = this.stream;
    await v.play();
    if (!v.videoWidth) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    return { w: v.videoWidth, h: v.videoHeight };
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  async hasMultipleCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length > 1;
    } catch { return false; }
  }

  /** Microphone for recordings; asked only when the user starts recording. */
  async microphone() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      return s.getAudioTracks()[0] || null;
    } catch (e) {
      console.warn('Microphone unavailable', e);
      return null;
    }
  }
}
