// The last few seconds again, from outside -- or, in the daily challenge, the whole run.
//
// "Do the replay one." When you are busted, or when you get away, the last REPLAY_SECONDS of every car
// near you can be watched again from a camera that circles your car. Recording is cheap on purpose --
// "any good ideas that won't compromise on performance?" -- REPLAY_HZ snapshots a second, of the cars
// within REPLAY_NEAR of yours, kept in a ring; nothing is simulated to play it back, the drawn cars are
// just put where they were.
import * as THREE from 'three';
import { CAM_MODES } from './camera.js';

const REPLAY_SECONDS = 10;
/**
 * In the daily challenge, the whole run: "can you make it that it records the entire thing instead of just
 * the last 10 seconds? So when you press replay, you can have a look at your entire run." Up to this long, s.
 */
const DAILY_SECONDS = 900;
const REPLAY_HZ = 20;
const REPLAY_NEAR = 220;
/** The camera: how far out it circles, how high, and how fast it goes round, rad/s. */
const CAM_OUT = 11;
const CAM_UP = 3.8;
const CAM_TURN = 0.35;

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

export class Replay {
  constructor(game) {
    this.game = game;
    this.frames = [];          // { t, cars: Map(vehicle -> Float32Array[7]) }
    this.clock = 0;
    this._next = 0;
    this.playing = false;
    this.t = 0;
  }

  reset() {
    this.stop(true);
    this.frames = [];
    this.clock = 0;
    this._next = 0;
  }

  /** Every frame the game runs. */
  record(dt) {
    if (this.playing) return;
    this.clock += dt;
    if (this.clock < this._next) return;
    this._next = this.clock + 1 / REPLAY_HZ;
    const g = this.game, p = g.player;
    if (!p || p.isAircraft) return;
    const cars = new Map();
    for (const v of g.vehicles) {
      if (v.removed || !v.view) continue;
      const dx = v.position.x - p.position.x, dz = v.position.z - p.position.z;
      if (v !== p && dx * dx + dz * dz > REPLAY_NEAR * REPLAY_NEAR) continue;
      cars.set(v, Float32Array.of(v.position.x, v.position.y, v.position.z,
        v.quaternion.x, v.quaternion.y, v.quaternion.z, v.quaternion.w));
    }
    this.frames.push({ t: this.clock, cars });
    const keep = g.daily ? DAILY_SECONDS : REPLAY_SECONDS;
    while (this.frames.length && this.frames[0].t < this.clock - keep) this.frames.shift();
  }

  get available() { return this.frames.length > REPLAY_HZ; }

  /**
   * `behind`: under the BUSTED screen, round and round, with the screen still up. "When you get busted, it
   * kind of just shows you a replay of the last 10 seconds ... in the background, so it still has a busted
   * symbol."
   */
  play(behind = false) {
    if (!this.available) return false;
    this.playing = true;
    this.behind = behind;
    this.t = this.frames[0].t;
    this.end = this.frames[this.frames.length - 1].t;
    this.orbit = 0;
    this._i = 0;
    this._proxy = null;
    // Each time from the replay's own camera, round the car: "keep it on cinematic." C goes on through the
    // game's views (cycleView).
    this.view = 0;
    this._label();
    document.body.classList.toggle('replaying', !behind);
    document.body.classList.toggle('replay-behind', behind);
    return true;
  }

  stop(quiet = false) {
    if (!this.playing) return;
    this.playing = false;
    this.behind = false;
    document.body.classList.remove('replaying');
    document.body.classList.remove('replay-behind');
    for (const v of this.game.vehicles) if (v.view) v.view.visible = true;
    if (this.onEnd && !quiet) this.onEnd();
  }

  /** Move the replay on; false once it has run out. */
  advance(dt) {
    if (!this.playing) return false;
    this.t += dt;
    if (this.t >= this.end) {
      // Behind the BUSTED screen it goes round again; watched on its own, it ends.
      if (this.behind) { this.t = this.frames[0].t; this._i = 0; }
      else { this.stop(); return false; }
    }
    // The frame either side of now, on from the last one: a whole daily run is thousands of frames.
    const f = this.frames;
    let i = this._i || 0;
    if (i >= f.length || f[i].t > this.t) i = 0;
    while (i < f.length - 2 && f[i + 1].t <= this.t) i++;
    this._i = i;
    this._a = f[i];
    this._b = f[i + 1] || f[i];
    const span = this._b.t - this._a.t;
    this._u = span > 0 ? Math.min(1, (this.t - this._a.t) / span) : 0;
    this.orbit += dt * CAM_TURN;
    return true;
  }

