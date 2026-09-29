// Keyboard, gamepad and touchscreen input.
//
// Steering is deliberately passed through almost raw: the vehicle already rate
// limits the road wheels, and adding a second smoothing stage on top makes the
// car feel like it is being driven through treacle.
//
// The touchscreen controls (core/touch.js) attach themselves as `touch` and
// are merged with the keyboard rather than replacing it, so a laptop with a
// touchscreen can use either at any moment.

import { clamp, moveTowards } from '../util/math.js';

/**
 * Pad buttons that press a key. Standard gamepad numbering, which every pad
 * the browser calls "standard" follows: 3 is Y on an Xbox pad, triangle on a
 * PlayStation one.
 */
const PAD_TAPS = {
  3: 'KeyC',        // Y: change view
};

const KEYMAP = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  clutch: ['ShiftLeft', 'ShiftRight'],
};

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    this.word = '';              // the last few letters typed: see typed()
    this.steerAxis = 0;
    this.gamepadIndex = null;
    this.usingPad = false;
    this.touch = null;

    this._onDown = (e) => {
      if (e.repeat) return;
      // Stop the page scrolling out from under the game.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.pressed.add(e.code);
      // The last few letters, for things that are typed rather than pressed.
      if (/^Key[A-Z]$/.test(e.code)) {
        this.word = (this.word + e.code.slice(3)).slice(-12).toLowerCase();
      }
      this.usingPad = false;
    };
    this._onUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();

    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  down(action) { return KEYMAP[action].some((k) => this.keys.has(k)); }

  /**
   * Has this word just been typed?
   *
   * For the things that should not be one key away from an accident. The
   * buffer only holds letters, and a match clears it so a word fires once.
   */
  typed(word) {
    if (!this.word.endsWith(word)) return false;
    this.word = '';
    return true;
  }

  /**
   * Pad buttons that act like key taps, read once a frame.
   *
   * Held axes and triggers are sampled with the driving controls; these are
   * different -- they fire once on the press, like a key, so they go through
   * the same `pressed` set the keyboard and the on-screen buttons use and the
   * game does not have to know where a tap came from.
   *
   * It has to be polled from the frame loop rather than from `sample`, which
   * runs later in the frame than the key handling and only while the game is
   * unpaused: a press found there would be cleared by endFrame before anything
   * read it.
   */
  pollPad() {
    const pad = this._pad();
    if (!pad) { this._padPrev = null; return; }
    const prev = this._padPrev || [];
    const now = [];
    for (const [index, code] of Object.entries(PAD_TAPS)) {
      const b = pad.buttons[index];
      const on = !!(b && b.pressed);
      now[index] = on;
      if (on && !prev[index]) this.press(code);
    }
    this._padPrev = now;
  }

  /** True once per press. */
  tapped(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  /**
   * A key press that did not come from a key: the on-screen buttons. Counts
   * for tapped() exactly as a real press would.
   */
  press(code) { this.pressed.add(code); }

  endFrame() { this.pressed.clear(); }

  _pad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const p = navigator.getGamepads()[this.gamepadIndex];
    return p && p.connected ? p : null;
  }

  /** Returns { throttle, brake, steer, handbrake, clutchKick }. */
  sample(dt) {
    const pad = this._pad();
    if (pad) {
      const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
      const steer = dead(pad.axes[0] || 0);
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
      const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      const hb = pad.buttons[0] && pad.buttons[0].pressed ? 1 : 0;
      const kick = !!(pad.buttons[2] && pad.buttons[2].pressed);
      if (rt > 0.05 || lt > 0.05 || Math.abs(steer) > 0.05) this.usingPad = true;
      if (this.usingPad) {
        this.steerAxis = -steer;    // pad right = steer right = negative in our frame
        return { throttle: rt, brake: lt, steer: this.steerAxis, handbrake: hb, clutchKick: kick };
      }
    }

    // Keyboard: a virtual axis that winds on at a human rate and snaps back to
    // centre quickly. Ramping on too fast is indistinguishable from a driver
    // slamming the wheel to full lock, which just scrubs the front tyres.
    const want = (this.down('left') ? 1 : 0) + (this.down('right') ? -1 : 0);
    const rate = want === 0 ? 7.0 : 3.1;
    this.steerAxis = moveTowards(this.steerAxis, want, rate * dt);

    const out = {
      throttle: this.down('throttle') ? 1 : 0,
      brake: this.down('brake') ? 1 : 0,
      steer: clamp(this.steerAxis, -1, 1),
      handbrake: this.down('handbrake') ? 1 : 0,
      clutchKick: this.down('clutch'),
    };

    // Touch: pedals add to the keys, and a thumb on the stick takes the
    // steering. The stick is analogue, like a pad, so it goes straight through
    // rather than through the keyboard's wind-on ramp.
    const t = this.touch;
    if (t && t.enabled) {
      out.throttle = Math.max(out.throttle, t.throttle);
      out.brake = Math.max(out.brake, t.brake);
      out.handbrake = Math.max(out.handbrake, t.handbrake);
      if (t.steering) {
        out.steer = t.steer;
        this.steerAxis = t.steer;
      }
    }
    return out;
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
  }
}
