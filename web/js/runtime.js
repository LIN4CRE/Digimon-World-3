/**
 * The PlayStation runtime: the WASM core, the picture, the sound, the pad.
 *
 * The core is synchronous and DOM-free; this adapter owns the frame loop, the
 * WebGL2 presentation, the AudioWorklet ring buffer and input. It also owns
 * the machine's persistent state: memory cards and save states.
 *
 * The core takes the whole disc image (it copies it into wasm memory), so the
 * loader hydrates the image first and this class boots from an assembled
 * buffer. See docs/ARCHITECTURE.md for what that means for time-to-play and
 * what a streaming core would change.
 */
import { MEMCARD_BYTES } from './core-constants.js';

/** Pad bits, low to high: Select, -, -, Start, Up, Right, Down, Left, L2, R2, L1, R1, Triangle, Circle, Cross, Square. */
export const PAD = {
  SELECT: 1 << 0,
  START: 1 << 3,
  UP: 1 << 4,
  RIGHT: 1 << 5,
  DOWN: 1 << 6,
  LEFT: 1 << 7,
  L2: 1 << 8,
  R2: 1 << 9,
  L1: 1 << 10,
  R1: 1 << 11,
  TRIANGLE: 1 << 12,
  CIRCLE: 1 << 13,
  CROSS: 1 << 14,
  SQUARE: 1 << 15,
};

const DEFAULT_KEYMAP = {
  ArrowUp: ['UP'],
  ArrowDown: ['DOWN'],
  ArrowLeft: ['LEFT'],
  ArrowRight: ['RIGHT'],
  KeyX: ['CROSS'],
  KeyZ: ['CIRCLE'],
  KeyA: ['SQUARE'],
  KeyS: ['TRIANGLE'],
  KeyQ: ['L1'],
  KeyW: ['R1'],
  KeyE: ['L2'],
  KeyR: ['R2'],
  Enter: ['START'],
  ShiftLeft: ['SELECT'],
  ShiftRight: ['SELECT'],
};

