// BLACK_MONDAY_WEB iPhone preview bundle — generated from verified v0.3.2 modules.

// ---- input/controlProfiles.js ----
const PAD = Object.freeze({
  ANALOG_LEFT_X: 0, ANALOG_LEFT_Y: 1, ANALOG_RIGHT_X: 2, ANALOG_RIGHT_Y: 3,
  DPAD_UP: 4, DPAD_DOWN: 5, DPAD_LEFT: 6, DPAD_RIGHT: 7,
  SELECT: 8, START: 9, SQUARE: 10, TRIANGLE: 11, CIRCLE: 12, CROSS: 13,
  L1: 14, L2: 15, L3: 16, R1: 17, R2: 18, R3: 19,
});

const KEY = Object.freeze({
  SQUARE: 'KeyA', CROSS: 'KeyZ', TRIANGLE: 'KeyS', CIRCLE: 'KeyX',
  L1: 'Key1', L2: 'Key2', L3: 'Key3', R1: 'Key8', R2: 'Key9', R3: 'Key0',
  START: 'Enter', SELECT: 'Backspace',
  LEFT_LEFT: 'KeyF', LEFT_RIGHT: 'KeyH', LEFT_UP: 'KeyT', LEFT_DOWN: 'KeyG',
  RIGHT_LEFT: 'KeyJ', RIGHT_RIGHT: 'KeyL', RIGHT_UP: 'KeyI', RIGHT_DOWN: 'KeyK',
});

const KEY_TO_PAD = Object.freeze({
  [KEY.SQUARE]: PAD.SQUARE, [KEY.CROSS]: PAD.CROSS, [KEY.TRIANGLE]: PAD.TRIANGLE, [KEY.CIRCLE]: PAD.CIRCLE,
  [KEY.L1]: PAD.L1, [KEY.L2]: PAD.L2, [KEY.L3]: PAD.L3, [KEY.R1]: PAD.R1, [KEY.R2]: PAD.R2, [KEY.R3]: PAD.R3,
  [KEY.START]: PAD.START, [KEY.SELECT]: PAD.SELECT,
});

const CONTROL_PROFILES = Object.freeze({
  onFootMitch: [
    ['ATTACK/FIRE', KEY.SQUARE], ['ACTION', KEY.TRIANGLE], ['COVER/ROLL', KEY.CROSS], ['ARREST/DRAG', KEY.CIRCLE],
    ['TARGET', KEY.R1], ['FREE AIM', KEY.R2], ['RELOAD', KEY.L2], ['WEAPON', KEY.R3],
  ],
  driving: [
    ['ACCEL', KEY.CROSS], ['BRAKE', KEY.SQUARE], ['REVERSE', KEY.CIRCLE], ['EXIT', KEY.TRIANGLE],
    ['HANDBRAKE', KEY.R1], ['SHOOT', KEY.L1], ['LOOK L', KEY.L2], ['LOOK R', KEY.R2],
  ],
});


// ---- input/inputMath.js ----
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function normalizeStick(dx, dy, radius) {
  const length = Math.hypot(dx, dy);
  if (!length || !radius) return { x: 0, y: 0, magnitude: 0 };
  const scale = Math.min(1, radius / length);
  return { x: (dx * scale) / radius, y: (dy * scale) / radius, magnitude: Math.min(1, length / radius) };
}

function vectorToDigitalKeys(x, y, keys, deadZone = 0.24) {
  const active = new Set();
  if (x < -deadZone) active.add(keys.left);
  if (x > deadZone) active.add(keys.right);
  if (y < -deadZone) active.add(keys.up);
  if (y > deadZone) active.add(keys.down);
  return active;
}

function axisToPs2Byte(v, deadZone = 0.08) {
  if (Math.abs(v) < deadZone) return 0x7F;
  return clamp(Math.round(0x7F + v * 0x80), 0, 0xFF);
}


// ---- input/GamepadController.js ----


// W3C Standard Gamepad layout -> PS2 pad semantics used by Play!.
const BUTTON_MAP = Object.freeze({
  0: [PAD.CROSS, KEY.CROSS],
  1: [PAD.CIRCLE, KEY.CIRCLE],
  2: [PAD.SQUARE, KEY.SQUARE],
  3: [PAD.TRIANGLE, KEY.TRIANGLE],
  4: [PAD.L1, KEY.L1],
  5: [PAD.R1, KEY.R1],
  6: [PAD.L2, KEY.L2],
  7: [PAD.R2, KEY.R2],
  8: [PAD.SELECT, KEY.SELECT],
  9: [PAD.START, KEY.START],
  10: [PAD.L3, KEY.L3],
  11: [PAD.R3, KEY.R3],
});

const DPAD_MAP = Object.freeze({
  12: [PAD.DPAD_UP, 'ArrowUp'],
  13: [PAD.DPAD_DOWN, 'ArrowDown'],
  14: [PAD.DPAD_LEFT, 'ArrowLeft'],
  15: [PAD.DPAD_RIGHT, 'ArrowRight'],
});

class GamepadController {
  constructor({ canvas, emitKey, onActivity = () => {} } = {}) {
    this.canvas = canvas;
    this.emitKey = emitKey ?? ((code, down) => this.dispatchKey(code, down));
    this.onActivity = onActivity;
    this.nativePadSink = null;
    this.running = false;
    this.raf = 0;
    this.heldKeys = new Set();
    this.lastPadIndex = null;
    this.axisDeadzone = 0.12;
    this._loop = this._loop.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.releaseAll();
  }

  attachNativePadSink({ setValue, clearValue, clearAll }) {
    this.releaseAll();
    this.nativePadSink = { setValue, clearValue, clearAll };
    this.nativePadSink.clearAll?.();
  }

  detachNativePadSink() {
    this.releaseAll();
    this.nativePadSink = null;
  }

  _loop() {
    if (!this.running) return;
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find(p => p && p.connected && (p.mapping === 'standard' || p.axes.length >= 4));
    if (pad) this.updateFromGamepad(pad);
    else if (this.lastPadIndex !== null) {
      this.releaseAll();
      this.lastPadIndex = null;
    }
    this.raf = requestAnimationFrame(this._loop);
  }

  updateFromGamepad(gamepad) {
    this.lastPadIndex = gamepad.index;
    const buttonStates = Object.fromEntries(
      [...Object.keys(BUTTON_MAP), ...Object.keys(DPAD_MAP)].map(indexText => {
        const index = Number(indexText);
        const button = gamepad.buttons[index];
        return [index, Boolean(button?.pressed || (button?.value ?? 0) > 0.5)];
      }),
    );
    const axes = [0, 1, 2, 3].map(i => this.applyDeadzone(gamepad.axes[i] ?? 0));
    const active = Object.values(buttonStates).some(Boolean) || axes.some(v => Math.abs(v) > 0);

    // Claim ownership before emitting the first active frame so a newly used gamepad
    // doesn't lose its first movement/button event to the input arbiter.
    if (active) this.onActivity({ type: 'gamepad', index: gamepad.index, id: gamepad.id });

    for (const [indexText, [padButton, fallbackKey]] of Object.entries(BUTTON_MAP)) {
      this.emitButton(padButton, fallbackKey, buttonStates[Number(indexText)]);
    }
    for (const [indexText, [padButton, fallbackKey]] of Object.entries(DPAD_MAP)) {
      this.emitButton(padButton, fallbackKey, buttonStates[Number(indexText)]);
    }

    if (this.nativePadSink) {
      this.nativePadSink.setValue(PAD.ANALOG_LEFT_X, axisToPs2Byte(axes[0]));
      this.nativePadSink.setValue(PAD.ANALOG_LEFT_Y, axisToPs2Byte(axes[1]));
      this.nativePadSink.setValue(PAD.ANALOG_RIGHT_X, axisToPs2Byte(axes[2]));
      this.nativePadSink.setValue(PAD.ANALOG_RIGHT_Y, axisToPs2Byte(axes[3]));
    } else {
      this.syncKeyGroup(
        vectorToDigitalKeys(axes[0], axes[1], { left: KEY.LEFT_LEFT, right: KEY.LEFT_RIGHT, up: KEY.LEFT_UP, down: KEY.LEFT_DOWN }, 0.25),
        [KEY.LEFT_LEFT, KEY.LEFT_RIGHT, KEY.LEFT_UP, KEY.LEFT_DOWN],
      );
      this.syncKeyGroup(
        vectorToDigitalKeys(axes[2], axes[3], { left: KEY.RIGHT_LEFT, right: KEY.RIGHT_RIGHT, up: KEY.RIGHT_UP, down: KEY.RIGHT_DOWN }, 0.25),
        [KEY.RIGHT_LEFT, KEY.RIGHT_RIGHT, KEY.RIGHT_UP, KEY.RIGHT_DOWN],
      );
    }
  }

  applyDeadzone(value) {
    const v = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    if (Math.abs(v) <= this.axisDeadzone) return 0;
    const sign = Math.sign(v);
    return sign * ((Math.abs(v) - this.axisDeadzone) / (1 - this.axisDeadzone));
  }

  emitButton(padButton, fallbackKey, down) {
    if (this.nativePadSink) {
      if (down) this.nativePadSink.setValue(padButton, 1);
      else this.nativePadSink.clearValue(padButton);
    } else this.setFallbackKey(fallbackKey, down);
  }

  syncKeyGroup(next, group) {
    for (const code of group) this.setFallbackKey(code, next.has(code));
  }

  setFallbackKey(code, down) {
    const already = this.heldKeys.has(code);
    if (already === down) return;
    if (down) this.heldKeys.add(code); else this.heldKeys.delete(code);
    this.emitKey(code, down);
  }

  neutralizeAxes() {
    if (!this.nativePadSink) return;
    const neutral = axisToPs2Byte(0);
    this.nativePadSink.setValue(PAD.ANALOG_LEFT_X, neutral);
    this.nativePadSink.setValue(PAD.ANALOG_LEFT_Y, neutral);
    this.nativePadSink.setValue(PAD.ANALOG_RIGHT_X, neutral);
    this.nativePadSink.setValue(PAD.ANALOG_RIGHT_Y, neutral);
  }

  releaseAll() {
    for (const code of [...this.heldKeys]) this.setFallbackKey(code, false);
    this.nativePadSink?.clearAll?.();
  }

  dispatchKey(code, down) {
    const event = new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true, cancelable: true });
    this.canvas?.dispatchEvent(event);
  }
}

const STANDARD_GAMEPAD_BUTTON_MAP = BUTTON_MAP;


// ---- input/TouchController.js ----


class TouchController {
  constructor({ canvas, leftStick, lookZone, buttons, pauseButton, emitKey, onActivity = () => {} }) {
    this.canvas = canvas;
    this.leftStick = leftStick;
    this.lookZone = lookZone;
    this.buttons = buttons;
    this.pauseButton = pauseButton;
    this.emitKey = emitKey ?? ((code, down) => this.dispatchKey(code, down));
    this.onActivity = onActivity;
    this.nativePadSink = null;
    this.held = new Set();
    this.mode = 'onFootMitch';
    this.leftPointer = null;
    this.lookPointer = null;
    this.lookLast = null;
    this.lookNeutralTimer = null;
  }

  mount() {
    this.renderButtons();
    this.bindStick();
    this.bindLook();
    this.pauseButton.addEventListener('pointerdown', e => { e.preventDefault(); this.press(KEY.START, true); });
    this.pauseButton.addEventListener('pointerup', e => { e.preventDefault(); this.press(KEY.START, false); });
    window.addEventListener('blur', () => this.releaseAll());
  }

  attachNativePadSink({ setValue, clearValue, clearAll }) {
    this.releaseAll();
    this.nativePadSink = { setValue, clearValue, clearAll };
    this.nativePadSink.clearAll?.();
  }