  /** Put a car's drawing where it was; false (and hidden) if it was not there. */
  pose(v) {
    const a = this._a && this._a.cars.get(v), b = this._b && this._b.cars.get(v);
    const s = a || b, e = b || a;
    if (!s) { v.view.visible = false; return false; }
    v.view.visible = true;
    const u = this._u;
    v.view.position.set(s[0] + (e[0] - s[0]) * u, s[1] + (e[1] - s[1]) * u, s[2] + (e[2] - s[2]) * u);
    _qa.set(s[3], s[4], s[5], s[6]);
    _qb.set(e[3], e[4], e[5], e[6]);
    v.view.quaternion.copy(_qa).slerp(_qb, u);
    return true;
  }

  /**
   * The next view: the replay's own camera going round the car, then each of the game's (chase, close,
   * bonnet, cinematic), each with the look-around. "Allow me to switch between any camera view and look
   * around."
   */
  cycleView() {
    this.view = (this.view + 1) % (1 + CAM_MODES.length);
    const cam = this.game.camera3;
    if (this.view > 0 && cam) {
      cam.mode = this.view - 1;
      cam._rel = cam._lookRel = null;
      if (this._proxy) cam.snapTo(this._proxy);
    }
    this._label();
  }

  _label() {
    const el = typeof document !== 'undefined' && document.getElementById('replayview');
    if (el) el.textContent = this.view === 0 ? '(replay)' : `(${CAM_MODES[this.view - 1]})`;
  }

  /**
   * The player's car as the replay has it, dressed as a vehicle for the game's camera: where it is drawn,
   * which way, and how fast, from the change since the last frame.
   */
  _carNow(dt) {
    const p = this.game.player;
    const pr = this._proxy || (this._proxy = {
      position: new THREE.Vector3(), prevPos: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
      prevQuat: new THREE.Quaternion(), forward: new THREE.Vector3(), up: new THREE.Vector3(), linvel: new THREE.Vector3(),
      speed: 0, forwardSpeed: 0, lateralSpeed: 0, isAircraft: false, _seen: false,
    });
    pr.spec = p.spec;
    pr.specKey = p.specKey;
    pr.view = p.view;
    const at = p.view.position;
    if (pr._seen && dt > 0) {
      const vx = (at.x - pr.position.x) / dt, vy = (at.y - pr.position.y) / dt, vz = (at.z - pr.position.z) / dt;
      // A replay frame is a twentieth of a second, so the speed is smoothed rather than stepping.
      const k = 1 - Math.exp(-8 * dt);
      pr.linvel.x += (vx - pr.linvel.x) * k; pr.linvel.y += (vy - pr.linvel.y) * k; pr.linvel.z += (vz - pr.linvel.z) * k;
    }
    pr._seen = true;
    pr.position.copy(at);
    pr.prevPos.copy(at);
    pr.quaternion.copy(p.view.quaternion);
    pr.prevQuat.copy(p.view.quaternion);
    pr.forward.set(0, 0, 1).applyQuaternion(pr.quaternion);
    pr.up.set(0, 1, 0).applyQuaternion(pr.quaternion);
    pr.speed = Math.hypot(pr.linvel.x, pr.linvel.z);
    pr.forwardSpeed = pr.linvel.x * pr.forward.x + pr.linvel.z * pr.forward.z;
    pr.lateralSpeed = 0;
    return pr;
  }

  /** The camera: the replay's own going round the car, or one of the game's following it. */
  aim(camera, dt = 1 / 60) {
    const p = this.game.player;
    if (!p || !p.view) return;
    const car = this._carNow(dt);
    const cam = this.game.camera3;
    if (this.view > 0 && cam) {
      cam.update(dt, car, 1);
      return;
    }
    const c = p.view.position;
    // Swung by the look-around as well (right stick, right mouse button): round the car, and up or down.
    const yaw = this.orbit + (cam ? cam.lookYaw : 0), up = CAM_UP + (cam ? Math.sin(cam.lookPitch) * CAM_OUT : 0);
    camera.position.set(c.x + Math.sin(yaw) * CAM_OUT, c.y + up, c.z + Math.cos(yaw) * CAM_OUT);
    const h = this.game.sim && this.game.sim.heightAt;
    if (h) camera.position.y = Math.max(camera.position.y, h(camera.position.x, camera.position.z) + 1.2);
    camera.up.set(0, 1, 0);
    camera.lookAt(c.x, c.y + 0.6, c.z);
    if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
  }
}
