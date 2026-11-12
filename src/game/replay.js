// The last few seconds again, from outside.
//
// "Do the replay one." When you are busted, or when you get away, the last REPLAY_SECONDS of every car
// near you can be watched again from a camera that circles your car. Recording is cheap on purpose --
// "any good ideas that won't compromise on performance?" -- REPLAY_HZ snapshots a second, of the cars
// within REPLAY_NEAR of yours, kept in a ring; nothing is simulated to play it back, the drawn cars are
// just put where they were.
import * as THREE from 'three';

const REPLAY_SECONDS = 10;
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
    this.stop();
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
    while (this.frames.length && this.frames[0].t < this.clock - REPLAY_SECONDS) this.frames.shift();
  }

  get available() { return this.frames.length > REPLAY_HZ; }

  play() {
    if (!this.available || this.playing) return false;
    this.playing = true;
    this.t = this.frames[0].t;
    this.end = this.frames[this.frames.length - 1].t;
    this.orbit = 0;
    document.body.classList.add('replaying');
    return true;
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    document.body.classList.remove('replaying');
    for (const v of this.game.vehicles) if (v.view) v.view.visible = true;
    if (this.onEnd) this.onEnd();
  }

  /** Move the replay on; false once it has run out. */
  advance(dt) {
    if (!this.playing) return false;
    this.t += dt;
    if (this.t >= this.end) { this.stop(); return false; }
    // The frame either side of now.
    const f = this.frames;
    let i = 0;
    while (i < f.length - 2 && f[i + 1].t <= this.t) i++;
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

  /** The camera, going round the player's car as it was. */
  aim(camera) {
    const p = this.game.player;
    if (!p || !p.view) return;
    const c = p.view.position;
    camera.position.set(c.x + Math.sin(this.orbit) * CAM_OUT, c.y + CAM_UP, c.z + Math.cos(this.orbit) * CAM_OUT);
    const h = this.game.sim && this.game.sim.heightAt;
    if (h) camera.position.y = Math.max(camera.position.y, h(camera.position.x, camera.position.z) + 1.2);
    camera.up.set(0, 1, 0);
    camera.lookAt(c.x, c.y + 0.6, c.z);
    if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
  }
}
