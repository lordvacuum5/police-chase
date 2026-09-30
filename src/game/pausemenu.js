// Pause, and the settings that live behind it.
//
// There was nowhere to change the sound on a phone. The keyboard has N for
// mute and that is all there ever was, so a phone got a small SND button in a
// row of six along the top of the screen -- no volume at all, and five of the
// six were things you want once a session rather than mid-corner.
//
// So P and the pause button open one panel: volume, sound, camera, and the way
// back to the menu. The top bar on a phone keeps only what you need with the
// car moving -- pause, full screen, and flip -- and everything else moved in
// here.
//
// Pausing silences the game as well as stopping it, which it did not used to:
// see Audio.setHeld.

import { clamp01 } from '../util/math.js';
import { CAM_MODES } from './camera.js';

const VOL_KEY = 'pc.volume';

/** The volume last chosen, 0 to 1. Defaults to the mix the game ships with. */
export function savedVolume() {
  try {
    const raw = localStorage.getItem(VOL_KEY);
    if (raw === null) return 0.75;
    const v = Number(raw);
    return Number.isFinite(v) ? clamp01(v) : 0.75;
  } catch (e) {
    return 0.75;                     // storage blocked
  }
}

export class PauseMenu {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('pause');
    if (!this.el) return;
    this.volEl = document.getElementById('vol');
    this.volVal = document.getElementById('volval');
    this.soundBtn = document.getElementById('soundbtn');
    this.camBtn = document.getElementById('cambtn');
    this.shown = false;

    const vol = savedVolume();
    this.volEl.value = String(Math.round(vol * 100));
    this._paintVolume(vol);

    // `input` rather than `change`, so the sound follows the thumb.
    this.volEl.addEventListener('input', () => {
      const v = clamp01(Number(this.volEl.value) / 100);
      this._paintVolume(v);
      if (this.game.audio) {
        this.game.audio.setVolume(v);
        // Turning it up from silence is the obvious way to mean "sound on".
        if (v > 0 && this.game.audio.muted) this.game.audio.toggleMute();
      }
      try { localStorage.setItem(VOL_KEY, String(v)); } catch (e) { /* blocked */ }
      this._paintSound();
    });

    this.soundBtn.addEventListener('click', () => {
      if (!this.game.audio) return;
      this.game.audio.toggleMute();
      this._paintSound();
    });

    this.camBtn.addEventListener('click', () => {
      this.game.camera3.cycle();
      this._paintCamera();
    });

    document.getElementById('resume').addEventListener('click', () => {
      this.game.paused = false;
    });
    // Going back to the menu throws the run away, and it sits next to RESUME,
    // so it asks once. The phone's old MENU button did the same for the same
    // reason; the button moved in here and the guard came with it.
    this.menuBtn = document.getElementById('tomenu');
    this.menuBtn.addEventListener('click', () => {
      if (this._sureUntil && performance.now() < this._sureUntil) {
        this.game.input.press('KeyM');
        return;
      }
      this._sureUntil = performance.now() + 3000;
      this.menuBtn.textContent = 'SURE?';
      this.menuBtn.classList.add('off');
      clearTimeout(this._sureTimer);
      this._sureTimer = setTimeout(() => this._clearSure(), 3100);
    });

    // A press anywhere on the dimmed background resumes, which is what a tap
    // outside a dialogue means everywhere else on a phone. Presses inside the
    // box must not count, hence the target test.
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.game.paused = false;
    });
  }

  /** Put the menu button back to saying MENU. */
  _clearSure() {
    this._sureUntil = 0;
    if (this.menuBtn) {
      this.menuBtn.textContent = 'MENU';
      this.menuBtn.classList.remove('off');
    }
  }

  _paintVolume(v) {
    if (this.volVal) this.volVal.textContent = `${Math.round(v * 100)}%`;
  }

  _paintSound() {
    const muted = !!(this.game.audio && this.game.audio.muted);
    this.soundBtn.textContent = muted ? 'OFF' : 'ON';
    this.soundBtn.classList.toggle('on', !muted);
    this.soundBtn.classList.toggle('off', muted);
  }

  _paintCamera() {
    const name = CAM_MODES[this.game.camera3.mode] || '';
    this.camBtn.textContent = name.toUpperCase();
  }

  /** Called every frame: shows or hides itself with the game's paused flag. */
  frame() {
    if (!this.el) return;
    const want = !!this.game.paused && !this.game.outcome;
    if (want === this.shown) return;
    this.shown = want;
    this.el.classList.toggle('show', want);
    if (want) {
      this._clearSure();
      this._paintSound();
      this._paintCamera();
    }
  }
}
