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
//
// Flying gets its own layout, because the driving one has nothing to fly with:
// a car needs one axis and three pedals, a helicopter needs four axes. Air
// mode puts a thumbstick under each thumb -- the same split as the Xbox pad in
// input.js, which is the scheme every game with a helicopter in it uses:
//
//   left stick    up/down the collective, across the pedals
//   right stick   the cyclic: forward to tilt forward and go, right to bank
//
// The pedals are hidden while it is up, GAS and BRAKE and HANDBRAKE being
// three words for things a helicopter does not have: "it shouldn't say break
// and stuff."
//
// Two deliberate differences between the sticks, both about what happens when
// a thumb lifts off. The cyclic springs back to centre, so letting go levels
// the aircraft -- that is the recovery a phone pilot needs and the flight
// model already self-centres toward it. The collective latches where it was
// left, like the lever it is named after: a stick that sprang back to zero
// power would drop you out of the sky every time you adjusted your grip. It
// is a relative lever, too -- a thumb slides it up from wherever it already
// is, rather than the touch-down point meaning a particular power setting.

import { clamp } from '../util/math.js';
import { appleMobile } from './platform.js';

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

/** One stick axis, dead zone taken out and the rest stretched back to full. */
function deaden(d) {
  if (Math.abs(d) < DEAD) return 0;
  return (d - Math.sign(d) * DEAD) / (1 - DEAD);
}

/**
 * Put a stick under the thumb that is holding it.
 *
 * Page coordinates are what a pointer event carries and are not what `left`
 * and `top` mean: each stick is absolutely positioned inside its own half of
 * the screen, so they are measured from that half's corner. The right-hand
 * zone starts halfway across, which put the cyclic a full half-screen off the
 * right-hand edge -- on screen in the DOM, invisible to the player. The left
 * one was out by the height of the button bar for the same reason, which was
 * small enough to look like nothing and be lived with.
 */
function place(el, x, y) {
  const parent = el.offsetParent;
  const r = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
  el.style.left = `${x - r.left}px`;
  el.style.top = `${y - r.top}px`;
}

