// WebGL2 renderer: owns the context, the three textures (camera frame,
// person mask, background image) and the single effect program.
import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.js';

export class RendererError extends Error {}

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.src = { w: 0, h: 0 };
    this.mask = { w: 0, h: 0, ready: false };
    this.bg = { w: 0, h: 0, ready: false };
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this._init(); this.onRestored?.(); });
    this._init();
  }

  _init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new RendererError('This browser cannot run WebGL2, which the effects need. Try an up-to-date Chrome, Safari, Edge or Firefox.');
    this.gl = gl;
    this.program = this._link(VERTEX_SHADER, FRAGMENT_SHADER);
    gl.useProgram(this.program);
    this.vao = gl.createVertexArray();
    this.u = {};
    const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(this.program, i);
      this.u[info.name] = gl.getUniformLocation(this.program, info.name);
    }
    this.camTex = this._texture(gl.CLAMP_TO_EDGE, true);
    this.maskTex = this._texture(gl.CLAMP_TO_EDGE, false);
    this.bgTex = this._texture(gl.REPEAT, true);
    gl.uniform1i(this.u.uCam, 0);
    gl.uniform1i(this.u.uMask, 1);
    gl.uniform1i(this.u.uBg, 2);
    this.src = { w: 0, h: 0 };
    this.mask.ready = false;
    this.bg.ready = false;
  }

  _link(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        console.error('Shader compile error:', log);
        throw new RendererError('The graphics effect could not be prepared on this device.');
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(p));
      throw new RendererError('The graphics effect could not be prepared on this device.');
    }
    return p;
  }

  _texture(wrap, mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 1x1 placeholder so the program is always complete.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  get maxTextureSize() { return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE); }

  setOutputSize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /** Upload the current camera/video/image frame. */
  uploadSource(source, w, h) {
    if (this.lost) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (w !== this.src.w || h !== this.src.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.src = { w, h };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Upload a person mask (Uint8Array, one byte per pixel, top row first). */
  uploadMask(data, w, h) {
    if (this.lost) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    this.mask = { w, h, ready: true };
  }

  clearMask() { this.mask.ready = false; }

  /** Upload the background image used for the image planet. */
  uploadBackground(source, w, h) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.bg = { w, h, ready: true };
  }

  /** Draw one frame. `u` holds already-resolved uniform values (see effects.js). */
  render(u) {
    if (this.lost || !this.src.w) return false;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    const L = this.u;
    gl.uniform2f(L.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(L.uSrcRes, this.src.w, this.src.h);
    gl.uniform1f(L.uCamMaxLod, Math.floor(Math.log2(Math.max(this.src.w, this.src.h))));
    gl.uniform1f(L.uHasMask, this.mask.ready ? 1 : 0);
    gl.uniform2f(L.uMaskRes, Math.max(1, this.mask.w), Math.max(1, this.mask.h));
    for (const [name, v] of Object.entries(u)) {
      const loc = L[name];
      if (loc == null) continue;
      if (name === 'uMode' || name === 'uLens' || name === 'uBgKind' || name === 'uScene') gl.uniform1i(loc, v);
      else if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
}