  setMode(mode) {
    if (!CONTROL_PROFILES[mode]) throw new Error(`Unknown control mode: ${mode}`);
    this.releaseAll();
    this.mode = mode;
    this.renderButtons();
  }

  renderButtons() {
    this.buttons.replaceChildren();
    CONTROL_PROFILES[this.mode].forEach(([label, code], slot) => {
      const button = document.createElement('button');
      button.className = 'touchButton';
      button.dataset.slot = String(slot);
      button.textContent = label;
      const down = e => { e.preventDefault(); button.setPointerCapture?.(e.pointerId); button.classList.add('pressed'); this.press(code, true); };
      const up = e => { e.preventDefault(); button.classList.remove('pressed'); this.press(code, false); };
      button.addEventListener('pointerdown', down);
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', up);
      this.buttons.append(button);
    });
  }

  bindStick() {
    const nub = this.leftStick.querySelector('.nub');
    const radius = 62;
    const update = e => {
      const r = this.leftStick.getBoundingClientRect();
      const n = normalizeStick(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), radius);
      nub.style.transform = `translate(${n.x * radius}px, ${n.y * radius}px)`;
      this.onActivity({ type: 'touch' });
      if (this.nativePadSink) {
        this.emitAxis(PAD.ANALOG_LEFT_X, n.x);
        // Driving uses the left stick primarily for steering. Keep Y neutral so
        // a steering gesture cannot accidentally become throttle/brake input.
        this.emitAxis(PAD.ANALOG_LEFT_Y, this.mode === 'driving' ? 0 : n.y);
      } else {
        this.syncDirectional(vectorToDigitalKeys(n.x, n.y, { left: KEY.LEFT_LEFT, right: KEY.LEFT_RIGHT, up: KEY.LEFT_UP, down: KEY.LEFT_DOWN }));
      }
    };
    this.leftStick.addEventListener('pointerdown', e => { e.preventDefault(); this.leftPointer = e.pointerId; this.leftStick.setPointerCapture(e.pointerId); update(e); });
    this.leftStick.addEventListener('pointermove', e => { if (e.pointerId === this.leftPointer) update(e); });
    const end = e => {
      if (e.pointerId !== this.leftPointer) return;
      this.leftPointer = null;
      nub.style.transform = 'translate(0,0)';
      if (this.nativePadSink) { this.clearAxis(PAD.ANALOG_LEFT_X); this.clearAxis(PAD.ANALOG_LEFT_Y); }
      else this.syncDirectional(new Set());
    };
    this.leftStick.addEventListener('pointerup', end);
    this.leftStick.addEventListener('pointercancel', end);
  }

  bindLook() {
    const neutralLook = () => {
      if (this.nativePadSink) { this.emitAxis(PAD.ANALOG_RIGHT_X, 0); this.emitAxis(PAD.ANALOG_RIGHT_Y, 0); }
      else this.syncLook(new Set());
    };
    this.lookZone.addEventListener('pointerdown', e => {
      e.preventDefault(); this.lookPointer = e.pointerId; this.lookLast = { x: e.clientX, y: e.clientY }; this.lookZone.setPointerCapture(e.pointerId);
    });
    this.lookZone.addEventListener('pointermove', e => {
      if (e.pointerId !== this.lookPointer || !this.lookLast) return;
      const dx = e.clientX - this.lookLast.x; const dy = e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
      this.onActivity({ type: 'touch' });
      if (this.nativePadSink) {
        if (this.mode === 'driving') {
          // Black Monday's driving look controls are L2/R2, not the right stick.
          // A horizontal drag therefore becomes a short directional look hold.
          const next = new Set();
          if (dx < -2) next.add(KEY.L2);
          if (dx > 2) next.add(KEY.R2);
          this.syncGroup(next, [KEY.L2, KEY.R2]);
          clearTimeout(this.lookNeutralTimer);
          this.lookNeutralTimer = setTimeout(() => this.syncGroup(new Set(), [KEY.L2, KEY.R2]), 90);
        } else {
          this.emitAxis(PAD.ANALOG_RIGHT_X, clamp(dx / 18, -1, 1));
          this.emitAxis(PAD.ANALOG_RIGHT_Y, clamp(dy / 18, -1, 1));
          clearTimeout(this.lookNeutralTimer);
          this.lookNeutralTimer = setTimeout(neutralLook, 55);
        }
      } else {
        this.syncLook(vectorToDigitalKeys(dx / 18, dy / 18, { left: KEY.RIGHT_LEFT, right: KEY.RIGHT_RIGHT, up: KEY.RIGHT_UP, down: KEY.RIGHT_DOWN }, 0.15));
      }
    });
    const end = e => {
      if (e.pointerId !== this.lookPointer) return;
      this.lookPointer = null; this.lookLast = null; clearTimeout(this.lookNeutralTimer);
      if (this.nativePadSink) {
        if (this.mode === 'driving') this.syncGroup(new Set(), [KEY.L2, KEY.R2]);
        else { this.clearAxis(PAD.ANALOG_RIGHT_X); this.clearAxis(PAD.ANALOG_RIGHT_Y); }
      } else neutralLook();
    };
    this.lookZone.addEventListener('pointerup', end);
    this.lookZone.addEventListener('pointercancel', end);
  }

  emitAxis(button, normalizedValue) {
    if (this.nativePadSink) this.nativePadSink.setValue(button, axisToPs2Byte(normalizedValue));
  }

  clearAxis(button) { this.nativePadSink?.clearValue?.(button); }

  syncDirectional(next) { this.syncGroup(next, [KEY.LEFT_LEFT, KEY.LEFT_RIGHT, KEY.LEFT_UP, KEY.LEFT_DOWN]); }
  syncLook(next) { this.syncGroup(next, [KEY.RIGHT_LEFT, KEY.RIGHT_RIGHT, KEY.RIGHT_UP, KEY.RIGHT_DOWN]); }
  syncGroup(next, group) { for (const code of group) this.press(code, next.has(code)); }

  press(code, down) {
    if (down) this.onActivity({ type: 'touch' });
    const already = this.held.has(code);
    if (down === already) return;
    if (down) this.held.add(code); else this.held.delete(code);
    const padButton = KEY_TO_PAD[code];
    if (this.nativePadSink && padButton !== undefined) {
      if (down) this.nativePadSink.setValue(padButton, 1);
      else this.nativePadSink.clearValue(padButton);
    } else this.emitKey(code, down);
  }

  dispatchKey(code, down) {
    const event = new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true, cancelable: true });
    this.canvas.dispatchEvent(event);
  }

  releaseAll() {
    for (const code of [...this.held]) this.press(code, false);
    this.nativePadSink?.clearAll?.();
  }
}


// ---- runtime/DiscImageDevice.js ----
class DiscImageDevice {
  constructor(module) { this.module = module; this.doneFlag = false; this.file = null; this.lastError = null; }
  read(dstPtr, offset, size) {
    if (!this.file) throw new Error('No disc image selected.');
    this.doneFlag = false; this.lastError = null;
    this.file.slice(offset, offset + size).arrayBuffer()
      .then(buffer => { this.module.HEAPU8.set(new Uint8Array(buffer), dstPtr); this.doneFlag = true; })
      .catch(error => { this.lastError = error; this.doneFlag = true; });
  }
  getFileSize() { if (!this.file) throw new Error('No disc image selected.'); return this.file.size; }
  isDone() { return this.doneFlag; }
  setFile(file) { this.file = file; }
}


// ---- runtime/PersistentFs.js ----
const PLAY_DATA_PATH = '/home/web_user/.local/share/Play Data Files';

function mkdirTree(FS, path) {
  if (typeof FS.mkdirTree === 'function') {
    FS.mkdirTree(path);
    return;
  }
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try { FS.mkdir(current); }
    catch (error) {
      const message = String(error?.message ?? error);
      if (!message.includes('File exists') && error?.errno !== 20) throw error;
    }
  }
}

function syncFs(FS, populate) {
  return new Promise((resolve, reject) => {
    FS.syncfs(populate, error => error ? reject(error) : resolve());
  });
}

async function mountPersistentVfs(module, { mountPoint = PLAY_DATA_PATH, autoPersist = true } = {}) {
  const FS = module?.FS;
  if (!FS) throw new Error('Emscripten FS is unavailable.');
  const IDBFS = FS.filesystems?.IDBFS;
  if (!IDBFS) throw new Error('Play! was built without IDBFS. Rebuild with -lidbfs.js.');

  // Play!'s DefaultAppConfig resolves its browser data root to:
  // $HOME/.local/share/Play Data Files. Mount IDBFS there BEFORE initVm(),
  // so config.xml, vfs/mc0, vfs/mc1 and state data are persistent.
  const parent = mountPoint.slice(0, mountPoint.lastIndexOf('/')) || '/';
  mkdirTree(FS, parent);
  try { FS.mkdir(mountPoint); }
  catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes('File exists') && error?.errno !== 20) throw error;
  }
  FS.mount(IDBFS, { autoPersist }, mountPoint);
  await syncFs(FS, true);
  return { mountPoint, autoPersist };
}

async function flushPersistentVfs(module) {
  if (!module?.FS?.syncfs) return;
  await syncFs(module.FS, false);
}


// ---- runtime/performanceProfiles.js ----
const PERFORMANCE_PROFILES = Object.freeze({
  compatibility: Object.freeze({
    label: 'Compatibility', eeNumerator: 1, eeDenominator: 1,
    experimental: false,
    note: 'Default PS2 timing. Required baseline for correctness testing.',
  }),
  balanced: Object.freeze({
    label: 'Balanced (experimental)', eeNumerator: 3, eeDenominator: 4,
    experimental: true,
    note: 'Reduces emulated EE work. Must be regression-tested for timing/audio/mission side effects.',
  }),
  lowPower: Object.freeze({
    label: 'Low power (experimental)', eeNumerator: 1, eeDenominator: 2,
    experimental: true,
    note: 'Aggressive CPU reduction for thermal testing only; never the default.',
  }),
});

function getPerformanceProfile(id = 'compatibility') {
  const profile = PERFORMANCE_PROFILES[id];
  if (!profile) throw new Error(`Unknown performance profile: ${id}`);
  return profile;
}


// ---- runtime/SaveBackup.js ----

const FORMAT = 'black-monday-web-vfs';
const VERSION = 1;

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeRelativePath(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('..')) throw new Error(`Unsafe backup path: ${path}`);
  return path.split('/').filter(Boolean).join('/');
}

function walk(FS, root, rel, files) {
  const current = rel ? `${root}/${rel}` : root;
  for (const name of FS.readdir(current)) {
    if (name === '.' || name === '..') continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const full = `${root}/${childRel}`;
    const stat = FS.stat(full);
    if (FS.isDir(stat.mode)) walk(FS, root, childRel, files);
    else files.push({ path: childRel, data: toBase64(FS.readFile(full, { encoding: 'binary' })) });
  }
}

function exportVfsBackup(module, { root = `${PLAY_DATA_PATH}/vfs` } = {}) {
  if (!module?.FS) throw new Error('Emscripten FS is unavailable.');
  const files = [];
  walk(module.FS, root.replace(/\/$/, ''), '', files);
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    files,
  };
}

function importVfsBackup(module, backup, { root = `${PLAY_DATA_PATH}/vfs` } = {}) {
  if (!module?.FS) throw new Error('Emscripten FS is unavailable.');
  if (backup?.format !== FORMAT || backup?.version !== VERSION || !Array.isArray(backup.files)) throw new Error('Unsupported save backup format.');
  const base = root.replace(/\/$/, '');
  let bytesWritten = 0;
  for (const entry of backup.files) {
    const rel = safeRelativePath(entry.path);
    if (!rel) continue;
    const parts = rel.split('/');
    const name = parts.pop();
    let dir = base;
    for (const part of parts) {
      dir += `/${part}`;
      try { module.FS.mkdir(dir); } catch (error) { if (!String(error).includes('File exists')) { try { module.FS.stat(dir); } catch { throw error; } } }
    }
    const data = fromBase64(entry.data);
    module.FS.writeFile(`${dir}/${name}`, data);
    bytesWritten += data.length;
  }
  return { filesWritten: backup.files.length, bytesWritten };
}

