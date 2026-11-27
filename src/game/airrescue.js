// Air Rescue, the daily challenge's helicopter day (game/daily.js).
//
// "With the helicopter ... it's kind of really easy ... you take off, and then ... you can see on the mini map ...
// the direction ... You have to go there, and you'll see like this relatively large box, and you have to land there
// gently and without like breaking yourself. If you break the helicopter, you instantly have to restart again ... go
// to like 3 different places like that ... but maybe make more of a reason." So: a crash. Pick up the doctor, then
// the casualty, then land them at the hospital. The places are the day's own, the same for everyone.
import * as THREE from 'three';
import { GROUP } from '../physics/world.js';
import { SKID, ENDURANCE } from './flyheli.js';

/** The box to land in, m across and high; held down in it this long, s; the hardest touch that counts, m/s. */
export const BOX = 18;
const BOX_H = 9;
const HOLD = 3;
// 5, not 3: "it says you touched down too hard, but it didn't break my landers. It needs to be a bit more lenient".
export const GENTLE = 5;
/** The clock: m/s over the ground it allows, and s for each landing and for the start. */
const PACE = 27;
const PER_LANDING = 22;
const START = 18;
/** A wreck is seen for this long before it is from the top, s. */
const WRECK_SHOWN = 1.6;

const LEGS = [
  { go: 'Fly to the doctor', load: 'DOCTOR ON BOARD', busy: 'Doctor getting in', next: 'Now the crash site. Take off.' },
  { go: 'Fly to the crash', load: 'CASUALTY ON BOARD', busy: 'Loading the casualty', next: 'Now the hospital. Take off, gently.' },
  { go: 'Fly to the hospital', load: 'DELIVERED', busy: 'Handing over', next: '' },
];

/** Three places to land, from the day's numbers: open, level ground, clear of roads, buildings, trees and water. */
export function pickSites(game, rng, from) {
  const G = game.graph, sim = game.sim, map = game.world.__map || {};
  const half = (game.mapDef && game.mapDef.half) || 1000;
  // Everything solid, as circles in a coarse grid (as game/garage.js finds its lot).
  const C = 40, solids = new Map();
  game.world.forEachCollider((c) => {
    const m = c.collisionGroups() >>> 16;
    if (!(m & (GROUP.BUILDING | GROUP.PROP | GROUP.CANOPY | GROUP.HEDGE))) return;
    const he = c.halfExtents ? c.halfExtents() : null;
    const t = c.translation();
    const r = he ? Math.hypot(he.x, he.z) : c.shape && c.shape.radius ? c.shape.radius : 0;
    if (!r) return;
    const key = `${Math.floor(t.x / C)},${Math.floor(t.z / C)}`;
    let l = solids.get(key);
    if (!l) solids.set(key, l = []);
    l.push({ x: t.x, z: t.z, r: Math.min(r, 60) });
  });
  const clear = (x, z, room) => {
    const i = Math.floor(x / C), j = Math.floor(z / C);
    for (let a = i - 3; a <= i + 3; a++) {
      for (let b = j - 3; b <= j + 3; b++) {
        for (const s of solids.get(`${a},${b}`) || []) if (Math.hypot(s.x - x, s.z - z) < s.r + room) return false;
      }
    }
    for (const e of G.edgesNear(x, z, 60)) {
      if (e.dead) continue;
      for (const sg of e.segs) {
        const dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, l2 = dx * dx + dz * dz;
        let u = l2 ? ((x - sg.a.x) * dx + (z - sg.a.z) * dz) / l2 : 0;
        u = Math.max(0, Math.min(1, u));
        if (Math.hypot(sg.a.x + dx * u - x, sg.a.z + dz * u - z) < e.width * 0.5 + room) return false;
      }
    }
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < 12; a++) {
      for (const r of [0, 6, 12]) {
        const px = x + Math.cos(a * Math.PI / 6) * r, pz = z + Math.sin(a * Math.PI / 6) * r;
        if (map.clearAt && map.clearAt(px, pz)) return false;
        const y = sim.heightAt ? sim.heightAt(px, pz) || 0 : 0;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    }
    return hi - lo < 0.9;
  };
  const out = [];
  let at = from;
  for (const [room, near] of [[15, 450], [13, 380], [12, 300], [12, 200]]) {
    for (let k = 0; k < 900 && out.length < 3; k++) {
      const x = (rng() * 2 - 1) * half * 0.78, z = (rng() * 2 - 1) * half * 0.78;
      const d = Math.hypot(x - at.x, z - at.z);
      if (d < near || d > near + 650) continue;
      if (out.some((s) => Math.hypot(s.x - x, s.z - z) < near)) continue;
      if (!clear(x, z, room)) continue;
      at = { x, z };
      out.push({ x, z, y: sim.heightAt ? sim.heightAt(x, z) || 0 : 0 });
    }
    if (out.length === 3) break;
  }
  return out;
}

export class AirRescue {
  constructor(game, rng) {
    this.game = game;
    this.rng = rng;
    this.sites = [];
    this.limit = 300;
    this.leg = 0;
    this.held = 0;
  }

  /** The day's places, once the map has its garage (the challenge is made before it). */
  _plan() {
    const g = this.game, pad = g.garage && g.garage.helipad;
    if (!pad || this.sites.length) return;
    this.pad = pad;
    this.sites = pickSites(g, this.rng, pad);
    let len = 0, at = pad;
    for (const s of this.sites) { len += Math.hypot(s.x - at.x, s.z - at.z); at = s; }
    this.limit = Math.round(len / PACE + PER_LANDING * this.sites.length + START);
    this.length = len;
  }

