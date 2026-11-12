// Police cars thrown into the air on the hills, in a real chase.
//
// "I still see police cars going really, really fast, and they go up a hill and they just hit something
// invisible, and they just go flying ... it's on hills always." The staged rig (hillcharge.js) drives at
// slopes head on and finds little. This watches every police car in whatever chase is running, physics
// step by physics step, and records each one that gains more than KICK m/s upward in one step, or loses
// more than a third of its speed in a fifth of a second: what it was touching, how fast, on what slope.
//
//   await import('/tests/launch.js');
//   __launchWatch();                       // then run a chase rig, e.g. __runKeepUp([150], 30, 8)
//   __launchReport();
import { Vehicle } from '../src/physics/vehicle.js';
import { GROUP } from '../src/physics/world.js';

const KICK = 4;

window.__launchWatch = function () {
  const L = window.__launch = { steps: 0, kicks: [], stops: [], by: {} };
  if (Vehicle.prototype.__watched) return;
  const orig = Vehicle.prototype.postStep;
  Vehicle.prototype.__watched = true;
  Vehicle.prototype.postStep = function (dt) {
    const before = this._prevVel ? { x: this._prevVel.x, y: this._prevVel.y, z: this._prevVel.z } : null;
    const r = orig.call(this, dt);
    if (!this.isPolice || this.humanDriven || !before || !window.__launch) return r;
    const W = window.__launch;
    W.steps++;
    const lv = this.body.linvel();
    const hs = Math.hypot(lv.x, lv.z), hs0 = Math.hypot(before.x, before.z);
    this._hsHist = this._hsHist || [];
    this._hsHist.push(hs);
    if (this._hsHist.length > 24) this._hsHist.shift();
    this._kickCool = Math.max(0, (this._kickCool || 0) - 1);
    const kick = lv.y - before.y;
    const stop = this._hsHist.length === 24 && this._hsHist[0] > 15 && hs < this._hsHist[0] * 0.66;
    if ((kick > KICK || stop) && !this._kickCool && hs0 > 12) {
      this._kickCool = 60;
      const touch = [];
      for (const c of this.keel ? [this.collider, this.keel] : [this.collider]) {
        this.world.contactPairsWith(c, (o) => {
          if (o === this.collider || o === this.keel) return;
          let t = false;
          this.world.contactPair(c, o, (m) => { if (m.numContacts() > 0) t = true; });
          if (!t) return;
          const m = (o.collisionGroups() >>> 16) & 0xFFFF;
          const name = m & GROUP.HILL ? 'hill' : m & GROUP.TERRAIN ? 'plate' : m & GROUP.BUILDING ? 'building'
            : m & GROUP.PROP ? 'prop' : m & GROUP.VEHICLE ? 'car' : m & GROUP.RAMP ? 'ramp' : m.toString(16);
          touch.push(`${c === this.keel ? 'keel' : 'body'}:${name}`);
        });
      }
      const h = this.sim.heightAt;
      const ux = hs0 ? before.x / hs0 : 0, uz = hs0 ? before.z / hs0 : 0;
      const px = this.position.x, pz = this.position.z;
      const grade = h ? (h(px + ux * 4, pz + uz * 4) - h(px - ux * 4, pz - uz * 4)) / 8 : 0;
      const ahead = h ? (h(px + ux * 8, pz + uz * 8) - h(px, pz)) / 8 - (h(px, pz) - h(px - ux * 8, pz - uz * 8)) / 8 : 0;
      const e = {
        kind: kick > KICK ? 'kick' : 'stop',
        kph: Math.round(hs0 * 3.6), now: Math.round(hs * 3.6), kick: +kick.toFixed(1), vy: +lv.y.toFixed(1),
        wheels: this.grounded, up: +this.up.y.toFixed(2), y: h ? +(this.position.y - h(px, pz)).toFixed(2) : null,
        grade: Math.round(grade * 100), bend: Math.round(ahead * 100), touch: touch.join(' ') || 'nothing',
        comp: this.wheels.map((w) => +w.compression.toFixed(2)).join(','),
      };
      (e.kind === 'kick' ? W.kicks : W.stops).push(e);
      W.by[e.touch] = (W.by[e.touch] || 0) + 1;
    }
    return r;
  };
};

window.__launchReport = function () {
  const W = window.__launch;
  if (!W) return 'not watching';
  const mins = W.steps / 120 / 60;
  const rows = [`${mins.toFixed(1)} police-car minutes: kicked up ${W.kicks.length}, sudden stops ${W.stops.length}; touching ${JSON.stringify(W.by)}`];
  const big = W.kicks.slice().sort((a, b) => b.kick - a.kick).slice(0, 8);
  for (const k of big) rows.push('kick ' + JSON.stringify(k));
  for (const s of W.stops.slice(0, 6)) rows.push('stop ' + JSON.stringify(s));
  return rows.join('\n');
};