const SAVE_BACKUP_FORMAT = Object.freeze({ format: FORMAT, version: VERSION });


// ---- runtime/PadInputRouter.js ----
// Arbitrates direct PS2 pad overrides between touch and browser Gamepad input.
// Keyboard remains handled by Play!'s upstream bindings; claiming keyboard clears
// every direct override so the upstream keyboard state becomes authoritative again.
class PadInputRouter {
  constructor({ setValue, clearValue, clearAll, initialSource = 'keyboard', onSourceChange = () => {} }) {
    this.setValue = setValue;
    this.clearValue = clearValue;
    this.clearAll = clearAll;
    this.activeSource = initialSource;
    this.onSourceChange = onSourceChange;
  }

  claim(source) {
    if (!source || source === this.activeSource) return;
    this.clearAll?.();
    this.activeSource = source;
    this.onSourceChange(source);
  }

  sinkFor(source) {
    return {
      setValue: (button, value) => {
        if (this.activeSource === source) this.setValue?.(button, value);
      },
      clearValue: button => {
        if (this.activeSource === source) this.clearValue?.(button);
      },
      clearAll: () => {
        if (this.activeSource === source) this.clearAll?.();
      },
    };
  }
}


// ---- runtime/BlackMondayDisc.js ----
const SECTOR = 2048;
const PVD_SECTOR = 16;
const EXPECTED_VOLUME_ID = 'TGBM';
const EXPECTED_EXECUTABLE = 'SCES_527.58';
const EXPECTED_ISO_SIZE = 4211343360;

function ascii(bytes, start, length) {
  return new TextDecoder('ascii').decode(bytes.subarray(start, start + length)).replace(/\0/g, '').trim();
}

function u32le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function readBlob(blob, offset, size) {
  const chunk = blob.slice(offset, offset + size);
  return new Uint8Array(await chunk.arrayBuffer());
}

function normalizeIsoName(name) {
  return name.replace(/;\d+$/, '').toUpperCase();
}

function parseDirectory(bytes) {
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset];
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR) * SECTOR;
      continue;
    }
    if (offset + length > bytes.length || length < 34) break;
    const extent = u32le(bytes, offset + 2);
    const size = u32le(bytes, offset + 10);
    const flags = bytes[offset + 25];
    const nameLength = bytes[offset + 32];
    const rawName = new TextDecoder('ascii').decode(bytes.subarray(offset + 33, offset + 33 + nameLength));
    if (rawName !== '\x00' && rawName !== '\x01') {
      entries.push({ name: normalizeIsoName(rawName), rawName, extent, size, directory: Boolean(flags & 0x02) });
    }
    offset += length;
  }
  return entries;
}

async function inspectBlackMondayDisc(file) {
  if (!file?.slice || !Number.isFinite(file.size)) throw new Error('A File/Blob-compatible disc image is required.');
  if (file.size < (PVD_SECTOR + 1) * SECTOR) throw new Error('Disc image is too small to contain an ISO9660 volume descriptor.');

  const pvd = await readBlob(file, PVD_SECTOR * SECTOR, SECTOR);
  const descriptorType = pvd[0];
  const standardId = ascii(pvd, 1, 5);
  if (descriptorType !== 1 || standardId !== 'CD001') throw new Error('Selected image is not a supported ISO9660 PS2 disc image.');

  const volumeId = ascii(pvd, 40, 32);
  const rootRecordLength = pvd[156];
  if (rootRecordLength < 34) throw new Error('ISO9660 root directory record is invalid.');
  const rootExtent = u32le(pvd, 158);
  const rootSize = u32le(pvd, 166);
  if (!rootExtent || !rootSize || rootSize > 16 * 1024 * 1024) throw new Error('ISO9660 root directory bounds are invalid.');

  const root = await readBlob(file, rootExtent * SECTOR, rootSize);
  const entries = parseDirectory(root);
  const system = entries.find(entry => entry.name === 'SYSTEM.CNF');
  const executable = entries.find(entry => entry.name === EXPECTED_EXECUTABLE);

  let systemCnf = '';
  if (system && !system.directory) {
    const bytes = await readBlob(file, system.extent * SECTOR, Math.min(system.size, 4096));
    systemCnf = new TextDecoder('ascii').decode(bytes).replace(/\0+$/g, '').trim();
  }
  const bootMatches = /BOOT2\s*=\s*cdrom0:\\SCES_527\.58;1/i.test(systemCnf);
  const exactSize = file.size === EXPECTED_ISO_SIZE;
  const releaseMatches = volumeId === EXPECTED_VOLUME_ID && Boolean(system) && Boolean(executable) && bootMatches;

  return {
    releaseMatches,
    exactSize,
    fileSize: file.size,
    expectedSize: EXPECTED_ISO_SIZE,
    volumeId,
    hasSystemCnf: Boolean(system),
    hasExecutable: Boolean(executable),
    executable: EXPECTED_EXECUTABLE,
    systemCnf,
    rootEntryCount: entries.length,
  };
}

async function assertBlackMondayDisc(file, { requireExactSize = true } = {}) {
  const report = await inspectBlackMondayDisc(file);
  if (!report.releaseMatches) {
    throw new Error(`This does not match the PAL Black Monday disc layout (volume=${report.volumeId || 'unknown'}, executable=${report.hasExecutable ? 'present' : 'missing'}).`);
  }
  if (requireExactSize && !report.exactSize) {
    throw new Error(`Black Monday disc layout matched, but image size is ${report.fileSize} bytes; expected ${report.expectedSize}.`);
  }
  return report;
}

const BLACK_MONDAY_DISC = Object.freeze({
  volumeId: EXPECTED_VOLUME_ID,
  executable: EXPECTED_EXECUTABLE,
  isoSize: EXPECTED_ISO_SIZE,
});


// ---- runtime/DiscStore.js ----
const DEFAULT_DIR = 'black-monday-discs';
const IMPORT_CHUNK_BYTES = 64 * 1024 * 1024;

function storageManager() {
  return globalThis.navigator?.storage ?? null;
}

function opfsAvailable() {
  return typeof storageManager()?.getDirectory === 'function';
}