/** Builds the pad mask from the pressed keys and the first gamepad. 0 = pressed. */
export class Pad {
  constructor() {
    this.keys = new Set();
    this.pressed = 0;
    this.enabled = true;
    this.axisDeadzone = 0.35;
    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (DEFAULT_KEYMAP[event.code]) {
        this.keys.add(event.code);
        event.preventDefault();
      }
    });
    window.addEventListener('keyup', (event) => {
      if (DEFAULT_KEYMAP[event.code]) this.keys.delete(event.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** @returns {number} the core's button mask */
  read() {
    if (!this.enabled) return 0xffff;
    let pressed = 0;
    for (const code of this.keys) {
      for (const button of DEFAULT_KEYMAP[code] ?? []) pressed |= PAD[button];
    }
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
      const [axisX = 0, axisY = 0] = pad.axes;
      if (pad.buttons[12]?.pressed || axisY < -this.axisDeadzone) pressed |= PAD.UP;
      if (pad.buttons[13]?.pressed || axisY > this.axisDeadzone) pressed |= PAD.DOWN;
      if (pad.buttons[14]?.pressed || axisX < -this.axisDeadzone) pressed |= PAD.LEFT;
      if (pad.buttons[15]?.pressed || axisX > this.axisDeadzone) pressed |= PAD.RIGHT;
      if (pad.buttons[0]?.pressed) pressed |= PAD.CROSS;
      if (pad.buttons[1]?.pressed) pressed |= PAD.CIRCLE;
      if (pad.buttons[2]?.pressed) pressed |= PAD.SQUARE;
      if (pad.buttons[3]?.pressed) pressed |= PAD.TRIANGLE;
      if (pad.buttons[4]?.pressed) pressed |= PAD.L1;
      if (pad.buttons[5]?.pressed) pressed |= PAD.R1;
      if (pad.buttons[6]?.pressed) pressed |= PAD.L2;
      if (pad.buttons[7]?.pressed) pressed |= PAD.R2;
      if (pad.buttons[8]?.pressed) pressed |= PAD.SELECT;
      if (pad.buttons[9]?.pressed) pressed |= PAD.START;
      break;
    }
    this.pressed = pressed;
    return (~pressed) & 0xffff;
  }
}

/** Presents frames through Canvas 2D when WebGL2 is unavailable (blocked driver, software-only browser, some remote desktops). */
export class Canvas2DPresenter {
  constructor(canvas) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) throw new Error('Neither WebGL2 nor Canvas 2D is available; this browser cannot show the picture');
    this.context = context;
    this.buffer = document.createElement('canvas');
    this.bufferContext = this.buffer.getContext('2d', { alpha: false });
    this.scaleMode = 'integer';
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.kind = 'canvas2d';
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(this.canvas.clientWidth * ratio);
    const height = Math.floor(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(rgba, width, height) {
    this.resize();
    if (width !== this.textureWidth || height !== this.textureHeight) {
      this.textureWidth = width;
      this.textureHeight = height;
      this.buffer.width = width;
      this.buffer.height = height;
    }
    this.bufferContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const ctx = this.context;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    let viewWidth;
    let viewHeight;
    if (this.scaleMode === 'integer') {
      const scale = Math.max(1, Math.floor(Math.min(canvasWidth / width, canvasHeight / height)));
      viewWidth = width * scale;
      viewHeight = height * scale;
    } else {
      const scale = Math.min(canvasWidth / width, canvasHeight / height);
      viewWidth = Math.floor(width * scale);
      viewHeight = Math.floor(height * scale);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.drawImage(this.buffer, Math.floor((canvasWidth - viewWidth) / 2), Math.floor((canvasHeight - viewHeight) / 2), viewWidth, viewHeight);
  }
}

/** Presents the core's RGBA frames with WebGL2, integer-scaled and letterboxed. */
export class Presenter {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WEBGL2_UNAVAILABLE');
    this.kind = 'webgl2';
    this.gl = gl;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const vertex = `#version 300 es
      in vec2 position;
      out vec2 uv;
      void main() {
        uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
        gl_Position = vec4(position, 0.0, 1.0);
      }`;
    const fragment = `#version 300 es
      precision mediump float;
      in vec2 uv;
      uniform sampler2D frame;
      out vec4 color;
      void main() { color = texture(frame, uv); }`;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader failed');
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program failed');
    gl.useProgram(program);
    this.program = program;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0);
    this.scaleMode = 'integer';
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(this.canvas.clientWidth * ratio);
    const height = Math.floor(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Draws one frame. `rgba` is a view into wasm memory: upload it now. */
  draw(rgba, width, height) {
    const gl = this.gl;
    this.resize();
    if (width !== this.textureWidth || height !== this.textureHeight) {
      this.textureWidth = width;
      this.textureHeight = height;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    let viewWidth = canvasWidth;
    let viewHeight = canvasHeight;
    if (this.scaleMode === 'integer') {
      const scale = Math.max(1, Math.floor(Math.min(canvasWidth / width, canvasHeight / height)));
      viewWidth = width * scale;
      viewHeight = height * scale;
    } else {
      const scale = Math.min(canvasWidth / width, canvasHeight / height);
      viewWidth = Math.floor(width * scale);
      viewHeight = Math.floor(height * scale);
    }
    gl.viewport(Math.floor((canvasWidth - viewWidth) / 2), Math.floor((canvasHeight - viewHeight) / 2), viewWidth, viewHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/**
 * WebGL2 when it exists, Canvas 2D when it does not. The picture is identical;
 * the difference is how many pixels the GPU touches on the way to the screen.
 */
export function createPresenter(canvas) {
  try {
    return new Presenter(canvas);
  } catch (error) {
    if (error.message !== 'WEBGL2_UNAVAILABLE') throw error;
    console.warn('[presenter] WebGL2 unavailable, using Canvas 2D');
    return new Canvas2DPresenter(canvas);
  }
}

/**
 * The machine: core + frame loop + audio + input + saves.
 */
export class Ps1Runtime {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {(state: object) => void} [opts.onState]
   */
  constructor({ canvas, onState = () => {} }) {
    this.canvas = canvas;
    this.onState = onState;
    this.core = null;
    this.presenter = null;
    this.pad = new Pad();
    this.audio = null;
    this.running = false;
    this.paused = false;
    this.fastForward = false;
    this.frames = 0;
    this.droppedFrames = 0;
    this.lastFrameAt = 0;
    this.fps = 0;
    this.frameTimes = [];
    this.audioNode = null;
  }

  /** Loads the WASM module and instantiates the machine. */
  async loadCore({ wasmUrl, onProgress = () => {} }) {
    const response = await fetch(wasmUrl, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`The emulator core could not be loaded (HTTP ${response.status} from ${wasmUrl})`);
    const total = Number(response.headers.get('content-length') ?? 0);
    const reader = response.body?.getReader();
    let buffer;
    if (reader && total) {
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress({ received, total, fraction: received / total });
      }
      buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      buffer = new Uint8Array(await response.arrayBuffer());
      onProgress({ received: buffer.byteLength, total: buffer.byteLength, fraction: 1 });
    }
    const module = await WebAssembly.compile(buffer);
    const { Ps1Core } = await import('./ps1-core.js');
    this.core = await Ps1Core.create(module, { onLog: (line) => console.debug('[ps1]', line) });
    this.core.setCpuEngine('cached');
    this.presenter = createPresenter(this.canvas);
    this.memcard = new Uint8Array(MEMCARD_BYTES);
    this.memcard.fill(0);
    this.core.loadMemcard(0, this.memcard);
    return this;
  }

  /** Installs a BIOS image (the player's own, or the MIT OpenBIOS). */
  loadBios(bytes) {
    if (!this.core) throw new Error('Load the core before the BIOS');
    if (bytes.byteLength !== 512 * 1024) {
      throw Object.assign(new Error(`A PlayStation BIOS image is 512 KiB; this file is ${bytes.byteLength} bytes`), {
        code: 'BAD_BIOS_SIZE',
      });
    }
    const info = this.core.loadBios(bytes);
    return info;
  }

  /** Inserts the assembled disc image and boots. */
  loadDisc({ image, cue }) {
    if (!this.core) throw new Error('Load the core before the disc');
    this.core.loadDisc({ bin: image, cue });
    return { pal: this.core.isPal };
  }

  async startAudio() {
    if (this.audio) return;
    const context = new (window.AudioContext ?? window.webkitAudioContext)({ sampleRate: 44100, latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/js/audio-worklet.js');
    const node = new AudioWorkletNode(context, 'ps1-audio', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.gain = context.createGain();
    this.gain.gain.value = 0.8;
    node.connect(this.gain).connect(context.destination);
    this.audioContext = context;
    this.audioNode = node;
    this.audio = { pushed: 0, underruns: 0 };
    node.port.onmessage = (event) => {
      if (event.data?.type === 'stats') this.audio.underruns = event.data.underruns;
    };
  }

  /** 0..1 */
  setVolume(value) {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, value));
  }

  pushAudio() {
    if (!this.audioNode) return;
    const samples = this.core.readAudio();
    if (samples && samples.length) {
      this.audioNode.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
      this.audio.pushed += samples.length;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.lastFrameAt = performance.now();
    this.accumulator = 0;
    const frameDuration = this.core.isPal ? 1000 / 50 : 1000 / 60;
    this.frameDuration = frameDuration;
    const loop = (now) => {
      if (!this.running) return;
      const delta = Math.min(now - this.lastFrameAt, 250);
      this.lastFrameAt = now;
      if (!this.paused) {
        this.accumulator += delta;
        const budget = this.fastForward ? 8 : 3;
        let steps = 0;
        while (this.accumulator >= frameDuration && steps < budget) {
          this.core.setButtons(this.pad.read());
          this.core.runFrame();
          this.pushAudio();
          this.accumulator -= frameDuration;
          this.frames++;
          steps++;
        }
        if (steps === budget) this.droppedFrames++;
        const frame = this.core.frame();
        this.presenter.draw(frame.rgba, frame.width, frame.height);
        this.frameTimes.push(now);
        while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
        this.fps = this.frameTimes.length;
      }
      this.onState({
        running: true,
        paused: this.paused,
        fps: this.fps,
        frames: this.frames,
        fastForward: this.fastForward,
        audioPushed: this.audio?.pushed ?? 0,
      });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.audioContext?.suspend?.();
  }

  pause(paused = true) {
    this.paused = paused;
    if (this.audioContext) {
      if (paused) this.audioContext.suspend();
      else this.audioContext.resume();
    }
  }

  /** A save state: the whole machine at this instant. */
  saveState() {
    return this.core.saveState();
  }

  loadState(bytes) {
    this.core.loadState(bytes);
  }

  /** The memory card as the game last wrote it, or null when unchanged. */
  takeMemcard() {
    return this.core.takeMemcard(0);
  }

  installMemcard(bytes) {
    if (bytes.byteLength !== MEMCARD_BYTES) throw new Error(`A memory card is ${MEMCARD_BYTES} bytes`);
    this.memcard = new Uint8Array(bytes);
    this.core.loadMemcard(0, this.memcard);
  }

  reset() {
    this.core.reset();
  }
}
