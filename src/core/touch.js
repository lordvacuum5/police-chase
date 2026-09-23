// Touchscreen controls.
//
// A phone has no keys, so it gets the layout a driving game on a phone usually
// has: steer with the left thumb, pedals under the right, and the handful of
// one-off keys -- pause, camera, flip, sound, menu -- as small buttons along
// the top. None of it exists until the screen is actually touched (or the
// device is a phone to begin with), so a desktop never sees any of it and
// never has a click intercepted by it.
//
// It does not drive anything itself. It publishes throttle, brake, handbrake
// and steering for Input.sample to merge with the keyboard, and the buttons
// press the same virtual keys the keyboard does, so every action still goes
// through Game._handleKeys and there is one place that decides what a key does.

import { clamp } from '../util/math.js';

/**
 * Is this a device whose main input is a finger? `?touch` forces it, so the
 * layout can be checked on a desktop.
 */
export function prefersTouch() {
  try {
    if (/[?&]touch\b/.test(window.location.search)) return true;
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch (e) {
    return false;
  }
}

/**
 * Thumb travel for full lock, in CSS pixels. A fifth of the short side of the
 * screen: about 75 px on a phone held sideways -- a comfortable thumb slide --
 * without asking for a longer one on a tablet.
 */
function fullLockPx() {
  return Math.max(48, Math.min(window.innerWidth, window.innerHeight) * 0.19);
}

/** Dead zone at the centre of the stick, as a fraction of full lock. */
const DEAD = 0.06;

const BUTTONS = [
  { id: 'pause', label: 'II', title: 'Pause', key: 'KeyP' },
  { id: 'camera', label: 'CAM', title: 'Camera', key: 'KeyC' },
  { id: 'flip', label: 'FLIP', title: 'Flip upright', key: 'KeyR' },
  { id: 'mute', label: 'SND', title: 'Sound on or off', key: 'Mute' },
  { id: 'full', label: 'FULL', title: 'Full screen' },
  { id: 'menu', label: 'MENU', title: 'Back to the menu', key: 'KeyM', confirm: true },
];

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.input = game.input;
    this.enabled = false;

    // What Input.sample reads.
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.steer = 0;
    this.steering = false;

    this.pointers = new Map();
    this._confirmUntil = 0;
    this._ended = null;

    this._build();
    this.input.touch = this;

    if (prefersTouch()) this.enable();
    // A finger anywhere turns the controls on. A key press turns them off
    // again, but only on a machine with a mouse -- a laptop with a touchscreen
    // -- not on a phone that happens to have a keyboard attached.
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') this.enable();
    }, true);
    window.addEventListener('keydown', () => {
      if (this.enabled && !prefersTouch()) this.disable();
    });
    const clear = () => this._releaseAll();
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    document.addEventListener('fullscreenchange', () => this._syncFullscreen());
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add('touch');
    this.input.usingPad = false;
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    document.body.classList.remove('touch');
    this._releaseAll();
  }

  // ------------------------------------------------------------------ DOM

  _build() {
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div id="t-steer"><div id="t-stick"><i></i><span>&#9664; STEER &#9654;</span></div></div>
      <div id="t-pedals">
        <div class="tpedal" id="t-hand" data-pedal="handbrake">HANDBRAKE</div>
        <div class="tpedal" id="t-brake" data-pedal="brake">BRAKE</div>
        <div class="tpedal" id="t-gas" data-pedal="throttle">GAS</div>
      </div>
      <div id="t-buttons">${BUTTONS.map((b) => `<div class="tbtn" id="t-${b.id}" data-tap="${b.id}"`
        + ` role="button" aria-label="${b.title}">${b.label}</div>`).join('')}</div>
      <div class="tbtn" id="t-again" data-tap="again" role="button">RUN AGAIN</div>
      <div id="t-rotate" data-tap="rotate" role="button">Turn your phone sideways for a wider view<small>tap to hide</small></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.stick = root.querySelector('#t-stick');
    this.knob = this.stick.querySelector('i');
    this.steerZone = root.querySelector('#t-steer');
    this.pedalEls = [...root.querySelectorAll('[data-pedal]')];
    this.menuBtn = root.querySelector('#t-menu');
    this.flipBtn = root.querySelector('#t-flip');
    this.muteBtn = root.querySelector('#t-mute');
    this.pauseBtn = root.querySelector('#t-pause');
    this.fullBtn = root.querySelector('#t-full');
    this.againBtn = root.querySelector('#t-again');

    const canFull = !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);
    if (!canFull) this.fullBtn.hidden = true;

    root.addEventListener('pointerdown', (e) => this._down(e));
    root.addEventListener('pointermove', (e) => this._move(e));
    root.addEventListener('pointerup', (e) => this._up(e));
    root.addEventListener('pointercancel', (e) => this._up(e));
    root.addEventListener('lostpointercapture', (e) => this._up(e));
    // Long presses would otherwise bring up the copy menu or a magnifier.
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------- pointers

  _down(e) {
    e.preventDefault();
    this.enable();
    const tap = e.target.closest('[data-tap]');
    if (tap) {
      this._tap(tap.dataset.tap, tap);
      return;
    }
    const pedal = e.target.closest('[data-pedal]');
    if (pedal) {
      this.pointers.set(e.pointerId, { kind: 'pedal', pedal: pedal.dataset.pedal });
    } else if (e.target.closest('#t-steer')) {
      // The stick is wherever the thumb lands, not a fixed spot it has to
      // find without looking.
      this.pointers.set(e.pointerId, { kind: 'steer', x0: e.clientX, y0: e.clientY, x: e.clientX });
    } else {
      return;
    }
    try { this.root.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    this._apply();
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    if (p.kind === 'steer') {
      p.x = e.clientX;
    } else {
      // A thumb rocks between the pedals rather than lifting, so the pedal is
      // whichever one is under it now. Sliding off them altogether keeps the
      // last one held: a thumb that drifts a few pixels past the edge of GAS
      // should not lift off the throttle.
      const under = this._pedalAt(e.clientX, e.clientY);
      if (under) p.pedal = under;
    }
    this._apply();
  }

  _up(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this._apply();
  }

  _releaseAll() {
    this.pointers.clear();
    this._apply();
  }

  _pedalAt(x, y) {
    for (const el of this.pedalEls) {
      const r = el.getBoundingClientRect();
      if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6) return el.dataset.pedal;
    }
    return null;
  }

  /** Turn the pointers held right now into controls, and show them. */
  _apply() {
    let throttle = 0, brake = 0, handbrake = 0, steer = null;
    for (const p of this.pointers.values()) {
      if (p.kind === 'pedal') {
        if (p.pedal === 'throttle') throttle = 1;
        else if (p.pedal === 'brake') brake = 1;
        else if (p.pedal === 'handbrake') handbrake = 1;
      } else if (steer === null) {
        steer = p;
      }
    }
    this.throttle = throttle;
    this.brake = brake;
    this.handbrake = handbrake;

    const full = fullLockPx();
    if (steer) {
      const dx = clamp((steer.x - steer.x0) / full, -1, 1);
      const live = Math.abs(dx) < DEAD ? 0 : (dx - Math.sign(dx) * DEAD) / (1 - DEAD);
      // Thumb right is steer right, which is negative in the car's frame.
      this.steer = -live;
      this.steering = true;
      this.stick.classList.add('on');
      this.stick.style.left = `${steer.x0}px`;
      this.stick.style.top = `${steer.y0}px`;
      this.knob.style.transform = `translateX(${dx * full}px)`;
    } else {
      this.steer = 0;
      this.steering = false;
      this.stick.classList.remove('on');
      this.stick.style.left = '';
      this.stick.style.top = '';
      this.knob.style.transform = '';
    }
    for (const el of this.pedalEls) {
      const on = el.dataset.pedal === 'throttle' ? throttle
        : el.dataset.pedal === 'brake' ? brake : handbrake;
      el.classList.toggle('on', !!on);
    }
  }

  // -------------------------------------------------------------- buttons

  _tap(id, el) {
    if (id === 'rotate') { el.hidden = true; return; }
    if (id === 'again') { this.input.press('KeyR'); return; }
    if (id === 'full') { this._toggleFullscreen(); return; }
    const b = BUTTONS.find((x) => x.id === id);
    if (!b) return;
    if (b.confirm) {
      // Going back to the menu throws the run away, and the button sits where
      // a thumb reaching for something else can land on it: ask once.
      const now = performance.now();
      if (now > this._confirmUntil) {
        this._confirmUntil = now + 2500;
        el.textContent = 'SURE?';
        el.classList.add('warn');
        setTimeout(() => {
          if (performance.now() >= this._confirmUntil) {
            el.textContent = b.label;
            el.classList.remove('warn');
          }
        }, 2600);
        return;
      }
    }
    this.input.press(b.key);
  }

  _toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        // Only allowed in full screen, and only on some phones. Worth asking.
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      })
      .catch(() => {});
  }

  _syncFullscreen() {
    this.fullBtn.classList.toggle('on', !!document.fullscreenElement);
  }

  /** Per frame: the parts of the layout that follow the game rather than a finger. */
  frame() {
    if (!this.enabled) return;
    const ended = !!this.game.outcome;
    if (ended !== this._ended) {
      this._ended = ended;
      this.root.classList.toggle('ended', ended);
      // A police player in somebody else's game is stopped by the arrest like
      // everyone else, but starting again is not theirs to do -- so they get
      // the overlay and no button, rather than one that does nothing.
      this.againBtn.hidden = ended && !this.game.canRestart;
    }
    const p = this.game.player;
    const stuck = !!p && (p.flippedFor > 0.3);
    if (stuck !== this._stuck) {
      this._stuck = stuck;
      this.flipBtn.classList.toggle('warn', stuck);
    }
    // The radio log that used to confirm "[sound] muted" is hidden, so the
    // button has to show it.
    const muted = !!(this.game.audio && this.game.audio.muted);
    if (muted !== this._muted) {
      this._muted = muted;
      this.muteBtn.classList.toggle('off', muted);
    }
    const paused = !!this.game.paused;
    if (paused !== this._paused) {
      this._paused = paused;
      this.pauseBtn.classList.toggle('on', paused);
      this.pauseBtn.textContent = paused ? '▶' : 'II';
    }
  }
}