/** Launched from the home screen, with no browser chrome around it. */
function standalone() {
  return window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

/**
 * What to tell somebody whose browser will not let the page go full screen.
 *
 * On an iPhone that is all of them, and the answer is the home screen: a page
 * added there opens without Safari's bars, which is the same thing by a
 * different route (index.html carries the meta tags that make it work).
 */
function fullScreenAdvice() {
  return appleMobile()
    ? 'Safari can\'t make a page full screen on an iPhone.<br>'
      + 'Tap <b>Share</b>, then <b>Add to Home Screen</b> \u2014 opened from there, '
      + 'the game gets the whole screen.'
    : 'This browser won\'t let a page go full screen.<br>'
      + 'Try hiding its bars, or use Chrome.';
}

/**
 * The buttons along the top of a phone screen.
 *
 * Only what you need with the car moving. It used to be six -- camera, sound
 * and the way back to the menu as well -- which is a row of small targets
 * above the game for things you want once a session, and no volume control
 * anywhere. They live in the pause panel now (game/pausemenu.js), which is
 * what the first of these opens: "on the phone all we need is full screen...
 * and flip".
 */
const BUTTONS = [
  { id: 'pause', label: 'II', title: 'Pause and settings', key: 'KeyP' },
  { id: 'full', label: 'FULL', title: 'Full screen' },
  { id: 'flip', label: 'FLIP', title: 'Flip upright', key: 'KeyR' },
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

    // What Input.sampleAir reads. `air` is the layout, set by the game when
    // the player turns out to be flying; the rest is the two sticks.
    this.air = false;
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.collective = 0;
    this.cyclicOn = false;
    this.leftOn = false;

    this.pointers = new Map();
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

  /**
   * Switch between the driving layout and the flying one.
   *
   * Called every frame with the same value nearly always, so it does nothing
   * unless it changes -- and when it does change it drops whatever is held.
   * Stepping out of the car with a thumb on the throttle would otherwise
   * leave that thumb holding the collective of an aircraft on a rooftop.
   */
  setAir(on) {
    const want = !!on;
    if (want === this.air) return;
    this.air = want;
    this.root.classList.toggle('air', want);
    this._releaseAll();
    // The collective is a lever that remembers where it was left, and a fresh
    // aircraft is parked with it closed.
    this.collective = 0;
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
      <div id="t-steer"><div id="t-stick"><i></i><span>&#9664; STEER &#9654;</span>
        <b>POWER<br>&#9664; PEDALS &#9654;</b></div></div>
      <div id="t-cyc"><div id="t-cstick"><i></i><b>TILT</b></div></div>
      <div id="t-pedals">
        <div class="tpedal" id="t-hand" data-pedal="handbrake">HANDBRAKE</div>
        <div class="tpedal" id="t-brake" data-pedal="brake">BRAKE</div>
        <div class="tpedal" id="t-gas" data-pedal="throttle">GAS</div>
      </div>
      <div id="t-buttons">${BUTTONS.map((b) => `<div class="tbtn" id="t-${b.id}" data-tap="${b.id}"`
        + ` role="button" aria-label="${b.title}">${b.label}</div>`).join('')}</div>
      <div class="tbtn" id="t-again" data-tap="again" role="button">RUN AGAIN</div>
      <div id="t-hint" data-tap="hint" role="button" hidden></div>
      <div id="t-rotate" data-tap="rotate" role="button">Turn your phone sideways for a wider view<small>tap to hide</small></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.stick = root.querySelector('#t-stick');
    this.knob = this.stick.querySelector('i');
    this.steerZone = root.querySelector('#t-steer');
    this.cyc = root.querySelector('#t-cstick');
    this.cycKnob = this.cyc.querySelector('i');
    this.pedalEls = [...root.querySelectorAll('[data-pedal]')];
    this.flipBtn = root.querySelector('#t-flip');
    this.pauseBtn = root.querySelector('#t-pause');
    this.fullBtn = root.querySelector('#t-full');
    this.againBtn = root.querySelector('#t-again');
    this.hintEl = root.querySelector('#t-hint');

    // An iPhone has no Fullscreen API at all -- Safari only ever gave it to
    // video -- so the button used to hide itself there, which is every iPhone:
    // "on some phones, and mainly on Apple phones, you can't see the full
    // screen button." Hiding it was the wrong answer twice over, because
    // there *is* a way to play an iPhone full screen; it is just not a button
    // the page is allowed to press. So the button stays, and on a phone that
    // cannot do it from here it says how.
    //
    // The one case where it really has nothing to offer is a game already
    // launched from the home screen: there is no browser left to hide.
    this.canFull = !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);
    if (standalone()) this.fullBtn.hidden = true;

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
    // Either stick is wherever the thumb lands, not a fixed spot it has to
    // find without looking. Flying tracks the vertical as well, and the
    // collective remembers what it was when the thumb arrived, because the
    // slide adjusts it rather than setting it.
    const here = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
    if (pedal && !this.air) {
      this.pointers.set(e.pointerId, { kind: 'pedal', pedal: pedal.dataset.pedal });
    } else if (this.air && e.target.closest('#t-cyc')) {
      this.pointers.set(e.pointerId, Object.assign({ kind: 'cyclic' }, here));
    } else if (e.target.closest('#t-steer')) {
      this.pointers.set(e.pointerId, Object.assign({ kind: 'steer', c0: this.collective }, here));
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
    if (p.kind === 'steer' || p.kind === 'cyclic') {
      p.x = e.clientX;
      p.y = e.clientY;
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
    let throttle = 0, brake = 0, handbrake = 0, steer = null, cyclic = null;
    for (const p of this.pointers.values()) {
      if (p.kind === 'pedal') {
        if (p.pedal === 'throttle') throttle = 1;
        else if (p.pedal === 'brake') brake = 1;
        else if (p.pedal === 'handbrake') handbrake = 1;
      } else if (p.kind === 'cyclic') {
        if (cyclic === null) cyclic = p;
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
      const dy = clamp((steer.y - steer.y0) / full, -1, 1);
      // Thumb right is steer right, which is negative in the car's frame.
      this.steer = -deaden(dx);
      this.steering = true;
      if (this.air) {
        // Across is the pedals. Thumb right swings the nose right, and right
        // is a falling yaw -- see the pedals in flyheli.update.
        this.yaw = -deaden(dx);
        // Up is more power. The slide adjusts the lever from where it already
        // was, and `full` of travel covers the whole range, so half a thumb
        // slide is half the lever.
        this.collective = clamp(steer.c0 - dy, -1, 1);
        this.leftOn = true;
      }
      this.stick.classList.add('on');
      place(this.stick, steer.x0, steer.y0);
      this.knob.style.transform = this.air
        ? `translate(${dx * full}px, ${dy * full}px)`
        : `translateX(${dx * full}px)`;
    } else {
      this.steer = 0;
      this.steering = false;
      this.yaw = 0;
      // Not the collective: it stays where it was left. See setAir.
      this.leftOn = false;
      this.stick.classList.remove('on');
      this.stick.style.left = '';
      this.stick.style.top = '';
      this.knob.style.transform = '';
    }

    // The cyclic, which is the one the aircraft is flown on. Forward is a
    // positive pitch, which tilts the rotor forward and goes -- the screen's
    // up is a falling clientY, hence the negation. Right is a positive roll
    // and banks right. Both match the mouse and the pad; nothing here is
    // handed the way the car's steering is.
    if (cyclic) {
      const dx = clamp((cyclic.x - cyclic.x0) / full, -1, 1);
      const dy = clamp((cyclic.y - cyclic.y0) / full, -1, 1);
      this.roll = deaden(dx);
      this.pitch = -deaden(dy);
      this.cyclicOn = true;
      this.cyc.classList.add('on');
      place(this.cyc, cyclic.x0, cyclic.y0);
      this.cycKnob.style.transform = `translate(${dx * full}px, ${dy * full}px)`;
    } else {
      // Centred, and said so rather than merely left at nought: the flight
      // model levels the aircraft when the stick is at rest, so letting go is
      // how a phone pilot recovers.
      this.roll = 0;
      this.pitch = 0;
      this.cyclicOn = false;
      this.cyc.classList.remove('on');
      this.cyc.style.left = '';
      this.cyc.style.top = '';
      this.cycKnob.style.transform = '';
    }

    for (const el of this.pedalEls) {
      const on = el.dataset.pedal === 'throttle' ? throttle
        : el.dataset.pedal === 'brake' ? brake : handbrake;
      el.classList.toggle('on', !!on);
    }
  }

  // -------------------------------------------------------------- buttons

  _tap(id, el) {
    if (id === 'rotate' || id === 'hint') { el.hidden = true; return; }
    if (id === 'again') { this.input.press('KeyR'); return; }
    if (id === 'full') { this._toggleFullscreen(); return; }
    const b = BUTTONS.find((x) => x.id === id);
    if (!b) return;
    this.input.press(b.key);
  }

  _toggleFullscreen() {
    if (!this.canFull) { this._say(fullScreenAdvice()); return; }
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

  /** A line of advice over the game, until it is tapped or ten seconds pass. */
  _say(html) {
    if (!this.hintEl) return;
    this.hintEl.innerHTML = `${html}<small>tap to hide</small>`;
    this.hintEl.hidden = false;
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => { this.hintEl.hidden = true; }, 10000);
  }

  /** Per frame: the parts of the layout that follow the game rather than a finger. */
  frame() {
    if (!this.enabled) return;
    // Which layout. Asked every frame rather than wired to one event, because
    // there are several ways to stop being a driver: taking the aircraft,
    // crashing it and coming back on the pad, or being handed a role by the
    // host in multiplayer. setAir does nothing unless the answer changed.
    const p0 = this.game.player;
    this.setAir(!!p0 && !!p0.isAircraft);
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
    const paused = !!this.game.paused;
    if (paused !== this._paused) {
      this._paused = paused;
      this.pauseBtn.classList.toggle('on', paused);
      this.pauseBtn.textContent = paused ? '▶' : 'II';
      // The stick and the pedals cover most of the screen and they are over
      // the pause panel, so they have to let go of the pointer while it is up
      // or they catch presses meant for it. Releasing what is held matters as
      // much: pausing with a thumb on the throttle used to latch it there,
      // and the car drove off on its own when the game came back.
      this.root.classList.toggle('held', paused);
      if (paused) this._releaseAll();
    }
  }
}