async function discDirectory(name = DEFAULT_DIR) {
  const storage = storageManager();
  if (!storage?.getDirectory) throw new Error('Origin Private File System is unavailable in this browser.');
  const root = await storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

async function getStorageStatus() {
  const storage = storageManager();
  if (!storage) return { opfs: false, persisted: false, usage: 0, quota: 0 };
  const estimate = typeof storage.estimate === 'function' ? await storage.estimate() : {};
  const persisted = typeof storage.persisted === 'function' ? await storage.persisted() : false;
  return {
    opfs: opfsAvailable(),
    persisted: Boolean(persisted),
    usage: Number(estimate.usage ?? 0),
    quota: Number(estimate.quota ?? 0),
  };
}

async function requestPersistentStorage() {
  const storage = storageManager();
  if (!storage?.persist) return false;
  return Boolean(await storage.persist());
}

async function ensureSpace(requiredBytes, reserveBytes = 256 * 1024 * 1024) {
  const status = await getStorageStatus();
  if (!status.opfs) throw new Error('Origin Private File System is unavailable.');
  if (status.quota > 0) {
    const available = Math.max(0, status.quota - status.usage);
    if (available < requiredBytes + reserveBytes) {
      throw new Error(`Not enough browser storage: ${(available / 1073741824).toFixed(2)} GiB available; ${(requiredBytes / 1073741824).toFixed(2)} GiB game image plus reserve required.`);
    }
  }
  return status;
}

async function importDiscFile(file, { onProgress = () => {}, directory = DEFAULT_DIR } = {}) {
  if (!file?.slice || !Number.isFinite(file.size)) throw new Error('A File/Blob-compatible disc image is required.');
  await ensureSpace(file.size);
  await requestPersistentStorage().catch(() => false);
  const dir = await discDirectory(directory);
  const target = await dir.getFileHandle(file.name, { create: true });
  const writer = await target.createWritable();
  let written = 0;
  try {
    while (written < file.size) {
      const end = Math.min(written + IMPORT_CHUNK_BYTES, file.size);
      await writer.write(file.slice(written, end));
      written = end;
      onProgress(written, file.size);
    }
    await writer.close();
  } catch (error) {
    try { await writer.abort?.(); } catch { /* ignore abort cleanup */ }
    throw error;
  }
  return { name: file.name, size: file.size };
}

async function listInstalledDiscs({ directory = DEFAULT_DIR } = {}) {
  if (!opfsAvailable()) return [];
  const dir = await discDirectory(directory);
  const result = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    try {
      const file = await handle.getFile();
      result.push({ name, size: file.size, lastModified: file.lastModified ?? 0 });
    } catch {
      result.push({ name, size: 0, lastModified: 0 });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadInstalledDisc(name, { directory = DEFAULT_DIR } = {}) {
  const dir = await discDirectory(directory);
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

async function removeInstalledDisc(name, { directory = DEFAULT_DIR } = {}) {
  const dir = await discDirectory(directory);
  await dir.removeEntry(name);
}


// ---- runtime/AudioUnlock.js ----
let context = null;
let unlocked = false;

function audioContextCtor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function audioUnlockSupported() {
  return Boolean(audioContextCtor());
}

function isAudioUnlocked() {
  return unlocked;
}

async function unlockAudio() {
  const Ctor = audioContextCtor();
  if (!Ctor) return { supported: false, unlocked: false, state: 'unsupported' };
  if (!context) context = new Ctor();
  try {
    if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
    // Safari can leave a context suspended unless audio is actually touched from a gesture.
    if (typeof context.createBuffer === 'function' && typeof context.createBufferSource === 'function') {
      const buffer = context.createBuffer(1, 1, Math.max(8000, context.sampleRate || 44100));
      const source = context.createBufferSource();
      source.buffer = buffer;
      if (context.destination && typeof source.connect === 'function') source.connect(context.destination);
      if (typeof source.start === 'function') source.start(0);
    }
    unlocked = context.state !== 'suspended';
    return { supported: true, unlocked, state: context.state };
  } catch (error) {
    return { supported: true, unlocked: false, state: context?.state ?? 'error', error };
  }
}

function installFirstGestureAudioUnlock(target = document) {
  const handler = () => { unlockAudio().catch(() => {}); };
  target.addEventListener('pointerdown', handler, { once: true, capture: true, passive: true });
  target.addEventListener('touchstart', handler, { once: true, capture: true, passive: true });
  target.addEventListener('keydown', handler, { once: true, capture: true });
  return handler;
}


// ---- runtime/RuntimeDiagnostics.js ----
class RuntimeDiagnostics {
  constructor({ limit = 1000 } = {}) {
    this.limit = limit;
    this.events = [];
    this.startedAt = new Date().toISOString();
    this.bound = false;
  }
  record(type, detail = {}) {
    const event = { t: Math.round(performance.now()), type, detail };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    return event;
  }
  bindWindow(target = window) {
    if (this.bound) return;
    this.bound = true;
    target.addEventListener('error', event => this.record('window.error', { message: event.message, filename: event.filename, line: event.lineno, column: event.colno }));
    target.addEventListener('unhandledrejection', event => this.record('window.unhandledrejection', { reason: String(event.reason?.stack || event.reason) }));
  }
  sampleRuntime(runtime) {
    const frames = runtime?.getFrames?.() ?? 0;
    const heap = performance?.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null;
    return this.record('runtime.sample', { frames, heap });
  }
  snapshot(extra = {}) {
    return { schema: 1, startedAt: this.startedAt, capturedAt: new Date().toISOString(), userAgent: globalThis.navigator?.userAgent ?? null, ...extra, events: [...this.events] };
  }
  persist({ storage = globalThis.localStorage, key = 'black-monday-web:last-diagnostics', extra = {} } = {}) {
    if (!storage?.setItem) return false;
    try { storage.setItem(key, JSON.stringify(this.snapshot(extra))); return true; }
    catch { return false; }
  }
  static loadPersisted({ storage = globalThis.localStorage, key = 'black-monday-web:last-diagnostics' } = {}) {
    if (!storage?.getItem) return null;
    try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
}


// ---- runtime/PerformanceMonitor.js ----
class PerformanceMonitor {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.reset(0);
  }
  reset(frames = 0) {
    this.lastFrames = frames;
    this.lastTime = this.now();
  }
  sample(frames) {
    const t = this.now();
    const deltaMs = Math.max(0.001, t - this.lastTime);
    const deltaFrames = Math.max(0, frames - this.lastFrames);
    const fps = deltaFrames * 1000 / deltaMs;
    const frameTimeMs = deltaFrames > 0 ? deltaMs / deltaFrames : null;
    this.lastFrames = frames;
    this.lastTime = t;
    const memory = performance?.memory ? {
      usedJSHeapMiB: performance.memory.usedJSHeapSize / 1048576,
      totalJSHeapMiB: performance.memory.totalJSHeapSize / 1048576,
      heapLimitMiB: performance.memory.jsHeapSizeLimit / 1048576,
    } : null;
    return { t, frames, deltaFrames, deltaMs, fps, frameTimeMs, memory };
  }
}


// ---- runtime/PlayRuntimeAdapter.js ----




class PlayRuntimeAdapter {
  constructor({ runtimeUrl = './runtime/Play.js', canvasId = 'outputCanvas' } = {}) {
    this.runtimeUrl = runtimeUrl;
    this.canvasId = canvasId;
    this.module = null;
    this.booted = false;
  }

  async init() {
    const runtimeHref = new URL(this.runtimeUrl, import.meta.url).href;
    const imported = await import(runtimeHref);
    const Play = imported.default;
    if (typeof Play !== 'function') throw new Error('Play.js did not export the expected Emscripten module factory.');
    const base = new URL('.', runtimeHref).href;
    this.module = await Play({
      locateFile: path => new URL(path, base).href,
      mainScriptUrlOrBlob: runtimeHref,
      print: text => console.log(`[Play] ${text}`),
      printErr: text => console.error(`[Play] ${text}`),
    });
    try { this.module.FS.mkdir('/work'); } catch (e) { if (!String(e).includes('File exists')) throw e; }
    await mountPersistentVfs(this.module);
    this.module.discImageDevice = new DiscImageDevice(this.module);
    this.module.ccall('initVm', '', [], []);
    return this;
  }

  bootDisc(file) {
    if (!this.module) throw new Error('Runtime not initialised.');
    this.module.discImageDevice.setFile(file);
    this.module.bootDiscImage(file.name);
    this.booted = true;
  }

  bootElf(file) { throw new Error('ELF import is not wired in this first shell yet.'); }
  getFrames() { return this.module?.getFrames?.() ?? 0; }
  setPadValue(button, value, pad = 0) {
    if (!this.module?.setPadValue) throw new Error('Play! core does not expose setPadValue; apply patch 0001 and rebuild.');
    this.module.setPadValue(pad, button, value);
  }
  clearPadValue(button, pad = 0) { this.module?.clearPadValue?.(pad, button); }
  clearPadValues() { this.module?.clearPadValues?.(); }
  hasNativePadInjection() { return typeof this.module?.setPadValue === 'function' && typeof this.module?.clearPadValue === 'function'; }
  clearStats() { this.module?.clearStats?.(); }
  hasEeFrequencyScale() { return typeof this.module?.setEeFrequencyScale === 'function'; }
  hasGsResolutionFactor() { return typeof this.module?.setGsResolutionFactor === 'function'; }
  setGsResolutionFactor(factor = 1) {
    if (!this.hasGsResolutionFactor()) throw new Error('Play! core does not expose setGsResolutionFactor; apply patch 0005 and rebuild.');
    if (![1, 2, 4, 8].includes(factor)) throw new Error(`Unsupported GS resolution factor: ${factor}`);
    this.module.setGsResolutionFactor(factor);
    return factor;
  }
  setPerformanceProfile(id = 'compatibility') {
    const profile = getPerformanceProfile(id);
    if (!this.hasEeFrequencyScale()) {
      if (id !== 'compatibility') throw new Error('Play! core does not expose setEeFrequencyScale; apply patch 0003 and rebuild.');
      return profile;
    }
    this.module.setEeFrequencyScale(profile.eeNumerator, profile.eeDenominator);
    return profile;
  }
  pause() {
    if (!this.booted) return false;
    if (typeof this.module?.pauseVm !== 'function') return false;
    this.module.pauseVm();
    return true;
  }

  resume() {
    if (!this.booted) return false;
    if (typeof this.module?.resumeVm !== 'function') return false;
    this.module.resumeVm();
    return true;
  }

  hasLifecycleControl() {
    return typeof this.module?.pauseVm === 'function' && typeof this.module?.resumeVm === 'function';
  }

  hasSaveStates() {
    return typeof this.module?.saveState === 'function'
      && typeof this.module?.beginLoadState === 'function'
      && typeof this.module?.pollLoadState === 'function';
  }

  async saveState(slot = 0) {
    if (!this.module) throw new Error('Runtime not initialised.');
    if (!this.hasSaveStates()) throw new Error('Play! core does not expose browser savestates; apply patch 0006 and rebuild.');
    const safeSlot = Number(slot);
    if (!Number.isInteger(safeSlot) || safeSlot < 0 || safeSlot > 99) throw new Error(`Invalid savestate slot: ${slot}`);
    const saved = Boolean(this.module.saveState(safeSlot));
    if (saved) await flushPersistentVfs(this.module);
    return saved;
  }

  async loadState(slot = 0, { timeoutMs = 30000, pollMs = 25 } = {}) {
    if (!this.module) throw new Error('Runtime not initialised.');
    if (!this.hasSaveStates()) throw new Error('Play! core does not expose browser savestates; apply patch 0006 and rebuild.');
    const safeSlot = Number(slot);
    if (!Number.isInteger(safeSlot) || safeSlot < 0 || safeSlot > 99) throw new Error(`Invalid savestate slot: ${slot}`);
    this.clearPadValues();
    if (!this.module.beginLoadState(safeSlot)) throw new Error('Play! rejected savestate load request (another load may already be pending).');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const status = Number(this.module.pollLoadState());
      if (status === 2) {
        this.module.resumeVm?.();
        return true;
      }
      if (status === -1) return false;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error(`Savestate load timed out after ${timeoutMs} ms.`);
  }

  exportSaveBackup() {
    if (!this.module) throw new Error('Runtime not initialised.');
    return exportVfsBackup(this.module);
  }

  async importSaveBackup(backup) {
    if (!this.module) throw new Error('Runtime not initialised.');
    const result = importVfsBackup(this.module, backup);
    await flushPersistentVfs(this.module);
    return result;
  }

  async flushSaves() { await flushPersistentVfs(this.module); }
}


// ---- systemProbe.js ----
const MIB = 1024 * 1024;
const BLACK_MONDAY_ISO_BYTES = 4211343360;
const DISC_INSTALL_HEADROOM_BYTES = 512 * MIB;

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function probeSharedWasmMemory() {
  try {
    if (typeof WebAssembly !== 'object' || typeof SharedArrayBuffer === 'undefined') return false;
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBuffer;
  } catch {
    return false;
  }
}

async function probeSystem() {
  const nav = globalThis.navigator ?? {};
  const doc = globalThis.document;
  const canvas = doc?.createElement?.('canvas');
  const gl2 = Boolean(canvas?.getContext?.('webgl2'));

  let opfs = false;
  try { opfs = Boolean(nav.storage?.getDirectory && await nav.storage.getDirectory()); } catch { opfs = false; }

  let storage = null;
  try { storage = await nav.storage?.estimate?.(); } catch { storage = null; }

  let storagePersisted = null;
  try {
    if (typeof nav.storage?.persisted === 'function') storagePersisted = Boolean(await nav.storage.persisted());
  } catch { storagePersisted = null; }

  const quota = finiteNumber(storage?.quota);
  const usage = finiteNumber(storage?.usage);
  const available = quota == null ? null : Math.max(0, quota - (usage ?? 0));
  const installBytesRequired = BLACK_MONDAY_ISO_BYTES + DISC_INSTALL_HEADROOM_BYTES;

  const report = {
    userAgent: nav.userAgent ?? null,
    platform: nav.platform ?? null,
    wasm: typeof WebAssembly === 'object',
    webgl2: gl2,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    wasmSharedMemory: probeSharedWasmMemory(),
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    secureContext: globalThis.isSecureContext === true,
    worker: typeof Worker !== 'undefined',
    webAudio: typeof globalThis.AudioContext === 'function' || typeof globalThis.webkitAudioContext === 'function',
    serviceWorker: Boolean(nav.serviceWorker),
    indexedDb: typeof globalThis.indexedDB !== 'undefined',
    opfs,
    storagePersisted,
    storageQuotaMiB: quota == null ? null : Math.round(quota / MIB),
    storageUsageMiB: usage == null ? null : Math.round(usage / MIB),
    storageAvailableMiB: available == null ? null : Math.round(available / MIB),
    discInstallBytesRequired: installBytesRequired,
    discInstallSpaceReady: available == null ? null : available >= installBytesRequired,
    hardwareConcurrency: finiteNumber(nav.hardwareConcurrency),
    deviceMemoryGiB: finiteNumber(nav.deviceMemory),
    maxTouchPoints: finiteNumber(nav.maxTouchPoints) ?? 0,
    visibilityApi: typeof doc?.visibilityState === 'string',
    standalone: Boolean(globalThis.matchMedia?.('(display-mode: standalone)')?.matches || nav.standalone === true),
  };

  // The pinned Play! browser core is an Emscripten pthread/WebGL2 build. These are hard launch requirements.
  report.playThreadedRuntimeReady = report.wasm
    && report.webgl2
    && report.sharedArrayBuffer
    && report.wasmSharedMemory
    && report.crossOriginIsolated
    && report.worker;

  report.missingRuntimeFeatures = [
    !report.wasm && 'WebAssembly',
    !report.webgl2 && 'WebGL2',
    !report.sharedArrayBuffer && 'SharedArrayBuffer',
    !report.wasmSharedMemory && 'WebAssembly shared memory',
    !report.crossOriginIsolated && 'cross-origin isolation',
    !report.worker && 'Web Workers',
  ].filter(Boolean);

  report.runtimeWarnings = [
    !report.secureContext && 'not a secure context',
    !report.webAudio && 'WebAudio unavailable',
    !report.serviceWorker && 'service workers unavailable',
    !report.indexedDb && 'IndexedDB unavailable',
    report.hardwareConcurrency != null && report.hardwareConcurrency < 4 && `only ${report.hardwareConcurrency} logical CPU threads reported`,
    report.discInstallSpaceReady === false && 'not enough browser storage to install a local ISO copy',
    report.storagePersisted === false && 'browser storage is not marked persistent',
  ].filter(Boolean);

  return report;
}


// ---- app.js ----









const $ = id => document.getElementById(id);
const status = $('status');
const probeEl = $('probe');
const discInput = $('discInput');
const bootPanel = $('bootPanel');
const gameShell = $('gameShell');
const hudStatus = $('hudStatus');
const inputStatus = $('inputStatus');
const canvas = $('outputCanvas');
const installOption = $('installOption');
const installDisc = $('installDisc');
const installedBoot = $('installedBoot');
const installStatus = $('installStatus');
const saveExport = $('saveExport');
const saveImport = $('saveImport');
const diagExport = $('diagExport');
const runtime = new PlayRuntimeAdapter();
const diagnostics = new RuntimeDiagnostics();
diagnostics.bindWindow(window);
window.__blackMondayDiagnostics = diagnostics;
const performanceMonitor = new PerformanceMonitor();
installFirstGestureAudioUnlock(document);
let runtimeReady = false;
let statsTimer = 0;
let inputRouter = null;
let installedDiscName = null;
let orientationAttempted = false;
let activePerformanceProfile = 'compatibility';
let activeGsScale = 1;

const probe = await probeSystem();
diagnostics.record('system.probe', probe);
diagnostics.persist({ extra: { phase: 'shell' } });
probeEl.textContent = Object.entries(probe).map(([k,v]) => `${k}: ${v}`).join('\n');
if (!probe.playThreadedRuntimeReady) {
  status.textContent = `Play! WebAssembly runtime prerequisites missing: ${probe.missingRuntimeFeatures.join(', ')}.`;
  discInput.disabled = true;
} else {
  status.textContent = 'Browser runtime ready. Select your original Black Monday ISO from Files.';
}

const touch = new TouchController({
  canvas,
  leftStick: $('leftStick'),
  lookZone: $('lookZone'),
  buttons: $('buttons'),
  pauseButton: $('pauseButton'),
  onActivity: () => {
    inputRouter?.claim('touch');
    inputStatus.textContent = 'TOUCH';
  },
});
touch.mount();

const gamepad = new GamepadController({
  canvas,
  onActivity: info => {
    inputRouter?.claim('gamepad');
    inputStatus.textContent = `GAMEPAD ${info.index + 1}`;
  },
});
gamepad.start();

function attachNativeInputIfAvailable() {
  if (!runtime.hasNativePadInjection()) return false;
  inputRouter = new PadInputRouter({
    setValue: (button, value) => runtime.setPadValue(button, value),
    clearValue: button => runtime.clearPadValue(button),
    clearAll: () => runtime.clearPadValues(),
    initialSource: 'keyboard',
  });
  touch.attachNativePadSink(inputRouter.sinkFor('touch'));
  gamepad.attachNativePadSink(inputRouter.sinkFor('gamepad'));
  inputStatus.textContent = 'TOUCH + GAMEPAD + KEYBOARD / NATIVE PAD';
  return true;
}

async function ensureRuntime() {
  if (runtimeReady) return;
  status.textContent = 'Initialising Play! WebAssembly runtime…';
  const started = performance.now();
  await requestPersistentStorage().catch(() => false);
  await runtime.init();

  // First physical-iPhone run showed ~3fps even on the intro. Force the
  // timing-neutral native GS scale and reduce EE work for the mobile test.
  // Full 1:1 timing remains available with ?perf=compatibility.
  const params = new URLSearchParams(location.search);
  const isIphone = /iPhone|iPod/i.test(navigator.userAgent || '');
  activePerformanceProfile = params.get('perf') || (isIphone ? 'lowPower' : 'compatibility');
  try {
    runtime.setPerformanceProfile(activePerformanceProfile);
  } catch (error) {
    console.warn('Performance profile unavailable, using compatibility timing.', error);
    activePerformanceProfile = 'compatibility';
    runtime.setPerformanceProfile('compatibility');
  }
  try {
    if (runtime.hasGsResolutionFactor()) {
      activeGsScale = 1;
      runtime.setGsResolutionFactor(activeGsScale);
    }
  } catch (error) {
    console.warn('Unable to force native GS scale.', error);
  }

  runtimeReady = true;
  diagnostics.record('runtime.initialized', {
    elapsedMs: performance.now() - started,
    nativePad: runtime.hasNativePadInjection(),
    lifecycle: runtime.hasLifecycleControl(),
    performanceProfile: activePerformanceProfile,
    gsScale: activeGsScale,
  });
  diagnostics.persist({ extra: { phase: 'runtime-ready', performanceProfile: activePerformanceProfile, gsScale: activeGsScale } });
  const nativeInput = attachNativeInputIfAvailable();
  status.textContent = nativeInput
    ? `Runtime ready with native analogue injection. Performance=${activePerformanceProfile}, GS=${activeGsScale}x.`
    : `Runtime ready in compatibility-input mode. Performance=${activePerformanceProfile}, GS=${activeGsScale}x.`;
}

function beginStats() {
  clearInterval(statsTimer);
  runtime.clearStats();
  performanceMonitor.reset(runtime.getFrames());
  let diagnosticSampleCounter = 0;
  statsTimer = window.setInterval(() => {
    const sample = performanceMonitor.sample(runtime.getFrames());
    const frameTime = sample.frameTimeMs == null ? '--' : sample.frameTimeMs.toFixed(1);
    const memory = sample.memory ? ` heap=${sample.memory.usedJSHeapMiB.toFixed(0)}MiB` : '';
    hudStatus.textContent = `frames=${sample.frames} ${sample.fps.toFixed(1)}fps ${frameTime}ms perf=${activePerformanceProfile} gs=${activeGsScale}x${memory}`;
    if ((++diagnosticSampleCounter % 5) === 0) diagnostics.record('performance.sample', sample);
    if ((diagnosticSampleCounter % 30) === 0) diagnostics.persist({ extra: { phase: 'running', fps: sample.fps, frameTimeMs: sample.frameTimeMs, performanceProfile: activePerformanceProfile, gsScale: activeGsScale } });
  }, 1000);
}

async function bootBlackMondayFile(file, { install = false } = {}) {
  // Keep these before any long async work: iOS Safari requires media/orientation requests
  // to originate from a user gesture. PWA manifest orientation remains the fallback.
  const audioReport = { supported: audioUnlockSupported(), unlocked: isAudioUnlocked(), state: isAudioUnlocked() ? 'running' : 'deferred' };
  // Do not block Black Monday boot on iOS media activation. Safari can keep
  // AudioContext.resume() pending indefinitely once the original user gesture
  // has expired (for example after a multi-minute archive extraction). The
  // document-level first-gesture handler will unlock audio on the next touch.
  unlockAudio().then(report => {
    if (report.supported && !report.unlocked) console.warn('Audio context is not yet unlocked', report.state);
  }).catch(error => console.warn('Deferred audio unlock failed', error));
  if (!orientationAttempted) {
    orientationAttempted = true;
    try {
      const orientationLock = globalThis.screen?.orientation?.lock?.('landscape');
      Promise.resolve(orientationLock).catch(() => {});
    } catch { /* iOS Safari may reject; standalone manifest handles it */ }
  }
  status.textContent = 'Checking original Black Monday disc…';
  const discReport = await assertBlackMondayDisc(file);
  let bootFile = file;
  if (install && opfsAvailable()) {
    installStatus.textContent = 'Preparing local PWA copy…';
    const entry = await importDiscFile(file, {
      onProgress: (written, total) => {
        installStatus.textContent = `Installing ${((written / total) * 100).toFixed(1)}%`;
      },
    });
    installedDiscName = entry.name;
    bootFile = await loadInstalledDisc(entry.name);
    installStatus.textContent = 'Local game copy installed.';
  }
  await ensureRuntime();
  console.info('Black Monday disc verified', discReport);
  diagnostics.record('disc.verified', discReport);
  status.textContent = `Booting ${bootFile.name} (${(bootFile.size / 1073741824).toFixed(2)} GiB)…`;
  bootPanel.classList.add('hidden');
  gameShell.classList.remove('hidden');
  canvas.focus();
  runtime.bootDisc(bootFile);
  diagnostics.record('runtime.boot_requested', { name: bootFile.name, size: bootFile.size });
  diagnostics.persist({ extra: { phase: 'boot-requested' } });
  hudStatus.textContent = 'BOOT REQUESTED';
  beginStats();
}

discInput.addEventListener('change', async () => {
  const file = discInput.files?.[0];
  if (!file) return;
  try {
    await bootBlackMondayFile(file, { install: Boolean(installDisc.checked) });
  } catch (error) {
    console.error(error);
    gameShell.classList.add('hidden');
    bootPanel.classList.remove('hidden');
    status.textContent = `Runtime blocked: ${error.message}`;
  }
});

installedBoot.addEventListener('click', async () => {
  if (!installedDiscName) return;
  try {
    await bootBlackMondayFile(await loadInstalledDisc(installedDiscName));
  } catch (error) {
    console.error(error);
    status.textContent = `Installed copy blocked: ${error.message}`;
  }
});

async function discoverInstalledDisc() {
  if (!opfsAvailable()) return;
  // Installing a 4.21 GB ISO is optional. Do not offer it when the browser reports
  // insufficient quota; direct File/Blob playback remains the default iPhone path.
  if (probe.discInstallSpaceReady !== false) installOption.classList.remove('hidden');
  else installStatus.textContent = 'Local ISO install disabled: browser storage quota is too small. Playing directly from Files is supported.';
  try {
    const installed = (await listInstalledDiscs()).find(entry => entry.size === 4211343360);
    if (!installed) return;
    const file = await loadInstalledDisc(installed.name);
    const report = await assertBlackMondayDisc(file);
    if (!report.releaseMatches) return;
    installedDiscName = installed.name;
    installedBoot.classList.remove('hidden');
    installStatus.textContent = 'Verified local Black Monday copy found.';
  } catch (error) {
    console.warn('Installed disc discovery failed', error);
  }
}

discoverInstalledDisc();

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

saveExport.addEventListener('click', async () => {
  try {
    await ensureRuntime();
    await runtime.flushSaves();
    const backup = runtime.exportSaveBackup();
    downloadJson(`black-monday-saves-${new Date().toISOString().slice(0, 10)}.json`, backup);
    installStatus.textContent = `Save backup exported (${backup.files.length} files).`;
    diagnostics.record('saves.exported', { files: backup.files.length });
  } catch (error) {
    installStatus.textContent = `Save export failed: ${error.message}`;
    diagnostics.record('saves.export_failed', { message: error.message });
  }
});

saveImport.addEventListener('change', async () => {
  const file = saveImport.files?.[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    await ensureRuntime();
    const result = await runtime.importSaveBackup(backup);
    installStatus.textContent = `Save backup imported (${result.filesWritten} files).`;
    diagnostics.record('saves.imported', result);
  } catch (error) {
    installStatus.textContent = `Save import failed: ${error.message}`;
    diagnostics.record('saves.import_failed', { message: error.message });
  } finally {
    saveImport.value = '';
  }
});

diagExport.addEventListener('click', () => {
  diagnostics.persist({ extra: { phase: runtime.booted ? 'running' : 'shell' } });
  downloadJson(`black-monday-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, diagnostics.snapshot({ phase: runtime.booted ? 'running' : 'shell' }));
});

document.addEventListener('keydown', event => {
  if (!runtimeReady || !inputRouter || event.metaKey || event.ctrlKey || event.altKey) return;
  inputRouter.claim('keyboard');
  inputStatus.textContent = 'KEYBOARD';
});

document.addEventListener('visibilitychange', () => {
  if (!runtimeReady) return;
  if (document.visibilityState === 'hidden') {
    touch.releaseAll();
    runtime.pause();
    diagnostics.record('lifecycle.hidden');
    diagnostics.persist({ extra: { phase: 'hidden' } });
    runtime.flushSaves().catch(console.warn);
  } else if (document.visibilityState === 'visible') {
    runtime.resume();
    diagnostics.record('lifecycle.visible');
  }
});
window.addEventListener('pagehide', () => {
  gamepad.stop();
  touch.releaseAll();
  runtime.pause();
  if (runtimeReady) runtime.flushSaves().catch(console.warn);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);


// ---- iPhone one-time archive installer / automatic installed-game boot ----
const archiveInput = $('archiveInput');
const archiveProgress = $('archiveProgress');
const setupNote = $('setupNote');
const INSTALLER_ISO_SIZE = 4211343360;
const INSTALLER_RESERVE = 384 * 1024 * 1024;
let archiveInstallRunning = false;
let installedAutoBootStarted = false;

function installerId() {
  try { return crypto.randomUUID(); }
  catch { return `install-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function setArchiveProgress(processed = 0, total = INSTALLER_ISO_SIZE) {
  if (!archiveProgress) return;
  const value = total > 0 ? Math.max(0, Math.min(1, processed / total)) : 0;
  archiveProgress.value = value;
  archiveProgress.textContent = `${(value * 100).toFixed(1)}%`;
}

async function installBlackMondayArchive(files) {
  if (archiveInstallRunning) return;
  const selected = Array.from(files || []);
  if (!selected.length) return;
  if (!opfsAvailable()) throw new Error('This Safari version does not expose the private browser filesystem required for a one-time Black Monday install.');

  archiveInstallRunning = true;
  archiveInput.disabled = true;
  setArchiveProgress(0);
  archiveProgress?.classList.remove('hidden');
  installStatus.textContent = 'Checking iPhone storage…';
  status.textContent = 'Preparing one-time Black Monday installation…';

  try {
    await ensureSpace(INSTALLER_ISO_SIZE, INSTALLER_RESERVE);
    await requestPersistentStorage().catch(() => false);

    const id = installerId();
    const workerUrl = new URL('./extractor/worker.js', import.meta.url);
    const worker = new Worker(workerUrl, { type: 'module', name: 'black-monday-7z-installer' });

    const result = await new Promise((resolve, reject) => {
      const cleanup = () => worker.terminate();
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.id && message.id !== id) return;
        if (message.type === 'archive-verified') {
          installStatus.textContent = `Archive verified. Extracting ${message.isoPath} directly to private PWA storage…`;
          diagnostics.record('installer.archive_verified', {
            archiveName: message.archiveName,
            isoPath: message.isoPath,
            totalBytes: message.totalBytes,
          });
          return;
        }
        if (message.type === 'progress') {
          setArchiveProgress(message.processedBytes, message.totalBytes);
          const pct = message.totalBytes ? (message.processedBytes / message.totalBytes) * 100 : 0;
          installStatus.textContent = `Installing Black Monday… ${pct.toFixed(1)}%`;
          return;
        }
        if (message.type === 'done') {
          cleanup();
          resolve(message);
          return;
        }
        if (message.type === 'error') {
          cleanup();
          reject(new Error(message.message || 'Archive extraction failed.'));
        }
      };
      worker.onerror = event => {
        cleanup();
        reject(new Error(event.message || 'Black Monday installer worker crashed.'));
      };
      worker.postMessage({ type: 'install', id, files: selected });
    });

    installStatus.textContent = 'Extraction complete. Verifying installed Black Monday disc…';
    const installedFile = await loadInstalledDisc(result.targetName);
    const report = await assertBlackMondayDisc(installedFile);
    installedDiscName = result.targetName;
    setArchiveProgress(INSTALLER_ISO_SIZE);
    diagnostics.record('installer.completed', {
      targetName: result.targetName,
      size: result.size,
      archiveName: result.archiveName,
      isoPath: result.isoPath,
      disc: report,
    });
    diagnostics.persist({ extra: { phase: 'installed' } });
    installStatus.textContent = 'Black Monday installed and verified. Starting…';
    status.textContent = 'Installed Black Monday found. Starting automatically…';
    await bootBlackMondayFile(installedFile);
  } finally {
    archiveInstallRunning = false;
    archiveInput.disabled = false;
    archiveInput.value = '';
  }
}

archiveInput?.addEventListener('change', async () => {
  try {
    await installBlackMondayArchive(archiveInput.files);
  } catch (error) {
    console.error(error);
    diagnostics.record('installer.failed', { message: error.message, stack: error.stack || null });
    diagnostics.persist({ extra: { phase: 'installer-failed', error: error.message } });
    archiveProgress?.classList.add('hidden');
    gameShell.classList.add('hidden');
    bootPanel.classList.remove('hidden');
    status.textContent = `Installation blocked: ${error.message}`;
    installStatus.textContent = 'Nothing was installed. You can retry after correcting the issue.';
  }
});

async function findVerifiedInstalledBlackMonday() {
  if (!opfsAvailable()) return null;
  const candidates = await listInstalledDiscs();
  for (const entry of candidates.filter(item => item.size === INSTALLER_ISO_SIZE)) {
    try {
      const file = await loadInstalledDisc(entry.name);
      await assertBlackMondayDisc(file);
      return { entry, file };
    } catch (error) {
      console.warn('Ignoring unverified installed disc', entry.name, error);
    }
  }
  return null;
}

async function autoBootInstalledBlackMonday() {
  if (installedAutoBootStarted || archiveInstallRunning) return;
  if (new URLSearchParams(location.search).has('noautoboot')) return;
  if (!probe.playThreadedRuntimeReady) return;
  installedAutoBootStarted = true;
  try {
    const installed = await findVerifiedInstalledBlackMonday();
    if (!installed) {
      installedAutoBootStarted = false;
      if (setupNote) setupNote.textContent = 'First time only: select your Black Monday .7z file (or every split .7z part). After installation, future launches start the game automatically.';
      status.textContent = 'First-time setup: install Black Monday from your 7-Zip archive.';
      return;
    }
    installedDiscName = installed.entry.name;
    installedBoot.classList.add('hidden');
    installOption.classList.add('hidden');
    if (setupNote) setupNote.textContent = 'Installed Black Monday detected. Starting automatically…';
    status.textContent = 'Installed Black Monday detected. Starting automatically…';
    installStatus.textContent = 'Local verified game copy found.';
    diagnostics.record('installer.autoboot_found', { name: installed.entry.name, size: installed.entry.size });
    await bootBlackMondayFile(installed.file);
  } catch (error) {
    installedAutoBootStarted = false;
    console.error('Installed Black Monday auto-boot failed', error);
    diagnostics.record('installer.autoboot_failed', { message: error.message });
    status.textContent = `Installed copy could not start automatically: ${error.message}`;
  }
}

// Let the existing storage discovery finish first, then upgrade it to the
// finished-app behaviour: a verified installed copy boots without a file picker.
setTimeout(() => autoBootInstalledBlackMonday(), 120);

window.__blackMondayWeb = Object.freeze({
  installArchive: files => installBlackMondayArchive(files),
  autoBoot: () => autoBootInstalledBlackMonday(),
  bootInstalled: async () => {
    const installed = await findVerifiedInstalledBlackMonday();
    if (!installed) throw new Error('No verified installed Black Monday copy was found.');
    installedDiscName = installed.entry.name;
    return bootBlackMondayFile(installed.file);
  },
});


// ---- iPhone performance diagnostics / disc read-ahead ----
// Play!'s upstream browser path proxies every optical-media read to the browser
// main thread and resolves it through File.slice(...).arrayBuffer(). On iOS this
// is expensive for games that stream lots of small DVD reads. Keep a small LRU
// of larger read-ahead windows so repeated/sequential sector reads stay in RAM.
function installBlackMondayDiscReadAhead(device, {
  windowBytes = 4 * 1024 * 1024,
  maxWindows = 4,
} = {}) {
  if (!device || device.__blackMondayReadAheadInstalled) return device;

  const windows = new Map();
  const stats = {
    reads: 0,
    hits: 0,
    misses: 0,
    requestedBytes: 0,
    fetchedBytes: 0,
    fetchMs: 0,
    maxFetchMs: 0,
    errors: 0,
  };

  const remember = (start, bytes) => {
    if (windows.has(start)) windows.delete(start);
    windows.set(start, { start, end: start + bytes.byteLength, bytes });
    while (windows.size > maxWindows) windows.delete(windows.keys().next().value);
  };

  const findWindow = (offset, end) => {
    for (const [key, entry] of windows) {
      if (offset >= entry.start && end <= entry.end) {
        windows.delete(key);
        windows.set(key, entry);
        return entry;
      }
    }
    return null;
  };

  device.read = function blackMondayRead(dstPtr, offset, size) {
    this.doneFlag = false;
    this.lastError = null;
    stats.reads += 1;
    stats.requestedBytes += size;

    if (!this.file) {
      this.lastError = new Error('No disc image selected.');
      stats.errors += 1;
      this.doneFlag = true;
      return;
    }

    const requestEnd = offset + size;
    const hit = findWindow(offset, requestEnd);
    if (hit) {
      const startInWindow = offset - hit.start;
      this.module.HEAPU8.set(hit.bytes.subarray(startInWindow, startInWindow + size), dstPtr);
      stats.hits += 1;
      this.doneFlag = true;
      return;
    }

    stats.misses += 1;
    const largeRead = size >= windowBytes;
    const fetchStart = largeRead ? offset : Math.floor(offset / windowBytes) * windowBytes;
    const fetchEnd = largeRead
      ? Math.min(this.file.size, requestEnd)
      : Math.min(this.file.size, Math.max(requestEnd, fetchStart + windowBytes));
    const started = performance.now();

    this.file.slice(fetchStart, fetchEnd).arrayBuffer()
      .then(buffer => {
        const elapsed = performance.now() - started;
        const bytes = new Uint8Array(buffer);
        stats.fetchedBytes += bytes.byteLength;
        stats.fetchMs += elapsed;
        stats.maxFetchMs = Math.max(stats.maxFetchMs, elapsed);
        if (!largeRead) remember(fetchStart, bytes);
        const startInFetch = offset - fetchStart;
        this.module.HEAPU8.set(bytes.subarray(startInFetch, startInFetch + size), dstPtr);
        this.doneFlag = true;
      })
      .catch(error => {
        stats.errors += 1;
        this.lastError = error;
        this.doneFlag = true;
      });
  };

  device.getBlackMondayIoStats = () => {
    const avgFetchMs = stats.misses ? stats.fetchMs / stats.misses : 0;
    return {
      ...stats,
      avgFetchMs,
      hitRate: stats.reads ? stats.hits / stats.reads : 0,
      windows: windows.size,
      windowBytes,
    };
  };
  device.clearBlackMondayReadAhead = () => windows.clear();
  device.__blackMondayReadAheadInstalled = true;
  return device;
}

// Add diagnostic EE profiles without changing the compatibility profiles used
// elsewhere in the shell. These are measurement modes only; correctness still
// has to be checked before any underclock becomes a shipping default.
const __blackMondayBaseSetPerformanceProfile = runtime.setPerformanceProfile.bind(runtime);
runtime.setPerformanceProfile = function blackMondaySetPerformanceProfile(id = 'compatibility') {
  if (id === 'quarter') {
    if (!this.module?.setEeFrequencyScale) throw new Error('EE frequency hook unavailable.');
    this.module.setEeFrequencyScale(1, 4);
    return { label: 'Quarter EE (diagnostic)', eeNumerator: 1, eeDenominator: 4, experimental: true };
  }
  if (id === 'eighth') {
    if (!this.module?.setEeFrequencyScale) throw new Error('EE frequency hook unavailable.');
    this.module.setEeFrequencyScale(1, 8);
    return { label: 'Eighth EE (diagnostic)', eeNumerator: 1, eeDenominator: 8, experimental: true };
  }
  return __blackMondayBaseSetPerformanceProfile(id);
};

// Safari's protected-preview network module loader can reject Play.js even when
// a normal authenticated request for the same URL succeeds. Avoid that network
// module-import path completely: fetch the exact JS/WASM pair as ordinary bytes,
// import Play.js from a same-origin Blob module, and hand the matching WASM bytes
// directly to Emscripten. Pthread workers then load the same Blob module, so the
// JS and WASM pair cannot be mixed across deployments or HTTP caches.
const BLACK_MONDAY_RUNTIME_BUILD = 'bmcore-20261003-r32';
function blackMondayRuntimeAssetUrl(name) {
  const url = new URL(`./runtime/${name}`, import.meta.url);
  url.searchParams.set('bmcore', BLACK_MONDAY_RUNTIME_BUILD);
  return url.href;
}

async function blackMondayFetchRuntimeAsset(url, expectedType) {
  const response = await fetch(url, {
    cache: 'reload',
    credentials: 'include',
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Runtime asset ${new URL(url).pathname} returned HTTP ${response.status}.`);
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (expectedType === 'js' && !contentType.includes('javascript')) {
    throw new Error(`Play.js returned unexpected content type: ${contentType || 'unknown'}.`);
  }
  if (expectedType === 'wasm' && !(contentType.includes('wasm') || contentType.includes('octet-stream'))) {
    throw new Error(`Play.wasm returned unexpected content type: ${contentType || 'unknown'}.`);
  }
  return response;
}

runtime.init = async function blackMondayRuntimeInitAuthenticatedBlob() {
  if (this.module) return this;
  const playJsUrl = blackMondayRuntimeAssetUrl('Play.js');
  const playWasmUrl = blackMondayRuntimeAssetUrl('Play.wasm');

  status.textContent = 'Runtime 1/5: fetching Play.js…';
  diagnostics.record('runtime.stage', { stage: 'fetch-play-js', build: BLACK_MONDAY_RUNTIME_BUILD });
  const jsResponse = await blackMondayFetchRuntimeAsset(playJsUrl, 'js');
  const jsSource = await jsResponse.text();
  if (!jsSource.includes('export default Play')) throw new Error('Fetched Play.js did not contain the expected ES-module export.');

  status.textContent = 'Runtime 2/5: loading Play module…';
  diagnostics.record('runtime.stage', { stage: 'import-play-blob', jsBytes: jsSource.length });
  const blobUrl = URL.createObjectURL(new Blob([jsSource], { type: 'text/javascript' }));
  this.runtimeBlobUrl = blobUrl;
  let imported;
  try {
    imported = await import(blobUrl);
  } catch (error) {
    throw new Error(`Local Play module import failed: ${error?.message || error}`);
  }
  const Play = imported?.default;
  if (typeof Play !== 'function') throw new Error('Local Play module did not export the expected Emscripten factory.');

  status.textContent = 'Runtime 3/5: fetching matching Play.wasm…';
  diagnostics.record('runtime.stage', { stage: 'fetch-play-wasm' });
  const wasmResponse = await blackMondayFetchRuntimeAsset(playWasmUrl, 'wasm');
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
  if (wasmBytes.byteLength < 1000000) throw new Error(`Play.wasm is unexpectedly small (${wasmBytes.byteLength} bytes).`);

  status.textContent = 'Runtime 4/5: instantiating Play! WebAssembly…';
  diagnostics.record('runtime.stage', { stage: 'instantiate-play', wasmBytes: wasmBytes.byteLength });
  const runtimeBase = new URL('./runtime/', import.meta.url).href;
  this.module = await Play({
    wasmBinary: wasmBytes,
    locateFile: path => path === 'Play.wasm' ? playWasmUrl : new URL(path, runtimeBase).href,
    mainScriptUrlOrBlob: blobUrl,
    print: text => console.log(`[Play] ${text}`),
    printErr: text => console.error(`[Play] ${text}`),
  });

  status.textContent = 'Runtime 5/5: mounting saves and creating PS2 VM…';
  diagnostics.record('runtime.stage', { stage: 'mount-and-init-vm' });
  try { this.module.FS.mkdir('/work'); } catch (e) { if (!String(e).includes('File exists')) throw e; }
  await mountPersistentVfs(this.module);
  this.module.discImageDevice = new DiscImageDevice(this.module);
  installBlackMondayDiscReadAhead(this.module.discImageDevice);
  this.module.ccall('initVm', '', [], []);
  diagnostics.record('runtime.stage', { stage: 'ready', build: BLACK_MONDAY_RUNTIME_BUILD });
  return this;
};

function blackMondayCoreStats(sample) {
  const module = runtime.module;
  // These low-overhead hooks already exist in the base Black Monday core patch.
  // Ratios are returned as 0..1, so convert to percentages for the HUD.
  const eeRatio = Number(module?.getEeUsageRatio?.());
  const iopRatio = Number(module?.getIopUsageRatio?.());
  const drawCalls = Number(module?.getDrawCalls?.());
  const frames = Math.max(0, Number(sample?.frames ?? 0));
  return {
    eeUsage: Number.isFinite(eeRatio) && eeRatio >= 0 ? eeRatio * 100 : null,
    iopUsage: Number.isFinite(iopRatio) && iopRatio >= 0 ? iopRatio * 100 : null,
    drawCalls: Number.isFinite(drawCalls) ? drawCalls : null,
    drawCallsPerFrame: Number.isFinite(drawCalls) && frames > 0 ? drawCalls / frames : null,
  };
}

// Replace the lightweight HUD sampler with one that exposes optical-media and
// emulator-core behaviour. This lets the physical iPhone distinguish browser
// file I/O from EE/IOP/GS pressure instead of guessing from FPS alone.
beginStats = function blackMondayBeginStatsWithCoreDiagnostics() {
  clearInterval(statsTimer);
  runtime.clearStats();
  performanceMonitor.reset(runtime.getFrames());
  let diagnosticSampleCounter = 0;
  statsTimer = window.setInterval(() => {
    const sample = performanceMonitor.sample(runtime.getFrames());
    const frameTime = sample.frameTimeMs == null ? '--' : sample.frameTimeMs.toFixed(1);
    const io = runtime.module?.discImageDevice?.getBlackMondayIoStats?.() ?? null;
    const core = blackMondayCoreStats(sample);
    const ioText = io
      ? ` jsio=${io.reads} hit=${(io.hitRate * 100).toFixed(0)}% fetch=${io.avgFetchMs.toFixed(1)}ms`
      : '';
    const coreText = [
      core.eeUsage == null ? null : `ee=${core.eeUsage.toFixed(0)}%`,
      core.iopUsage == null ? null : `iop=${core.iopUsage.toFixed(0)}%`,
      core.drawCallsPerFrame == null ? null : `dc=${core.drawCallsPerFrame.toFixed(0)}`,
    ].filter(Boolean).join(' ');
    const memory = sample.memory ? ` heap=${sample.memory.usedJSHeapMiB.toFixed(0)}MiB` : '';
    hudStatus.textContent = `frames=${sample.frames} ${sample.fps.toFixed(1)}fps ${frameTime}ms perf=${activePerformanceProfile} gs=${activeGsScale}x${ioText}${coreText ? ` ${coreText}` : ''}${memory}`;
    if ((++diagnosticSampleCounter % 5) === 0) {
      diagnostics.record('performance.sample', { ...sample, discIo: io, core });
    }
    if ((diagnosticSampleCounter % 30) === 0) {
      diagnostics.persist({
        extra: {
          phase: 'running',
          fps: sample.fps,
          frameTimeMs: sample.frameTimeMs,
          performanceProfile: activePerformanceProfile,
          gsScale: activeGsScale,
          discIo: io,
          core,
        },
      });
    }
  }, 1000);
};


// ---- Black Monday r33: WASM dynarec wall-clock profiler ----
// The installed disc stays on the same origin. Only the Play! runtime pair is
// cache-busted so this instrumented core cannot be mixed with the previous build.
blackMondayRuntimeAssetUrl = function blackMondayRuntimeAssetUrlR33(name) {
  const url = new URL(`./runtime/${name}`, import.meta.url);
  url.searchParams.set('bmcore', 'bmcore-20261003-r33');
  return url.href;
};

function blackMondayWasmCodegenTotals() {
  const module = runtime.module;
  const value = name => {
    const result = Number(module?.[name]?.());
    return Number.isFinite(result) && result >= 0 ? result : 0;
  };
  return {
    modules: value('getWasmCodegenModuleCount'),
    bytes: value('getWasmCodegenModuleBytes'),
    moduleMs: value('getWasmCodegenModuleMs'),
    instances: value('getWasmCodegenInstanceCount'),
    instanceMs: value('getWasmCodegenInstanceMs'),
  };
}

function blackMondayDeltaCodegen(current, previous, elapsedSeconds) {
  const seconds = Math.max(0.001, elapsedSeconds);
  return {
    modulesPerSecond: Math.max(0, current.modules - previous.modules) / seconds,
    kibPerSecond: Math.max(0, current.bytes - previous.bytes) / 1024 / seconds,
    moduleMsPerSecond: Math.max(0, current.moduleMs - previous.moduleMs) / seconds,
    instancesPerSecond: Math.max(0, current.instances - previous.instances) / seconds,
    instanceMsPerSecond: Math.max(0, current.instanceMs - previous.instanceMs) / seconds,
  };
}

// Replace the r32 sampler with a profiler that separates guest utilisation from
// real Safari wall time spent compiling/instantiating dynamically generated WASM.
beginStats = function blackMondayBeginStatsWithDynarecProfiler() {
  clearInterval(statsTimer);
  runtime.clearStats();
  performanceMonitor.reset(runtime.getFrames());
  let diagnosticSampleCounter = 0;
  let previousCodegen = blackMondayWasmCodegenTotals();

  statsTimer = window.setInterval(() => {
    const sample = performanceMonitor.sample(runtime.getFrames());
    const frameTime = sample.frameTimeMs == null ? '--' : sample.frameTimeMs.toFixed(1);
    const io = runtime.module?.discImageDevice?.getBlackMondayIoStats?.() ?? null;
    const core = blackMondayCoreStats(sample);
    const codegen = blackMondayWasmCodegenTotals();
    const cg = blackMondayDeltaCodegen(codegen, previousCodegen, sample.deltaMs / 1000);
    previousCodegen = codegen;

    const ioText = io
      ? ` jsio=${io.reads} hit=${(io.hitRate * 100).toFixed(0)}% fetch=${io.avgFetchMs.toFixed(1)}ms`
      : '';
    const coreText = [
      core.eeUsage == null ? null : `ee=${core.eeUsage.toFixed(0)}%`,
      core.iopUsage == null ? null : `iop=${core.iopUsage.toFixed(0)}%`,
      core.drawCallsPerFrame == null ? null : `dc=${core.drawCallsPerFrame.toFixed(0)}`,
    ].filter(Boolean).join(' ');
    const jitText = ` jit=${cg.modulesPerSecond.toFixed(0)}/s/${cg.moduleMsPerSecond.toFixed(0)}ms inst=${cg.instancesPerSecond.toFixed(0)}/s/${cg.instanceMsPerSecond.toFixed(0)}ms code=${cg.kibPerSecond.toFixed(0)}KiB/s`;
    const memory = sample.memory ? ` heap=${sample.memory.usedJSHeapMiB.toFixed(0)}MiB` : '';

    hudStatus.textContent = `frames=${sample.frames} ${sample.fps.toFixed(1)}fps ${frameTime}ms perf=${activePerformanceProfile} gs=${activeGsScale}x${ioText}${coreText ? ` ${coreText}` : ''}${jitText}${memory}`;

    if ((++diagnosticSampleCounter % 5) === 0) {
      diagnostics.record('performance.sample', { ...sample, discIo: io, core, codegen, codegenRate: cg });
    }
    if ((diagnosticSampleCounter % 30) === 0) {
      diagnostics.persist({
        extra: {
          phase: 'running',
          fps: sample.fps,
          frameTimeMs: sample.frameTimeMs,
          performanceProfile: activePerformanceProfile,
          gsScale: activeGsScale,
          discIo: io,
          core,
          codegen,
          codegenRate: cg,
        },
      });
    }
  }, 1000);
};


// ---- Black Monday r35: subsystem wall-time profiler ----
// r34's non-threaded GS experiment is intentionally not part of this bundle.
// Restore the known-booting r33 renderer topology and measure where Safari's
// actual wall time goes before making another performance architecture change.
blackMondayRuntimeAssetUrl = function blackMondayRuntimeAssetUrlR35(name) {
  const url = new URL(`./runtime/${name}`, import.meta.url);
  url.searchParams.set('bmcore', 'bmcore-20261003-r35');
  return url.href;
};

function blackMondayHostWallTotalsR35() {
  const module = runtime.module;
  const value = name => {
    const result = Number(module?.[name]?.());
    return Number.isFinite(result) && result >= 0 ? result : 0;
  };
  return {
    eeMs: value('getBlackMondayEeHostMs'),
    iopMs: value('getBlackMondayIopHostMs'),
    spuMs: value('getBlackMondaySpuHostMs'),
    gsSyncMs: value('getBlackMondayGsSyncMs'),
    limiterMs: value('getBlackMondayLimiterMs'),
    gsWorkerMs: value('getBlackMondayGsWorkerMs'),
    gsBursts: value('getBlackMondayGsWorkerBursts'),
    gsCalls: value('getBlackMondayGsWorkerCalls'),
  };
}

function blackMondayHostWallDeltaR35(current, previous, seconds) {
  const elapsed = Math.max(0.001, seconds);
  const rate = key => Math.max(0, current[key] - previous[key]) / elapsed;
  return {
    eeMsPerSecond: rate('eeMs'),
    iopMsPerSecond: rate('iopMs'),
    spuMsPerSecond: rate('spuMs'),
    gsSyncMsPerSecond: rate('gsSyncMs'),
    limiterMsPerSecond: rate('limiterMs'),
    gsWorkerMsPerSecond: rate('gsWorkerMs'),
    gsBurstsPerSecond: rate('gsBursts'),
    gsCallsPerSecond: rate('gsCalls'),
  };
}

beginStats = function blackMondayBeginStatsR35SubsystemWall() {
  clearInterval(statsTimer);
  runtime.clearStats();
  performanceMonitor.reset(runtime.getFrames());
  let diagnosticSampleCounter = 0;
  let previousCodegen = blackMondayWasmCodegenTotals();
  let previousHost = blackMondayHostWallTotalsR35();

  statsTimer = window.setInterval(() => {
    const sample = performanceMonitor.sample(runtime.getFrames());
    const frameTime = sample.frameTimeMs == null ? '--' : sample.frameTimeMs.toFixed(1);
    const io = runtime.module?.discImageDevice?.getBlackMondayIoStats?.() ?? null;
    const core = blackMondayCoreStats(sample);
    const codegen = blackMondayWasmCodegenTotals();
    const cg = blackMondayDeltaCodegen(codegen, previousCodegen, sample.deltaMs / 1000);
    previousCodegen = codegen;
    const host = blackMondayHostWallTotalsR35();
    const hw = blackMondayHostWallDeltaR35(host, previousHost, sample.deltaMs / 1000);
    previousHost = host;

    const ioText = io
      ? ` io=${(io.hitRate * 100).toFixed(0)}%/${io.avgFetchMs.toFixed(1)}ms`
      : '';
    const coreText = [
      core.eeUsage == null ? null : `ee=${core.eeUsage.toFixed(0)}%`,
      core.iopUsage == null ? null : `iop=${core.iopUsage.toFixed(0)}%`,
      core.drawCallsPerFrame == null ? null : `dc=${core.drawCallsPerFrame.toFixed(0)}`,
    ].filter(Boolean).join(' ');
    const jitWallMs = cg.moduleMsPerSecond + cg.instanceMsPerSecond;
    const hostText = ` hEE=${hw.eeMsPerSecond.toFixed(0)} hIOP=${hw.iopMsPerSecond.toFixed(0)} gsw=${hw.gsWorkerMsPerSecond.toFixed(0)} sync=${hw.gsSyncMsPerSecond.toFixed(0)} lim=${hw.limiterMsPerSecond.toFixed(0)} spu=${hw.spuMsPerSecond.toFixed(0)}ms/s`;

    hudStatus.textContent = `r35 frames=${sample.frames} ${sample.fps.toFixed(1)}fps ${frameTime}ms perf=${activePerformanceProfile} gs=${activeGsScale}x${ioText}${coreText ? ` ${coreText}` : ''} jit=${jitWallMs.toFixed(0)}ms/s${hostText}`;

    if ((++diagnosticSampleCounter % 5) === 0) {
      diagnostics.record('performance.sample', {
        ...sample,
        discIo: io,
        core,
        codegen,
        codegenRate: cg,
        hostWall: host,
        hostWallRate: hw,
      });
    }
    if ((diagnosticSampleCounter % 30) === 0) {
      diagnostics.persist({
        extra: {
          phase: 'running',
          build: 'bmcore-20261003-r35',
          fps: sample.fps,
          frameTimeMs: sample.frameTimeMs,
          performanceProfile: activePerformanceProfile,
          gsScale: activeGsScale,
          discIo: io,
          core,
          codegen,
          codegenRate: cg,
          hostWall: host,
          hostWallRate: hw,
        },
      });
    }
  }, 1000);
};


// ---- Black Monday r37: gated GS renderer breakdown profiler ----
// r35 proved the dominant cost is the GS worker/synchronisation path. r36 added
// fine-grained renderer timers too early and could stall Safari during initVm.
// r37 preserves the r35 VM/renderer startup path and enables those timers only
// after initVm has returned successfully.
blackMondayRuntimeAssetUrl = function blackMondayRuntimeAssetUrlR37(name) {
  const url = new URL(`./runtime/${name}`, import.meta.url);
  url.searchParams.set('bmcore', 'bmcore-20261003-r37');
  return url.href;
};

const __blackMondayRuntimeInitR35ForR37 = runtime.init.bind(runtime);
runtime.init = async function blackMondayRuntimeInitR37GatedGsProfiler() {
  const result = await __blackMondayRuntimeInitR35ForR37();
  if (this.module?.setBlackMondayGsBreakdownEnabled) {
    this.module.setBlackMondayGsBreakdownEnabled(true);
    diagnostics.record('performance.gs-profiler-enabled', { build: 'bmcore-20261003-r37', phase: 'post-init-vm' });
  }
  return result;
};

function blackMondayGsBreakdownTotalsR37() {
  const module = runtime.module;
  const value = name => {
    const result = Number(module?.[name]?.());
    return Number.isFinite(result) && result >= 0 ? result : 0;
  };
  return {
    drawMs: value('getBlackMondayGsDrawMs'),
    textureMs: value('getBlackMondayGsTextureMs'),
    transferMs: value('getBlackMondayGsTransferMs'),
    flipMs: value('getBlackMondayGsFlipMs'),
    shaderMs: value('getBlackMondayGsShaderMs'),
  };
}

function blackMondayGsBreakdownDeltaR37(current, previous, seconds) {
  const elapsed = Math.max(0.001, seconds);
  const rate = key => Math.max(0, current[key] - previous[key]) / elapsed;
  return {
    drawMsPerSecond: rate('drawMs'),
    textureMsPerSecond: rate('textureMs'),
    transferMsPerSecond: rate('transferMs'),
    flipMsPerSecond: rate('flipMs'),
    shaderMsPerSecond: rate('shaderMs'),
  };
}

beginStats = function blackMondayBeginStatsR37GsBreakdown() {
  clearInterval(statsTimer);
  runtime.clearStats();
  performanceMonitor.reset(runtime.getFrames());
  let diagnosticSampleCounter = 0;
  let previousCodegen = blackMondayWasmCodegenTotals();
  let previousHost = blackMondayHostWallTotalsR35();
  let previousGs = blackMondayGsBreakdownTotalsR37();

  statsTimer = window.setInterval(() => {
    const sample = performanceMonitor.sample(runtime.getFrames());
    const seconds = sample.deltaMs / 1000;
    const frameTime = sample.frameTimeMs == null ? '--' : sample.frameTimeMs.toFixed(1);
    const io = runtime.module?.discImageDevice?.getBlackMondayIoStats?.() ?? null;
    const core = blackMondayCoreStats(sample);
    const codegen = blackMondayWasmCodegenTotals();
    const cg = blackMondayDeltaCodegen(codegen, previousCodegen, seconds);
    previousCodegen = codegen;
    const host = blackMondayHostWallTotalsR35();
    const hw = blackMondayHostWallDeltaR35(host, previousHost, seconds);
    previousHost = host;
    const gs = blackMondayGsBreakdownTotalsR37();
    const gb = blackMondayGsBreakdownDeltaR37(gs, previousGs, seconds);
    previousGs = gs;

    const ioText = io ? ` io=${(io.hitRate * 100).toFixed(0)}%/${io.avgFetchMs.toFixed(1)}ms` : '';
    const coreText = [
      core.eeUsage == null ? null : `ee=${core.eeUsage.toFixed(0)}%`,
      core.iopUsage == null ? null : `iop=${core.iopUsage.toFixed(0)}%`,
      core.drawCallsPerFrame == null ? null : `dc=${core.drawCallsPerFrame.toFixed(0)}`,
    ].filter(Boolean).join(' ');
    const jitWallMs = cg.moduleMsPerSecond + cg.instanceMsPerSecond;

    hudStatus.textContent =
      `r37 frames=${sample.frames} ${sample.fps.toFixed(1)}fps ${frameTime}ms perf=${activePerformanceProfile} gs=${activeGsScale}x${ioText}${coreText ? ` ${coreText}` : ''} jit=${jitWallMs.toFixed(0)}ms/s hEE=${hw.eeMsPerSecond.toFixed(0)} hIOP=${hw.iopMsPerSecond.toFixed(0)} gsw=${hw.gsWorkerMsPerSecond.toFixed(0)} sync=${hw.gsSyncMsPerSecond.toFixed(0)}\n` +
      `draw=${gb.drawMsPerSecond.toFixed(0)} tex=${gb.textureMsPerSecond.toFixed(0)} xfer=${gb.transferMsPerSecond.toFixed(0)} flip=${gb.flipMsPerSecond.toFixed(0)} shader=${gb.shaderMsPerSecond.toFixed(0)} lim=${hw.limiterMsPerSecond.toFixed(0)} spu=${hw.spuMsPerSecond.toFixed(0)}ms/s`;

    if ((++diagnosticSampleCounter % 5) === 0) {
      diagnostics.record('performance.sample', {
        ...sample,
        discIo: io,
        core,
        codegen,
        codegenRate: cg,
        hostWall: host,
        hostWallRate: hw,
        gsBreakdown: gs,
        gsBreakdownRate: gb,
      });
    }
    if ((diagnosticSampleCounter % 30) === 0) {
      diagnostics.persist({
        extra: {
          phase: 'running',
          build: 'bmcore-20261003-r37',
          fps: sample.fps,
          frameTimeMs: sample.frameTimeMs,
          performanceProfile: activePerformanceProfile,
          gsScale: activeGsScale,
          discIo: io,
          core,
          codegen,
          codegenRate: cg,
          hostWall: host,
          hostWallRate: hw,
          gsBreakdown: gs,
          gsBreakdownRate: gb,
        },
      });
    }
  }, 1000);
};
