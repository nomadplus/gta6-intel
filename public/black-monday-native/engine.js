const canvas = document.getElementById('gameCanvas');
const statusEl = document.getElementById('status');
const perfEl = document.getElementById('perf');
const movePad = document.getElementById('movePad');
const moveNub = movePad.querySelector('.nub');
const lookPad = document.getElementById('lookPad');
const actionButton = document.getElementById('actionButton');

class InputSystem {
  constructor() {
    this.keys = new Set();
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.action = false;
    this._movePointer = null;
    this._lookPointer = null;
    this._lastLook = null;
    addEventListener('keydown', e => this.keys.add(e.code));
    addEventListener('keyup', e => this.keys.delete(e.code));
    this.bindTouch();
  }
  bindTouch() {
    movePad.addEventListener('pointerdown', e => {
      movePad.setPointerCapture(e.pointerId);
      this._movePointer = e.pointerId;
      this.updateMove(e);
    });
    movePad.addEventListener('pointermove', e => {
      if (e.pointerId === this._movePointer) this.updateMove(e);
    });
    const clearMove = e => {
      if (e.pointerId !== this._movePointer) return;
      this._movePointer = null;
      this.move.x = this.move.y = 0;
      moveNub.style.transform = 'translate(0px,0px)';
    };
    movePad.addEventListener('pointerup', clearMove);
    movePad.addEventListener('pointercancel', clearMove);

    lookPad.addEventListener('pointerdown', e => {
      lookPad.setPointerCapture(e.pointerId);
      this._lookPointer = e.pointerId;
      this._lastLook = { x: e.clientX, y: e.clientY };
    });
    lookPad.addEventListener('pointermove', e => {
      if (e.pointerId !== this._lookPointer || !this._lastLook) return;
      this.look.x += e.clientX - this._lastLook.x;
      this.look.y += e.clientY - this._lastLook.y;
      this._lastLook = { x: e.clientX, y: e.clientY };
    });
    const clearLook = e => {
      if (e.pointerId !== this._lookPointer) return;
      this._lookPointer = null;
      this._lastLook = null;
    };
    lookPad.addEventListener('pointerup', clearLook);
    lookPad.addEventListener('pointercancel', clearLook);
    actionButton.addEventListener('pointerdown', () => this.action = true);
    actionButton.addEventListener('pointerup', () => this.action = false);
    actionButton.addEventListener('pointercancel', () => this.action = false);
  }
  updateMove(e) {
    const r = movePad.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const max = r.width * 0.34;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    if (len > max) { dx *= max / len; dy *= max / len; }
    this.move.x = dx / max;
    this.move.y = -dy / max;
    moveNub.style.transform = `translate(${dx}px,${dy}px)`;
  }
  sample() {
    const keyboardX = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const keyboardY = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const out = {
      moveX: Math.max(-1, Math.min(1, this.move.x + keyboardX)),
      moveY: Math.max(-1, Math.min(1, this.move.y + keyboardY)),
      lookX: this.look.x,
      lookY: this.look.y,
      action: this.action || this.keys.has('Space'),
    };
    this.look.x = this.look.y = 0;
    return out;
  }
}

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, stencil: false, powerPreference: 'high-performance' });
    if (!this.gl) throw new Error('WebGL2 unavailable');
    this.program = this.makeProgram(`#version 300 es\nlayout(location=0) in vec3 aPos;uniform vec2 uOffset;void main(){gl_Position=vec4(aPos.xy+uOffset,aPos.z,1.0);}`, `#version 300 es\nprecision mediump float;out vec4 outColor;void main(){outColor=vec4(0.70,0.72,0.74,1.0);}`);
    this.offsetLoc = this.gl.getUniformLocation(this.program, 'uOffset');
    this.vao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.vao);
    const vb = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vb);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
      -0.035,-0.055,0, 0.035,-0.055,0, 0.0,0.055,0,
      -1,-0.62,0.5, 1,-0.62,0.5, 1,-0.58,0.5,
      -1,-0.62,0.5, 1,-0.58,0.5, -1,-0.58,0.5,
    ]), this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 3, this.gl.FLOAT, false, 0, 0);
  }
  makeProgram(vsSource, fsSource) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(innerWidth * dpr));
    const h = Math.max(1, Math.floor(innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }
  render(world) {
    this.resize();
    const gl = this.gl;
    gl.clearColor(0.035,0.04,0.045,1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.offsetLoc, world.player.x, world.player.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.uniform2f(this.offsetLoc, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 3, 6);
  }
}

class World {
  constructor() {
    this.player = { x: 0, y: -0.25, heading: 0, speed: 0 };
    this.camera = { yaw: 0, pitch: 0 };
  }
  update(dt, input) {
    const targetSpeed = Math.min(1, Math.hypot(input.moveX, input.moveY));
    this.player.speed += (targetSpeed - this.player.speed) * Math.min(1, dt * 10);
    if (targetSpeed > 0.05) {
      const len = Math.hypot(input.moveX, input.moveY) || 1;
      this.player.x += (input.moveX / len) * this.player.speed * dt * 0.45;
      this.player.y += (input.moveY / len) * this.player.speed * dt * 0.45;
      this.player.x = Math.max(-0.95, Math.min(0.95, this.player.x));
      this.player.y = Math.max(-0.52, Math.min(0.52, this.player.y));
    }
    this.camera.yaw += input.lookX * 0.0025;
    this.camera.pitch = Math.max(-1.2, Math.min(1.2, this.camera.pitch + input.lookY * 0.0025));
  }
}

class Game {
  constructor() {
    this.input = new InputSystem();
    this.renderer = new Renderer(canvas);
    this.world = new World();
    this.fixedDt = 1 / 60;
    this.accumulator = 0;
    this.last = performance.now();
    this.frameCount = 0;
    this.fpsClock = this.last;
  }
  start() {
    statusEl.textContent = 'native runtime active — no PS2 emulation';
    requestAnimationFrame(t => this.frame(t));
  }
  frame(now) {
    const frameDt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.accumulator += frameDt;
    const input = this.input.sample();
    while (this.accumulator >= this.fixedDt) {
      this.world.update(this.fixedDt, input);
      this.accumulator -= this.fixedDt;
    }
    this.renderer.render(this.world);
    this.frameCount++;
    if (now - this.fpsClock >= 1000) {
      perfEl.textContent = `${Math.round(this.frameCount * 1000 / (now - this.fpsClock))} fps · WebGL2 · fixed 60 Hz sim`;
      this.frameCount = 0;
      this.fpsClock = now;
    }
    requestAnimationFrame(t => this.frame(t));
  }
}

try {
  new Game().start();
} catch (error) {
  console.error(error);
  statusEl.textContent = `runtime error: ${error?.message || error}`;
}