  /** The place to fly to now, or null when all are done. */
  get target() { return this.sites[this.leg] || null; }

  /** On the pad, shut down, mended, full: the start, and the start again. */
  begin() {
    const p = this.game.player;
    this._plan();
    this.leg = 0;
    this.held = 0;
    this.hard = false;
    this.wreckT = 0;
    this._air = false;
    this._vy = 0;
    if (p && p.isAircraft && this.pad) {
      p.repair();
      p.teleport({ x: this.pad.x, y: this.pad.y + SKID, z: this.pad.z }, this._heading());
      p.fuel = ENDURANCE;
      p.engineOff = true;
      p.starting = 0;
      p.collective = 0;
      p.spin = 0;
    }
    this._build();
    this._place();
  }

  _heading() {
    const s = this.sites[0];
    return s && this.pad ? Math.atan2(s.x - this.pad.x, s.z - this.pad.z) : 0;
  }

  /** Nothing turns until GO. */
  hold() {
    const p = this.game.player;
    if (!p || !p.isAircraft) return;
    p.engineOff = true;
    p.starting = 0;
  }

  /**
   * A moment of the run: 'won', 'wrecked' (it has been down long enough: from the top), or null.
   */
  update(dt) {
    const g = this.game, p = g.player, s = this.target;
    if (!p || !p.isAircraft) return null;
    if (p.disabled) {
      this.wreckT += dt;
      return this.wreckT > WRECK_SHOWN ? 'wrecked' : null;
    }
    // Plenty for the day; what ends it is breaking it.
    p.fuel = Math.max(p.fuel, 60);
    if (!s) return 'won';
    const inBox = Math.abs(p.position.x - s.x) < BOX / 2 && Math.abs(p.position.z - s.z) < BOX / 2;
    const down = p.onGround && !p.sliding;
    if (!p.onGround) {
      this._air = true;
      this._vy = -p.linvel.y;
      this.held = 0;
      if (p.position.y > s.y + 1.5 || !inBox) this.hard = false;
    } else if (this._air) {
      // Down, just now: how hard?
      this._air = false;
      this.touch = this._vy;
      this.hard = this._vy > GENTLE;
      if (inBox && this.hard && g.hud) g.hud.toast('TOO HARD: LIFT OFF AND SET IT DOWN GENTLY');
    }
    if (down && inBox && !this.hard && p.speed < 0.6) {
      this.held += dt;
      if (this.held >= HOLD) {
        const l = LEGS[this.leg];
        this.held = 0;
        this.leg++;
        if (g.hud) g.hud.toast(l.load);
        if (g.audio && g.audio.impact) g.audio.impact(0.12);
        this._place();
        if (!this.target) return 'won';
      }
    } else if (!down) this.held = 0;
    this._paintBox(inBox, down);
    return null;
  }

  /** What the panel says. */
  get say() {
    const p = this.game.player, s = this.target;
    if (!s || !p) return '';
    if (p.disabled) return 'aircraft down: from the top';
    const l = LEGS[this.leg];
    const d = Math.hypot(p.position.x - s.x, p.position.z - s.z);
    if (this.held > 0) return `${this.leg + 1}/3 · ${l.busy} ${Math.max(0, HOLD - this.held).toFixed(1)}`;
    if (this.hard) return `${this.leg + 1}/3 · too hard: lift off and try again`;
    if (p.onGround && this.leg > 0 && d > BOX) return `${this.leg + 1}/3 · ${LEGS[this.leg - 1].next}`;
    return `${this.leg + 1}/3 · ${l.go} · ${d > 950 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`}`;
  }

  // ---------------------------------------------------------------- the box

  _build() {
    if (this.group) return;
    const g = this.group = new THREE.Group();
    g.name = 'air-rescue';
    const mat = (opacity) => new THREE.MeshBasicMaterial({ color: 0xff9a2e, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.mats = [mat(0.34), mat(0.13), mat(0.2)];
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(BOX, BOX), this.mats[0]);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.35;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(BOX, BOX_H, BOX), this.mats[1]);
    walls.position.y = BOX_H / 2;
    this.edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(BOX, BOX_H, BOX)), new THREE.LineBasicMaterial({ color: 0xffd9a0, fog: false }));
    this.edge.position.y = BOX_H / 2;
    // Seen over the roofs from across the map.
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 220, 16, 1, true), this.mats[2]);
    beam.position.y = 110 + BOX_H;
    for (const m of [floor, walls, beam, this.edge]) { m.frustumCulled = false; m.renderOrder = 6; g.add(m); }
    this.game.scene.add(g);
  }

  _place() {
    const s = this.target;
    if (!this.group) return;
    this.group.visible = !!s;
    if (s) this.group.position.set(s.x, s.y, s.z);
  }

  _paintBox(inBox, down) {
    const c = inBox && down && !this.hard ? 0x46d17a : this.hard && inBox ? 0xff4d3d : 0xff9a2e;
    if (c === this._colour) return;
    this._colour = c;
    for (const m of this.mats) m.color.setHex(c);
  }

  dispose() {
    if (!this.group) return;
    this.game.scene.remove(this.group);
    for (const o of this.group.children) { o.geometry.dispose(); o.material.dispose(); }
    this.group = null;
  }
}
